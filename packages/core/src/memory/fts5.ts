/**
 * The FTS5-backed retriever, and the indexer that keeps it in step with the files.
 *
 * **FTS5 narrows; it does not rank.** The index answers "which passages contain any of these terms",
 * bounded, and everything after that is `rank/bm25.ts` — the same tokeniser, the same idf, the same
 * summation and the same normalisation the index-free skill selector uses. Two reasons, and the second
 * is the one that would have bitten:
 *
 * 1. `bm25()` computes its statistics over the **whole table**, and one sandbox root has one store
 *    shared by every agent in it. Average document length and N would be corpus-wide while retrieval is
 *    per-agent, so one agent's scores would shift when an unrelated agent saved a note — a ranking that
 *    changes for reasons outside the agent, with nothing reporting it.
 * 2. It makes FTS5's tokeniser irrelevant. `porter` stems differently from `stem()` and no built-in
 *    tokeniser applies a stopword list, so scoring through `bm25()` would have meant `memory.threshold`
 *    and `skills.threshold` were two different floors wearing one number.
 *
 * What is indexed is therefore the output of `terms()`, space-joined — which leaves FTS5's tokeniser
 * nothing to do but split on the spaces we put there. The cost is that the indexed column is *derived*:
 * `TOKENISER_VERSION` rides along in `memory_sources` so a changed tokeniser forces a rebuild instead of
 * silently degrading every query.
 *
 * ## Why the index is trusted about staleness but not about content
 *
 * `syncFiles` skips a source whose mtime **and** size **and** tokeniser version all match. Size is in
 * there because mtime alone is a poor witness: a file rewritten within the same millisecond, or restored
 * from a copy that preserved timestamps, reports unchanged. Both together are still not a proof — the
 * blind spot is an edit that preserves mtime and length, which `memory rebuild` exists for and which is
 * stated rather than papered over.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { estimateTokens } from "../context/tokens.ts"
import { ceiling, counted, informative, score, TOKENISER_VERSION, terms } from "../rank/bm25.ts"
import type { MemoryPassageRecord, MemoryStore } from "../store/store.ts"
import { document, type Passage, splitPassages } from "./passages.ts"
import { boosted, type MemoryRetriever, type RetrievedPassage } from "./retriever.ts"

/**
 * How many candidates to pull per requested result.
 *
 * Over-fetching is required rather than merely prudent, for two independent reasons. The recency boost
 * reorders after scoring, so a passage that FTS5 ranked twelfth can finish third — fetch exactly `limit`
 * and that passage is invisible. And `exclude` drops whole sources *after* the query, so a corpus whose
 * carried file dominates the matches would return almost nothing.
 *
 * Eight, with a floor, because the work is a string split per candidate and 5,000-passage retrieval
 * measures in single-digit milliseconds either way.
 */
const CANDIDATE_FACTOR = 8
const MIN_CANDIDATES = 64

export interface Fts5Options {
    readonly store: MemoryStore
    readonly agentId: string
}

function toPassage(record: MemoryPassageRecord): Passage {
    return {
        id: record.id,
        source: record.source,
        ...(record.heading === undefined ? {} : { heading: record.heading }),
        text: record.text,
        at: record.at,
        tags: record.tags,
        stamped: record.stamped,
    }
}

/**
 * Rank the corpus against one query. Ranking only — the caller applies threshold, `maxActive` and budget.
 *
 * Returns `[]` on an empty corpus and on a query with no informative term, and those are different
 * situations with the same answer: nothing indexed yet, versus a question made entirely of words no
 * passage contains. Neither is an error, and `memory search` distinguishes them from the corpus size.
 */
