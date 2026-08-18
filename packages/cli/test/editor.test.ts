import { describe, expect, test } from "bun:test"
import {
    applyIntent,
    continueLine,
    EMPTY_EDITOR,
    lineAt,
    lineInfo,
    searchMatches,
    searchSelection,
    submit,
    submitIntent,
} from "#editor"
import { HISTORY_LIMIT, UNDO_LIMIT } from "#lib/const"
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

// ─── stage 2: the buffer became an editor ────────────────────────────────────────────────

/** A buffer with the cursor placed by character offset, so a test reads like the screen looks. */
function at(text: string, cursor: number): EditorState {
    return { ...EMPTY_EDITOR, value: text, cursor }
}

describe("more than one line", () => {
    test("a newline goes in and the cursor follows it", () => {
        const state = apply(typed("first"), { kind: "newline" }, { kind: "insert", text: "second" })
        expect(state.value).toBe("first\nsecond")
        expect(state.cursor).toBe(12)
    })

    test("lineInfo reports where the cursor is and how many lines there are", () => {
        // "a\nbb\nccc": index 5 is the start of the third line, 6 is one character into it.
        expect(lineInfo(at("a\nbb\nccc", 5))).toEqual({ line: 2, lines: 3, column: 0 })
        expect(lineInfo(at("a\nbb\nccc", 6))).toEqual({ line: 2, lines: 3, column: 1 })
        expect(lineInfo(at("a\nbb\nccc", 3))).toEqual({ line: 1, lines: 3, column: 1 })
        expect(lineInfo(at("one line", 4))).toEqual({ line: 0, lines: 1, column: 4 })
    })

    test("lineAt finds the bounds of the line under the cursor", () => {
        expect(lineAt("a\nbb\nccc", 3)).toEqual({ start: 2, end: 4 })
        expect(lineAt("a\nbb\nccc", 0)).toEqual({ start: 0, end: 1 })
    })

    test("↑ and ↓ keep the column", () => {
        const state = at("hello\nworld", 8) // column 2 of line 1
        expect(applyIntent(state, { kind: "lineUp" }).cursor).toBe(2)
        expect(applyIntent(at("hello\nworld", 2), { kind: "lineDown" }).cursor).toBe(8)
    })

    test("a shorter target line clamps to its end rather than wrapping", () => {
        // Column 4 of "world" has nowhere to be on "ab", so it lands at the end of it.
        expect(applyIntent(at("ab\nworld", 7), { kind: "lineUp" }).cursor).toBe(2)
    })

    test("↑ on the first line and ↓ on the last do nothing", () => {
        // The keymap sends history at the edges, so if one of these arrives it means the cursor really
        // has nowhere to go and moving to the buffer's end would be a surprise.
        expect(applyIntent(at("a\nb", 0), { kind: "lineUp" }).cursor).toBe(0)
        expect(applyIntent(at("a\nb", 3), { kind: "lineDown" }).cursor).toBe(3)
    })

    test("^A and ^E act on the line, not the whole buffer", () => {
        const state = at("first\nsecond\nthird", 15)
        expect(applyIntent(state, { kind: "cursorHome" }).cursor).toBe(13)
        expect(applyIntent(state, { kind: "cursorEnd" }).cursor).toBe(18)
    })

    test("^U and ^K cut within the line and leave the rest of the message", () => {
        expect(applyIntent(at("first\nsecond", 9), { kind: "killToStart" }).value).toBe(
            "first\nond",
        )
        expect(applyIntent(at("first\nsecond", 9), { kind: "killToEnd" }).value).toBe("first\nsec")
    })

    test("a multi-line message is sent whole", () => {
        const { text } = submit(at("one\ntwo\nthree", 13))
        expect(text).toBe("one\ntwo\nthree")
    })
})

