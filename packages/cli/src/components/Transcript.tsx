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

import { Static, Text } from "ink"
import type { TranscriptProps } from "#lib/schema"
import type { TranscriptItem } from "#lib/types"
import { formatStats } from "#transcript"

const COLOUR: Record<TranscriptItem["role"], string | undefined> = {
    user: "cyan",
    assistant: undefined,
    reasoning: "gray",
    note: "gray",
    error: "red",
    tool: "blue",
}

const PREFIX: Record<TranscriptItem["role"], string> = {
    user: "› ",
    assistant: "",
    reasoning: "· reasoning · ",
    note: "· ",
    error: "✖ ",
    tool: "  · ",
}

export function Transcript({ items, showReasoning, quiet }: TranscriptProps) {
    const visible = items.filter((item) => item.role !== "reasoning" || showReasoning)

    return (
        <Static items={visible}>
            {(item) => {
                // Spread rather than `color={COLOUR[...]}`: Ink declares `color?: string`, so under
                // `exactOptionalPropertyTypes` an explicit `undefined` is a type error. Omitting it
                // is also what we want at runtime — an assistant reply should use the terminal's own
                // foreground colour rather than one we picked for it.
                const colour = COLOUR[item.role]
                return (
                    <Text
                        key={item.id}
                        {...(colour === undefined ? {} : { color: colour })}
                        dimColor={item.role === "reasoning" || item.role === "tool"}
                    >
                        {PREFIX[item.role]}
                        {item.text}
                        {item.stats === undefined || quiet ? "" : `\n  ${formatStats(item.stats)}`}
                    </Text>
                )
            }}
        </Static>
    )
}
