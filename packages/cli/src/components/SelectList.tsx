/**
 * An arrow-key select list: ❯ on the selected row, hints dim, optional numbering.
 *
 * Controlled and presentational — `index` comes from the parent's reducer (`lib/select.ts`), and
 * values stay with the parent, which maps the index back to its own data. This component never
 * listens to input; the screen root owns the single `useInput`.
 */

import { Box, Text } from "ink"
import { GLYPH, THEME } from "#lib/theme"

export interface SelectItem {
    readonly label: string
    /** Dim, after the label — a model id, a relative time, a one-line description. */
    readonly hint?: string
}

export interface SelectListProps {
    readonly items: readonly SelectItem[]
    readonly index: number
    /** `1.`-style prefixes; digits then jump the cursor (they never choose). */
    readonly numbered?: boolean
}

export function SelectList({ items, index, numbered }: SelectListProps) {
    return (
        <Box flexDirection="column">
            {items.map((item, at) => {
                const selected = at === index
                const number = numbered === true ? `${at + 1}. ` : ""
                return (
                    <Text key={item.label} {...(selected ? { color: THEME.accent } : {})}>
                        {selected ? GLYPH.pointer : "  "}
                        <Text bold={selected}>
                            {number}
                            {item.label}
                        </Text>
                        {item.hint === undefined ? (
                            ""
                        ) : (
                            <Text dimColor {...(selected ? { color: THEME.muted } : {})}>
                                {"  "}
                                {item.hint}
                            </Text>
                        )}
                    </Text>
                )
            })}
        </Box>
    )
}
