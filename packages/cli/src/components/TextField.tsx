/**
 * A labelled text input for wizard questions: label, caret, LineCursor, optional error line.
 *
 * The editing itself lives upstream — the screen root routes keys through `keyToIntent` into
 * `applyIntent` and hands the resulting `EditorState` down — so every editing nicety the chat
 * input has (^A/^E, ^W, code-point cursor) works here without a second implementation.
 */

import { Box, Text } from "ink"
import { LineCursor } from "#components/LineCursor"
import { GLYPH, THEME } from "#lib/theme"
import type { EditorState } from "#lib/types"

export interface TextFieldProps {
    readonly label: string
    readonly editor: EditorState
    /** The question's default, shown dim when the buffer is empty; enter accepts it. */
    readonly placeholder?: string
    /** A validation failure, rendered beneath in the error colour. Cleared upstream on edit. */
    readonly error?: string
    /** Mask the value as it is typed. Passed straight through to the cursor. */
    readonly secret?: boolean
}

export function TextField({ label, editor, placeholder, error, secret }: TextFieldProps) {
    return (
        <Box flexDirection="column">
            <Text>{label}</Text>
            <Text>
                <Text color={THEME.accent}>{GLYPH.prompt}</Text>
                <LineCursor
                    editor={editor}
                    {...(placeholder === undefined ? {} : { placeholder })}
                    {...(secret === true ? { secret: true } : {})}
                />
            </Text>
            {error === undefined ? null : (
                <Text color={THEME.error}>
                    {GLYPH.error}
                    {error}
                </Text>
            )}
        </Box>
    )
}
