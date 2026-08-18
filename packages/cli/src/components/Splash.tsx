/**
 * What a new conversation looks like before anything has been said.
 *
 * A session that opens onto a wall of boot notes and an empty transcript tells you what the runtime did;
 * this tells you what to do. It is the *same composer* — one `EditorState`, one keymap — moved to the
 * middle of the screen and given a placeholder, so nothing about typing changes when the splash goes
 * away on the first message.
 *
 * Presentational and controlled, like everything in this kit: it owns no keyboard and no state. The
 * screen root still has the single `useInput`, which is what lets `/` open the palette from here exactly
 * as it does from the transcript.
 *
 * ## What is deliberately not on it
 *
 * The banner's facts — boot time, store path, the load warnings in full — are still seeded as the first
 * transcript item, so they are there to scroll back to the moment there is a transcript. What the splash
 * carries is the compact form: who you are talking to, on what, and a count of anything worth reading.
 * A splash that reproduced the banner would be the banner with a picture on top.
 */

import { Box, Text } from "ink"
import { Prompt } from "#components/Prompt"
import type { SplashProps } from "#lib/schema"
import { GLYPH, THEME } from "#lib/theme"
import { wordmark } from "#lib/wordmark"

/** Rows the composer and everything under it occupy, so the wordmark knows what is left. */
const BELOW_WORDMARK = 8

export function Splash({
    name,
    version,
    agentName,
    model,
    warnings,
    location,
    editor,
    busy,
    columns,
    rows,
    hint,
}: SplashProps) {
    // The wordmark takes whatever is left after the composer, and degrades rather than overflowing —
    // there is no scrollback on the alternate screen to recover an overflowed frame from.
    const mark = wordmark(name, {
        columns: columns - 2,
        rows: Math.max(1, rows - BELOW_WORDMARK),
    })

    const notes = warnings.length
    const facts = [agentName, model, ...(notes === 0 ? [] : [`⚠ ${notes}`])].join(" · ")
    // The composer is narrower than the screen and centred, which is the whole visual idea: an empty
    // prompt spanning 140 columns reads as a form to fill in rather than a question to answer.
    const boxWidth = Math.max(24, Math.min(columns - 4, 64))
    const indent = Math.max(0, Math.floor((columns - boxWidth) / 2))
    const markIndent = Math.max(0, Math.floor((columns - mark.width) / 2))
    // Row numbers computed before the map, so the key is a position rather than a callback index. Position
    // is the honest identity: two rows of a wordmark can be identical — `L` draws two the same — and a
    // content key would collapse them into one.
    const markRows = mark.lines.map((text, at) => ({ at, text }))

    return (
        <Box flexDirection="column" width={columns} height={rows}>
            {/* Pushes the wordmark and composer off the top edge and into the middle of the screen. */}
            <Box flexGrow={1} />

            <Box flexDirection="column" marginBottom={1}>
                {markRows.map((row) => (
                    <Text key={`mark-${row.at}`} color={THEME.accent} bold wrap="truncate">
                        {" ".repeat(markIndent)}
                        {row.text}
                    </Text>
                ))}
            </Box>

            <Box flexDirection="column" marginLeft={indent} width={boxWidth}>
                <Prompt editor={editor} busy={busy} placeholder="Ask anything…" />
                <Text color={THEME.muted} wrap="truncate">
                    {"  "}
                    {facts}
                </Text>
            </Box>

            <Box marginLeft={indent} marginTop={1}>
                <Text dimColor wrap="truncate">
                    {hint}
                </Text>
            </Box>

            <Box flexGrow={1} />

            {/* Where you are, and which build — the two things a screenshot of this should carry. */}
            <Box>
                <Box flexGrow={1}>
                    <Text color={THEME.muted} wrap="truncate">
                        {location}
                    </Text>
                </Box>
                <Text color={THEME.muted} wrap="truncate">
                    {GLYPH.dot}
                    {name} {version}
                </Text>
            </Box>
        </Box>
    )
}
