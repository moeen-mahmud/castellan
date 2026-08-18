/**
 * The plain path's shared vocabulary — the half of the house style that never had one.
 *
 * `theme.ts` serves the Ink path. The plain path is most of the binary, and until this file every
 * command that printed a labelled block invented its own: eight hand-rolled `padEnd` widths across
 * seven files (9, 14, `FLAG_COLUMN`, `ENV_COLUMN`, `COMMAND_COLUMN`, and three computed maxima),
 * with `agents.ts` emitting tab-separated columns while everything beside it emitted padded ones.
 * `agents` and `validate` genuinely looked like output from two different products.
 *
 * So this is not a new style — it is the existing one, written down once. A new surface that wants
 * a labelled block, a status word or a byte count reaches here rather than adding a ninth variant.
 *
 * **Pure.** No `node:*`, no `process`, no colour decision. Every function is text in, text out, so
 * it belongs on the boundaries test's `PURE` list and every rendering rule is unit-testable without
 * capturing stdout. Colour is deliberately *not* applied here: the plain path is read as often from
 * a log file as from a terminal, and a module that emitted escape codes would have to know which,
 * which is `resolveMode`'s job and nowhere near a formatter's.
 */

import { GLYPH } from "#lib/theme"

/** Where a labelled block starts, and the space between the widest label and its value. */
const INDENT = "  "
const GAP = 2

export interface Row {
    readonly label: string
    readonly value: string
    /**
     * Trailing text, aligned past the value.
     *
     * Its own field rather than something the caller concatenates, because the interesting rows
     * are the ones carrying a fact *and* its consequence — "2463 · launchd has restarted this
     * 2463 times" — and a caller building that by hand loses the alignment on the next row.
     */
    readonly note?: string
}

/**
 * A labelled block: two-space indent, labels padded to the widest, values aligned.
 *
 * Rows with an empty value are dropped rather than printed blank. A field that does not apply is
 * not the same as a field that is empty, and printing `logs` with nothing after it invites the
 * reader to wonder which one they are looking at.
 */
export function keyValue(rows: readonly Row[]): string {
    const shown = rows.filter((row) => row.value !== "")
    if (shown.length === 0) return ""
    const width = Math.max(...shown.map((row) => row.label.length))
    return shown
        .map((row) => {
            const head = `${INDENT}${row.label.padEnd(width)}${" ".repeat(GAP)}${row.value}`
            return row.note === undefined ? head : `${head}${" ".repeat(GAP)}${row.note}`
        })
        .join("\n")
}

/** A heading with its own blank line above, unless it opens the output. */
export function section(title: string, first = false): string {
    return first ? title : `\n${title}`
}

export function bullet(text: string): string {
    return `${INDENT}${GLYPH.bullet}${text}`
}

/** Indent a block that was rendered elsewhere — a log tail, a nested report. */
export function indent(text: string, depth = 2): string {
    const pad = " ".repeat(depth)
    return text
        .split("\n")
        .map((line) => (line === "" ? line : `${pad}${line}`))
        .join("\n")
}

/**
 * Bytes as a person reads them.
 *
 * Binary units, and the decimal place only below 10 in each unit — `1.2 MB` is worth a digit,
 * `847 MB` is not, and the extra precision only makes a size harder to compare at a glance.
 */
export function bytes(count: number): string {
    if (!Number.isFinite(count) || count < 0) return "unknown"
    if (count < 1024) return `${Math.round(count)} B`
    const units = ["KB", "MB", "GB", "TB"]
    let value = count / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * A span, in the largest two units that carry information.
 *
 * "3h 12m" rather than "3.2 hours" or "11520 seconds": an uptime is read to answer "since roughly
 * when", and two units is where that question stops getting better answers.
 */
export function duration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "unknown"
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ${minutes % 60}m`
    return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * `~/…` for a path under home, so a block of paths stays readable at a glance.
 *
 * Takes `home` rather than reading it, because this module is pure — and because the daemon's
 * output has to be able to render a path under a *different* home than the current process's when
 * it is describing a service definition it did not write.
 */
export function tildify(path: string, home: string): string {
    if (home === "" || !path.startsWith(home)) return path
    const rest = path.slice(home.length)
    return rest === "" ? "~" : rest.startsWith("/") ? `~${rest}` : path
}

const MINUTE_MS = 60_000
const HOURS_PER_DAY = 24

/**
 * How long ago, in the shortest honest form.
 *
 * `now` is a parameter rather than a `Date.now()` call, which is what lets this live in a pure module and
 * be shared. It was previously private to `sessions.ts` and read the clock itself, so the session picker
 * would have had to reimplement it — and two renderings of "how old is this conversation" that disagree
 * is the drift this module exists to end.
 *
 * An unparseable timestamp is returned as itself. A store row with a bad date is a real thing to see, and
 * "NaNm ago" says nothing about it.
 */
export function ago(iso: string, now: number): string {
    const ms = now - Date.parse(iso)
    if (Number.isNaN(ms)) return iso
    const mins = Math.floor(ms / MINUTE_MS)
    if (mins < 1) return "just now"
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < HOURS_PER_DAY) return `${hours}h ago`
    return `${Math.floor(hours / HOURS_PER_DAY)}d ago`
}
