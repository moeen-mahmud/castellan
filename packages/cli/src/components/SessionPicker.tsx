/**
 * Which conversation to pick up — a bare `--session`, and the in-session `/sessions` switcher.
 *
 * A view under the Phase 5.5 contract: it never mounts itself, never calls `useApp().exit()`, and reports
 * through `onDone`. Two hosts use it, which is the point — `run` mounts it before the chat exists, and the
 * chat opens it as a pane — and neither is visible from here.
 *
 * `focused` gates the `useInput`, because Ink fires **every** active hook: a picker over a live prompt
 * would otherwise have two surfaces reading one keystroke, which is a wrong action rather than a
 * rendering fault.
 */

import { SelectList } from "#components/SelectList"
import { keyToListIntent } from "#keymap"
import { moveSelect, type SelectState } from "#lib/select"
import { sessionRows, type SessionRow, type SessionRowSource } from "#lib/sessions-view"
import { THEME } from "#lib/theme"
import { Box, Text, useInput } from "ink"
import { useState } from "react"

export interface SessionPickerProps {
    readonly sessions: readonly SessionRowSource[]
    /** Injected so the "3h ago" column is deterministic in a frame test. */
    readonly now: number
    readonly columns: number
    readonly maxRows: number
    /** The session currently in use, marked so switching away from it is a deliberate choice. */
    readonly current?: string
    readonly focused?: boolean
    /** A key to use, or `undefined` for "leave things as they are". */
    readonly onDone: (sessionKey: string | undefined) => void
}

export function SessionPicker({
    sessions,
    now,
    columns,
    maxRows,
    current,
    focused = true,
    onDone,
}: SessionPickerProps) {
    const rows: readonly SessionRow[] = sessionRows(sessions, { now, columns })
    const [select, setSelect] = useState<SelectState>({ index: 0, count: rows.length })

    useInput(
        (input, key) => {
            const intent = keyToListIntent(input, key)
            switch (intent.kind) {
                case "move":
                    setSelect((state) => moveSelect(state, intent.move))
                    return
                case "choose":
                    onDone(rows[select.index]?.key)
                    return
                case "back":
                case "exit":
                    onDone(undefined)
                    return
                case "none":
                    return
            }
        },
        { isActive: focused },
    )

    if (rows.length === 0) {
        return (
            <Box flexDirection="column">
                <Text color={THEME.muted} wrap="truncate">
                    {"  no stored conversations with this agent yet"}
                </Text>
                <Text dimColor wrap="truncate">
                    {"  esc starts a new one"}
                </Text>
            </Box>
        )
    }

    return (
        <Box flexDirection="column">
            <SelectList
                items={rows.map((row) => ({
                    label: row.label,
                    hint: row.key === current ? `${row.hint} · in use` : row.hint,
                }))}
                index={select.index}
                numbered
                maxRows={maxRows}
            />
            <Text dimColor wrap="truncate">
                {"  ↑↓ move · enter opens it · esc keeps the one you are in"}
            </Text>
        </Box>
    )
}
