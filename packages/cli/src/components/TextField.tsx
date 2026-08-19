/**
 * A labelled text input for wizard questions: label, caret, LineCursor, optional error line.
 *
 * The editing itself lives upstream — the screen root routes keys through `keyToIntent` into
 * `applyIntent` and hands the resulting `EditorState` down — so every editing nicety the chat
 * input has (^A/^E, ^W, code-point cursor) works here without a second implementation.
 */

import { LineCursor } from "#components/LineCursor"
import { GLYPH, THEME } from "#lib/theme"
import type { EditorState } from "#lib/types"
import { Box, Text } from "ink"

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
            {/*
             * The prompt glyph is the cursor's `gutter` rather than a sibling `<Text>`. Two reasons, and
             * the second is not optional: it keeps a wrapped or multi-line value in one column, and
             * `LineCursor` renders a `<Box>`, which inside a `<Text>` produces an empty frame — no error,
             * nothing on screen. A frame test caught that; nothing else would have.
             */}
            <LineCursor
                editor={editor}
                gutter={GLYPH.prompt}
                {...(placeholder === undefined ? {} : { placeholder })}
                {...(secret === true ? { secret: true } : {})}
            />
            {error === undefined ? null : (
                <Text color={THEME.error}>
                    {GLYPH.error}
                    {error}
                </Text>
            )}
        </Box>
    )
}
