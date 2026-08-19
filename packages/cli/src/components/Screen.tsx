/**
 * The frame every surface renders inside: header, body, footer.
 *
 * Replaces the three hand-rolled banners that came before it. `Banner` stays for what it is good at —
 * a title and some dim lines — and this composes it with the two things every screen also needed and
 * each solved separately: a live state row, and a footer saying what the keys do.
 *
 * ## It measures the terminal itself
 *
 * Width comes from `useTerminalSize()` rather than from a prop. The alternative was tried and is what
 * shipped in Phase 5: the caller measured once, passed numbers down, and a resized terminal left
 * every row laid out for a width that no longer existed. A component that reads the size cannot
 * forget to, and there is exactly one hook doing it.
 *
 * The clamps stay the kit's rather than the measurement's, because they are policy — 40 columns is
 * where a description column stops being worth having, 140 is where a description stops belonging on
 * the same line as its name. They are applied to the *live* value here.
 *
 * ## No input, no exit
 *
 * Presentational, like every component in this kit: it renders what it is given and owns no keyboard.
 * The focused surface owns the single `useInput`, and this is never it.
 */

import { Box, Text } from "ink"
import type { ReactNode } from "react"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { MAX_SCREEN_COLUMNS, MIN_SCREEN_COLUMNS } from "#lib/const"
import {
    type HeaderLine,
    headerLines,
    hintLine,
    type KeyHint,
    type ScreenHeader,
    type StateChip,
} from "#lib/screen"
import { BORDER_STYLE, THEME } from "#lib/theme"

export interface ScreenProps {
    readonly header: ScreenHeader
    readonly footer?: readonly KeyHint[]
    /**
     * Optional: a screen whose whole content is its header is a real screen — a one-line report, or a
     * list that came back empty. Required, it also made `createElement(Screen, props, body)` a type
     * error, because the third argument is not matched against a mandatory `children` prop.
     */
    readonly children?: ReactNode
}

/** Chip tone → colour. The pure module names a role; the mapping to a colour lives with the theme. */
const TONE: Record<StateChip["tone"], string> = {
    ok: THEME.success,
    warn: THEME.warning,
    off: THEME.muted,
}

/** Header line kind → how it is drawn. Exhaustive, so a new kind is a type error rather than a plain line. */
const LINE_STYLE: Record<
    HeaderLine["kind"],
    { readonly color?: string; readonly dim?: boolean; readonly bold?: boolean }
> = {
    title: { color: THEME.accent, bold: true },
    summary: { dim: true },
    state: {},
    warning: { color: THEME.warning },
}

/** The live columns, clamped. Exported so a body lays its rows out against the same number. */
export function screenWidth(columns: number): number {
    return Math.max(MIN_SCREEN_COLUMNS, Math.min(MAX_SCREEN_COLUMNS, columns))
}

export function Screen({ header, footer, children }: ScreenProps) {
    const size = useTerminalSize()
    const width = screenWidth(size.columns)
    // Two columns for the border, two for the padding: what the header may actually use.
    const inner = width - 4
    const lines = headerLines(header, inner)
    const chips = header.state ?? []

    return (
        <Box flexDirection="column" width={width}>
            <Box
                flexDirection="column"
                borderStyle={BORDER_STYLE}
                borderColor={THEME.borderActive}
                paddingX={1}
            >
                {lines.map((line) =>
                    // The state row is the one line whose parts are coloured individually, so it is
                    // rendered from the chips rather than from its own already-joined text. The text is
                    // still what the tests read, and the two cannot disagree because `headerLines`
                    // built that string from the same array.
                    line.kind === "state" ? (
                        <Text key={line.text} wrap="truncate">
                            {chips.map((chip, at) => (
                                <Text key={chip.label} color={TONE[chip.tone]}>
                                    {at === 0 ? "" : " · "}
                                    {chip.label}
                                </Text>
                            ))}
                        </Text>
                    ) : (
                        <Text
                            key={line.text}
                            wrap="truncate"
                            bold={LINE_STYLE[line.kind].bold === true}
                            dimColor={LINE_STYLE[line.kind].dim === true}
                            {...(LINE_STYLE[line.kind].color === undefined
                                ? {}
                                : { color: LINE_STYLE[line.kind].color })}
                        >
                            {line.text}
                        </Text>
                    ),
                )}
            </Box>

            <Box flexDirection="column" marginTop={1}>
                {children}
            </Box>

            {footer === undefined || footer.length === 0 ? null : (
                <Box marginTop={1}>
                    <Text dimColor wrap="truncate">
                        {"  "}
                        {hintLine(footer, inner)}
                    </Text>
                </Box>
            )}
        </Box>
    )
}
