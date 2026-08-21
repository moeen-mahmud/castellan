/**
 * The config editor as a pure reducer: what the rows are, where the cursor is, what is being typed.
 *
 * Same grain as `lib/wizard.ts` and `lib/select.ts` — the screen root owns one `useInput` and the
 * arithmetic lives here, so navigating a list and rejecting a bad handle are assertable as data rather
 * than by driving a terminal.
 *
 * ## Why a row is not just a setting
 *
 * The catalogue in core answers "what fields exist". An editor has to answer "what can I change from
 * here", and three of those are not dotted paths:
 *
 * - **A secret.** `.env` is a protected path precisely so the agent cannot write it, which leaves the
 *   person as the only actor who can — and the editor is where they are. Masked as it is typed.
 * - **`allowFrom`, once per channel.** It lives inside a list entry, so `channels[].allowFrom` is one
 *   catalogue row and *n* editable ones. Expanded here, keyed by the channel's declared id.
 * - **A heading.** Unselectable, and the cursor must step over it in the direction it was moving —
 *   parking on one draws no cursor at all, which reads as a broken keyboard rather than a skipped row.
 *
 * ## Why every confirmed edit is written immediately
 *
 * There is no staged set and no unsaved state. Each confirmation goes through the same `editManifest`
 * call `config set` makes, so every state the file is ever in is valid, a closed pane cannot discard
 * work, and two edits that are individually fine cannot combine into an invalid document nobody
 * reviewed. The cost is stated rather than hidden: there is no cancel-all, and undo is `config set`
 * with the old value, which the row still shows until the write lands.
 */

import type { Setting } from "@dispach/core"
import { EMPTY_EDITOR } from "#editor"
import type { EditorState } from "#lib/types"

/** One line of the editor. Only three kinds are selectable. */
export type EditorRow =
    /** A dotted path, edited as the text that would appear in the file. */
    | { readonly kind: "setting"; readonly setting: Setting; readonly value: unknown }
    /** One channel's inbound allowlist, edited as space-separated handles. */
    | {
          readonly kind: "allow"
          readonly channelId: string
          readonly channelType: string
          readonly handles: readonly string[]
      }
    /** An env variable the manifest depends on. Never displays its value, only whether it is set. */
    | {
          readonly kind: "secret"
          readonly name: string
          readonly why: string
          readonly present: boolean
      }
    /** A group label. Never selectable. */
    | { readonly kind: "heading"; readonly label: string }

export interface ConfigEditorState {
    readonly rows: readonly EditorRow[]
    readonly cursor: number
    readonly mode: "browse" | "editing"
    /** The buffer while editing. Empty and unused while browsing. */
    readonly editor: EditorState
    /**
     * The result of the last write, or why one was refused. Cleared as soon as anything is typed.
     *
     * `| undefined` rather than merely optional: under `exactOptionalPropertyTypes` an omitted key and an
     * explicit `undefined` are different types, and this one is *cleared* far more often than it is left
     * out — a spread that had to omit the key to reset it would be unreadable.
     */
    readonly note?: string | undefined
    /** Set while a write is in flight, so the row cannot be confirmed twice. */
    readonly busy: boolean
}

export function isSelectable(row: EditorRow | undefined): boolean {
    return row !== undefined && row.kind !== "heading"
}

/** A stable identity for a row, for React keys and for tests. */
export function rowKey(row: EditorRow): string {
    switch (row.kind) {
        case "setting":
            return `setting:${row.setting.path}`
        case "allow":
            return `allow:${row.channelId}`
        case "secret":
            return `secret:${row.name}`
        case "heading":
            return `heading:${row.label}`
    }
}

/** The path or name a row writes to, for a caller reporting what happened. */
export function rowTarget(row: EditorRow): string {
    switch (row.kind) {
        case "setting":
            return row.setting.path
        case "allow":
            return `${row.channelId}.allowFrom`
        case "secret":
            return row.name
        case "heading":
            return row.label
    }
}

