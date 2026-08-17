/**
 * Bare `skills` at a terminal: tick the skills you want, then pick the agent.
 *
 * Two screens in one root, because they are one decision. Splitting them into two Ink mounts would mean
 * two `render()` calls, two chances for the terminal to be left dirty, and a person who picks four skills
 * and then discovers the agent list is empty with no way back.
 *
 * One `useInput`, as every screen root here has: the checklist step reads `keyToCheckIntent` and the agent
 * step reads `keyToListIntent`, both pure, and all the state lives in `lib/multiselect.ts` and
 * `lib/select.ts`. The rows themselves come from `lib/browse.ts`, which the plain path also reads — so a
 * pipe prints the same list in the same order.
 */

import { Box, Text, useApp, useInput } from "ink"
import { useCallback, useState } from "react"
import { Banner } from "#components/Banner"
import { CheckList } from "#components/CheckList"
import { SelectList } from "#components/SelectList"
import { keyToCheckIntent, keyToListIntent } from "#keymap"
import type { BrowseRow } from "#lib/browse"
import { chosenEntries, selectableOf } from "#lib/browse"
import { firstSelectable, type MultiSelectState, reduceMultiSelect } from "#lib/multiselect"
import type { SandboxAgent } from "#lib/sandbox"
import { moveSelect, type SelectState } from "#lib/select"
import type { CatalogueEntry } from "#lib/source-cache"
import { GLYPH, THEME } from "#lib/theme"

export type BrowseResult =
    | {
          readonly kind: "install"
          readonly skills: readonly CatalogueEntry[]
          readonly manifestPath: string
      }
    | { readonly kind: "quit" }

export interface SkillBrowserProps {
    readonly rows: readonly BrowseRow[]
    /** Terminal columns. Measured by the caller — a component must not read a stream. */
    readonly width: number
    readonly agents: readonly SandboxAgent[]
    /**
     * Install into this manifest and never ask which agent.
     *
     * `init` passes the agent it is in the middle of creating: there is exactly one possible answer and it
     * does not exist in the sandbox listing yet, so the second screen would be both empty and pointless.
     */
    readonly target?: string
    /** Terminal rows to spend on the list. The caller measures; this component never reads a stream. */
    readonly window: number
    readonly onDone: (result: BrowseResult) => void
}

export function SkillBrowser({ rows, agents, window, width, target, onDone }: SkillBrowserProps) {
    const { exit } = useApp()
    const selectable = selectableOf(rows)
    const [step, setStep] = useState<"skills" | "agent">("skills")
    const [picked, setPicked] = useState<MultiSelectState>({
        cursor: { index: firstSelectable(selectable), count: rows.length },
        chosen: [],
    })
    const [agent, setAgent] = useState<SelectState>({ index: 0, count: agents.length })

    const finish = useCallback(
        (result: BrowseResult) => {
            onDone(result)
            exit()
        },
        [onDone, exit],
    )

    useInput((input, key) => {
        if (step === "skills") {
            const intent = keyToCheckIntent(input, key)
            switch (intent.kind) {
                case "move":
                case "toggle":
                case "all":
                    setPicked((current) =>
                        reduceMultiSelect(
                            current,
                            intent.kind === "move"
                                ? { kind: "move", move: intent.move }
                                : { kind: intent.kind },
                            selectable,
                        ),
                    )
                    return
                case "none-selected":
                    setPicked((current) => reduceMultiSelect(current, { kind: "none" }, selectable))
                    return
                case "confirm":
                    // Nothing ticked is not a reason to advance: enter with an empty set would land on an
                    // agent picker that has nothing to install, and the person would find out one screen
                    // later. `a` ticks everything if that was the intent.
                    if (picked.chosen.length === 0) return
                    if (target !== undefined) {
                        finish({
                            kind: "install",
                            skills: chosenEntries(rows, picked.chosen),
                            manifestPath: target,
                        })
                        return
                    }
                    // With one agent there is no choice to offer, and asking would be a keypress that
                    // cannot go any other way.
                    if (agents.length === 1) {
                        finish({
                            kind: "install",
                            skills: chosenEntries(rows, picked.chosen),
                            manifestPath: agents[0]?.manifestPath ?? "",
                        })
                        return
                    }
                    setStep("agent")
                    return
                case "cancel":
                    finish({ kind: "quit" })
                    return
                case "none":
                    return
            }
        }

        const intent = keyToListIntent(input, key)
        switch (intent.kind) {
            case "move":
                setAgent((current) => moveSelect(current, intent.move))
                return
            case "choose": {
                const chosen = agents[agent.index]
                if (chosen === undefined) return
                finish({
                    kind: "install",
                    skills: chosenEntries(rows, picked.chosen),
                    manifestPath: chosen.manifestPath,
                })
                return
            }
            case "back":
                // Back to the skills, keeping what was ticked. The reason both steps live in one root.
                setStep("skills")
                return
            case "exit":
                finish({ kind: "quit" })
                return
            case "none":
                return
        }
    })

    const count = picked.chosen.length
    if (step === "agent") {
        return (
            <Box flexDirection="column">
                <Banner
                    title={`Install ${count} skill${count === 1 ? "" : "s"}`}
                    lines={["pick an agent · enter installs · esc goes back"]}
                />
                <Box marginTop={1}>
                    <SelectList
                        items={agents.map((entry) => ({
                            label: entry.name ?? entry.ref,
                            hint:
                                entry.problem === undefined
                                    ? `${entry.modelId ?? "?"} ${GLYPH.bullet}${entry.ref}`
                                    : `⚠ ${entry.problem}`,
                        }))}
                        index={agent.index}
                        numbered
                    />
                </Box>
            </Box>
        )
    }

    return (
        <Box flexDirection="column">
            <Banner
                title="Skills"
                lines={[
                    `space ticks · a all · n none · enter ${target === undefined ? "continues" : "installs"} · esc ${target === undefined ? "quits" : "skips"}`,
                ]}
            />
            <Box marginTop={1}>
                <CheckList
                    rows={rows}
                    index={picked.cursor.index}
                    chosen={picked.chosen}
                    window={window}
                    width={width}
                />
            </Box>
            <Box marginTop={1}>
                <Text color={count === 0 ? THEME.muted : THEME.success}>
                    {count === 0 ? "nothing ticked yet" : `${count} ticked`}
                </Text>
            </Box>
        </Box>
    )
}
