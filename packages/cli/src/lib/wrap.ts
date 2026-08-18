/**
 * Breaking text into the rows a fixed-width window will draw.
 *
 * ## One wrapping, ours
 *
 * This module used to count rows the way a terminal does — divide the character count by the width — and
 * hand the text to Ink to wrap. Those are two different answers to one question, and the difference is not
 * academic: Ink breaks at spaces, so 240 characters at 80 columns is **four** rows to Ink and three to a
 * division. Every cap built on the division was therefore one row short of what appeared on screen, which
 * on the alternate buffer is a frame taller than the terminal.
 *
 * So the rule is that whoever owns a bounded window wraps the text itself and renders each row with
 * `wrap="truncate"`. The count is then the count, by construction, and a frame test asserts it against a
 * real render rather than trusting the arithmetic.
 *
 * Tabs are expanded to spaces on the way through. A tab's width is the terminal's business and not ours,
 * so a row containing one cannot be measured — expanding it is the only way the number we counted is the
 * number drawn. It changes bytes, never meaning, which is the line decision 4.27 draws.
 */

const TAB_WIDTH = 8
const TAB = " ".repeat(TAB_WIDTH)

/**
 * One logical line, broken at spaces to fit `columns`.
 *
 * A word longer than the whole width is cut rather than allowed to overflow — a URL or a base64 blob is
 * the normal case for that, and there is nowhere better to break it. Returns one row for an empty line,
 * because a blank line in a reply is a blank row on screen and dropping it would close up paragraphs the
 * model deliberately separated.
 */
function wrapLine(line: string, columns: number): readonly string[] {
    const flat = line.replaceAll("\t", TAB)
    if (columns <= 0 || [...flat].length <= columns) return [flat]

    // Leading whitespace is structure, and splitting on spaces destroys it.
    //
    // Found live: `/help`'s output indents each entry by two spaces, and every line short enough to fit kept
    // them while every line that wrapped lost them — so one list came out at two different indents depending
    // on how long each summary happened to be. Held aside here and re-applied to every row, which also gives
    // a wrapped indented block a hanging indent rather than a ragged left edge.
    const body = flat.trimStart()
    const indent = flat.slice(0, flat.length - body.length)
    // An indent as wide as the window is dropped rather than honoured: keeping it would leave no room for
    // the text, and shrinking the width to fit it recurses forever.
    if (indent !== "" && [...indent].length < columns) {
        return wrapLine(body, columns - [...indent].length).map((row) => `${indent}${row}`)
    }

    const rows: string[] = []
    let row: string[] = []
    for (const word of body.split(" ")) {
        const wide = [...word]
        // The word does not fit beside what is already on this row.
        if (row.length > 0 && row.length + 1 + wide.length > columns) {
            rows.push(row.join(""))
            row = []
        }
        if (wide.length > columns) {
            // Longer than any row can hold. Flush what is pending, then cut it into full rows and carry
            // the remainder, so the next word continues on the same row rather than after a gap.
            if (row.length > 0) {
                rows.push(row.join(""))
                row = []
            }
            let at = 0
            while (wide.length - at > columns) {
                rows.push(wide.slice(at, at + columns).join(""))
                at += columns
            }
            row = wide.slice(at)
            continue
        }
        if (row.length > 0) row.push(" ")
        row.push(...wide)
    }
    rows.push(row.join(""))
    return rows
}

/** Every row `text` occupies at `columns`, newlines respected and long lines broken. */
export function wrapText(text: string, columns: number): readonly string[] {
    return text.split("\n").flatMap((line) => wrapLine(line, columns))
}

/**
 * The live pane: the rows to draw, how tall that makes it, and how much was dropped.
 *
 * Height-capped on purpose. Ink erases and redraws its whole dynamic tree per frame, so an uncapped pane
 * means redrawing the entire reply on every token — a cost that grows with the length of the answer,
 * precisely when the terminal is busiest. The newest rows are the ones kept, because they are what the
 * reader is looking at, and nothing is lost: the finished reply joins the transcript at `turn.end`.
 *
 * All three numbers from one wrap, because they were computed separately and disagreed. The component
 * needs the rows and the dropped count; the chat frame needs the height to subtract from the terminal
 * *before* the pane renders. Deriving them apart meant the notice's own row was counted by one caller and
 * not the other, which is a layout one row taller than the screen.
 */
export interface LivePane {
    /** What to draw, newest last. Already wrapped, so each is one row. */
    readonly lines: readonly string[]
    /** Rows the pane occupies, the "… n hidden" notice included. Zero when there is nothing to show. */
    readonly rows: number
    /** Rows dropped off the top. Non-zero is exactly the condition for drawing the notice. */
    readonly hidden: number
}

export function livePane(text: string, columns: number, maxRows: number): LivePane {
    if (text === "" || maxRows <= 0) return { lines: [], rows: 0, hidden: 0 }
    const all = wrapText(text, columns)
    if (all.length <= maxRows) return { lines: all, rows: all.length, hidden: 0 }
    // The extra row is the notice itself.
    return {
        lines: all.slice(all.length - maxRows),
        rows: maxRows + 1,
        hidden: all.length - maxRows,
    }
}
