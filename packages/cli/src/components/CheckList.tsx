/**
 * A grouped, scrolling, column-aligned multi-select list. One row is one line, always.
 *
 * Not `SelectList` with a flag: rows can be *headings* the cursor skips, rows carry a ticked state, and the
 * list is longer than a terminal, so it needs a viewport. Bending the existing component to do all three
 * would leave both callers reading conditionals.
 *
 * ## One row, one line
 *
 * The first version handed the whole description to Ink and let it wrap. Every long row became two or
 * three lines, the checkbox column stopped lining up, and forty skills were unreadable. All the width
 * arithmetic is in `lib/rows.ts` now — pure, so the layout is asserted as strings — and every field is
 * truncated before it can wrap. `wrap="truncate"` is set as well, but a backstop is not a layout: if the
 * columns did not add up, the cut would land at a width nobody chose.
 *
 * Controlled and presentational, like every component here: the cursor and the chosen set come from
 * `lib/multiselect.ts`, and the screen root owns the single `useInput`. Keyed on the row index rather than
 * the label, because two sources can carry a skill of the same name and a label key would collapse them.
 */

import { columnsFor, headingRule, layoutRow, viewport } from "#lib/rows"
import { GLYPH, THEME } from "#lib/theme"
import { Box, Text } from "ink"

export interface CheckRow {
    /** `source` is a top-level heading, `group` a subheading; neither is selectable. */
    readonly kind: "source" | "group" | "item"
    readonly label: string
    /** Right-aligned column: size and script count, or `installed`. */
    readonly meta?: string
    readonly description?: string
}

export interface CheckListProps {
    readonly rows: readonly CheckRow[]
    readonly index: number
    readonly chosen: readonly number[]
    /** Visible rows. The list scrolls inside this rather than growing past the terminal. */
    readonly window: number
    /** Terminal columns. Measured by the caller; this component never reads a stream. */
    readonly width: number
}

export function CheckList({ rows, index, chosen, window, width }: CheckListProps) {
    const { from, to } = viewport(rows.length, index, window)
    const picked = new Set(chosen)
    const longest = rows.reduce(
        (max, row) => (row.kind === "item" ? Math.max(max, row.label.length) : max),
        0,
    )
    const columns = columnsFor(width, longest)

    return (
        <Box flexDirection="column">
            {from > 0 ? (
                <Text dimColor wrap="truncate">
                    {"    "}
                    {GLYPH.ellipsis} {from} above
                </Text>
            ) : null}
            {rows.slice(from, to).map((row, offset) => {
                const at = from + offset
                if (row.kind !== "item") {
                    const source = row.kind === "source"
                    return (
                        <Text
                            key={at}
                            wrap="truncate"
                            bold={source}
                            color={source ? THEME.accent : THEME.muted}
                        >
                            {source ? "  " : "    "}
                            {headingRule(row.label, width - (source ? 2 : 4))}
                        </Text>
                    )
                }
                const selected = at === index
                const ticked = picked.has(at)
                const cells = layoutRow(
                    {
                        name: row.label,
                        meta: row.meta ?? "",
                        description: row.description ?? "",
                    },
                    columns,
                )
                return (
                    <Text key={at} wrap="truncate">
                        <Text color={THEME.accent}>{selected ? GLYPH.pointer : "  "}</Text>
                        <Text color={ticked ? THEME.success : THEME.muted}>
                            {ticked ? GLYPH.checked : GLYPH.unchecked}
                        </Text>
                        <Text bold={selected} {...(ticked ? { color: THEME.success } : {})}>
                            {cells.name}
                        </Text>
                        {"  "}
                        <Text color={THEME.muted}>{cells.meta}</Text>
                        {cells.description === "" ? "" : "  "}
                        <Text dimColor>{cells.description}</Text>
                    </Text>
                )
            })}
            {to < rows.length ? (
                <Text dimColor wrap="truncate">
                    {"    "}
                    {GLYPH.ellipsis} {rows.length - to} below
                </Text>
            ) : null}
        </Box>
    )
}
