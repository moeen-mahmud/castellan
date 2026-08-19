/**
 * The slash-command list, above the prompt.
 *
 * Opens as soon as `/` is typed and narrows as the word is completed, which is what makes the whole
 * command surface discoverable without a manual. Deliberately the same shape as `HistorySearch`: matches
 * above the input, ↑↓ to move, tab to complete, enter to run, esc to close. One interaction learned once
 * and used by both, because a terminal app that invents a second list idiom for its second list is the
 * inconsistency this phase set out to remove.
 *
 * Controlled and presentational. The entries come from `lib/palette.ts` — generated from the CLI's own
 * command table — and the cursor lives in the screen root; this owns no keyboard.
 */

import type { Palette as PaletteModel } from "#lib/palette"
import { clip, viewport } from "#lib/rows"
import { GLYPH, THEME } from "#lib/theme"
import { Box, Text } from "ink"

export interface PaletteProps {
    readonly palette: PaletteModel
    readonly index: number
    readonly width: number
    readonly maxRows: number
}

/** Widest word among the matches, so the summaries line up in a column. */
function wordColumn(palette: PaletteModel): number {
    return palette.matches.reduce((widest, entry) => Math.max(widest, entry.word.length), 0)
}

export function Palette({ palette, index, width, maxRows }: PaletteProps) {
    if (palette.matches.length === 0) {
        return (
            <Text color={THEME.muted} wrap="truncate">
                {"  "}
                no command starts with /{palette.query}
            </Text>
        )
    }

    const at = Math.min(index, palette.matches.length - 1)
    const { from, to } = viewport(palette.matches.length, at, maxRows)
    const column = wordColumn(palette)
    // Two for the pointer, the word column, two of gap.
    const room = Math.max(8, width - (2 + column + 2))

    return (
        <Box flexDirection="column">
            {from > 0 ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {GLYPH.ellipsis} {from} above
                </Text>
            ) : null}
            {palette.matches.slice(from, to).map((entry, offset) => {
                const selected = from + offset === at
                return (
                    <Text key={entry.word} wrap="truncate">
                        <Text color={THEME.accent}>{selected ? GLYPH.pointer : "  "}</Text>
                        <Text bold={selected} {...(selected ? { color: THEME.accent } : {})}>
                            {entry.word.padEnd(column)}
                        </Text>
                        {"  "}
                        <Text dimColor>{clip(entry.summary, room)}</Text>
                    </Text>
                )
            })}
            {to < palette.matches.length ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {GLYPH.ellipsis} {palette.matches.length - to} below
                </Text>
            ) : null}
            <Text dimColor wrap="truncate">
                {"  "}↑↓ move · tab complete · enter run · esc close
            </Text>
        </Box>
    )
}
