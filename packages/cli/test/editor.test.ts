import { describe, expect, test } from "bun:test"
import { applyIntent, EMPTY_EDITOR, submit } from "#editor"
import { HISTORY_LIMIT } from "#lib/const"
import type { EditorState, Intent } from "#lib/types"

function typed(text: string): EditorState {
    return applyIntent(EMPTY_EDITOR, { kind: "insert", text })
}

function apply(state: EditorState, ...intents: readonly Intent[]): EditorState {
    return intents.reduce(applyIntent, state)
}

describe("insertion", () => {
    test("appends at the cursor and moves it along", () => {
        const state = typed("hello")
        expect(state.value).toBe("hello")
        expect(state.cursor).toBe(5)
    })

    test("inserts mid-line", () => {
        const state = apply(typed("held"), { kind: "cursorLeft" }, { kind: "insert", text: "l" })
        expect(state.value).toBe("helld")
        expect(state.cursor).toBe(4)
    })
})

describe("code points, not UTF-16 units", () => {
    test("one backspace removes a whole emoji", () => {
        // "👍".length is 2. A cursor counted in string indices lands inside the surrogate pair, and
        // deleting half of it leaves a replacement glyph that then gets sent to the model.
        const state = apply(typed("ok👍"), { kind: "backspace" })
        expect(state.value).toBe("ok")
    })

    test("the cursor counts characters a reader can see", () => {
        const state = typed("👍👍")
        expect(state.cursor).toBe(2)
    })

    test("arrows step over an emoji, not into it", () => {
        const state = apply(typed("a👍b"), { kind: "cursorLeft" }, { kind: "cursorLeft" })
        expect(state.cursor).toBe(1)
        expect(applyIntent(state, { kind: "insert", text: "X" }).value).toBe("aX👍b")
    })
})

describe("deletion", () => {
    test("backspace at the start of the line does nothing", () => {
        expect(apply(EMPTY_EDITOR, { kind: "backspace" })).toEqual(EMPTY_EDITOR)
    })

    test("delete at the end of the line does nothing", () => {
        const state = typed("abc")
        expect(applyIntent(state, { kind: "delete" })).toEqual(state)
    })

    test("delete removes forward without moving the cursor", () => {
        const state = apply(typed("abc"), { kind: "cursorHome" }, { kind: "delete" })
        expect(state.value).toBe("bc")
        expect(state.cursor).toBe(0)
    })

    test("kill to start and to end", () => {
        const from = apply(typed("hello world"), { kind: "cursorLeft" }, { kind: "cursorLeft" })
        expect(applyIntent(from, { kind: "killToStart" }).value).toBe("ld")
        expect(applyIntent(from, { kind: "killToEnd" }).value).toBe("hello wor")
    })

    test("kill word takes the trailing space with it, as every shell does", () => {
        expect(apply(typed("hello world "), { kind: "killWord" }).value).toBe("hello ")
        expect(apply(typed("hello world"), { kind: "killWord" }).value).toBe("hello ")
    })

    test("kill word on an empty line does nothing", () => {
        expect(apply(EMPTY_EDITOR, { kind: "killWord" })).toEqual(EMPTY_EDITOR)
    })
})

describe("cursor bounds", () => {
    test("cannot go left of the start or right of the end", () => {
        const state = typed("ab")
        const left = apply(
            state,
            { kind: "cursorLeft" },
            { kind: "cursorLeft" },
            { kind: "cursorLeft" },
        )
        expect(left.cursor).toBe(0)
        const right = apply(
            left,
            { kind: "cursorRight" },
            { kind: "cursorRight" },
            { kind: "cursorRight" },
        )
        expect(right.cursor).toBe(2)
    })

    test("home and end", () => {
        const state = typed("abcdef")
        expect(applyIntent(state, { kind: "cursorHome" }).cursor).toBe(0)
        expect(apply(state, { kind: "cursorHome" }, { kind: "cursorEnd" }).cursor).toBe(6)
    })
})

describe("history", () => {
    function withHistory(...entries: readonly string[]): EditorState {
        return entries.reduce((state, entry) => {
            return submit(applyIntent(state, { kind: "insert", text: entry })).state
        }, EMPTY_EDITOR)
    }

    test("up walks back through what was sent", () => {
        const state = apply(withHistory("first", "second"), { kind: "historyPrev" })
        expect(state.value).toBe("second")
        expect(apply(state, { kind: "historyPrev" }).value).toBe("first")
    })

    test("walking past the oldest entry stays there", () => {
        const state = apply(
            withHistory("only"),
            { kind: "historyPrev" },
            { kind: "historyPrev" },
            { kind: "historyPrev" },
        )
        expect(state.value).toBe("only")
    })

    test("the line being typed is preserved and restored", () => {
        // Browsing history must not destroy an unsent draft.
        const start = applyIntent(withHistory("old"), { kind: "insert", text: "half-typed" })
        const browsed = apply(start, { kind: "historyPrev" })
        expect(browsed.value).toBe("old")
        expect(apply(browsed, { kind: "historyNext" }).value).toBe("half-typed")
    })

    test("down at a fresh line does nothing", () => {
        const state = withHistory("old")
        expect(applyIntent(state, { kind: "historyNext" })).toEqual(state)
    })

    test("up on an empty history does nothing", () => {
        expect(applyIntent(EMPTY_EDITOR, { kind: "historyPrev" })).toEqual(EMPTY_EDITOR)
    })

    test("a recalled line lands with the cursor at the end, ready to edit", () => {
        const state = apply(withHistory("a long previous line"), { kind: "historyPrev" })
        expect(state.cursor).toBe("a long previous line".length)
    })
})

describe("submit", () => {
    test("returns the text and clears the line", () => {
        const result = submit(typed("send me"))
        expect(result.text).toBe("send me")
        expect(result.state.value).toBe("")
        expect(result.state.cursor).toBe(0)
    })

    test("trims surrounding whitespace", () => {
        expect(submit(typed("  padded  ")).text).toBe("padded")
    })

    test("an empty line submits nothing and is not recorded", () => {
        const result = submit(typed("   "))
        expect(result.text).toBe("")
        expect(result.state.history).toEqual([])
    })

    test("the same line twice is recorded once", () => {
        // Otherwise pressing Enter twice fills history with duplicates the arrows have to walk.
        const once = submit(typed("repeat")).state
        const twice = submit(applyIntent(once, { kind: "insert", text: "repeat" })).state
        expect(twice.history).toEqual(["repeat"])
    })

    test("history is capped", () => {
        let state = EMPTY_EDITOR
        for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
            state = submit(applyIntent(state, { kind: "insert", text: `line ${i}` })).state
        }
        expect(state.history).toHaveLength(HISTORY_LIMIT)
        // The cap drops the oldest, not the newest.
        expect(state.history.at(-1)).toBe(`line ${HISTORY_LIMIT + 9}`)
    })

    test("submitting resets history browsing", () => {
        const browsed = apply(submit(typed("old")).state, { kind: "historyPrev" })
        expect(browsed.historyOffset).toBe(1)
        expect(submit(browsed).state.historyOffset).toBe(0)
    })
})

test("session-level intents leave the line untouched", () => {
    const state = typed("in progress")
    for (const kind of ["submit", "cancel", "exit", "none"] as const) {
        expect(applyIntent(state, { kind })).toEqual(state)
    }
})
