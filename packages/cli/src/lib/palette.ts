/**
 * The slash-command palette: what a partially typed `/word` could mean.
 *
 * ## Generated, not listed
 *
 * The entries come from two tables that already exist. `SESSION_COMMANDS` holds the verbs that only make
 * sense inside a session — `/help`, `/reset`, `/exit` — and `COMMANDS` holds the whole CLI, with every
 * flag, every `choices` value and every summary already written down for `--help`.
 *
 * Reading `COMMANDS` rather than a second list is the load-bearing decision. A flag added to the CLI
 * appears in the TUI with nothing to remember, which is the discipline `session-commands.ts`'s own header
 * argues for after watching `/help` drift in both directions when it was a string in a component. A
 * command that should not be offered in a session declares `inSession: "hidden"` — hiding by omission
 * from a hand-written list is the same drift wearing a different hat, and a required field means a new
 * command cannot be silently absent instead.
 *
 * ## Pure
 *
 * Derived from the editor's value, so the only state the renderer adds is a cursor index. No filesystem,
 * no process, no renderer — PURE-listed, and the matching rules are asserted as data.
 */

import { COMMANDS } from "#lib/commands"
import type { CommandSpec } from "#lib/schema"
import { SESSION_COMMANDS } from "#lib/session-commands"

export interface PaletteEntry {
    /** With the slash, as it would be typed. */
    readonly word: string
    readonly summary: string
    /**
     * `session` — dispatched by `resolveSessionCommand`.
     * `view` — a bespoke screen.
     * `output` — run the command and show what it printed.
     */
    readonly kind: "session" | "view" | "output"
    /** Present for a CLI command, so a host can read its flags and actions. */
    readonly spec?: CommandSpec
}

/**
 * Every entry a session offers, session verbs first.
 *
 * Session verbs lead because they are the ones with no shell equivalent and the ones typed most: `/help`
 * and `/exit` at the top of an unfiltered list is what makes the palette answer "what can I do here"
 * rather than "what commands exist".
 */
export function paletteEntries(): readonly PaletteEntry[] {
    const session: PaletteEntry[] = SESSION_COMMANDS.map((spec) => ({
        word: spec.word,
        summary: spec.summary,
        kind: "session" as const,
    }))
    const own = new Set(session.map((entry) => entry.word))
    const commands: PaletteEntry[] = COMMANDS.filter((spec) => spec.inSession !== "hidden")
        // A CLI command whose name collides with a session verb loses: `/tools` inside a session means
        // the running agent's catalogue, not a fresh load of the manifest from disk.
        .filter((spec) => !own.has(`/${spec.name}`))
        .map((spec) => ({
            word: `/${spec.name}`,
            summary: spec.summary,
            kind: spec.inSession === "view" ? ("view" as const) : ("output" as const),
            spec,
        }))
    return [...session, ...commands]
}

export interface Palette {
    /** What has been typed after the slash, lowercased. */
    readonly query: string
    readonly matches: readonly PaletteEntry[]
}

/**
 * The palette for a buffer, or `undefined` when the buffer is not a slash command being typed.
 *
 * Open only while the *whole* buffer is one `/word` under construction. Two consequences, both
 * deliberate: a message that merely mentions a path never opens it, and once arguments are being typed
 * the list closes, because there is nothing left to complete and a list covering the line would hide
 * what is being written.
 */
export function paletteFor(
    value: string,
    entries: readonly PaletteEntry[] = paletteEntries(),
): Palette | undefined {
    if (!/^\/[A-Za-z-]*$/.test(value)) return undefined
    const query = value.slice(1).toLowerCase()
    const matches = entries.filter((entry) => entry.word.slice(1).toLowerCase().startsWith(query))
    // Prefix, not fuzzy. A palette that offers `/sessions` for `/st` reads as noise, and the words are
    // short enough that a prefix always reaches them in two or three characters.
    return { query, matches }
}

/** The entry a cursor is on, clamped, or `undefined` when nothing matches. */
export function paletteSelection(palette: Palette, index: number): PaletteEntry | undefined {
    if (palette.matches.length === 0) return undefined
    return palette.matches[Math.max(0, Math.min(index, palette.matches.length - 1))]
}