describe("word motion", () => {
    test("⌥← goes to the start of the word behind, skipping the space first", () => {
        expect(applyIntent(at("hello world", 11), { kind: "wordLeft" }).cursor).toBe(6)
        expect(applyIntent(at("hello world ", 12), { kind: "wordLeft" }).cursor).toBe(6)
    })

    test("⌥→ goes to the end of the word ahead", () => {
        expect(applyIntent(at("hello world", 0), { kind: "wordRight" }).cursor).toBe(5)
        expect(applyIntent(at("hello world", 5), { kind: "wordRight" }).cursor).toBe(11)
    })

    test("word motion crosses a line break", () => {
        // Stopping at the boundary was the other option and reads as a dead key: ⌥← at the start of a
        // line would silently do nothing.
        expect(applyIntent(at("first\nsecond", 6), { kind: "wordLeft" }).cursor).toBe(0)
        expect(applyIntent(at("first\nsecond", 5), { kind: "wordRight" }).cursor).toBe(12)
    })

    test("⌥d deletes the word ahead, ⌥⌫ the one behind", () => {
        expect(applyIntent(at("hello world", 6), { kind: "killWordForward" }).value).toBe("hello ")
        expect(applyIntent(at("hello world", 11), { kind: "killWord" }).value).toBe("hello ")
    })

    test("at either end, deleting a word is a no-op rather than an error", () => {
        expect(applyIntent(at("word", 0), { kind: "killWord" }).value).toBe("word")
        expect(applyIntent(at("word", 4), { kind: "killWordForward" }).value).toBe("word")
    })

    test("an emoji is one step, so word motion never splits a surrogate pair", () => {
        const state = at("hi 👍 there", 10)
        const moved = applyIntent(state, { kind: "wordLeft" })
        expect([...state.value].length).toBe(10)
        expect(moved.value).toBe(state.value)
        expect(moved.cursor).toBe(5)
    })
})

describe("undo and redo", () => {
    test("a run of typing is one step, not one per keystroke", () => {
        // Undo that takes back one character at a time is undo nobody uses.
        let state = EMPTY_EDITOR
        for (const char of "hello") state = applyIntent(state, { kind: "insert", text: char })
        expect(state.value).toBe("hello")
        expect(applyIntent(state, { kind: "undo" }).value).toBe("")
    })

    test("a deletion opens a new step", () => {
        const typedIn = apply(typed("hello"), { kind: "backspace" })
        expect(typedIn.value).toBe("hell")
        expect(applyIntent(typedIn, { kind: "undo" }).value).toBe("hello")
    })

    test("redo puts back what undo took", () => {
        const state = apply(typed("hello"), { kind: "backspace" })
        const undone = applyIntent(state, { kind: "undo" })
        expect(applyIntent(undone, { kind: "redo" }).value).toBe("hell")
    })

    test("a fresh edit clears the redo stack", () => {
        // Redoing into text that no longer follows from what is on screen would be a lie about the
        // buffer's history.
        const undone = applyIntent(apply(typed("hello"), { kind: "backspace" }), { kind: "undo" })
        const edited = applyIntent(undone, { kind: "insert", text: "!" })
        expect(applyIntent(edited, { kind: "redo" }).value).toBe(edited.value)
    })

    test("undo restores the cursor as well as the text", () => {
        // Without the cursor, undo puts the caret nowhere in particular.
        const state = apply(at("hello world", 11), { kind: "killWord" })
        expect(state.cursor).toBe(6)
        expect(applyIntent(state, { kind: "undo" })).toMatchObject({
            value: "hello world",
            cursor: 11,
        })
    })

    test("undo with nothing to undo is a no-op", () => {
        expect(applyIntent(EMPTY_EDITOR, { kind: "undo" })).toEqual(EMPTY_EDITOR)
        expect(applyIntent(EMPTY_EDITOR, { kind: "redo" })).toEqual(EMPTY_EDITOR)
    })

    test("the stack is bounded", () => {
        // A snapshot holds a whole copy of the text, so an unbounded stack keeps every intermediate
        // version of a pasted document alive for the life of the process.
        let state = EMPTY_EDITOR
        for (let step = 0; step < UNDO_LIMIT + 50; step += 1) {
            state = apply(state, { kind: "insert", text: "x" }, { kind: "backspace" })
        }
        expect(state.past.length).toBeLessThanOrEqual(UNDO_LIMIT)
    })

    test("sending clears the undo stack", () => {
        // It describes a message that is now in the transcript.
        const { state } = submit(typed("hello"))
        expect(state.past).toEqual([])
        expect(state.future).toEqual([])
    })

    test("recalling history is undoable", () => {
        const withHistory = { ...typed("draft"), history: ["an older message"] }
        const recalled = applyIntent(withHistory, { kind: "historyPrev" })
        expect(recalled.value).toBe("an older message")
        expect(applyIntent(recalled, { kind: "undo" }).value).toBe("draft")
    })
})

