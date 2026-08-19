/**
 * The product name, large, as the top of a new session.
 *
 * ## Why this is a header and not a screen
 *
 * It was a screen — a `Splash` component the chat swapped itself out for while the conversation was empty —
 * and that shape caused three bugs in a row, all the same bug. `/help` writes a note, the transcript stops
 * being empty, and the entire branch is replaced: the landing screen "disappeared" for almost every command.
 * Worse, anything added to the *other* branch was silently missing here — the palette drew nothing on the
 * splash for a day, and `/exit`'s "press y" prompt was invisible, because both were rendered in the layout
 * that was not on screen.
 *
 * Two layouts where one belongs is the defect. So there is one frame now, and this is the part of it that
 * changes: the brand mark sits above the ordinary one-line header until the first message is sent, and then
 * only the one-line header remains. Nothing appears or disappears on that transition — a block above it
 * goes.
 *
 * Presentational and controlled: it owns no keyboard, no state, and no opinion about when it is shown.
 */

import { Box, Text } from "ink"
import type { BrandmarkProps } from "#lib/schema"
import { THEME } from "#lib/theme"

export function Brandmark({ lines }: BrandmarkProps) {
    // Row numbers computed before the map, so the key is a position rather than a callback index. Position is
    // the honest identity here: two rows of a wordmark can be identical — `L` draws two the same — and a
    // content key would collapse them into one.
    const rows = lines.map((text, at) => ({ at, text }))

    return (
        <Box flexDirection="column">
            {rows.map((row) => (
                <Text key={`mark-${row.at}`} color={THEME.brand} bold wrap="truncate">
                    {" ".repeat(BRAND_INDENT)}
                    {row.text}
                </Text>
            ))}
        </Box>
    )
}

/**
 * Left-aligned, not centred, and exported so the caller wraps to the same width it is drawn at.
 *
 * Centring looked better when this was a screen of its own with a centred composer under it. In the unified
 * frame the line directly beneath it — the one-line header that outlives it — is left-aligned, and the two
 * have to read as one block or the collapse looks like a different screen rather than the same one with less
 * on it.
 */
export const BRAND_INDENT = 1
