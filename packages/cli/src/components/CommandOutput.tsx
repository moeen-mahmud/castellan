/**
 * A command's output, in a scrollable pane inside the session.
 *
 * ## Why one pane rather than nine screens
 *
 * Every command in the table already produces good text — `keyValue` blocks, sections, the house
 * vocabulary in `lib/render.ts`. Nine bespoke screens for `/status`, `/policy`, `/config`, `/model` and
 * the rest would mostly reproduce those same tables in JSX, and several of them are read-only lists where
 * a generic pane and a hand-made one look identical.
 *
 * So this runs the command, captures what it printed, and shows it. That makes *every* non-hidden command
 * reachable from the palette the moment it exists, which is what "all the CLI inside the TUI" asks for,
 * and leaves a bespoke view as something a command earns by having a next action worth a keypress —
 * skills and sources have one, `/policy` does not.
 *
 * Controlled: the scroll offset lives in the screen root, and this owns no keyboard.
 */

import { Spinner } from "#components/Spinner"
import { viewport } from "#lib/rows"
import { GLYPH, THEME } from "#lib/theme"
import { Box, Text } from "ink"

export interface CommandOutputProps {
    /** `undefined` while it is still running. */
    readonly lines: readonly string[] | undefined
    readonly label: string
    /** First visible line. Clamped here, so a shrinking output cannot leave the view past its end. */
    readonly offset: number
    readonly maxRows: number
    /** Non-zero means the command reported a failure; shown, never hidden behind a clean-looking pane. */
    readonly code?: number
}

export function CommandOutput({ lines, label, offset, maxRows, code }: CommandOutputProps) {
    if (lines === undefined) {
        return (
            <Box marginLeft={2}>
                <Spinner label={`running ${label}`} />
            </Box>
        )
    }

    if (lines.length === 0) {
        return (
            <Box marginLeft={2}>
                <Text color={THEME.muted}>{label} printed nothing</Text>
            </Box>
        )
    }

    // `viewport` centres on a cursor; here the cursor *is* the offset, so it is asked for the row at the
    // top of the window and clamped by the same arithmetic the lists use.
    const { from, to } = viewport(
        lines.length,
        Math.min(offset + Math.floor(maxRows / 2), lines.length - 1),
        maxRows,
    )

    const visible = lines.slice(from, to).map((text, at) => ({ row: from + at, text }))

    return (
        <Box flexDirection="column">
            {code !== undefined && code !== 0 ? (
                <Text color={THEME.error} wrap="truncate">
                    {GLYPH.error}
                    {label} exited {code}
                </Text>
            ) : null}
            {from > 0 ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {GLYPH.ellipsis} {from} line{from === 1 ? "" : "s"} above
                </Text>
            ) : null}
            {visible.map((entry) => (
                // Keyed by the row's position in the whole output, computed before the map so the key is a
                // line number rather than a callback index. Position is the honest identity here: two
                // identical lines in a report are different lines, and a content key would collapse them.
                <Text key={entry.row} wrap="truncate">
                    {entry.text}
                </Text>
            ))}
            {to < lines.length ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {GLYPH.ellipsis} {lines.length - to} line{lines.length - to === 1 ? "" : "s"}{" "}
                    below
                </Text>
            ) : null}
        </Box>
    )
}
