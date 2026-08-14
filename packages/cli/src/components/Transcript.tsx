/**
 * Finished conversation, rendered once.
 *
 * `<Static>` is the load-bearing part. Ink erases and redraws its dynamic tree on every frame; a
 * transcript in that tree would be redrawn on every streamed token, which flickers, burns CPU, and
 * destroys scrollback on a long session. `<Static>` writes each node to the terminal once and never
 * touches it again — so history costs nothing to keep, no matter how much of it there is.
 *
 * Two consequences worth knowing before editing this file:
 *
 * - Items must be **append-only and immutable**. Changing one already written is a change to
 *   something the renderer will never look at again, so it silently does not appear.
 * - `key` must be stable and unique, which is why `TranscriptItem.id` comes from a counter in the
 *   reducer rather than from an array index.
 */

import { Box, Static, Text } from "ink"
import { Banner } from "#components/Banner"
import type { TranscriptProps } from "#lib/schema"
import { ROLE_COLOR, ROLE_PREFIX } from "#lib/theme"
import { formatStats } from "#transcript"

export function Transcript({ items, showReasoning, quiet }: TranscriptProps) {
    const visible = items.filter((item) => item.role !== "reasoning" || showReasoning)

    return (
        <Static items={visible}>
            {(item) => {
                // The banner is one item, written once like everything else in Static — a sibling
                // above the transcript would live in the dynamic region, which draws *below*
                // Static output and redraws every frame.
                if (item.role === "banner") {
                    const [title = "", ...lines] = item.text.split("\n")
                    return (
                        <Box key={item.id} flexDirection="column" marginBottom={1}>
                            <Banner title={title} lines={lines} />
                        </Box>
                    )
                }

                // Spread rather than `color={ROLE_COLOR[...]}`: Ink declares `color?: string`, so
                // under `exactOptionalPropertyTypes` an explicit `undefined` is a type error.
                // Omitting it is also what we want at runtime — an assistant reply should use the
                // terminal's own foreground colour rather than one we picked for it.
                const colour = ROLE_COLOR[item.role]
                return (
                    // One blank line after every item — the rich transcript is read, not grepped,
                    // and turns that touch each other read as one wall. The plain path formats its
                    // own lines and is untouched by this, which is what keeps pipe output stable.
                    <Box key={item.id} flexDirection="column" marginBottom={1}>
                        <Text
                            {...(colour === undefined ? {} : { color: colour })}
                            dimColor={item.role === "reasoning" || item.role === "tool"}
                        >
                            {ROLE_PREFIX[item.role]}
                            {item.text}
                        </Text>
                        {item.stats === undefined || quiet ? null : (
                            <Text dimColor>{`  ${formatStats(item.stats)}`}</Text>
                        )}
                    </Box>
                )
            }}
        </Static>
    )
}
