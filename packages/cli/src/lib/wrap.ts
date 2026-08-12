/**
 * Counting terminal rows, which is not the same as counting lines.
 *
 * The live pane is capped at a fixed number of rows because Ink erases and redraws its whole dynamic
 * tree on every frame: an uncapped pane means redrawing the entire reply on every token. But the cap
 * has to be measured in *rows the terminal will use*, not lines in the string — one 400-character
 * paragraph in an 80-column terminal is five rows, and treating it as one would let the pane grow
 * without limit exactly when it matters.
 */

const TAB_WIDTH = 8

/** How many rows a single logical line occupies once the terminal wraps it. */
export function visualRows(line: string, columns: number): number {
    if (columns <= 0) return 1
    // Code points, not UTF-16 units: an emoji is one column-ish, not two.
    const width = [...line].reduce((sum, char) => sum + (char === "\t" ? TAB_WIDTH : 1), 0)
    return width === 0 ? 1 : Math.ceil(width / columns)
}

export function totalRows(text: string, columns: number): number {
    return text.split("\n").reduce((sum, line) => sum + visualRows(line, columns), 0)
}

/**
 * The last `maxRows` rows of `text`, whole lines only.
 *
 * Cuts at line boundaries rather than mid-line: a half-line at the top of the pane reads as
 * corruption, whereas a missing line reads as scrolling — which is what it is. Returns the text
 * unchanged when it already fits, so the common case allocates nothing extra.
 */
export function tailRows(text: string, columns: number, maxRows: number): string {
    if (maxRows <= 0) return ""
    if (totalRows(text, columns) <= maxRows) return text

    const lines = text.split("\n")
    const kept: string[] = []
    let rows = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i] ?? ""
        const cost = visualRows(line, columns)
        if (rows + cost > maxRows) break
        kept.unshift(line)
        rows += cost
    }

    // A single line longer than the whole budget would otherwise leave the pane empty, which looks
    // like a hang. Show its tail instead: the newest text is the part being generated.
    if (kept.length === 0) {
        const last = lines.at(-1) ?? ""
        return [...last].slice(-(columns * maxRows)).join("")
    }
    return kept.join("\n")
}
