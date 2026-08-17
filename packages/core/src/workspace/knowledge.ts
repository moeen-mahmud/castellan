/**
 * Tier 3: keyword-gated knowledge files. Governed by docs/07-SPEC-WORKSPACE.md.
 *
 * Knowledge is *retrieved, never pinned*. The workspace tiers are carried on every turn and must
 * survive every compaction stage; a knowledge entry enters the context only on the turns whose
 * input mentions one of its keywords, is never written back, and compaction may drop it. That
 * difference is why it lives outside the workspace budgets entirely — it is not paid for on every
 * turn, so it does not compete with the files that are.
 *
 * The gate is deliberately dumb: case-insensitive whole-word matching against the current input.
 * Phase 6 attaches a scored retriever behind `KnowledgeSelector` — the seam is the function type,
 * not a plugin surface — and **must not** build a second index to do it. Until a scored selector
 * exists, prove the lexical gate insufficient before replacing it, which is the same bar memory's
 * FTS5 sets for embeddings.
 *
 * Everything here is synchronous and filesystem-only, read once at agent load. It runs inside
 * boot, where hard rule 4 puts the network entirely out of reach.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { activate } from "../context/activate.ts"
import { estimateTokens } from "../context/tokens.ts"
import { knowledgeDirMissing, knowledgeEntryOverBudget, knowledgeFileInvalid } from "../errors.ts"
import { DEFAULT_PROMPT_STYLE, type PromptStyle, renderPromptStyle } from "../model/prompt-style.ts"
import { parseKnowledgeFile } from "./frontmatter.ts"

export interface KnowledgeEntry {
    /** The filename, for errors and the block label. */
    readonly name: string
    /** Lowercased. A phrase is matched as a phrase, not as its words separately. */
    readonly keywords: readonly string[]
    /** Stripped and rendered. What the model sees when the entry activates. */
    readonly content: string
    readonly tokens: number
}

export interface KnowledgeBase {
    /** Sorted by filename, so activation ties break the same way on every machine. */
    readonly entries: readonly KnowledgeEntry[]
    readonly maxActive: number
    /** Total across the entries active in one turn. */
    readonly budget: number
}

/**
 * The Phase 6 seam. Given the turn's input, return the entries worth activating, best first.
 *
 * The contract is ranking only: the caller applies `maxActive` and the budget, so a selector
 * cannot quietly widen either. A scored retriever replaces the default by being a different
 * function, not a different pipeline.
 */
export type KnowledgeSelector = (
    input: string,
    entries: readonly KnowledgeEntry[],
) => readonly KnowledgeEntry[]

export interface LoadKnowledgeOptions {
    /** Absolute. The caller resolves it against the manifest directory. */
    readonly dir: string
    readonly maxActive: number
    readonly budget: number
    /** The same style the workspace rendered with, so the two cannot drift. */
    readonly style?: PromptStyle
}

export function loadKnowledge(options: LoadKnowledgeOptions): KnowledgeBase {
    const style = options.style ?? DEFAULT_PROMPT_STYLE

    let names: string[]
    try {
        if (!statSync(options.dir).isDirectory()) throw new Error("not a directory")
        names = readdirSync(options.dir).filter((name) => name.endsWith(".md"))
    } catch {
        throw knowledgeDirMissing(options.dir, options.dir)
    }

    const entries: KnowledgeEntry[] = []
    for (const name of names.sort()) {
        const path = join(options.dir, name)
        let raw: string
        try {
            raw = readFileSync(path, "utf8")
        } catch (cause) {
            throw knowledgeFileInvalid(name, `it is not readable at ${path}.`, cause)
        }

        const parsed = parseKnowledgeFile(name, raw)
        const content = renderPromptStyle(parsed.body, style)
        const tokens = estimateTokens(content)

        // An entry larger than the whole activation budget would sit in the catalogue and silently
        // never be selected — starved by configuration, refused at load like everything else with
        // that shape.
        if (tokens > options.budget) {
            throw knowledgeEntryOverBudget(name, tokens, options.budget)
        }

        entries.push({ name, keywords: parsed.keywords, content, tokens })
    }

    return { entries, maxActive: options.maxActive, budget: options.budget }
}

/**
 * The default gate: case-insensitive whole-word match, ranked by how many keywords matched.
 *
 * Whole-word rather than substring, because "art" must not activate on "start" — a false
 * activation costs budget the right entry needed. Ties keep filename order, which `loadKnowledge`
 * already sorted, so the same input activates the same entries on every machine.
 */
export const keywordSelector: KnowledgeSelector = (input, entries) => {
    const haystack = input.toLowerCase()
    return entries
        .map((entry) => ({
            entry,
            score: entry.keywords.filter((keyword) => wholeWordIncludes(haystack, keyword)).length,
        }))
        .filter((scored) => scored.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((scored) => scored.entry)
}

function wholeWordIncludes(haystack: string, needle: string): boolean {
    let from = 0
    while (true) {
        const at = haystack.indexOf(needle, from)
        if (at === -1) return false
        const before = at === 0 ? "" : (haystack[at - 1] ?? "")
        const after = haystack[at + needle.length] ?? ""
        if (!isWordChar(before) && !isWordChar(after)) return true
        from = at + 1
    }
}

function isWordChar(char: string): boolean {
    return char !== "" && /[\p{L}\p{N}]/u.test(char)
}

/**
 * Rank, then take what fits: up to `maxActive` entries whose cumulative size stays inside the
 * budget.
 *
 * The walk itself is `activate()` in `context/activate.ts`, shared with skills — it was duplicated
 * the moment a second tier needed the same rule, and its no-skip-past property is documented there.
 */
export function activateKnowledge(
    input: string,
    base: KnowledgeBase,
    selector: KnowledgeSelector = keywordSelector,
): readonly KnowledgeEntry[] {
    if (base.entries.length === 0) return []
    return activate(selector(input, base.entries), {
        maxActive: base.maxActive,
        budget: base.budget,
    })
}
