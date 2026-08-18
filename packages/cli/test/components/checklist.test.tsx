/**
 * The catalogue list, as painted.
 *
 * This is the test that did not exist when it was needed. `lib/rows.ts` was asserted as strings and
 * was correct; `CheckList` composed those strings and was correct; the rendered list still wrapped on a
 * real terminal at 40 columns, because the *fixed* part of a row — gutter, name column, meta column —
 * came to 60 on its own and no assertion looked at the finished line.
 *
 * So every case here is an assertion about the finished line.
 */

import { describe, expect, test } from "bun:test"
import { createElement as h } from "react"
import { CheckList, type CheckRow } from "#components/CheckList"
import { viewport } from "#lib/rows"
import { GLYPH } from "#lib/theme"
import { overflowing, renderFrame, width } from "../helpers/frame.tsx"

/** A name longer than the name column, so clipping and alignment are both exercised. */
const LONG_NAME = "create-architectural-decision-record"

const ROWS: readonly CheckRow[] = [
    { kind: "source", label: "anthropic  18 skills" },
    {
        kind: "item",
        label: "pdf",
        meta: "2.3k · 8 scripts",
        description:
            "Use this skill whenever the user wants to do anything with a PDF — fill forms, extract text, split or merge.",
    },
    {
        kind: "item",
        label: LONG_NAME,
        meta: "12.3k · 15 scripts",
        description: "Record an architectural decision, with its context and consequences.",
    },
    { kind: "group", label: "Communications" },
    { kind: "item", label: "meeting-minutes", meta: "installed", description: "Generate minutes." },
]

function list(columns: number, options: { index?: number; chosen?: readonly number[] } = {}) {
    return renderFrame(
        h(CheckList, {
            rows: ROWS,
            index: options.index ?? 1,
            chosen: options.chosen ?? [],
            window: 20,
            width: columns,
        }),
        { columns },
    )
}

describe("one row is one line", () => {
    for (const columns of [40, 60, 80, 100, 140]) {
        test(`nothing wraps at ${columns} columns`, () => {
            expect(overflowing(list(columns), columns)).toEqual([])
        })
    }

    test("the row count equals the line count — no row became two", () => {
        // The real symptom of the original bug: five rows painting seven or eight lines, with the
        // checkbox column no longer aligned under itself.
        expect(list(80).lines).toHaveLength(ROWS.length)
    })

    test("an over-length name at 40 columns still leaves one line", () => {
        // Named explicitly because this is the exact case that failed: at 40 columns the gutter, a
        // 34-character name column and an 18-column meta column total 60 before the description is
        // considered at all, so the name and meta have to shrink first.
        const frame = list(40)
        const row = frame.lines.find((line) => line.includes("create-arch"))
        expect(row).toBeDefined()
        expect(width(row ?? "")).toBeLessThanOrEqual(40)
    })
})

describe("the columns line up", () => {
    test("every item row starts its name at the same column", () => {
        const frame = list(100)
        const starts = frame.lines
            .filter((line) => line.includes(GLYPH.checked) || line.includes(GLYPH.unchecked))
            .map((line) => {
                const at = [...line].findIndex(
                    (char) => char === GLYPH.checked.trim() || char === GLYPH.unchecked.trim(),
                )
                return at
            })
        expect(new Set(starts).size).toBe(1)
    })

    test("the meta column is aligned across rows of different name lengths", () => {
        // `pdf` is 3 characters and `create-architectural-decision-record` is 36, so if the name
        // column were not padded these three metas would begin 33 columns apart. Asserted by looking
        // up where each meta string actually starts — the property padding exists to produce.
        const frame = list(120)
        const starts = ROWS.filter((row) => row.kind === "item").map((row) => {
            // Matched on a prefix, not the whole label: a name longer than the column is clipped, so
            // the full string is legitimately absent from the line.
            const line = frame.lines.find((candidate) => candidate.includes(row.label.slice(0, 10)))
            return line === undefined ? -1 : line.indexOf(row.meta ?? "")
        })
        expect(starts).not.toContain(-1)
        expect(new Set(starts).size).toBe(1)
    })

    test("a name longer than its column is clipped, not allowed to push the row", () => {
        // 36 characters against a 34-column maximum. The ellipsis is the visible evidence that the
        // column held rather than the row growing.
        expect([...LONG_NAME]).toHaveLength(36)
        const row = list(120).lines.find((line) => line.includes("create-arch"))
        expect(row).toContain("…")
        expect(row).not.toContain(LONG_NAME)
    })
})

describe("what the row says", () => {
    test("a ticked row shows the ticked glyph and an unticked one does not", () => {
        const ticked = list(100, { chosen: [1] })
        expect(ticked.lines[1]).toContain(GLYPH.checked.trim())
        const untouched = list(100)
        expect(untouched.lines[1]).toContain(GLYPH.unchecked.trim())
    })

    test("the cursor marks exactly one row", () => {
        const frame = list(100, { index: 2 })
        const pointed = frame.lines.filter((line) => line.includes(GLYPH.pointer.trim()))
        expect(pointed).toHaveLength(1)
        expect(pointed[0]).toContain("create-arch")
    })

    test("an installed skill says so instead of showing a size", () => {
        expect(list(100).text).toContain("installed")
    })

    test("headings are present and carry no checkbox", () => {
        const frame = list(100)
        const heading = frame.lines.find((line) => line.includes("anthropic"))
        expect(heading).toBeDefined()
        expect(heading).not.toContain(GLYPH.unchecked.trim())
    })

    test("the description is dropped rather than shown as three characters", () => {
        // Below the threshold a description takes the same column and carries no information, so it
        // is not drawn at all.
        expect(list(44).text).not.toContain("Use this skill")
        expect(list(100).text).toContain("Use this skill")
    })
})

describe("the viewport", () => {
    test("shows everything when it fits", () => {
        expect(viewport(5, 0, 20)).toEqual({ from: 0, to: 5 })
    })

    test("keeps the cursor inside the window rather than paging", () => {
        // A cursor that jumps a whole viewport loses the reader's place.
        expect(viewport(100, 50, 10)).toEqual({ from: 45, to: 55 })
    })

    test("clamps at both ends", () => {
        expect(viewport(100, 0, 10)).toEqual({ from: 0, to: 10 })
        expect(viewport(100, 99, 10)).toEqual({ from: 90, to: 100 })
    })

    test("says how many rows are out of sight in each direction", () => {
        const frame = renderFrame(
            h(CheckList, {
                rows: Array.from({ length: 40 }, (_, at) => ({
                    kind: "item" as const,
                    label: `skill-${at}`,
                    meta: "1.0k",
                    description: "a description",
                })),
                index: 20,
                chosen: [],
                window: 8,
                width: 80,
            }),
            { columns: 80 },
        )
        expect(frame.text).toContain("above")
        expect(frame.text).toContain("below")
    })
})
