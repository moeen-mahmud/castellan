/**
 * The confirm screen's answer recap: labels dim and right-padded, values plain, in a card.
 */

import { Box, Text } from "ink"
import { BORDER_STYLE, THEME } from "#lib/theme"

export interface SummaryCardProps {
    readonly rows: readonly { readonly label: string; readonly value: string }[]
}

export function SummaryCard({ rows }: SummaryCardProps) {
    const width = rows.reduce((widest, row) => Math.max(widest, row.label.length), 0)
    return (
        <Box
            flexDirection="column"
            borderStyle={BORDER_STYLE}
            borderColor={THEME.border}
            paddingX={1}
            paddingY={1}
        >
            {rows.map((row) => (
                <Text key={row.label}>
                    <Text dimColor>{row.label.padEnd(width + 2)}</Text>
                    {row.value}
                </Text>
            ))}
        </Box>
    )
}
