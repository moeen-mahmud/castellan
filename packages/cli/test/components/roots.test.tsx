/**
 * The screen roots, as painted and as driven by a keyboard.
 *
 * These are the components that own state and a `useInput`, so the assertions here press keys and read
 * the frame that came back — the closest thing to a person using the thing that a test can be.
 *
 * The stubs are structural on purpose. `App` needs an `Agent` and an `EventBus`, and standing up a real
 * runtime to check that a transcript renders would make the test slow, order-dependent and dishonest
 * about what it covers. What is stubbed is exactly the surface the component calls; anything else it
 * reached for would be a type error rather than a silent pass.
 */

import { describe, expect, test } from "bun:test"
import { createElement as h } from "react"
import { App } from "#components/App"
import { Picker } from "#components/Picker"
import { SkillBrowser } from "#components/SkillBrowser"
import { WizardApp } from "#components/WizardApp"
import type { BrowseRow } from "#lib/browse"
import type { SandboxAgent } from "#lib/sandbox"
import type { AppProps } from "#lib/schema"
import { GLYPH } from "#lib/theme"
import { KEY, mount, overflowing } from "../helpers/frame.tsx"

const AGENTS: readonly SandboxAgent[] = [
    {
        ref: "milo",
        name: "milo",
        manifestPath: "/tmp/milo/agent.yaml",
        dir: "/tmp/milo",
        modelId: "qwen3.5:9b",
        mtimeMs: 0,
    },
    {
        ref: "ada",
        name: "ada",
        manifestPath: "/tmp/ada/agent.yaml",
        dir: "/tmp/ada",
        modelId: "claude-sonnet-5",
        mtimeMs: 0,
    },
]

describe("Picker", () => {
    test("lists the agents and always offers a new one", () => {
        const harness = mount(h(Picker, { title: "Agents", agents: AGENTS, onDone: () => {} }), {
            columns: 80,
        })
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("milo")
        expect(frame.text).toContain("ada")
        // The final row is always "create a new agent" — a picker with no agents must still lead
        // somewhere.
        expect(frame.text).toContain("create")
    })

    test("the arrows move the cursor and enter chooses that row", async () => {
        let chosen: unknown
        const harness = mount(
            h(Picker, {
                title: "Agents",
                agents: AGENTS,
                onDone: (result: unknown) => {
                    chosen = result
                },
            }),
            { columns: 80 },
        )
        await harness.press(KEY.down, KEY.enter)
        harness.unmount()
        expect(chosen).toMatchObject({ manifestPath: "/tmp/ada/agent.yaml" })
    })

    test("an empty sandbox still renders a way forward", () => {
        const harness = mount(h(Picker, { title: "Agents", agents: [], onDone: () => {} }), {
            columns: 80,
        })
        const frame = harness.frame()
        harness.unmount()
        expect(frame.lines.length).toBeGreaterThan(0)
        expect(frame.text).toContain("create")
    })
})

const ROWS: readonly BrowseRow[] = [
    { kind: "source", label: "anthropic  2 skills" },
    {
        kind: "item",
        label: "pdf",
        meta: "2.3k · 8 scripts",
        description: "Do things with PDFs.",
        entry: {
            source: "anthropic",
            skill: "pdf",
            dir: "/cache/anthropic/skills/pdf",
            repoPath: "skills/pdf",
            description: "Do things with PDFs.",
            tokens: 2300,
            scripts: ["scripts/fill.py"],
        },
    },
    {
        kind: "item",
        label: "docx",
        meta: "1.6k",
        description: "Do things with Word files.",
        entry: {
            source: "anthropic",
            skill: "docx",
            dir: "/cache/anthropic/skills/docx",
            repoPath: "skills/docx",
            description: "Do things with Word files.",
            tokens: 1600,
            scripts: [],
        },
    },
]

