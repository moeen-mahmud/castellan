/**
 * `^R` — what you have already sent, filtered as you type, above the prompt.
 *
 * A list rather than bash's in-place `(reverse-i-search)` line, and deliberately the same shape the
 * slash palette uses: matches above the input, narrowing as you type, ↑↓ to pick, ⏎ to use, esc to
 * cancel. One interaction learned once and used by both — a shell shows a single match at a time
 * because a shell has one line to work with, which is not a constraint here.
 *
 * Controlled and presentational: the query, the match list and the selected index all come from
 * `editor.ts`, and this component owns no keyboard. The line being composed is untouched until a match
 * is accepted, so the search costs nothing to cancel — which is why the draft can stay on screen
 * underneath.
 */

import { Box, Text } from "ink"
import { searchMatches } from "#editor"
import { clip, viewport } from "#lib/rows"
import { GLYPH, THEME } from "#lib/theme"
import type { EditorState } from "#lib/types"

export interface HistorySearchProps {
    readonly editor: EditorState
    /** Terminal columns, so a long message is clipped rather than wrapped into the list. */
    readonly width: number
    /** Visible matches. The list scrolls inside this rather than pushing the prompt off the screen. */
    readonly maxRows: number
}

export function HistorySearch({ editor, width, maxRows }: HistorySearchProps) {
    const search = editor.search
    if (search === undefined) return null

    const matches = searchMatches(editor)
    const index = Math.min(search.index, Math.max(0, matches.length - 1))
    const { from, to } = viewport(matches.length, index, maxRows)
    // Two for the gutter, and the query line needs room for its own label.
    const room = Math.max(8, width - 4)

    return (
        <Box flexDirection="column">
            {matches.length === 0 ? (
                <Text color={THEME.muted} wrap="truncate">
                    {"  "}
                    nothing you have sent matches that
                </Text>
            ) : (
                matches.slice(from, to).map((entry, offset) => {
                    const at = from + offset
                    const selected = at === index
                    return (
                        // Keyed by the entry, which is unique: `searchMatches` deduplicates, so the same
                        // question asked twice appears once.
                        <Text key={entry} wrap="truncate">
                            <Text color={THEME.accent}>{selected ? GLYPH.pointer : "  "}</Text>
                            <Text bold={selected} dimColor={!selected}>
                                {/* Newlines collapsed: a multi-line message has to read as one row here,
                                    the same rule the catalogue list follows. */}
                                {clip(entry.replace(/\s+/g, " "), room)}
                            </Text>
                        </Text>
                    )
                })
            )}
            <Text wrap="truncate">
                <Text color={THEME.muted}>{"  search: "}</Text>
                {search.query}
                <Text inverse> </Text>
                {matches.length > 1 ? (
                    <Text color={THEME.muted}>{`  ${index + 1} of ${matches.length}`}</Text>
                ) : null}
            </Text>
        </Box>
    )
}
