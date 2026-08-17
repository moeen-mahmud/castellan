/**
 * Laying a catalogue row out in a fixed number of columns. Pure, so the layout is testable as strings.
 *
 * ## Why this is not a component's problem
 *
 * The first version put the name, the size and the whole description in one `<Text>` and let Ink wrap.
 * Every row longer than the terminal became two or three lines, the checkbox column stopped lining up,
 * and a list of forty skills was unreadable. Wrapping is not a styling detail in a list — it destroys the
 * one property a list has, which is that a row is a row.
 *
 * So the width arithmetic lives here, in one place, as functions over numbers and strings: pad the name to
 * a column, pad the meta to a column, give the description whatever is left, and **truncate every field
 * before it can wrap**. `Text` also carries `wrap="truncate"` as a backstop, but a backstop is not a
 * layout — the columns have to add up, or the description gets cut at a width nobody chose.
 */

/** Terminal columns below which the description is dropped rather than shown as three characters. */
const NARROW = 60
/** The name column, wide enough for `create-architectural-decision-record` to be recognisable. */
const NAME_MIN = 18
const NAME_MAX = 34
/** `12.3k · 15 scripts` is the widest realistic meta string. */
const META = 18
/** Checkbox plus pointer, both two characters. */
const GUTTER = 4
const GAP = 2

/** `2284` → `2.3k`. A row is scanned, not audited, and five digits of precision cost a column. */
export function compactTokens(tokens: number): string {
    if (tokens < 1000) return String(tokens)
    const thousands = tokens / 1000
    return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`
}

export function metaOf(tokens: number, scripts: number, installed: boolean): string {
    if (installed) return "installed"
    const size = compactTokens(tokens)
    return scripts === 0 ? size : `${size} · ${scripts} script${scripts === 1 ? "" : "s"}`
}

/** Cut to `width`, with an ellipsis when anything was lost. Never returns more than `width`. */
export function clip(text: string, width: number): string {
    if (width <= 0) return ""
    const flat = text.replace(/\s+/g, " ").trim()
    if (flat.length <= width) return flat
    if (width === 1) return "…"
    return `${flat.slice(0, width - 1)}…`
}

export interface RowColumns {
    readonly name: number
    readonly meta: number
    readonly description: number
}

/**
 * How wide each column is at a given terminal width.
 *
 * The name column flexes with the longest name actually present rather than being fixed: a catalogue of
 * short names should not leave a third of the row empty, and one long name should not push the
 * description off the screen. Clamped at both ends for both reasons.
 */
export function columnsFor(
    width: number,
    longestName: number,
    options: { readonly nameMax?: number } = {},
): RowColumns {
    // Overridden by the plain path, whose names carry a `source/` prefix and which has no cursor to keep
    // near them. Passing a wider name column *without* going through this function is what pushed every
    // piped row twelve characters over the width it was laid out for.
    let name = Math.max(NAME_MIN, Math.min(options.nameMax ?? NAME_MAX, longestName))
    let meta = META

    // The name and meta columns shrink before anything else does. Without this the *fixed* part of the row
    // could exceed the terminal on its own — at 40 columns with a 34-character name it came to 60, so every
    // row wrapped no matter what the description did, which is the bug this module exists to remove.
    const chrome = GUTTER + GAP
    if (chrome + name + meta > width) meta = Math.max(6, width - chrome - name)
    if (chrome + name + meta > width) name = Math.max(6, width - chrome - meta)

    const description = width - (chrome + name + meta + GAP)
    // Below the threshold the description is dropped entirely. Three characters of a sentence is worse than
    // none: it takes the same column and carries no information.
    if (width < NARROW || description < 24) return { name, meta, description: 0 }
    return { name, meta, description }
}

/**
 * One row, exactly `width` characters wide or less, in three aligned columns.
 *
 * Returned as one string rather than as fields, because alignment is the whole point and a caller that
 * assembled the parts could get the padding wrong. Colour is applied by the component *around* this — the
 * arithmetic must not know about escape codes, which do not occupy columns and would break every count.
 */
export function layoutRow(
    input: {
        readonly name: string
        readonly meta: string
        readonly description: string
    },
    columns: RowColumns,
): { readonly name: string; readonly meta: string; readonly description: string } {
    return {
        name: clip(input.name, columns.name).padEnd(columns.name),
        meta: clip(input.meta, columns.meta).padEnd(columns.meta),
        description: columns.description === 0 ? "" : clip(input.description, columns.description),
    }
}

/** A heading, drawn as a rule so groups separate without costing a blank line each. */
export function headingRule(label: string, width: number): string {
    const text = clip(label, Math.max(0, width - 8))
    const filled = text.length + 3
    return `${text} ${"─".repeat(Math.max(0, Math.min(width, 80) - filled))}`
}
