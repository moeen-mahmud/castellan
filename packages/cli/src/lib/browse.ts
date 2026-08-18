/**
 * The browse list: a curated catalogue turned into rows, and rows turned back into skills.
 *
 * Pure and PURE-listed. The screen root renders it and the plain path prints it, so the *shape* of the
 * list — which sources appear, in what order, under which headings, with what shown beside each entry —
 * is decided once here and asserted without mounting Ink or reaching a network.
 *
 * Keeping this separate from the component is what makes `--plain` honest: a terminal and a pipe print
 * the same list because both read the same rows, rather than the plain path reimplementing the ordering
 * and drifting the first time a group is added.
 */

import { curatedGroupOf } from "#lib/curated"
import { metaOf } from "#lib/rows"
import type { CatalogueEntry } from "#lib/source-cache"
import type { SourceSpec } from "#lib/sources"

export interface BrowseRow {
    /** `source` is a top-level heading, `group` a subheading; neither is selectable. */
    readonly kind: "source" | "group" | "item"
    readonly label: string
    /** Its own column, not appended to the label — the row is laid out, not concatenated. */
    readonly meta?: string
    readonly description?: string
    /** The skill this row installs. Absent on a heading. */
    readonly entry?: CatalogueEntry
}

/**
 * A source's entries, filtered by its curation and grouped for display.
 *
 * Curation is applied *here* rather than in `readCatalogue`, so `sources search` keeps seeing everything.
 * A curated list is a recommendation; a search that could not find a named skill would be a restriction.
 */
export function curatedEntries(
    spec: SourceSpec,
    entries: readonly CatalogueEntry[],
): readonly CatalogueEntry[] {
    const usable = entries.filter((entry) => entry.problem === undefined)
    if (spec.curated === undefined) return usable
    const allowed = new Set(spec.curated)
    // Matched on the *folder* name, which is what a curated list is written in terms of — and which the
    // spec requires to equal the frontmatter name, so either would work today and the folder is the one
    // that stays true if upstream renames the skill inside the file.
    return usable.filter(
        (entry) => allowed.has(entry.skill) || allowed.has(basename(entry.repoPath)),
    )
}

function basename(path: string): string {
    const cut = path.lastIndexOf("/")
    return cut === -1 ? path : path.slice(cut + 1)
}

export interface BrowseInput {
    readonly spec: SourceSpec
    readonly entries: readonly CatalogueEntry[]
    /** Already installed in the target agent, shown as such rather than offered twice. */
    readonly installed?: readonly string[]
}

/**
 * Every row, in display order: one heading per source, then per curated group where the source has them.
 *
 * An installed skill is listed with a note rather than removed, because a list whose contents change
 * depending on which agent you picked is one you cannot learn.
 */
export function browseRows(inputs: readonly BrowseInput[]): readonly BrowseRow[] {
    const rows: BrowseRow[] = []
    for (const input of inputs) {
        const entries = curatedEntries(input.spec, input.entries)
        if (entries.length === 0) continue
        const installed = new Set(input.installed ?? [])

        rows.push({
            kind: "source",
            label: `${input.spec.name}  ${entries.length} skill${entries.length === 1 ? "" : "s"}`,
        })

        // Grouped where the curation defines groups, flat otherwise. `anthropics/skills` is 17 broadly
        // useful entries and inventing categories for it would be editorialising about somebody else's
        // catalogue; `awesome-copilot` is 425 and the groups are why it is legible at all.
        const grouped = new Map<string, CatalogueEntry[]>()
        const ungrouped: CatalogueEntry[] = []
        for (const entry of entries) {
            const group = input.spec.curated === undefined ? undefined : curatedGroupOf(entry.skill)
            if (group === undefined) ungrouped.push(entry)
            else {
                const bucket = grouped.get(group)
                if (bucket === undefined) grouped.set(group, [entry])
                else bucket.push(entry)
            }
        }

        for (const entry of ungrouped) rows.push(itemRow(entry, installed))
        for (const [title, bucket] of grouped) {
            rows.push({ kind: "group", label: title })
            for (const entry of bucket) rows.push(itemRow(entry, installed))
        }
    }
    return rows
}

function itemRow(entry: CatalogueEntry, installed: ReadonlySet<string>): BrowseRow {
    return {
        kind: "item",
        label: entry.skill,
        // The script count is on the row because it is the one fact that should change somebody's mind
        // before ticking a box: a skill with runnable files is code that will run on this machine.
        meta: metaOf(entry.tokens, entry.scripts.length, installed.has(entry.skill)),
        description: summarise(entry.description),
        entry,
    }
}

/**
 * First sentence, uncapped.
 *
 * The *column* decides the visible width now, in `lib/rows.ts`, so capping here as well would truncate
 * twice — once at 96 characters and again at whatever the terminal has left, which is how a wide terminal
 * ends up showing a short description with an ellipsis and empty space after it.
 */
export function summarise(description: string): string {
    const flat = description.replace(/\s+/g, " ").trim()
    const stop = flat.search(/\.\s/)
    return stop === -1 ? flat : flat.slice(0, stop + 1)
}

/** Which rows the cursor may land on, for the multi-select reducer. */
export function selectableOf(rows: readonly BrowseRow[]): readonly boolean[] {
    return rows.map((row) => row.kind === "item")
}

/** The skills behind a set of chosen row indices, in the order they appear on screen. */
export function chosenEntries(
    rows: readonly BrowseRow[],
    chosen: readonly number[],
): readonly CatalogueEntry[] {
    return chosen
        .map((index) => rows[index]?.entry)
        .filter((entry): entry is CatalogueEntry => entry !== undefined)
}

// ─── what an install did ─────────────────────────────────────────────────────────────────

/**
 * The structural half of `skills.ts`'s `InstallOutcome`.
 *
 * Declared here rather than imported so this module stays free of the command that produces it —
 * `skills.ts` reaches the filesystem, and importing it would drag that into every consumer of the row
 * layout, including the pure tests.
 */
export interface InstallOutcomeLike {
    readonly name: string
    readonly ok: boolean
    readonly reason?: string
    readonly runnable: readonly string[]
}

export interface InstallReport {
    readonly installed: readonly string[]
    readonly failed: readonly { readonly name: string; readonly reason: string }[]
    /** Runnable files across every successful install, and how many skills brought them. */
    readonly runnable: number
    readonly withCode: number
    readonly total: number
}

/**
 * One report for a batch, as data.
 *
 * Both renderings read this — the text one the pipe and `init` print, and the card the browser shows
 * inside its own frame. The alternative was each composing its own summary from the outcomes, and a
 * terminal and a pipe disagreeing about what happened is exactly the class of failure the shared
 * `browseRows` was introduced to end.
 */
export function installReport(outcomes: readonly InstallOutcomeLike[]): InstallReport {
    const ok = outcomes.filter((outcome) => outcome.ok)
    return {
        installed: ok.map((outcome) => outcome.name),
        failed: outcomes
            .filter((outcome) => !outcome.ok)
            .map((outcome) => ({ name: outcome.name, reason: outcome.reason ?? "not installed" })),
        runnable: ok.reduce((count, outcome) => count + outcome.runnable.length, 0),
        withCode: ok.filter((outcome) => outcome.runnable.length > 0).length,
        total: outcomes.length,
    }
}