export function fts5Retriever(options: Fts5Options): MemoryRetriever {
    const { store, agentId } = options

    return async (request) => {
        const stats = await store.stats(agentId)
        if (stats.passages === 0) return []

        const candidateTerms = [...new Set(terms(request.input))]
        if (candidateTerms.length === 0) return []

        const df = await store.frequencies(agentId, candidateTerms)
        // `informative` re-tokenises the input, which is deliberate duplication of a few microseconds:
        // it keeps "which terms count" in one place, and a term dropped here must also be absent from
        // the MATCH expression — a term FTS5 scored that the denominator did not divide by would push a
        // score above 1 and stop the threshold bounding anything.
        const query = informative(request.input, df, stats.passages)
        if (query.length === 0) return []

        const want = Math.max(MIN_CANDIDATES, request.limit * CANDIDATE_FACTOR)
        const candidates = await store.candidates(agentId, query, want)

        const excluded = new Set(request.exclude ?? [])
        const denominator = ceiling(query, df, stats.passages)
        // A corpus of empty documents cannot happen — `splitPassages` emits no empty passage — but a
        // zero average would produce NaN, and NaN sorts unpredictably instead of failing.
        const averageLength = stats.totalLength === 0 ? 1 : stats.totalLength / stats.passages

        const ranked: RetrievedPassage[] = []
        for (const record of candidates) {
            if (excluded.has(record.source)) continue
            const lexical = score({
                counts: counted(record.terms === "" ? [] : record.terms.split(" ")),
                length: record.length,
                averageLength,
                query,
                df,
                total: stats.passages,
                denominator,
            })
            ranked.push({
                passage: toPassage(record),
                lexical,
                score: boosted(lexical, record.at, request.now),
                tokens: record.tokens,
            })
        }

        ranked.sort(byScoreThenId)
        return ranked.slice(0, request.limit)
    }
}

/**
 * Descending score, then id.
 *
 * The tiebreak is not cosmetic: two passages scoring identically must be injected in the same order on
 * every machine, or one agent behaves differently from another with the same files. Same reasoning as
 * `byScoreThenName` in the skill selector, and the id is the stable key here because two passages can
 * share a source and a timestamp.
 */
function byScoreThenId(a: RetrievedPassage, b: RetrievedPassage): number {
    if (b.score !== a.score) return b.score - a.score
    return a.passage.id < b.passage.id ? -1 : a.passage.id > b.passage.id ? 1 : 0
}

/** One file the indexer has been asked to consider. The caller decides which files those are. */
export interface IndexableFile {
    /** Stable identity for the source: a path relative to the memory root, or the carried file's name. */
    readonly source: string
    /**
     * Read on demand, and **only** when the file turns out to have changed.
     *
     * A `string` here would be simpler and would put the whole corpus in the boot path: the acceptance
     * criterion is that boot stays inside its budget *with* a 5,000-passage index, and it only does
     * because an unchanged file costs one `stat` and no read. Making the read lazy is what keeps the
     * skip cheap — otherwise the caller has already paid for every file before the indexer decides it
     * needed none of them.
     */
    readonly read: () => string
    readonly mtimeMs: number
    readonly size: number
}

export interface IndexReport {
    /** Sources re-read because they changed, were new, or were tokenised under older rules. */
    readonly indexed: readonly string[]
    /** Sources whose mtime, size and tokeniser version all matched. */
    readonly skipped: readonly string[]
    /** Sources dropped because the file is gone. */
    readonly dropped: readonly string[]
    /** Passages in the corpus after the sync. */
    readonly passages: number
}

/**
 * Bring the index in line with a set of files.
 *
 * Wholesale per source, incremental across sources: an unchanged file is not even read by the caller,
 * and a changed one is re-split entirely. Per-source rather than per-passage because a markdown file has
 * no stable per-line identity, and content-derived ids make the re-insert idempotent — an unchanged
 * passage in a changed file keeps its row rather than churning.
 *
 * **This reconciles rather than adds, and the distinction bites.** A source present in the index but
 * absent from `files` is **dropped** — so calling this with one file forgets every other source, which
 * is correct for "here is the corpus" and catastrophic for "here is one more file". Written down because
 * the first test against this function made exactly that mistake, indexing five files one call at a time
 * and finding four of them gone. Callers pass the whole set, every time.
 *
 * Dropping is what makes a deleted archive file disappear from retrieval. The alternative — leaving it — would retrieve text that no
 * longer exists anywhere on disk, and a person who deleted a memory file would reasonably expect the
 * memory to be gone.
 */
