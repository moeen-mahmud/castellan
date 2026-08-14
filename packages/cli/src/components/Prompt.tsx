/**
 * The input line, in a rounded box — accent-bordered when ready, muted while a turn runs.
 *
 * Ink has no text field — it delivers keystrokes and nothing else — so the cursor is drawn rather
 * than positioned; `LineCursor` owns that rendering (code-point split, inverse under-cursor
 * character) for this component and the wizard's fields alike. The border exists only where Ink
 * renders: the plain path never mounts this, so plain parity is untouched by definition.
 */

import { Box, Text } from "ink"
import { LineCursor } from "#components/LineCursor"
import { PROMPT } from "#lib/const"
import type { PromptProps } from "#lib/schema"
import { BORDER_STYLE, THEME } from "#lib/theme"

export function Prompt({ editor, busy }: PromptProps) {
    return (
        <Box
            borderStyle={BORDER_STYLE}
            borderColor={busy ? THEME.border : THEME.borderActive}
            paddingX={1}
        >
            <Text color={busy ? THEME.muted : THEME.accent}>{PROMPT}</Text>
            <LineCursor editor={editor} />
        </Box>
    )
}
