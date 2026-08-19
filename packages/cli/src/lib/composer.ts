/**
 * The composer's visual rows and where the caret sits on them. Pure, so the layout is arithmetic.
 *
 * ## Why the input box needs its own wrapping at all
 *
 * It rendered each logical line with `wrap="truncate"` and no wrapping of its own, which is half of the
 * rule `lib/wrap.ts` states and the half that does not work. Ink truncates to the width Yoga measured,
 * and a `<Box>` with no explicit width takes its *content* width — so a long message made the box wider
 * than the terminal, and what happened next was the terminal's decision rather than ours. Measured at 100
 * columns: VS Code cut the line at the border and took the caret with it, so you could not see what you
 * were typing; Warp wrapped the over-wide row and the tail landed on top of the right-hand border. One
 * cause, two symptoms, and neither reproducible in the other terminal.
 *
 * So the composer wraps its own text, exactly as the transcript and the live pane do, and every row is
 * drawn `wrap="truncate"` as a backstop rather than as the layout.
 *
 * ## One column is reserved, deliberately
 *
 * The caret is drawn as an inverse cell, so it needs a cell — including when it sits at the end of a line
 * that exactly fills the row. Wrapping to `columns - 1` buys that cell once, for every row, with no
 * special case; the alternative is an extra visual row that appears and disappears as you type past the
 * edge, which moves the whole frame on a surface that has no room to move.
 *
 * ## One derivation, two callers
 *
 * `LineCursor` draws these rows and `chat-frame.promptRows` counts them. That is the pairing the repo has
 * been bitten by before — a component that grows a row without the frame arithmetic knowing is a frame
 * taller than the terminal, which on the alternate buffer is corruption rather than crowding. Here the
 * count is `layout.rows.length` plus the notices, by construction.
 */

import { lineInfo } from "#editor"
import type { EditorState } from "#lib/types"
import { expandColumn, wrapRows } from "#lib/wrap"

/** A cell reserved so the caret has somewhere to sit at the end of a full row. */
const CARET_CELL = 1

export interface ComposerRow {
    /** What is painted, hanging indent included. Never wider than the window. */
    readonly text: string
    /** Where the caret sits in this row, or `undefined` when it is on another row. */
    readonly caret: number | undefined
}

export interface ComposerLayout {
    /** Every visual row of the buffer, in order. At least one, even for an empty buffer. */
    readonly rows: readonly ComposerRow[]
    /** Index into `rows` holding the caret. */
    readonly caretRow: number
}

/**
 * Every visual row of `editor`'s buffer at `columns`, and which one the caret is on.
 *
 * `columns` is the width available *inside* whatever draws it — a caller with a border and padding
 * subtracts those first, because this cannot see them.
 */
export function composerLayout(editor: EditorState, columns: number): ComposerLayout {
    const width = Math.max(1, columns - CARET_CELL)
    const lines = editor.value.split("\n")
    const cursor = lineInfo(editor)

    const rows: ComposerRow[] = []
    let caretRow = 0
    for (const [at, line] of lines.entries()) {
        const wrapped = wrapRows(line, width)
        // The caret's column has to be translated into the same tab-expanded coordinates the rows are
        // measured in, or a line containing a tab puts it seven columns to the left of where it is.
        const column = at === cursor.line ? expandColumn(line, cursor.column) : -1
        // Walked backwards so a caret exactly on a break lands at the *end* of the earlier row rather
        // than the start of the later one, which is where a person expects it after pressing → .
        let on = -1
        if (column >= 0) {
            on = wrapped.length - 1
            for (const [n, row] of wrapped.entries()) {
                if (column <= row.to) {
                    on = n
                    break
                }
            }
        }
        for (const [n, row] of wrapped.entries()) {
            if (n === on) caretRow = rows.length
            rows.push({
                text: row.text,
                // Clamped into the row: a caret past `to` can only mean the source column sat in the
                // whitespace a break consumed, and the end of the row is the honest place for it.
                caret:
                    n === on
                        ? row.lead + Math.max(0, Math.min(column - row.from, row.to - row.from))
                        : undefined,
            })
        }
    }
    return { rows, caretRow }
}
