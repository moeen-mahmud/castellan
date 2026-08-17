/**
 * The one home for appearance: colour tokens, glyphs, and the maps components render from.
 *
 * `lib/const.ts` keeps *behavioural* numbers (row caps, history limits, control sequences); this
 * module holds everything a person would touch to change how the CLI looks. Splitting the two
 * extends the "no magic value inline" rule rather than weakening it — one home each, and a
 * component containing a literal colour name is a review failure.
 *
 * Tokens are plain Ink colour names (16-colour safe; Ink's chalk layer maps them per terminal),
 * which keeps this module PURE-listable. `NO_COLOR` needs no handling here: the mode resolution
 * forces plain output before Ink ever loads, and chalk independently honours it anyway.
 *
 * This is deliberately a single built-in token set, not a theming system — decision 11.12
 * reverses Phase 2.5's "themes" non-goal in the narrowest possible sense. User-configurable
 * themes stay a non-goal.
 */

import type { TranscriptRole, TurnStatus } from "#lib/types"

export interface Theme {
    /** The one accent, used sparingly: caret, selection cursor, user lines, banner border. */
    readonly accent: string
    /** Hints, notes, reasoning, breadcrumbs. */
    readonly muted: string
    readonly success: string
    readonly warning: string
    readonly error: string
    /** Tool rows and tool-running status. */
    readonly info: string
    /** Cancelling — the one transitional state worth its own colour. */
    readonly emphasis: string
    /** Non-focal boxes: cards, frames. */
    readonly border: string
    /** The focused box: the input line, the banner. */
    readonly borderActive: string
}

export const THEME: Theme = {
    accent: "cyan",
    muted: "gray",
    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",
    emphasis: "magenta",
    border: "gray",
    borderActive: "cyan",
}

/** Status-dot colours, previously inlined in StatusBar. */
export const STATUS_COLOR: Record<TurnStatus, string> = {
    idle: THEME.success,
    thinking: THEME.warning,
    streaming: THEME.accent,
    working: THEME.info,
    cancelling: THEME.emphasis,
}

/** Transcript role colours, previously inlined in Transcript. `undefined` = terminal default. */
export const ROLE_COLOR: Record<TranscriptRole, string | undefined> = {
    user: THEME.accent,
    assistant: undefined,
    reasoning: THEME.muted,
    note: THEME.muted,
    error: THEME.error,
    tool: THEME.info,
    banner: undefined,
}

export const ROLE_PREFIX: Record<TranscriptRole, string> = {
    user: "› ",
    assistant: "",
    reasoning: "· reasoning · ",
    note: "· ",
    error: "✖ ",
    tool: "  · ",
    banner: "",
}

/** The glyph vocabulary. Components compose these; none defines its own. */
export const GLYPH = {
    prompt: "› ",
    pointer: "❯ ",
    bullet: "· ",
    error: "✖ ",
    dot: "● ",
    check: "✓ ",
    ellipsis: "…",
    create: "+ ",
    /** Multi-select boxes. Two glyphs so a ticked row reads as ticked without colour. */
    checked: "◉ ",
    unchecked: "◯ ",
} as const

/** Braille spinner. Ten glyphs in a const, not a dependency — decision 11.10 holds. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const SPINNER_INTERVAL_MS = 80

/** cli-boxes ships inside Ink 7; rounded is the house border. Zero new dependencies. */
export const BORDER_STYLE = "round" as const
