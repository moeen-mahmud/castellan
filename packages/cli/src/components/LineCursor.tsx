/**
 * Editable text with an inverse-video cursor — the rendering half of `editor.ts`.
 *
 * Shared by the chat composer and the wizard's text fields, so there is one cursor implementation:
 * code-point split (never UTF-16 units), the character under the cursor drawn inverse, and a trailing
 * space inverted when the cursor sits at the end. When the buffer is empty and a placeholder is given,
 * the placeholder renders dim with the cursor on its first character — the affordance every modern CLI
 * uses for "press enter to accept this".
 *
 * ## Why it renders lines rather than a line
 *
 * The chat buffer became multi-line in Phase 5.5, and the alternative to generalising this was a second
 * component for the composer — which would be a second cursor implementation, the exact thing this file
 * was extracted to prevent. So it renders a column of lines with a caller-supplied `gutter`, and a
 * single-line field is the one-line case of that.
 *
 * Two consequences worth stating. The cursor is never drawn *on* a newline: the line break is structure
 * rather than a character, so the caret sits at the end of one line or the start of the next, which is
 * where a person expects it. And the view scrolls to follow the cursor through `viewport()` — the same
 * function the catalogue list uses, because "keep the interesting row visible" is one rule.
 */

import { Box, Text } from "ink"
import { lineInfo } from "#editor"
import { viewport } from "#lib/rows"
import { THEME } from "#lib/theme"
import type { EditorState } from "#lib/types"

export interface LineCursorProps {
    readonly editor: EditorState
    readonly placeholder?: string
    /**
     * Render every character as a dot. For a value that must not appear on screen, in scrollback, or
     * over a shoulder — the cursor still moves normally, because the editing model is unchanged and
     * only the rendering differs.
     */
    readonly secret?: boolean
    /**
     * Drawn before the first line. Continuation lines get an equal-width blank, so the text stays in
     * one column and a two-line message does not look like two messages.
     */
    readonly gutter?: string
    /** Visible rows before the view starts scrolling to follow the cursor. */
    readonly maxRows?: number
}

export function LineCursor({ editor, placeholder, secret, gutter = "", maxRows }: LineCursorProps) {
    const pad = " ".repeat([...gutter].length)

    if (editor.value === "" && placeholder !== undefined && placeholder !== "") {
        const chars = [...placeholder]
        return (
            <Text dimColor>
                <Text color={THEME.accent}>{gutter}</Text>
                <Text inverse>{chars[0] ?? " "}</Text>
                {chars.slice(1).join("")}
            </Text>
        )
    }

    const lines = editor.value.split("\n")
    const { line: cursorLine, column } = lineInfo(editor)
    const window = maxRows ?? lines.length
    const { from, to } = viewport(lines.length, cursorLine, Math.max(1, window))
    const hiddenAbove = from
    const hiddenBelow = lines.length - to

    return (
        <Box flexDirection="column">
            {hiddenAbove > 0 ? (
                <Text dimColor wrap="truncate">
                    {pad}… {hiddenAbove} line{hiddenAbove === 1 ? "" : "s"} above
                </Text>
            ) : null}
            {lines.slice(from, to).map((text, offset) => {
                const at = from + offset
                // Masked per code point, so the dot count matches what was typed rather than its byte
                // length.
                const chars = secret === true ? [...text].map(() => "•") : [...text]
                const lead = at === from && hiddenAbove === 0 ? gutter : pad
                if (at !== cursorLine) {
                    return (
                        // Keyed by index: two identical lines in a message are not the same line, and a
                        // content key would collapse them.
                        <Text key={`line-${at}`} wrap="truncate">
                            <Text color={THEME.accent}>{lead}</Text>
                            {chars.join("")}
                        </Text>
                    )
                }
                return (
                    <Text key={`line-${at}`} wrap="truncate">
                        <Text color={THEME.accent}>{lead}</Text>
                        {chars.slice(0, column).join("")}
                        {/* Inverting a trailing space is how the cursor stays visible at end of line. */}
                        <Text inverse>{chars[column] ?? " "}</Text>
                        {chars.slice(column + 1).join("")}
                    </Text>
                )
            })}
            {hiddenBelow > 0 ? (
                <Text dimColor wrap="truncate">
                    {pad}… {hiddenBelow} line{hiddenBelow === 1 ? "" : "s"} below
                </Text>
            ) : null}
        </Box>
    )
}
