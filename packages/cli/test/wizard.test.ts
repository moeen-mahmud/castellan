/**
 * The wizard reducer: forward flow, esc-back over the answer log, and the honest step count.
 *
 * Driven exactly the way `WizardApp` drives it, so a passing test here is the wizard working —
 * the component adds only pixels.
 */

import { describe, expect, test } from "bun:test"
import {
    currentQuestion,
    isSelectStep,
    partialOf,
    reduceWizard,
    startWizard,
    stepCounts,
    summaryRows,
    type WizardState,
} from "#lib/wizard"

function type(state: WizardState, text: string): WizardState {
    return [...text].reduce(
        (current, char) =>
            reduceWizard(current, { kind: "edit", intent: { kind: "insert", text: char } }),
        state,
    )
}

function commit(state: WizardState): WizardState {
    return reduceWizard(state, { kind: "commit" })
}

function answer(state: WizardState, text: string): WizardState {
    return commit(type(state, text))
}

describe("the happy path", () => {
    test("answers every step, reaches confirm, and yields the collected answers", () => {
        let state = startWizard({}, {})
        state = answer(state, "Moeen") // user
        state = answer(state, "Milo") // name
        state = commit(state) // purpose: empty commit takes the fallback
        // preset: select step; move to deepseek (index 2) and choose
        expect(isSelectStep(state)).toBe(true)
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "jump", index: 2 } },
        })
        state = commit(state)
        state = commit(state) // model: preset default
        state = commit(state) // baseUrl: preset default
        state = commit(state) // apiKeyEnv: default MODEL_API_KEY
        state = commit(state) // dir: derived from name
        expect(state.phase).toBe("confirm")

        const partial = partialOf(state)
        expect(partial.user).toBe("Moeen")
        expect(partial.preset).toBe("deepseek")
        expect(partial.model).toBe("deepseek-chat")
        expect(partial.dir).toBe("./milo")

        // Confirm: index 0 is yes.
        state = commit(state)
        expect(state.phase).toBe("done")
    })

    test("a keyless preset skips the key question and the step total shrinks", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x" }, {})
        const totalBefore = stepCounts(state).total
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "jump", index: 3 } },
        }) // ollama
        state = commit(state)
        expect(stepCounts(state).total).toBe(totalBefore - 1)
        state = commit(state) // model default
        state = commit(state) // baseUrl default
        state = commit(state) // dir — apiKeyEnv was skipped
        expect(state.phase).toBe("confirm")
        expect(partialOf(state).apiKeyEnv).toBe(undefined)
    })
})

describe("validation", () => {
    test("an invalid answer sets the error and stays on the question", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x", preset: "custom" }, {})
        state = answer(state, "some-model") // model (custom has no default)
        state = answer(state, "https://x.example/v1/chat/completions") // baseUrl — the classic mistake
        expect(state.error).toContain("version segment")
        expect(currentQuestion(state)?.step).toBe("baseUrl")
        // Editing clears the error.
        state = reduceWizard(state, { kind: "edit", intent: { kind: "killToStart" } })
        expect(state.error).toBe(undefined)
    })
})

describe("back navigation", () => {
    test("esc pops the last wizard answer; flag-given answers are never poppable", () => {
        let state = startWizard({ user: "Moeen" }, {})
        state = answer(state, "Milo") // name (wizard-asked)
        expect(currentQuestion(state)?.step).toBe("purpose")
        state = reduceWizard(state, { kind: "back" })
        expect(currentQuestion(state)?.step).toBe("name")
        // Backing again does nothing: `user` came from a flag and stays answered.
        state = reduceWizard(state, { kind: "back" })
        expect(currentQuestion(state)?.step).toBe("name")
        expect(partialOf(state).user).toBe("Moeen")
    })

    test("re-answering the preset re-derives the downstream defaults", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x" }, {})
        state = commit(state) // preset: default index 0 = openai
        expect(currentQuestion(state)?.fallback).toBe("gpt-4o-mini")
        state = reduceWizard(state, { kind: "back" }) // back onto preset
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "jump", index: 2 } },
        })
        state = commit(state) // deepseek now
        expect(currentQuestion(state)?.fallback).toBe("deepseek-chat")
    })

    test("declining the confirm screen reopens the last question", () => {
        let state = startWizard({ user: "M", name: "Pip", purpose: "x", preset: "ollama" }, {})
        state = commit(state) // model
        state = commit(state) // baseUrl
        state = commit(state) // dir
        expect(state.phase).toBe("confirm")
        state = reduceWizard(state, {
            kind: "list",
            intent: { kind: "move", move: { kind: "down" } },
        })
        state = commit(state) // "no, go back"
        expect(state.phase).toBe("asking")
        expect(currentQuestion(state)?.step).toBe("dir")
    })
})

describe("abort", () => {
    test("abort works from any phase and is terminal", () => {
        let state = startWizard({}, {})
        state = reduceWizard(state, { kind: "abort" })
        expect(state.phase).toBe("aborted")
        expect(reduceWizard(state, { kind: "commit" }).phase).toBe("aborted")
    })
})

describe("flags answering everything", () => {
    test("opens directly on confirm rather than asking zero questions", () => {
        const state = startWizard(
            {
                user: "Moeen",
                name: "Milo",
                purpose: "x",
                preset: "deepseek",
                model: "deepseek-chat",
                baseUrl: "https://api.deepseek.com/v1",
                apiKeyEnv: "MODEL_API_KEY",
                dir: "./milo",
            },
            {},
        )
        expect(state.phase).toBe("confirm")
        expect(summaryRows(state).map((row) => row.label)).toEqual([
            "agent",
            "for",
            "endpoint",
            "directory",
        ])
    })
})