describe("SkillBrowser", () => {
    function browser(onDone: (result: unknown) => void) {
        return mount(
            h(SkillBrowser, {
                rows: ROWS,
                agents: AGENTS,
                window: 20,
                width: 100,
                onDone,
            }),
            { columns: 100 },
        )
    }

    test("space ticks a row and the count says how many", async () => {
        const harness = browser(() => {})
        expect(harness.frame().text).toContain("nothing ticked yet")
        await harness.press(KEY.space)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("1 ticked")
        expect(frame.text).toContain(GLYPH.checked.trim())
    })

    test("enter with nothing ticked does not advance", async () => {
        // Advancing would land on an agent picker with nothing to install, and the person would find
        // out one screen later.
        const harness = browser(() => {})
        await harness.press(KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("nothing ticked yet")
        expect(frame.text).not.toContain("pick an agent")
    })

    test("with several agents, enter asks which one", async () => {
        const harness = browser(() => {})
        await harness.press(KEY.space, KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("pick an agent")
        expect(frame.text).toContain("milo")
    })

    test("with exactly one agent it does not ask", async () => {
        let result: unknown
        const harness = mount(
            h(SkillBrowser, {
                rows: ROWS,
                agents: [AGENTS[0] as SandboxAgent],
                window: 20,
                width: 100,
                onDone: (picked: unknown) => {
                    result = picked
                },
            }),
            { columns: 100 },
        )
        await harness.press(KEY.space, KEY.enter)
        harness.unmount()
        expect(result).toMatchObject({ kind: "install", manifestPath: "/tmp/milo/agent.yaml" })
    })

    test("esc from the agent step goes back with the ticks intact", async () => {
        // The reason both steps live in one root: backing out must not lose what was chosen.
        const harness = browser(() => {})
        await harness.press(KEY.space, KEY.enter, KEY.escape)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("1 ticked")
    })

    test("`a` ticks everything and `n` clears it", async () => {
        const harness = browser(() => {})
        await harness.press("a")
        expect(harness.frame().text).toContain("2 ticked")
        await harness.press("n")
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("nothing ticked yet")
    })

    test("the cursor never lands on a heading", async () => {
        // A cursor parked where enter does nothing reads as a broken keyboard.
        const harness = browser(() => {})
        await harness.press(KEY.up, KEY.up, KEY.up)
        const frame = harness.frame()
        harness.unmount()
        const pointed = frame.lines.find((line) => line.includes(GLYPH.pointer.trim()))
        expect(pointed).toBeDefined()
        expect(pointed).not.toContain("anthropic  2 skills")
    })

    test("nothing wraps at a narrow terminal", () => {
        const harness = mount(
            h(SkillBrowser, {
                rows: ROWS,
                agents: AGENTS,
                window: 20,
                width: 40,
                onDone: () => {},
            }),
            { columns: 40 },
        )
        const frame = harness.frame()
        harness.unmount()
        expect(overflowing(frame, 40)).toEqual([])
    })
})

describe("WizardApp", () => {
    test("asks the first question and counts the steps honestly", () => {
        const harness = mount(
            h(WizardApp, { title: "Setup", given: {}, defaults: {}, onDone: () => {} }),
            { columns: 80 },
        )
        const frame = harness.frame()
        harness.unmount()
        // The step counter walks the flow the way it will actually be asked, so a total is a real
        // number rather than a guess that stops being true.
        expect(frame.text).toMatch(/\d+ of \d+/)
    })

    test("typing an answer and pressing enter advances", async () => {
        const harness = mount(
            h(WizardApp, { title: "Setup", given: {}, defaults: {}, onDone: () => {} }),
            { columns: 80 },
        )
        const before = harness.frame().text
        await harness.press("M", "o", "e", "e", "n", KEY.enter)
        const after = harness.frame()
        harness.unmount()
        expect(after.text).not.toBe(before)
        expect(after.text).toContain("Moeen")
    })
})

/** The narrow surface `App` actually calls. Anything else it reached for would be a type error. */
function stubAppProps(): AppProps {
    const filter = { push: (text: string) => text, endStep: () => "", end: () => "" }
    const agent = {
        streamFilter: () => filter,
        describe: () => ({ dialect: "nlt", catalogueTokens: 120 }),
        tools: { specs: () => [] },
        clearSession: async () => {},
        send: async () => {},
    }
    const bus = { on: () => () => {} }
    return {
        // Cast through `unknown` to the real prop types: a structural stub of the surface App calls.
        // Standing up a live runtime to check that a transcript renders would be slower and cover less,
        // and anything else the component reached for would be a type error here rather than a pass.
        agent: agent as unknown as AppProps["agent"],
        bus: bus as unknown as AppProps["bus"],
        sessionKey: "local:default",
        model: "qwen3.5:9b",
        initial: { items: [], live: undefined, status: "idle", nextId: 1 },
        showReasoning: false,
        quiet: false,
    }
}

describe("App", () => {
    test("renders a prompt and a status line with no history", () => {
        const harness = mount(h(App, stubAppProps()), { columns: 100 })
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("ready")
        expect(frame.text).toContain("qwen3.5:9b")
    })

    test("a draft handed in by a restart is on the line, cursor at its end", async () => {
        // The only state that cannot survive a `/restart` on its own: everything else is either in the
        // store or rebuilt from the manifest, while an unsent message lives in a component the restart
        // unmounts. Throwing it away would be a second, unasked-for consequence of asking for the first.
        const harness = mount(h(App, { ...stubAppProps(), initialDraft: "half a thought" }), {
            columns: 100,
        })
        const frame = harness.frame()
        await harness.press("!")
        const typed = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("half a thought")
        expect(typed.text).toContain("half a thought!")
    })

    test("a pasted block becomes one message, not one per line", async () => {
        // It used to submit every finished line, which was right when the buffer could not hold a
        // newline. Now that a message is composed, twelve lines pasted meant twelve messages, each
        // conditioned on the last and none of them editable.
        const sent: string[] = []
        const props = stubAppProps()
        const harness = mount(
            h(App, {
                ...props,
                agent: {
                    ...props.agent,
                    send: async (input: { text: string }) => {
                        sent.push(input.text)
                    },
                } as unknown as AppProps["agent"],
            }),
            { columns: 100 },
        )
        await harness.press("line one\nline two\nline three")
        const frame = harness.frame()
        harness.unmount()
        expect(sent).toEqual([])
        expect(frame.text).toContain("line one")
        expect(frame.text).toContain("line three")
    })

    test("an unknown slash command is refused rather than sent to the model", async () => {
        // `/skils` costs a model call and a confusing reply if it is treated as a prompt.
        const harness = mount(h(App, stubAppProps()), { columns: 100 })
        await harness.press("/", "s", "k", "i", "l", "s", KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("not a command")
    })
})
