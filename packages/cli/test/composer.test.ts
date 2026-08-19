/**
 * The composer's rows, and the caret on them.
 *
 * Two properties carry the weight. **The offsets have to be honest** — a row's text is not a slice of its
 * line, because a break consumes the space and a hanging indent is re-applied to rows that never held one,
 * so the assertion is that stripping the indent gives back exactly the source characters the row claims.
 * And **the caret has to be reachable at every position**, including the end of a row that exactly fills
 * the window, which is the case the reserved column exists for.
 *
 * The defect this file exists for: nothing wrapped. Each logical line went to Ink with `wrap="truncate"`,
 * so at 100 columns a long message was cut at the border and the caret went with it — you could not see
 * what you were typing. Measured in both VS Code (cut) and Warp (the terminal wrapped the over-wide box
 * and the tail landed on the border), which is one cause with two symptoms and neither reproducible in the
 * other terminal.
 */

import { describe, expect, test } from "bun:test"
import { EMPTY_EDITOR } from "#editor"
import { composerLayout } from "#lib/composer"
import type { EditorState } from "#lib/types"
import { expandColumn, wrapRows, wrapText } from "#lib/wrap"

function editor(value: string, cursor = value.length): EditorState {
    return { ...EMPTY_EDITOR, value, cursor }
}

describe("wrapRows", () => {
    test("every row's offsets name exactly the characters it draws", () => {
        const line =
            "The quick brown fox jumps over the lazy dog and keeps on jumping well past the edge."
        for (const columns of [8, 13, 20, 40, 79]) {
            for (const row of wrapRows(line, columns)) {
                const drawn = [...row.text].slice(row.lead).join("")
                expect(drawn).toBe([...line].slice(row.from, row.to).join(""))
                expect([...row.text].length).toBeLessThanOrEqual(columns)
            }
        }
    })

    test("the rows are the same rows `wrapText` produces", () => {
        // One implementation, so the caret arithmetic and every existing caller cannot disagree.
        for (const columns of [1, 4, 12, 37, 100]) {
            for (const line of [
                "",
                "short",
                "  an indented line that has to wrap somewhere sensible",
                "aVeryLongUnbreakableTokenThatHasToBeCutBecauseThereIsNowhereBetterToBreakIt",
                "trailing spaces   ",
            ]) {
                expect(wrapRows(line, columns).map((row) => row.text)).toEqual([
                    ...wrapText(line, columns),
                ])
            }
        }
    })

    test("a break at a space is drawn by neither row", () => {
        const rows = wrapRows("alpha beta", 5)
        expect(rows.map((row) => row.text)).toEqual(["alpha", "beta"])
        expect(rows[0]?.to).toBe(5)
        // 6, not 5: the space at index 5 is the break and belongs to no row.
        expect(rows[1]?.from).toBe(6)
    })

    test("expandColumn counts a tab as the width it is drawn at", () => {
        expect(expandColumn("a\tb", 0)).toBe(0)
        expect(expandColumn("a\tb", 1)).toBe(1)
        expect(expandColumn("a\tb", 2)).toBe(9)
    })
})

describe("composerLayout", () => {
    test("an empty buffer is one row with the caret at its start", () => {
        const layout = composerLayout(editor(""), 20)
        expect(layout.rows).toHaveLength(1)
        expect(layout.caretRow).toBe(0)
        expect(layout.rows[0]?.caret).toBe(0)
    })

    test("a long line becomes several rows and only one carries the caret", () => {
        const layout = composerLayout(editor("wrap me ".repeat(10).trim()), 20)
        expect(layout.rows.length).toBeGreaterThan(1)
        expect(layout.rows.filter((row) => row.caret !== undefined)).toHaveLength(1)
        expect(layout.caretRow).toBe(layout.rows.length - 1)
    })

    test("the caret is reachable at every position in a wrapped line", () => {
        // The property that matters: no cursor offset may fall off the layout. A caret placed past the end
        // of a row is a caret drawn over the border, or not drawn at all.
        const value = "the quick brown fox jumps over the lazy dog"
        for (let at = 0; at <= [...value].length; at += 1) {
            const layout = composerLayout(editor(value, at), 12)
            const row = layout.rows[layout.caretRow]
            expect(row).toBeDefined()
            const caret = row?.caret
            expect(caret).toBeDefined()
            expect(caret ?? -1).toBeGreaterThanOrEqual(0)
            // Inside the window, including the reserved cell the caret itself may occupy.
            expect(caret ?? 0).toBeLessThanOrEqual(11)
        }
    })

    test("a caret at the end of a full row stays inside the window", () => {
        // The reason a column is reserved. Wrapping to the full width would put the caret at column
        // `columns`, one past the last cell, which the terminal wraps and the border absorbs.
        const layout = composerLayout(editor("abcdefghij"), 6)
        const row = layout.rows[layout.caretRow]
        expect((row?.caret ?? 0) < 6).toBe(true)
    })

    test("newlines are rows too, and the caret follows the line it is on", () => {
        const layout = composerLayout(editor("one\ntwo\nthree", 5), 20)
        expect(layout.rows.map((row) => row.text)).toEqual(["one", "two", "three"])
        // Offset 5 is the "w" of "two": one past "one\nt".
        expect(layout.caretRow).toBe(1)
        expect(layout.rows[1]?.caret).toBe(1)
    })

    test("a blank line keeps its row rather than closing the paragraph up", () => {
        const layout = composerLayout(editor("one\n\ntwo"), 20)
        expect(layout.rows).toHaveLength(3)
        expect(layout.rows[1]?.text).toBe("")
    })

    test("the caret is measured in code points, not UTF-16 units", () => {
        // "👍" is two units and one column. A caret counted in units lands inside the pair.
        const layout = composerLayout(editor("👍👍a", 2), 20)
        expect(layout.rows[0]?.caret).toBe(2)
    })

    test("a tab moves the caret by the width it is drawn at", () => {
        const layout = composerLayout(editor("a\tb", 2), 40)
        expect(layout.rows[0]?.caret).toBe(9)
    })

    test("a width of one still produces a layout rather than looping", () => {
        // `columns - 1` floors at 1, so the reserved cell cannot make the window zero-wide.
        const layout = composerLayout(editor("abc"), 1)
        expect(layout.rows.length).toBeGreaterThan(0)
    })
})
