/**
 * The reply being generated — the only part of the screen that redraws.
 *
 * Height-capped on purpose. Ink redraws this whole subtree per frame, so an uncapped pane means
 * redrawing the entire reply on every token: the cost grows with the length of the answer, precisely
 * when the terminal is busiest. `tailRows` keeps the newest rows and drops the older ones, which is
 * what the reader is looking at anyway; the whole reply is committed to `<Static>` at `turn.end`, so
 * nothing is lost — it just arrives complete rather than in a redrawn window.
 */

import { Box, Text } from "ink"
import { LIVE_PANE_MAX_ROWS } from "#lib/const"
import type { LiveProps } from "#lib/schema"
import { tailRows, totalRows } from "#lib/wrap"

export function Live({ live, showReasoning, columns }: LiveProps) {
    const showing = showReasoning && live.reasoning !== "" && live.text === ""
    const text = showing ? live.reasoning : live.text
    if (text === "") return null

    const rows = totalRows(text, columns)
    const clipped = rows > LIVE_PANE_MAX_ROWS

    return (
        <Box flexDirection="column">
            {clipped ? (
                <Text dimColor>
                    … {rows - LIVE_PANE_MAX_ROWS} earlier row(s) hidden while streaming
                </Text>
            ) : null}
            <Text dimColor={showing}>
                {showing ? "· reasoning · " : ""}
                {tailRows(text, columns, LIVE_PANE_MAX_ROWS)}
            </Text>
        </Box>
    )
}
