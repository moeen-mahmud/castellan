/**
 * Domain shapes.
 *
 * The split follows termheat's rule: `types.ts` owns the shapes the CLI reasons *about*, and the
 * modules beside it own the logic. `schema.ts` owns the contracts between modules — parser output,
 * command options, component props.
 */

/**
 * How output is rendered.
 *
 * - `json`  — one machine-readable document on stdout and nothing else.
 * - `plain` — line-oriented text, no ANSI, no cursor movement. Safe to pipe, log, or diff.
 * - `rich`  — the Ink app: live transcript, status bar, input line.
 */
export type RenderMode = "json" | "plain" | "rich"

/** What the environment says about how much rendering is welcome. */
export interface EnvFacts {
    readonly noColor: boolean
    readonly dumbTerminal: boolean
    readonly ci: boolean
    readonly debug: boolean
}

// ─── transcript ──────────────────────────────────────────────────────────────────────────

export type TranscriptRole = "user" | "assistant" | "reasoning" | "note" | "error"

/**
 * A finished line of conversation.
 *
 * Immutable once created, which is not a style preference: finished items render inside Ink's
 * `<Static>`, which writes a node to the terminal once and never touches it again. Mutating one
 * would change a value the renderer will never look at, so the change would silently not appear.
 */
export interface TranscriptItem {
    /** Stable and unique. `<Static>` keys off it, and a reused key drops a line. */
    readonly id: string
    readonly role: TranscriptRole
    readonly text: string
    /** Present on a completed assistant reply. */
    readonly stats?: TurnStats
}

export interface TurnStats {
    readonly promptTokens: number
    readonly outputTokens: number
    readonly durationMs: number
    readonly steps: number
    /** `final` is the only clean ending. The rest are reported as themselves, never as success. */
    readonly reason: string
}

/** The turn in flight. Everything here is still moving, so none of it belongs in `<Static>`. */
export interface LiveTurn {
    readonly text: string
    readonly reasoning: string
    /** Which stream produced the most recent delta, so a view can label a switch. */
    readonly last: "text" | "reasoning" | undefined
}

export type TurnStatus = "idle" | "thinking" | "streaming" | "cancelling"

export interface TranscriptState {
    /** Append-only. Never reordered, never edited. */
    readonly items: readonly TranscriptItem[]
    readonly live: LiveTurn | undefined
    readonly status: TurnStatus
    /** Monotonic id source. Kept in state so the reducer needs no clock and no randomness. */
    readonly nextId: number
}

// ─── input ───────────────────────────────────────────────────────────────────────────────

/**
 * The subset of Ink's `Key` this CLI acts on.
 *
 * Declared here rather than imported from Ink so that `keymap.ts` and `editor.ts` stay free of the
 * rich-path dependency — they are the two modules most worth unit-testing, and importing Ink would
 * cost every plain-path invocation ~170 ms under Node. Ink's own `Key` satisfies this structurally.
 */
export interface KeyState {
    readonly upArrow: boolean
    readonly downArrow: boolean
    readonly leftArrow: boolean
    readonly rightArrow: boolean
    readonly return: boolean
    readonly escape: boolean
    readonly ctrl: boolean
    readonly shift: boolean
    readonly tab: boolean
    readonly backspace: boolean
    readonly delete: boolean
    readonly meta: boolean
}

export type Intent =
    | { readonly kind: "submit" }
    /** Ctrl-C while a turn is running: cancel the turn, keep the process. */
    | { readonly kind: "cancel" }
    /** Ctrl-C at an idle prompt, or Ctrl-D. */
    | { readonly kind: "exit" }
    | { readonly kind: "insert"; readonly text: string }
    /**
     * Text arriving as one chunk with newlines in it — a paste, or a here-doc fed to the process.
     *
     * It cannot be an `insert`: the newlines are control characters, and stripping them silently
     * runs the words together. It cannot be a `submit` either, because one chunk can carry several
     * finished lines. So the segments travel intact and the caller decides: every finished line is
     * submitted in order, and an unterminated tail stays on the input line.
     */
    | { readonly kind: "paste"; readonly lines: readonly string[]; readonly complete: boolean }
    | { readonly kind: "backspace" }
    | { readonly kind: "delete" }
    | { readonly kind: "cursorLeft" }
    | { readonly kind: "cursorRight" }
    | { readonly kind: "cursorHome" }
    | { readonly kind: "cursorEnd" }
    | { readonly kind: "historyPrev" }
    | { readonly kind: "historyNext" }
    | { readonly kind: "killToStart" }
    | { readonly kind: "killToEnd" }
    | { readonly kind: "killWord" }
    | { readonly kind: "none" }

export interface EditorState {
    readonly value: string
    /** Index into `value`, 0..value.length. */
    readonly cursor: number
    /** Newest last. Submitting appends; the arrows walk it. */
    readonly history: readonly string[]
    /** How far back the arrows have walked. 0 = editing a fresh line. */
    readonly historyOffset: number
    /** The line being edited when history browsing started, restored on the way back down. */
    readonly draft: string
}
