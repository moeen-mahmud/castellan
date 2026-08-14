/**
 * One line of editable text with an inverse-video cursor — the rendering half of `editor.ts`.
 *
 * Extracted from Prompt so the chat input and the wizard's text fields share one cursor
 * implementation: code-point split (never UTF-16 units), the character under the cursor drawn
 * inverse, and a trailing space inverted when the cursor sits at the end of the line. When the
 * buffer is empty and a placeholder is given, the placeholder renders dim with the cursor on its
 * first character — the affordance every modern CLI uses for "press enter to accept this".
 */

import { Text } from "ink"
import type { EditorState } from "#lib/types"

export interface LineCursorProps {
    readonly editor: EditorState
    readonly placeholder?: string
    /**
     * Render every character as a dot. For a value that must not appear on screen, in scrollback,
     * or over a shoulder — the cursor still moves normally, because the editing model is unchanged
     * and only the rendering differs.
     */
    readonly secret?: boolean
}

export function LineCursor({ editor, placeholder, secret }: LineCursorProps) {
    if (editor.value === "" && placeholder !== undefined && placeholder !== "") {
        const chars = [...placeholder]
        return (
            <Text dimColor>
                <Text inverse>{chars[0] ?? " "}</Text>
                {chars.slice(1).join("")}
            </Text>
        )
    }

    // Masked per code point, so the dot count matches what was typed rather than its byte length.
    const chars = secret === true ? [...editor.value].map(() => "•") : [...editor.value]
    const before = chars.slice(0, editor.cursor).join("")
    const under = chars[editor.cursor] ?? " "
    const after = chars.slice(editor.cursor + 1).join("")

    return (
        <Text>
            {before}
            {/* Inverting a trailing space is how the cursor stays visible at end of line. */}
            <Text inverse>{under}</Text>
            {after}
        </Text>
    )
}
