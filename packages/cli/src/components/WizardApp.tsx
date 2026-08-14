/**
 * The init wizard's Ink root: one `useInput`, a pure reducer, and the kit.
 *
 * Deliberately NO `<Static>` anywhere here — answered lines are editable via esc-back, which is
 * incompatible with Static's write-once contract, and the whole wizard is a couple of dozen
 * dynamic rows with no streaming, so full-frame redraw is free. Do not "optimise" this into
 * Static; the transcript's constraints do not apply to a form.
 */

import { Box, Text, useApp, useInput } from "ink"
import { useCallback, useEffect, useReducer } from "react"
import { Banner } from "#components/Banner"
import { SelectList } from "#components/SelectList"
import { SummaryCard } from "#components/SummaryCard"
import { TextField } from "#components/TextField"
import { WizardFrame } from "#components/WizardFrame"
import { keyToWizardIntent } from "#keymap"
import type { PartialAnswers, QuestionDefaults } from "#lib/init-flow"
import { GLYPH, THEME } from "#lib/theme"
import {
    answeredRows,
    currentQuestion,
    isSecretStep,
    isSelectStep,
    partialOf,
    reduceWizard,
    selectOptions,
    startWizard,
    stepCounts,
    summaryRows,
    type WizardState,
} from "#lib/wizard"

export interface WizardAppProps {
    readonly title: string
    readonly given: PartialAnswers
    readonly defaults: QuestionDefaults
    /** The collected answers, or undefined when the person backed out. */
    readonly onDone: (answers: PartialAnswers | undefined) => void
}

export function WizardApp({ title, given, defaults, onDone }: WizardAppProps) {
    const { exit } = useApp()
    const [state, dispatch] = useReducer(
        (current: WizardState, action: Parameters<typeof reduceWizard>[1]) =>
            reduceWizard(current, action),
        undefined,
        () => startWizard(given, defaults),
    )

    const finish = useCallback(
        (answers: PartialAnswers | undefined) => {
            onDone(answers)
            exit()
        },
        [onDone, exit],
    )

    useEffect(() => {
        if (state.phase === "done") finish(partialOf(state))
        if (state.phase === "aborted") finish(undefined)
    }, [state, finish])

    useInput((input, key) => {
        const intent = keyToWizardIntent(input, key, {
            select: isSelectStep(state) || state.phase === "confirm",
            empty: state.editor.value === "",
        })
        switch (intent.kind) {
            case "abort":
                dispatch({ kind: "abort" })
                return
            case "back":
                dispatch({ kind: "back" })
                return
            case "commit":
                dispatch({ kind: "commit" })
                return
            case "list":
                dispatch({ kind: "list", intent: intent.intent })
                return
            case "edit":
                dispatch({ kind: "edit", intent: intent.intent })
                return
        }
    })

    if (state.phase === "done" || state.phase === "aborted") return null

    const counts = stepCounts(state)
    const hint =
        state.phase === "confirm"
            ? "enter confirm · esc back · ^C quit — nothing written"
            : "enter accepts · esc back · ^C quit — nothing written"

    return (
        <Box flexDirection="column">
            <Banner
                title={title}
                lines={["a few questions — nothing is written until you confirm"]}
            />
            {state.phase === "confirm" ? (
                <Box flexDirection="column" marginTop={1}>
                    <SummaryCard rows={summaryRows(state)} />
                    <Box marginTop={1} flexDirection="column">
                        <Text>Write the files?</Text>
                        <SelectList
                            items={[{ label: "yes" }, { label: "no, go back" }]}
                            index={state.select.index}
                        />
                    </Box>
                    <Text dimColor>{hint}</Text>
                </Box>
            ) : (
                <Box marginTop={1}>
                    <WizardFrame
                        step={counts.asked}
                        total={counts.total}
                        answered={answeredRows(state)}
                        hint={hint}
                    >
                        {isSelectStep(state) ? (
                            <Box flexDirection="column">
                                <Text>{currentQuestion(state)?.prompt ?? ""}</Text>
                                <SelectList
                                    items={selectOptions(state).map((option) => ({
                                        label: option.label,
                                    }))}
                                    index={state.select.index}
                                    numbered
                                />
                            </Box>
                        ) : (
                            <TextField
                                label={currentQuestion(state)?.prompt ?? ""}
                                editor={state.editor}
                                placeholder={currentQuestion(state)?.fallback ?? ""}
                                {...(state.error === undefined ? {} : { error: state.error })}
                                {...(isSecretStep(state) ? { secret: true } : {})}
                            />
                        )}
                    </WizardFrame>
                </Box>
            )}
            {state.error !== undefined && (isSelectStep(state) || state.phase === "confirm") ? (
                <Text color={THEME.error}>
                    {GLYPH.error}
                    {state.error}
                </Text>
            ) : null}
        </Box>
    )
}
