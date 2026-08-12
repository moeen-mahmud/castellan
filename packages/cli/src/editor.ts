/**
 * The input line, as data. Pure — no Ink, no React, no terminal.
 *
 * Ink gives you keystrokes and nothing else: there is no text field, so cursor movement, history,
 * and word deletion are this file's job. Keeping them here rather than inside a component is what
 * makes them testable, and they are exactly the behaviours that are tedious to check by hand and
 * embarrassing when wrong.
 *
 * **Positions are code points, not UTF-16 units.** `"👍".length` is 2, so a cursor counted in string
 * indices lands *inside* the surrogate pair, and one backspace leaves half a character behind that
 * renders as a replacement glyph and gets sent to the model. Every operation here goes through an
 * array of code points for that reason.
 */

import { HISTORY_LIMIT } from "#lib/const"
import type { EditorState, Intent } from "#lib/types"

export const EMPTY_EDITOR: EditorState = {
    value: "",
    cursor: 0,
    history: [],
    historyOffset: 0,
    draft: "",
}

function chars(value: string): string[] {
    return [...value]
}

function clamp(cursor: number, length: number): number {
    return Math.max(0, Math.min(cursor, length))
}

/** Cursor to the end, which is where every whole-line replacement leaves it. */
function replaceLine(state: EditorState, value: string): EditorState {
    return { ...state, value, cursor: chars(value).length }
}

function insert(state: EditorState, text: string): EditorState {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    const next = [...current.slice(0, at), ...chars(text), ...current.slice(at)]
    return { ...state, value: next.join(""), cursor: at + chars(text).length }
}

function deleteBack(state: EditorState): EditorState {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    if (at === 0) return state
    const next = [...current.slice(0, at - 1), ...current.slice(at)]
    return { ...state, value: next.join(""), cursor: at - 1 }
}

function deleteForward(state: EditorState): EditorState {
    const current = chars(state.value)
    const at = clamp(state.cursor, current.length)
    if (at >= current.length) return state
    return { ...state, value: [...current.slice(0, at), ...current.slice(at + 1)].join("") }
}

/**
 * Delete the word before the cursor, trailing whitespace included — so Ctrl-W after "hello world "
 * removes "world " rather than only the space, which is what every shell does.
 */
function killWord(state: EditorState): EditorState {
    const current = chars(state.value)
    let at = clamp(state.cursor, current.length)
    while (at > 0 && current[at - 1] === " ") at -= 1
    while (at > 0 && current[at - 1] !== " ") at -= 1
    return {
        ...state,
        value: [...current.slice(0, at), ...current.slice(state.cursor)].join(""),
        cursor: at,
    }
}

/**
 * Walk back through history. The line being edited is saved on the first step and restored on the
 * way back down, so browsing history never destroys what you were typing.
 */
function historyPrev(state: EditorState): EditorState {
    if (state.history.length === 0) return state
    const offset = Math.min(state.historyOffset + 1, state.history.length)
    const entry = state.history[state.history.length - offset]
    if (entry === undefined) return state
    return replaceLine(
        {
            ...state,
            historyOffset: offset,
            draft: state.historyOffset === 0 ? state.value : state.draft,
        },
        entry,
    )
}

function historyNext(state: EditorState): EditorState {
    if (state.historyOffset === 0) return state
    const offset = state.historyOffset - 1
    if (offset === 0) return replaceLine({ ...state, historyOffset: 0 }, state.draft)
    const entry = state.history[state.history.length - offset]
    return entry === undefined ? state : replaceLine({ ...state, historyOffset: offset }, entry)
}

export function applyIntent(state: EditorState, intent: Intent): EditorState {
    switch (intent.kind) {
        case "insert":
            return insert(state, intent.text)
        case "backspace":
            return deleteBack(state)
        case "delete":
            return deleteForward(state)
        case "cursorLeft":
            return { ...state, cursor: clamp(state.cursor - 1, chars(state.value).length) }
        case "cursorRight":
            return { ...state, cursor: clamp(state.cursor + 1, chars(state.value).length) }
        case "cursorHome":
            return { ...state, cursor: 0 }
        case "cursorEnd":
            return { ...state, cursor: chars(state.value).length }
        case "killToStart":
            return { ...state, value: chars(state.value).slice(state.cursor).join(""), cursor: 0 }
        case "killToEnd":
            return { ...state, value: chars(state.value).slice(0, state.cursor).join("") }
        case "killWord":
            return killWord(state)
        case "historyPrev":
            return historyPrev(state)
        case "historyNext":
            return historyNext(state)
        // Submit, cancel, exit and none are the caller's business — they change the session, not
        // the line. A paste is the caller's too: it can carry several finished lines, and only the
        // caller can send them. Listed rather than defaulted so a new intent has to be considered.
        case "submit":
        case "cancel":
        case "exit":
        case "paste":
        case "none":
            return state
    }
}

/**
 * Commit the line. Returns the text to send and the state to keep.
 *
 * An empty line submits nothing, and a repeat of the previous entry is not added to history —
 * otherwise pressing Enter twice fills history with duplicates that the arrows then have to walk.
 */
export function submit(state: EditorState): { readonly text: string; readonly state: EditorState } {
    const text = state.value.trim()
    if (text === "") {
        return { text: "", state: { ...state, value: "", cursor: 0, historyOffset: 0, draft: "" } }
    }
    const last = state.history.at(-1)
    const history = last === text ? state.history : [...state.history, text].slice(-HISTORY_LIMIT)
    return {
        text,
        state: { value: "", cursor: 0, history, historyOffset: 0, draft: "" },
    }
}
