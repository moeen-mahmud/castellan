/**
 * The welcome box: product identity in a rounded frame, context lines dim beneath it.
 *
 * Purely presentational — the caller supplies the title (usually `BRAND.name + version`) and the
 * lines, so this renders identically at the top of a chat session, a wizard, or the picker.
 *
 * Every boxed surface stretches to the full terminal width — no `alignSelf`. Content-fit boxes
 * next to full-width ones read as different components; one rule everywhere is what makes the
 * screens look like one product.
 */

import { Box, Text } from "ink"
import { BORDER_STYLE, THEME } from "#lib/theme"

export interface BannerProps {
    readonly title: string
    readonly lines: readonly string[]
}

export function Banner({ title, lines }: BannerProps) {
    return (
        <Box
            flexDirection="column"
            borderStyle={BORDER_STYLE}
            borderColor={THEME.borderActive}
            paddingX={1}
        >
            <Text bold color={THEME.accent}>
                {title}
            </Text>
            {lines.map((line) => (
                <Text key={line} dimColor>
                    {line}
                </Text>
            ))}
        </Box>
    )
}