export async function syncFiles(input: {
    readonly store: MemoryStore
    readonly agentId: string
    readonly files: readonly IndexableFile[]
    readonly now: Date
}): Promise<IndexReport> {
    const { store, agentId, files, now } = input
    const stamp = now.toISOString()
    const known = new Map((await store.sources(agentId)).map((state) => [state.source, state]))

    const indexed: string[] = []
    const skipped: string[] = []

    for (const file of files) {
        const state = known.get(file.source)
        known.delete(file.source)
        if (
            state !== undefined &&
            state.mtimeMs === file.mtimeMs &&
            state.size === file.size &&
            state.tokeniser === TOKENISER_VERSION
        ) {
            skipped.push(file.source)
            continue
        }

        const passages = splitPassages({
            text: file.read(),
            source: file.source,
            // The file's own mtime is the honest fallback for a passage nobody stamped: it is the last
            // moment the fact could have been written down.
            fallbackAt: new Date(file.mtimeMs).toISOString(),
        })
        await store.replaceSource(
            agentId,
            file.source,
            passages.map(toRecord),
            { mtimeMs: file.mtimeMs, size: file.size, tokeniser: TOKENISER_VERSION },
            stamp,
        )
        indexed.push(file.source)
    }

    const dropped: string[] = []
    for (const source of known.keys()) {
        await store.dropSource(agentId, source)
        dropped.push(source)
    }

    const stats = await store.stats(agentId)
    return { indexed, skipped, dropped, passages: stats.passages }
}

/**
 * A passage as the store wants it: with its terms and their count precomputed.
 *
 * `document()` rather than `text` is tokenised, so a bullet is retrievable on its heading — "prefers
 * tabs" matches nothing useful, "Formatting / prefers tabs" matches `formatting`. `tokens` is estimated
 * from `text` alone, because `text` is what slot 7 pays for.
 */
function toRecord(passage: Passage): MemoryPassageRecord {
    const list = terms(document(passage))
    return {
        ...passage,
        terms: list.join(" "),
        length: list.length,
        tokens: estimateTokens(passage.text),
    }
}

/**
 * Every markdown file under `dir`, plus whatever else the caller names, ready to reconcile.
 *
 * Synchronous and `stat`-only: this runs inside boot, where hard rule 4 puts the network out of reach
 * and the budget puts a corpus read out of reach too. Nothing is opened here — `read` is a closure the
 * indexer calls only for a file whose mtime or size moved.
 *
 * A missing directory is the normal first-run state and yields nothing rather than throwing. Only `.md`
 * files, so a `.gitignore` or an editor's swap file never becomes a source; and non-recursive, because a
 * subdirectory under `memory/` is a person organising something, not more memory to index — guessing
 * otherwise is how a checked-out repository inside a memory folder becomes five thousand passages.
 */
export function enumerateFiles(input: {
    readonly dir: string
    /** Extra files with an explicit source name — the carried workspace file. */
    readonly extra?: readonly { readonly source: string; readonly path: string }[]
}): readonly IndexableFile[] {
    const out: IndexableFile[] = []

    let names: string[] = []
    try {
        names = readdirSync(input.dir)
            .filter((name) => name.endsWith(".md"))
            .sort()
    } catch {
        // No archive directory yet. Eviction creates it on first use, never speculatively.
    }
    for (const name of names) {
        const path = join(input.dir, name)
        const stats = statOf(path)
        if (stats === undefined) continue
        out.push({ source: name, read: () => readFileSync(path, "utf8"), ...stats })
    }

    for (const entry of input.extra ?? []) {
        const stats = statOf(entry.path)
        if (stats === undefined) continue
        out.push({
            source: entry.source,
            read: () => readFileSync(entry.path, "utf8"),
            ...stats,
        })
    }

    return out
}

function statOf(path: string): { mtimeMs: number; size: number } | undefined {
    try {
        const stats = statSync(path)
        if (!stats.isFile()) return undefined
        return { mtimeMs: Math.floor(stats.mtimeMs), size: stats.size }
    } catch {
        return undefined
    }
}
