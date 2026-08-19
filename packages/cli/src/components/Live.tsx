/**
 * The reply being generated — the only part of the conversation that redraws.
 *
 * Height-capped on purpose. Ink redraws this whole subtree per frame, so an uncapped pane means redrawing
 * the entire reply on every token: the cost grows with the length of the answer, precisely when the
 * terminal is busiest. `livePane` keeps the newest rows and drops the older ones, which is what the reader
 * is looking at anyway; the whole reply joins the transcript at `turn.end`, so nothing is lost — it just
 * arrives complete rather than in a redrawn window.
 *
 * It renders pre-wrapped rows rather than handing Ink a paragraph, for the reason `lib/wrap.ts` explains:
 * Ink breaks at spaces and a division does not, so a cap measured one way and drawn the other was always
 * a row or two short of the truth. The chat frame subtracts this pane's height from the terminal before it
 * renders, so being short by a row is a frame taller than the screen.
 */

import { Box, Text } from "ink"
import { LIVE_PANE_MAX_ROWS } from "#lib/const"
import type { LiveProps } from "#lib/schema"
import { livePane } from "#lib/wrap"

export function Live({ live, showReasoning, columns }: LiveProps) {
    const showing = showReasoning && live.reasoning !== "" && live.text === ""
    const text = showing ? live.reasoning : live.text
    if (text === "") return null

    // The reasoning label is a prefix on the first row, so the wrap has to account for its width or that
    // row is one longer than every other.
    const label = showing ? "· reasoning · " : ""
    const pane = livePane(text, columns - [...label].length, LIVE_PANE_MAX_ROWS)
    // Row numbers computed before the map, so the key is a position rather than a callback index. Position
    // is the honest identity here: two identical rows of a streamed reply are different rows, and a content
    // key would collapse them.
    const rows = pane.lines.map((text, at) => ({ at, text }))

    return (
        <Box flexDirection="column">
            {pane.hidden > 0 ? (
                <Text dimColor wrap="truncate">
                    … {pane.hidden} earlier row(s) hidden while streaming
                </Text>
            ) : null}
            {rows.map((row) => (
                <Text key={`row-${row.at}`} dimColor={showing} wrap="truncate">
                    {row.at === 0 ? label : ""}
                    {row.text}
                </Text>
            ))}
        </Box>
    )
}
