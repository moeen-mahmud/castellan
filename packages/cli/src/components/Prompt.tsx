/**
 * The input line.
 *
 * Ink has no text field — it delivers keystrokes and nothing else — so the cursor is drawn rather
 * than positioned: the character under it is inverted. That is also why the buffer is split on code
 * points and not string indices, which `editor.ts` explains at length: a cursor counted in UTF-16
 * units lands inside an emoji's surrogate pair and renders half a character.
 */

import { Text } from "ink"
import { PROMPT } from "#lib/const"
import type { PromptProps } from "#lib/schema"

export function Prompt({ editor, busy }: PromptProps) {
    const chars = [...editor.value]
    const before = chars.slice(0, editor.cursor).join("")
    const under = chars[editor.cursor] ?? " "
    const after = chars.slice(editor.cursor + 1).join("")

    return (
        <Text>
            <Text color={busy ? "gray" : "cyan"}>{PROMPT}</Text>
            {before}
            {/* Inverting a trailing space is how the cursor stays visible at end of line. */}
            <Text inverse>{under}</Text>
            {after}
        </Text>
    )
}
