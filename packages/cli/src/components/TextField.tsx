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
    /**
     * Columns available for the value. **Not optional in practice.**
     *
     * `LineCursor`'s own docstring says it: omitted, nothing wraps and a line wider than whatever draws
     * this is truncated by Ink at a width nobody chose. This component never passed it, and in the
     * settings editor — which draws the field into an unbordered column — a value longer than the
     * terminal was clipped at the right edge with the caret *past* the clip. You could not see what you
     * were typing, and `tools.pinned` is 92 characters in a generated manifest, so it was the first long
     * value anybody opened.
     *
     * **The wizard was not affected, and checking that mattered**: its bordered frame gives the `<Text>`
     * a bounded width, so Ink wrapped it anyway. Measured, after the assumption that it must be broken
     * too — the guard that would have "proved" it passed with the fix reverted. It is passed there now
     * regardless, because whoever owns a bounded window should wrap the text itself rather than leave it
     * to whatever happens to enclose it, and because `maxRows` genuinely bounds the height.
     */
    readonly columns?: number
    /** Rows the value may take before the view scrolls to follow the cursor. */
    readonly maxRows?: number
}

export function TextField({
    label,
    editor,
    placeholder,
    error,
    secret,
    columns,
    maxRows,
}: TextFieldProps) {
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
                {...(columns === undefined ? {} : { columns })}
                {...(maxRows === undefined ? {} : { maxRows })}
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
