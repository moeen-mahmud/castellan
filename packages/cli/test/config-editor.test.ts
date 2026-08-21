/**
 * The config editor's arithmetic: which rows exist, where the cursor may land, what a field starts with.
 *
 * Pure, so the two things most likely to be wrong are data rather than a terminal session — the cursor
 * stepping over headings, and a secret never being seeded into a buffer.
 */

import { describe, expect, test } from "bun:test"
import type { Setting } from "@dispach/core"
import {
    beginEdit,
    beginWrite,
    cancelEdit,
    type EditorRow,
    firstSelectable,
    isSelectable,
    moveCursor,
    openEditor,
    refuse,
    rowKey,
    rowTarget,
    seedFor,
    settle,
} from "#lib/config-editor"

function setting(path: string): Setting {
    return { path, means: `what ${path} does`, agentListed: true }
}

const ROWS: readonly EditorRow[] = [
    { kind: "heading", label: "tools" },
    { kind: "setting", setting: setting("tools.dialect"), value: "nlt" },
    { kind: "setting", setting: setting("tools.pinned"), value: ["exec"] },
    { kind: "heading", label: "who may reach it" },
    { kind: "allow", channelId: "tg", channelType: "telegram", handles: ["@moeen_m"] },
    { kind: "heading", label: "secrets" },
    { kind: "secret", name: "MODEL_API_KEY", why: "the manifest will not load", present: false },
]

describe("rows", () => {
    test("a heading is never selectable", () => {
        expect(isSelectable(ROWS[0])).toBe(false)
        expect(isSelectable(ROWS[1])).toBe(true)
        expect(isSelectable(undefined)).toBe(false)
    })

    test("the cursor opens on the first selectable row, not on row zero", () => {
        expect(firstSelectable(ROWS)).toBe(1)
        expect(openEditor(ROWS).cursor).toBe(1)
    })

    test("every row has a distinct key and a target", () => {
        const keys = ROWS.map(rowKey)
        expect(new Set(keys).size).toBe(keys.length)
        expect(rowTarget(ROWS[4] as EditorRow)).toBe("tg.allowFrom")
        expect(rowTarget(ROWS[6] as EditorRow)).toBe("MODEL_API_KEY")
    })
})

describe("moveCursor", () => {
    test("steps over a heading in the direction it was moving", () => {
        // Down from the last setting must land on the allow row, skipping the heading between them.
        const at2 = moveCursor(openEditor(ROWS), 2)
        expect(at2.cursor).toBe(2)
        expect(moveCursor(at2, 3).cursor).toBe(4)
        // And upwards from the allow row lands back on the setting, skipping the same heading.
        expect(moveCursor(moveCursor(at2, 3), 3).cursor).toBe(2)
    })

    test("running out of list stays put rather than parking on a heading", () => {
        // A cursor on a heading draws no cursor at all, which reads as a broken keyboard rather than a
        // skipped row — so the walk reverses, and only then gives up.
        const state = openEditor(ROWS)
        expect(moveCursor(state, -1).cursor).toBe(1)
        expect(moveCursor(state, 99).cursor).toBe(6)
    })

    test("a list with nothing selectable does not hang", () => {
        // An unbounded skip walk would spin forever here.
        const headings: readonly EditorRow[] = [
            { kind: "heading", label: "a" },
            { kind: "heading", label: "b" },
        ]
        const state = openEditor(headings)
        expect(moveCursor(state, 1)).toBe(state)
    })

    test("first travels backwards and then has to search forwards", () => {
        // Row 0 is a heading, so `first` cannot simply clamp — it has to reverse and find row 1. Read
        // off the indices rather than the kind of move, which is what makes this work.
        const state = moveCursor(openEditor(ROWS), 6)
        expect(moveCursor(state, 0).cursor).toBe(1)
    })
})

describe("seedFor", () => {
    test("a setting starts with its current value, rendered as it would be typed", () => {
        expect(seedFor(ROWS[1] as EditorRow)).toBe("nlt")
        expect(seedFor(ROWS[2] as EditorRow)).toBe('["exec"]')
    })

    test("an allow row starts with the handles, space separated", () => {
        expect(seedFor(ROWS[4] as EditorRow)).toBe("@moeen_m")
    })

    test("a secret starts EMPTY, never seeded with what is there", () => {
        // The whole point of the masked field is that the value is not on screen. Pre-filling it would
        // put it in the frame in every sense that matters.
        expect(seedFor(ROWS[6] as EditorRow)).toBe("")
    })

    test("an absent setting starts empty rather than with the words '(not set)'", () => {
        expect(seedFor({ kind: "setting", setting: setting("x"), value: undefined })).toBe("")
    })
})

describe("the edit cycle", () => {
    test("enter on a row opens the buffer with the cursor at the end", () => {
        const editing = beginEdit(moveCursor(openEditor(ROWS), 1))
        expect(editing.mode).toBe("editing")
        expect(editing.editor.value).toBe("nlt")
        expect(editing.editor.cursor).toBe(3)
    })

    test("a heading cannot be edited, and neither can anything while a write is in flight", () => {
        const onHeading = { ...openEditor(ROWS), cursor: 0 }
        expect(beginEdit(onHeading)).toBe(onHeading)
        const busy = beginWrite(openEditor(ROWS))
        expect(beginEdit(busy)).toBe(busy)
    })

    test("escape leaves the field and clears the buffer", () => {
        const back = cancelEdit(beginEdit(moveCursor(openEditor(ROWS), 1)))
        expect(back.mode).toBe("browse")
        expect(back.editor.value).toBe("")
    })

    test("a settled write takes the re-read rows and reports what happened", () => {
        // Re-read rather than patched: a write may normalise a value, an allowFrom change rewrites the
        // whole channels list, and a secret changes a row without touching the manifest at all.
        const next: readonly EditorRow[] = [
            { kind: "heading", label: "tools" },
            { kind: "setting", setting: setting("tools.dialect"), value: "native" },
        ]
        const done = settle(
            beginWrite(beginEdit(openEditor(ROWS))),
            next,
            "tools.dialect is now native",
        )
        expect(done.mode).toBe("browse")
        expect(done.busy).toBe(false)
        expect(done.rows).toBe(next)
        expect(done.note).toBe("tools.dialect is now native")
        // The cursor is clamped, because the new list may be shorter.
        expect(done.cursor).toBeLessThan(next.length)
    })

    test("a refusal keeps the buffer, so the value can be corrected rather than retyped", () => {
        const editing = beginEdit(moveCursor(openEditor(ROWS), 1))
        const refused = refuse(beginWrite(editing), "that is not a dialect")
        expect(refused.mode).toBe("editing")
        expect(refused.editor.value).toBe("nlt")
        expect(refused.busy).toBe(false)
        expect(refused.note).toBe("that is not a dialect")
    })
})