export function firstSelectable(rows: readonly EditorRow[]): number {
    const at = rows.findIndex((row) => isSelectable(row))
    return at === -1 ? 0 : at
}

export function openEditor(rows: readonly EditorRow[]): ConfigEditorState {
    return {
        rows,
        cursor: firstSelectable(rows),
        mode: "browse",
        editor: EMPTY_EDITOR,
        busy: false,
    }
}

/**
 * Move the cursor, stepping over headings in the direction of travel.
 *
 * Walk that way, then reverse, then stay put — and read the direction off the *indices* rather than the
 * kind of move, because `first` travels backwards to row 0 and must then search forwards. A cursor that
 * runs out of list stays where it is; it never lands on a row where enter does nothing.
 */
export function moveCursor(state: ConfigEditorState, to: number): ConfigEditorState {
    const total = state.rows.length
    if (total === 0) return state
    const clamped = Math.max(0, Math.min(total - 1, to))
    const forwards = clamped >= state.cursor
    const step = forwards ? 1 : -1

    for (let at = clamped; at >= 0 && at < total; at += step) {
        if (isSelectable(state.rows[at])) return { ...state, cursor: at }
    }
    // Nothing that way. Try the other, which is what makes the ends of the list behave.
    for (let at = clamped; at >= 0 && at < total; at -= step) {
        if (isSelectable(state.rows[at])) return { ...state, cursor: at }
    }
    return state
}

/** The row the cursor is on, or `undefined` for an empty list. */
export function current(state: ConfigEditorState): EditorRow | undefined {
    return state.rows[state.cursor]
}

/**
 * What a row's value looks like in the buffer when editing starts.
 *
 * A secret starts **empty**, never seeded with what is there: the point of the masked field is that the
 * value is not on screen, and pre-filling it would put it in the frame in every sense that matters.
 */
export function seedFor(row: EditorRow): string {
    switch (row.kind) {
        case "setting":
            return row.value === undefined || row.value === null
                ? ""
                : typeof row.value === "string"
                  ? row.value
                  : JSON.stringify(row.value)
        case "allow":
            return row.handles.join(" ")
        case "secret":
        case "heading":
            return ""
    }
}

export function beginEdit(state: ConfigEditorState): ConfigEditorState {
    const row = current(state)
    if (row === undefined || !isSelectable(row) || state.busy) return state
    const seed = seedFor(row)
    return {
        ...state,
        mode: "editing",
        editor: { ...EMPTY_EDITOR, value: seed, cursor: [...seed].length },
        note: undefined,
    }
}

export function cancelEdit(state: ConfigEditorState): ConfigEditorState {
    if (state.mode !== "editing") return state
    return { ...state, mode: "browse", editor: EMPTY_EDITOR, note: undefined }
}

/** Replace the buffer, which is what the host does after applying a keystroke to it. */
export function typing(state: ConfigEditorState, editor: EditorState): ConfigEditorState {
    // The note describes the previous write, so the first keystroke of the next edit retires it.
    return { ...state, editor, note: undefined }
}

export function beginWrite(state: ConfigEditorState): ConfigEditorState {
    return { ...state, busy: true }
}

/**
 * A write finished. `rows` is re-read from the file rather than patched in place.
 *
 * Patching would drift: `editManifest` validates and may normalise, an `allowFrom` write rewrites the
 * whole `channels` list, and a secret changes a row's `present` without touching the manifest at all.
 * Re-reading is one source of truth and costs a file read nobody notices.
 */
export function settle(
    state: ConfigEditorState,
    rows: readonly EditorRow[],
    note: string,
): ConfigEditorState {
    return {
        ...state,
        rows,
        cursor: Math.min(state.cursor, Math.max(0, rows.length - 1)),
        mode: "browse",
        editor: EMPTY_EDITOR,
        busy: false,
        note,
    }
}

/** A write was refused. The buffer stays, so the value can be corrected rather than retyped. */
export function refuse(state: ConfigEditorState, note: string): ConfigEditorState {
    return { ...state, busy: false, note }
}
