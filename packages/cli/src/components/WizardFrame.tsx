/**
 * The wizard's chrome: answered lines above, the current question in a rounded box, a dim hint
 * footer. The `step m of n` count is honest — a keyless preset shrinks `total`, and the frame
 * shows whatever the reducer computed rather than a number that quietly stops being true.
 */

import { BORDER_STYLE, GLYPH, THEME } from "#lib/theme"
import { Box, Text } from "ink"
import type { ReactNode } from "react"

export interface WizardFrameProps {
    readonly step: number
    readonly total: number
    /** Already-answered questions, rendered ✓ label value. Esc pops the last one. */
    readonly answered: readonly { readonly label: string; readonly value: string }[]
    readonly hint: string
    readonly children: ReactNode
}

export function WizardFrame({ step, total, answered, hint, children }: WizardFrameProps) {
    return (
        <Box flexDirection="column">
            {answered.map((entry) => (
                <Text key={entry.label}>
                    <Text color={THEME.success}>{GLYPH.check}</Text>
                    <Text dimColor>{entry.label.padEnd(18)}</Text>
                    {entry.value}
                </Text>
            ))}
            <Box
                flexDirection="column"
                borderStyle={BORDER_STYLE}
                borderColor={THEME.border}
                paddingX={1}
                paddingY={1}
                marginTop={answered.length > 0 ? 1 : 0}
            >
                {children}
            </Box>
            <Text dimColor>
                step {step} of {total} {GLYPH.bullet}
                {hint}
            </Text>
        </Box>
    )
}