describe("enter, or a continuation", () => {
    test("a trailing backslash continues the line", () => {
        expect(submitIntent(at("first line \\", 12))).toBe("newline")
        expect(continueLine(at("first line \\", 12)).value).toBe("first line \n")
    })

    test("an escaped backslash sends", () => {
        // Counted rather than tested for one character, so `a\\` is text and not an unsendable message.
        expect(submitIntent(at("a path C:\\\\", 11))).toBe("send")
    })

    test("a backslash anywhere but the end is ordinary text", () => {
        expect(submitIntent(at("C:\\Users and more", 17))).toBe("send")
    })

    test("only at the end of the buffer, not merely at the end of a line", () => {
        // Mid-message the cursor is not where a continuation would go.
        expect(submitIntent(at("first \\\nsecond", 6))).toBe("send")
    })
})

describe("reverse history search", () => {
    const HISTORY = [
        "what tools do you have",
        "why does the outbox double-send on a crash",
        "fix the loader so it reads the manifest first",
        "what tools do you have",
    ]
    const searching = (query: string): EditorState => {
        const opened = applyIntent(
            { ...EMPTY_EDITOR, value: "half a draft", cursor: 12, history: HISTORY },
            { kind: "searchOpen" },
        )
        return [...query].reduce(
            (state, char) => applyIntent(state, { kind: "insert", text: char }),
            opened,
        )
    }

    test("typing extends the query and leaves the message alone", () => {
        const state = searching("outbox")
        expect(state.search?.query).toBe("outbox")
        expect(state.value).toBe("half a draft")
    })

    test("matches are newest first, deduplicated", () => {
        // The same question asked twice should not take two presses of ↓ to walk past.
        expect(searchMatches(searching("tools"))).toEqual(["what tools do you have"])
    })

    test("the match is a substring, case-insensitively", () => {
        // A message is prose: remembering a word in the middle is much easier than the first one.
        expect(searchSelection(searching("OUTBOX"))).toBe(
            "why does the outbox double-send on a crash",
        )
    })

    test("an empty query lists everything", () => {
        expect(searchMatches(searching("")).length).toBe(3)
    })

    test("the arrows walk the matches and clamp at the ends", () => {
        const state = searching("")
        const down = applyIntent(applyIntent(state, { kind: "historyPrev" }), {
            kind: "historyPrev",
        })
        expect(down.search?.index).toBe(2)
        const clamped = applyIntent(down, { kind: "historyPrev" })
        expect(clamped.search?.index).toBe(2)
        expect(applyIntent(state, { kind: "historyNext" }).search?.index).toBe(0)
    })

    test("a further keystroke resets the position", () => {
        // The match list has changed underneath the index, so keeping it would silently highlight a
        // different entry than the one on screen.
        const moved = applyIntent(searching("what"), { kind: "historyPrev" })
        expect(applyIntent(moved, { kind: "insert", text: " " }).search?.index).toBe(0)
    })

    test("accepting puts the match on the line and closes", () => {
        const state = applyIntent(searching("outbox"), { kind: "searchAccept" })
        expect(state.value).toBe("why does the outbox double-send on a crash")
        expect(state.search).toBeUndefined()
        // And is undoable, because it replaced a draft.
        expect(applyIntent(state, { kind: "undo" }).value).toBe("half a draft")
    })

    test("cancelling leaves the message exactly as it was", () => {
        const state = applyIntent(searching("outbox"), { kind: "searchCancel" })
        expect(state.value).toBe("half a draft")
        expect(state.cursor).toBe(12)
        expect(state.search).toBeUndefined()
    })

    test("accepting with no match closes without touching the line", () => {
        const state = applyIntent(searching("zzzz"), { kind: "searchAccept" })
        expect(state.value).toBe("half a draft")
        expect(state.search).toBeUndefined()
    })

    test("backspace shortens the query rather than the message", () => {
        const state = applyIntent(searching("outbox"), { kind: "backspace" })
        expect(state.search?.query).toBe("outbo")
        expect(state.value).toBe("half a draft")
    })

    test("any other key closes the search and is not applied to the line", () => {
        // A ^K pressed to dismiss the search must not also truncate the message behind it.
        const state = applyIntent(searching("outbox"), { kind: "killToEnd" })
        expect(state.search).toBeUndefined()
        expect(state.value).toBe("half a draft")
    })
})
