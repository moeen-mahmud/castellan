/**
 * The agent picker: bare `run` at a terminal, one keystroke from any sandbox agent.
 *
 * One `useInput` over the pure list keymap and select reducer; the kit renders. Broken agents
 * are listed with their problem — dim, unselectable-looking but still runnable, because a person
 * debugging a manifest wants to reach it, not to be protected from it.
 */

import { Banner } from "#components/Banner"
import { SelectList } from "#components/SelectList"
import { keyToListIntent } from "#keymap"
import type { SandboxAgent } from "#lib/sandbox"
import { moveSelect, type SelectState } from "#lib/select"
import { GLYPH } from "#lib/theme"
import { Box, useApp, useInput } from "ink"
import { useCallback, useState } from "react"

export type PickerResult =
    | { readonly kind: "run"; readonly manifestPath: string }
    | { readonly kind: "create" }
    | { readonly kind: "quit" }

export interface PickerProps {
    readonly title: string
    readonly agents: readonly SandboxAgent[]
    readonly onDone: (result: PickerResult) => void
}

export function Picker({ title, agents, onDone }: PickerProps) {
    const { exit } = useApp()
    // The final row is always "+ create a new agent".
    const [select, setSelect] = useState<SelectState>({ index: 0, count: agents.length + 1 })

    const finish = useCallback(
        (result: PickerResult) => {
            onDone(result)
            exit()
        },
        [onDone, exit],
    )

    useInput((input, key) => {
        const intent = keyToListIntent(input, key)
        switch (intent.kind) {
            case "move":
                setSelect((current) => moveSelect(current, intent.move))
                return
            case "choose": {
                const agent = agents[select.index]
                finish(
                    agent === undefined
                        ? { kind: "create" }
                        : { kind: "run", manifestPath: agent.manifestPath },
                )
                return
            }
            case "back":
            case "exit":
                finish({ kind: "quit" })
                return
            case "none":
                return
        }
    })

    const items = [
        ...agents.map((agent) => ({
            label: agent.name ?? agent.ref,
            hint:
                agent.problem !== undefined
                    ? `⚠ ${agent.problem}`
                    : `${agent.modelId ?? "?"} ${GLYPH.bullet}${agent.ref}`,
        })),
        { label: `${GLYPH.create}create a new agent` },
    ]

    return (
        <Box flexDirection="column">
            <Banner title={title} lines={["pick an agent · enter runs it · esc quits"]} />
            <Box marginTop={1}>
                <SelectList items={items} index={select.index} numbered />
            </Box>
        </Box>
    )
}
