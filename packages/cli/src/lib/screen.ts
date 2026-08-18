/**
 * What every screen has in common, as data: the header block and the footer's key hints.
 *
 * ## Why this is a module and not a component
 *
 * Three surfaces had a banner before this existed — chat, the wizard, the agent picker — and each
 * decided its own title, its own context lines and its own key hints, in JSX. So the *content* of a
 * header was only observable by mounting a renderer, and the one thing worth asserting about it is
 * exactly that content: whether the agent in scope is named, whether a session-wide warning is still
 * visible after the screen scrolls, whether the footer fits.
 *
 * Everything here is text in, text out. `Screen.tsx` is one consumer; a test asserting a header names
 * the right agent is another, and neither can drift from the other because there is one derivation.
 *
 * ## The rule the header exists to enforce
 *
 * CLAUDE.md: anything true for the whole session belongs where a person still sees it after
 * scrolling. On an inline surface that could be a line printed at the top; on the alternate screen
 * there *is* no scrolling past, so it has to be the header or nowhere. `warnings` is therefore part
 * of the header's shape rather than something each screen remembers to render.
 *
 * Colour is not decided here, for `render.ts`'s reason: this module has no idea whether it is being
 * read from a terminal or a log file, and that is `resolveMode`'s question.
 */

import {
    MAX_SCREEN_COLUMNS,
    MAX_SCREEN_ROWS,
    MIN_SCREEN_COLUMNS,
    MIN_SCREEN_ROWS,
    SCREEN_CHROME_ROWS,
} from "#lib/const"
import { clip } from "#lib/rows"

/**
 * A live fact about the runtime, shown as a word rather than a sentence.
 *
 * `tone` is a role, never a colour — the component maps it. A literal colour name here would put
 * appearance in a pure module and break the one-home rule `theme.ts` exists for.
 */
export interface StateChip {
    readonly label: string
    readonly tone: "ok" | "warn" | "off"
}

export interface ScreenHeader {
    /** Product identity — `BRAND.name` and the version. The one line that is the same everywhere. */
    readonly title: string
    /** What this screen is, and the counts that make it worth looking at. */
    readonly summary: string
    /**
     * The agent this screen acts on, when it acts on one.
     *
     * Present so it is impossible to install a skill into, or stop, an agent you did not mean.
     * Absent — not blank — on the machine-level screens: `sources` is a registry shared by every
     * agent on the machine, and naming one there would be a lie about the scope of what you are
     * changing.
     */
    readonly agent?: { readonly name: string; readonly model: string }
    readonly state?: readonly StateChip[]
    /** True for the whole session, so it stays in the frame rather than scrolling away. */
    readonly warnings?: readonly string[]
}

export interface KeyHint {
    /** As a reader sees it: `↑↓`, `enter`, `^C`, `⌥⏎`. */
    readonly key: string
    readonly does: string
}

const SEPARATOR = " · "
/** Warnings past this many are counted rather than listed — a header is not a log. */
const WARNINGS_SHOWN = 3

/**
 * One rendered line, tagged with what it is.
 *
 * Tagged rather than returned as plain strings because the component styles each kind differently and
 * the alternative is worse in both directions: a flat list of strings forces the renderer to guess by
 * index (which broke the first time a header had no state row), and having the renderer rebuild the
 * summary from `header.agent` itself would be a second derivation of the one thing this module exists
 * to derive once. The kind travels with the text; appearance stays in `theme.ts`.
 */
export interface HeaderLine {
    readonly kind: "title" | "summary" | "state" | "warning"
    readonly text: string
}

/** The header, as tagged lines, each already clipped to the width. */
export function headerLines(header: ScreenHeader, width: number): readonly HeaderLine[] {
    const lines: HeaderLine[] = [{ kind: "title", text: clip(header.title, width) }]

    // The agent rides on the summary line rather than taking one of its own. It is the same fact —
    // "what am I looking at, and whose" — and a separate line for it pushes the body down on every
    // screen to say something the summary was already the place for.
    const scope =
        header.agent === undefined
            ? header.summary
            : [`${header.agent.name}${SEPARATOR}${header.agent.model}`, header.summary]
                  .filter((part) => part !== "")
                  .join(SEPARATOR)
    if (scope !== "") lines.push({ kind: "summary", text: clip(scope, width) })

    const chips = header.state ?? []
    if (chips.length > 0) {
        lines.push({
            kind: "state",
            text: clip(chips.map((chip) => chip.label).join(SEPARATOR), width),
        })
    }

    const warnings = header.warnings ?? []
    for (const warning of warnings.slice(0, WARNINGS_SHOWN)) {
        lines.push({ kind: "warning", text: clip(`⚠ ${warning}`, width) })
    }
    // Counted, not dropped. A header that silently showed three of five warnings would be the
    // trimmed-catalogue failure again: true of what is on screen, false of what is the case.
    if (warnings.length > WARNINGS_SHOWN) {
        lines.push({
            kind: "warning",
            text: clip(`⚠ and ${warnings.length - WARNINGS_SHOWN} more`, width),
        })
    }

    return lines
}

/**
 * The footer: what the keys do, on one line, clipped.
 *
 * One line and never two. A footer that wraps moves the body every time the hints change, and the
 * hints change per screen state — so a two-line footer means the list jumps as you use it. Hints are
 * dropped from the end when they do not fit, which is why the caller orders them by how likely
 * somebody is to need reminding: movement first, the destructive one last.
 */
export function hintLine(hints: readonly KeyHint[], width: number): string {
    const rendered = hints.map((hint) => `${hint.key} ${hint.does}`)
    // Longest prefix that fits. Built up rather than clipped down, so the line never ends in half a
    // hint — `enter inst…` reads as a different key than the one it is.
    let line = ""
    for (const hint of rendered) {
        const next = line === "" ? hint : `${line}${SEPARATOR}${hint}`
        if ([...next].length > width) break
        line = next
    }
    // Nothing fit: one clipped hint beats an empty footer, because a screen with no visible way out
    // is the worst thing a full-screen surface can be.
    return line === "" ? clip(rendered[0] ?? "", width) : line
}

/**
 * The whole header on one line, for a surface that cannot spare three.
 *
 * The chat is that surface. Its opening banner already says the version, the store, the session and every
 * load warning — and on the alternate screen that banner scrolls out of the window, taking the
 * session-wide facts with it. `headerLines`' three-to-six rows would fix that and cost a fifth of a short
 * terminal permanently, so this is the compromise the rule actually asks for: identity and scope always
 * visible, warnings reduced to a count that says where the detail is.
 *
 * A count rather than the text, deliberately. One warning wrapped over two lines is a header that changes
 * height, which is the one thing a fixed-height frame cannot have.
 */
export function titleLine(header: ScreenHeader, width: number): string {
    const parts = [header.title]
    if (header.agent !== undefined) parts.push(header.agent.name, header.agent.model)
    const warnings = header.warnings ?? []
    if (warnings.length > 0) {
        parts.push(`\u26a0 ${warnings.length} note${warnings.length === 1 ? "" : "s"} at the top`)
    }
    return clip(parts.join(SEPARATOR), width)
}

/** The hint every alternate-screen surface carries, so no screen invents its own word for leaving. */
export const QUIT_HINT: KeyHint = { key: "q", does: "back" }

/**
 * Terminal columns and rows a screen may use, clamped.
 *
 * Here rather than beside the one command that first needed them. They were exported from `browse.ts`,
 * which is imported both statically (by the wizard) and dynamically (by the command) — and the bundler
 * emitted the export twice, producing a `Duplicate export of 'windowFor'` that every test passed straight
 * through because tests import source, not the bundle. Screen arithmetic belongs with the screen.
 */
export function screenColumns(columns: number | undefined, fallback: number): number {
    return Math.max(MIN_SCREEN_COLUMNS, Math.min(MAX_SCREEN_COLUMNS, columns ?? fallback))
}

export function screenRows(rows: number | undefined, fallback: number): number {
    return Math.max(
        MIN_SCREEN_ROWS,
        Math.min(MAX_SCREEN_ROWS, (rows ?? fallback) - SCREEN_CHROME_ROWS),
    )
}
