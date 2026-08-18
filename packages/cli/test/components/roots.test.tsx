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
import { Brandmark } from "#components/Brandmark"
import { Picker } from "#components/Picker"
import { SessionPicker, type SessionPickerProps } from "#components/SessionPicker"
import { SkillBrowser } from "#components/SkillBrowser"
import { WizardApp } from "#components/WizardApp"
import type { BrowseRow, InstallReport } from "#lib/browse"
import type { SandboxAgent } from "#lib/sandbox"
import type { AppProps } from "#lib/schema"
import type { CatalogueEntry } from "#lib/source-cache"
import { GLYPH, SPINNER_FRAMES } from "#lib/theme"
import { wordmark } from "#lib/wordmark"
import { KEY, mount, overflowing, renderFrame } from "../helpers/frame.tsx"

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
    /** A load that resolves when the test says so, so the fetching stage can be observed. */
    function deferred() {
        let settle: (rows: readonly BrowseRow[]) => void = () => {}
        let fail: (error: Error) => void = () => {}
        const promise = new Promise<readonly BrowseRow[]>((resolve, reject) => {
            settle = resolve
            fail = reject
        })
        return { promise, settle, fail }
    }

    const REPORT: InstallReport = {
        installed: ["pdf"],
        failed: [],
        runnable: 1,
        withCode: 1,
        total: 1,
    }

    function browser(
        options: {
            load?: (onStatus: (line: string) => void) => Promise<readonly BrowseRow[]>
            install?: (
                skills: readonly CatalogueEntry[],
                manifestPath: string,
            ) => Promise<InstallReport>
            agents?: readonly SandboxAgent[]
            target?: string
            onDone?: (report: InstallReport | undefined) => void
        } = {},
    ) {
        return mount(
            h(SkillBrowser, {
                title: "Skills",
                load: options.load ?? (async () => ROWS),
                install: options.install ?? (async () => REPORT),
                agents: options.agents ?? AGENTS,
                onDone: options.onDone ?? (() => {}),
                ...(options.target === undefined ? {} : { target: options.target }),
            }),
            { columns: 100, rows: 30 },
        )
    }

    test("the wait is rendered, not printed — a spinner and the source being fetched", async () => {
        // The defect this stage exists to fix: the command used to fetch before mounting, so twenty
        // seconds of cloning went to stdout with no frame on screen.
        const gate = deferred()
        const harness = browser({
            load: (onStatus) => {
                onStatus("fetching anthropic (1 of 2)")
                return gate.promise
            },
        })
        await harness.settle(30)
        const frame = harness.frame()
        expect(frame.text).toContain("fetching anthropic (1 of 2)")
        expect(SPINNER_FRAMES.some((glyph) => frame.text.includes(glyph))).toBe(true)
        gate.settle(ROWS)
        await harness.settle(30)
        expect(harness.frame().text).toContain("pdf")
        harness.unmount()
    })

    test("a failed fetch is shown in the frame rather than thrown", async () => {
        const harness = browser({ load: async () => Promise.reject(new Error("git not found")) })
        await harness.settle(40)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("git not found")
    })

    test("an empty catalogue says so and points at the command that explains it", async () => {
        const harness = browser({ load: async () => [] })
        await harness.settle(40)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("no catalogue could be read")
        expect(frame.text).toContain("sources update")
    })

    test("space ticks a row and the header says how many", async () => {
        const harness = browser()
        await harness.settle(30)
        expect(harness.frame().text).toContain("nothing ticked yet")
        await harness.press(KEY.space)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("1 ticked")
        expect(frame.text).toContain(GLYPH.checked.trim())
    })

    test("enter with nothing ticked does not advance", async () => {
        const harness = browser()
        await harness.settle(30)
        await harness.press(KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("nothing ticked yet")
        expect(frame.text).not.toContain("pick an agent")
    })

    test("with several agents, enter asks which one", async () => {
        const harness = browser()
        await harness.settle(30)
        await harness.press(KEY.space, KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("pick an agent")
        expect(frame.text).toContain("milo")
    })

    test("with exactly one agent it installs without asking", async () => {
        const installed: string[] = []
        const harness = browser({
            agents: [AGENTS[0] as SandboxAgent],
            install: async (skills, manifestPath) => {
                installed.push(manifestPath)
                return { ...REPORT, total: skills.length }
            },
        })
        await harness.settle(30)
        await harness.press(KEY.space, KEY.enter)
        await harness.settle(30)
        harness.unmount()
        expect(installed).toEqual(["/tmp/milo/agent.yaml"])
    })

    test("the install happens inside the frame, with the result on screen", async () => {
        // It used to be printed after the unmount, so the last thing on screen was the picker.
        const harness = browser({ target: "/tmp/x/agent.yaml" })
        await harness.settle(30)
        await harness.press(KEY.space, KEY.enter)
        await harness.settle(40)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("installed 1 of 1")
        expect(frame.text).toContain("runnable file")
        expect(frame.text).toContain("restart the agent")
    })

    test("a failure is named in the result rather than swallowed", async () => {
        const harness = browser({
            target: "/tmp/x/agent.yaml",
            install: async () => ({
                installed: [],
                failed: [{ name: "pptx", reason: "already installed" }],
                runnable: 0,
                withCode: 0,
                total: 1,
            }),
        })
        await harness.settle(30)
        await harness.press(KEY.space, KEY.enter)
        await harness.settle(40)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("pptx — already installed")
    })

    test("the report reaches the host, so the host can print a pointer after restoring", async () => {
        let handed: InstallReport | undefined
        const harness = browser({
            target: "/tmp/x/agent.yaml",
            onDone: (result) => {
                handed = result
            },
        })
        await harness.settle(30)
        await harness.press(KEY.space, KEY.enter)
        await harness.settle(40)
        await harness.press("q")
        harness.unmount()
        expect(handed).toMatchObject({ installed: ["pdf"] })
    })

    test("it never exits by itself — the host owns that", async () => {
        // A view that called `useApp().exit()` could not be a pane over a live chat.
        let done = 0
        const harness = browser({
            onDone: () => {
                done += 1
            },
        })
        await harness.settle(30)
        await harness.press(KEY.escape)
        harness.unmount()
        expect(done).toBe(1)
    })

    test("esc from the agent step goes back with the ticks intact", async () => {
        const harness = browser()
        await harness.settle(30)
        await harness.press(KEY.space, KEY.enter, KEY.escape)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("1 ticked")
    })

    test("`a` ticks everything and `n` clears it", async () => {
        const harness = browser()
        await harness.settle(30)
        await harness.press("a")
        expect(harness.frame().text).toContain("2 ticked")
        await harness.press("n")
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("nothing ticked yet")
    })

    test("the cursor never lands on a heading", async () => {
        const harness = browser()
        await harness.settle(30)
        await harness.press(KEY.up, KEY.up, KEY.up)
        const frame = harness.frame()
        harness.unmount()
        const pointed = frame.lines.find((line) => line.includes(GLYPH.pointer.trim()))
        expect(pointed).toBeDefined()
        expect(pointed).not.toContain("anthropic  2 skills")
    })

    test("an unfocused view ignores the keyboard entirely", async () => {
        // Ink fires every active `useInput`, so a pane over a live prompt would otherwise tick a box
        // with the keystroke somebody meant for their message.
        const harness = mount(
            h(SkillBrowser, {
                title: "Skills",
                load: async () => ROWS,
                install: async () => REPORT,
                agents: AGENTS,
                focused: false,
                onDone: () => {},
            }),
            { columns: 100, rows: 30 },
        )
        await harness.settle(30)
        await harness.press(KEY.space)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("nothing ticked yet")
    })

    test("it follows a resize instead of staying at the width it launched with", async () => {
        const harness = browser()
        await harness.settle(30)
        const wide = harness.frame()
        await harness.resize(50)
        const narrow = harness.frame()
        harness.unmount()
        expect(overflowing(narrow, 50)).toEqual([])
        expect(narrow.widest).toBeLessThan(wide.widest)
    })

    for (const columns of [40, 80, 140]) {
        test(`nothing wraps at ${columns} columns`, async () => {
            const harness = mount(
                h(SkillBrowser, {
                    title: "Skills",
                    load: async () => ROWS,
                    install: async () => REPORT,
                    agents: AGENTS,
                    onDone: () => {},
                }),
                { columns, rows: 30 },
            )
            await harness.settle(30)
            const frame = harness.frame()
            harness.unmount()
            expect(overflowing(frame, columns)).toEqual([])
        })
    }
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
        agentName: "milo",
        initial: { items: [], live: undefined, status: "idle", nextId: 1 },
        showReasoning: false,
        quiet: false,
    }
}

/** A conversation long enough that no terminal shows all of it. */
function longHistory(turns: number): AppProps["initial"] {
    return {
        items: Array.from({ length: turns }, (_, at) => ({
            id: `t${at}`,
            role: at % 2 === 0 ? ("user" as const) : ("assistant" as const),
            text: `message number ${at}`,
        })),
        live: undefined,
        status: "idle" as const,
        nextId: turns,
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

    test("the header names the agent and the model, and stays put", () => {
        // The banner says all of this too, and on the alternate screen the banner scrolls out of the
        // window — so the two facts that identify what you are talking to have to be somewhere that does
        // not move.
        const harness = mount(h(App, { ...stubAppProps(), initial: longHistory(40) }), {
            columns: 100,
            rows: 24,
        })
        const frame = harness.frame()
        harness.unmount()
        expect(frame.lines[0]).toContain("milo")
        expect(frame.lines[0]).toContain("qwen3.5:9b")
    })
})

describe("App, on a screen with a hard ceiling", () => {
    /**
     * The one property the alternate screen makes non-negotiable.
     *
     * There is no scrollback to absorb an overshoot: a frame one row taller than the terminal makes Ink's
     * own output scroll the buffer, which leaves the status line halfway up the display and the composer
     * where the status line was. `chatFrame` restates each component's geometry to prevent that, and this
     * is what stops the restatement drifting from the components it describes.
     */
    for (const rows of [10, 16, 24, 40]) {
        for (const columns of [60, 80, 100]) {
            test(`the whole frame fits ${rows} rows at ${columns} columns`, () => {
                // Narrow widths are in the loop because that is how the first real overflow happened: the
                // status line was longer than 80 columns, Ink wrapped it onto a second row, and the frame
                // came out one row taller than it was laid out for. At 100 columns it fit and nothing was
                // wrong. A height check at one width is a height check that passes at one width.
                const props = {
                    ...stubAppProps(),
                    initial: longHistory(60),
                    // The longest status line this component can produce: a model id, a session key and a
                    // finished turn's counters.
                    model: "deepseek-v4-pro",
                    sessionKey: "live:two",
                }
                const harness = mount(h(App, props), { columns, rows })
                const frame = harness.frame()
                harness.unmount()
                expect(frame.lines.length).toBeLessThanOrEqual(rows)
                expect(overflowing(frame, columns)).toEqual([])
            })
        }
    }

    test("it still fits once the composer has scrolled internally", async () => {
        const harness = mount(h(App, { ...stubAppProps(), initial: longHistory(60) }), {
            columns: 100,
            rows: 24,
        })
        for (let line = 0; line < 14; line += 1) {
            await harness.press("a line", KEY.metaEnter)
        }
        const frame = harness.frame()
        harness.unmount()
        expect(frame.lines.length).toBeLessThanOrEqual(24)
        // Scrolled, not grown past its cap: the notice is what says so.
        expect(frame.text).toContain("lines above")
    })

    test("it still fits with the palette open", async () => {
        // Separately from the composer, and that is not laziness. `paletteFor` matches the *whole* buffer
        // against a lone `/word`, so a palette over a multi-line message is unreachable by construction —
        // `chatFrame` adds both anyway, which over-counts in the safe direction.
        const harness = mount(h(App, { ...stubAppProps(), initial: longHistory(60) }), {
            columns: 100,
            rows: 24,
        })
        await harness.press("/")
        const frame = harness.frame()
        harness.unmount()
        expect(frame.lines.length).toBeLessThanOrEqual(24)
        expect(frame.text).toContain("/status")
    })

    test("resizing re-lays the frame rather than keeping the launch height", async () => {
        const harness = mount(h(App, { ...stubAppProps(), initial: longHistory(60) }), {
            columns: 100,
            rows: 40,
        })
        expect(harness.frame().lines.length).toBeLessThanOrEqual(40)
        await harness.resize(80, 12)
        const small = harness.frame()
        harness.unmount()
        expect(small.lines.length).toBeLessThanOrEqual(12)
    })
})

describe("App, restarting", () => {
    test("the command that asked for the restart does not come back as the draft", async () => {
        // What shipped: `onRestart` read `editor.value` from a closure captured *before* the submit
        // cleared it, so `/restart` carried `/restart` across. The new mount then re-opened the palette on
        // top of the new banner, so the screen returned identical to before enter was pressed with the
        // "restarted" line hidden behind the list — and the restart read as having done nothing.
        const drafts: string[] = []
        const harness = mount(
            h(App, { ...stubAppProps(), onRestart: (draft: string) => drafts.push(draft) }),
            { columns: 100, rows: 24 },
        )
        await harness.press("/restart", KEY.enter)
        harness.unmount()
        expect(drafts).toEqual([""])
    })

    test("a command has to be the whole buffer, so a draft plus a command is prose", async () => {
        // This is *why* the residual is always empty for a typed command: `COMMAND_SHAPE` matches the whole
        // trimmed line, so `/restart` on the second line of a message is not a command at all — it goes to
        // the model with the rest. The `draft` parameter therefore exists for a restart offered by a
        // **pane**, where something half-written genuinely can be sitting in the buffer.
        const drafts: string[] = []
        const sent: string[] = []
        const props = stubAppProps()
        const harness = mount(
            h(App, {
                ...props,
                onRestart: (draft: string) => drafts.push(draft),
                agent: {
                    ...props.agent,
                    // `Agent.send(input, options)` — the text is the first positional, not a field.
                    send: async (input: string) => {
                        sent.push(input)
                    },
                } as unknown as AppProps["agent"],
            }),
            { columns: 100, rows: 24 },
        )
        await harness.press("half a thought", KEY.metaEnter, "/restart", KEY.enter)
        harness.unmount()
        expect(drafts).toEqual([])
        expect(sent).toEqual(["half a thought\n/restart"])
    })
})

describe("App, leaving", () => {
    test("^C at an idle prompt arms, and says so before the second press", async () => {
        const harness = mount(h(App, stubAppProps()), { columns: 100 })
        const before = harness.frame()
        await harness.press(KEY.ctrl("c"))
        const armed = harness.frame()
        harness.unmount()
        expect(before.text).toContain("^C twice to leave")
        expect(armed.text).toContain("^C again to leave")
    })

    test("a keystroke that is not ^C disarms", async () => {
        // Otherwise the warning stays true while a whole message is typed, and the ^C at the end of it —
        // meaning "cancel that" — ends the session instead.
        const harness = mount(h(App, stubAppProps()), { columns: 100 })
        await harness.press(KEY.ctrl("c"), "h")
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("^C twice to leave")
    })

    test("/exit asks before it goes", async () => {
        const harness = mount(h(App, stubAppProps()), { columns: 100 })
        await harness.press("/exit", KEY.enter)
        const asking = harness.frame()
        await harness.press("n")
        const stayed = harness.frame()
        harness.unmount()
        expect(asking.text).toContain("leave this session?")
        expect(stayed.text).not.toContain("leave this session?")
    })
})

describe("App, scrolling the conversation", () => {
    test("page up parks the window and esc brings it back", async () => {
        const harness = mount(h(App, { ...stubAppProps(), initial: longHistory(60) }), {
            columns: 100,
            rows: 20,
        })
        const bottom = harness.frame()
        await harness.press(KEY.pageUp)
        const parked = harness.frame()
        await harness.press(KEY.escape)
        const back = harness.frame()
        harness.unmount()
        // The newest message is visible at the bottom, gone once parked, and back again after esc.
        expect(bottom.text).toContain("message number 59")
        expect(parked.text).not.toContain("message number 59")
        expect(parked.text).toContain("rows below")
        expect(back.text).toContain("message number 59")
    })

    test("page up is not ^U, which still deletes to the start of the line", async () => {
        // The plan named ^U/^D for scrolling. Both were already taken by the editor and both are
        // documented, so a scroll key that silently deleted half a message would be the worse bug.
        const harness = mount(h(App, { ...stubAppProps(), initial: longHistory(60) }), {
            columns: 100,
            rows: 20,
        })
        await harness.press("half a thought", KEY.ctrl("u"))
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).not.toContain("half a thought")
        expect(frame.text).toContain("message number 59")
    })
})

describe("SessionPicker", () => {
    const NOW = Date.parse("2026-08-18T12:00:00Z")
    const SESSIONS = [
        {
            sessionKey: "local:a7f3c2",
            messages: 4,
            turns: 2,
            lastActivityAt: "2026-08-18T11:58:00Z",
        },
        {
            sessionKey: "local:9b1e04",
            messages: 18,
            turns: 7,
            lastActivityAt: "2026-08-18T09:00:00Z",
        },
        { sessionKey: "notes", messages: 61, turns: 22, lastActivityAt: "2026-08-16T09:00:00Z" },
    ]

    function picker(overrides: Partial<SessionPickerProps> = {}) {
        return h(SessionPicker, {
            sessions: SESSIONS,
            now: NOW,
            columns: 80,
            maxRows: 12,
            onDone: () => {},
            ...overrides,
        })
    }

    test("each row says what the conversation is and how old", () => {
        const frame = renderFrame(picker(), { columns: 80 })
        expect(frame.text).toContain("local:a7f3c2")
        expect(frame.text).toContain("4 messages")
        expect(frame.text).toContain("2m ago")
        expect(frame.text).toContain("3h ago")
        expect(overflowing(frame, 80)).toEqual([])
    })

    test("a key somebody chose is marked, because it is the one they will recognise", () => {
        // Everything else in the list is six characters they have never read before.
        const frame = renderFrame(picker(), { columns: 80 })
        expect(frame.text).toContain("named")
    })

    test("the session in use is labelled rather than hidden", () => {
        const frame = renderFrame(picker({ current: "local:9b1e04" }), { columns: 80 })
        expect(frame.text).toContain("in use")
    })

    test("enter reports the highlighted key and esc reports nothing", async () => {
        const chosen: (string | undefined)[] = []
        const harness = mount(picker({ onDone: (key) => chosen.push(key) }), { columns: 80 })
        await harness.press(KEY.down, KEY.enter)
        await harness.press(KEY.escape)
        harness.unmount()
        // `undefined` is "leave things as they are" — a distinct answer from any key, which is why the
        // callback takes an optional rather than the host inferring it from a sentinel string.
        expect(chosen).toEqual(["local:9b1e04", undefined])
    })

    test("an empty store says so instead of drawing an empty box", () => {
        const frame = renderFrame(picker({ sessions: [] }), { columns: 80 })
        expect(frame.text).toContain("no stored conversations")
    })

    test("it scrolls rather than growing past its allowance", () => {
        // Unbounded, fifty conversations would make the list taller than the terminal — and on the
        // alternate screen there is no scrollback to recover the top of the frame from.
        const many = Array.from({ length: 50 }, (_, at) => ({
            sessionKey: `local:00000${at}`,
            messages: at,
            turns: at,
            lastActivityAt: "2026-08-18T11:00:00Z",
        }))
        const frame = renderFrame(picker({ sessions: many, maxRows: 8 }), { columns: 80 })
        // Eight rows, the "below" notice, and the key hint.
        expect(frame.lines.length).toBe(10)
        expect(frame.text).toContain("42 below")
    })

    test("a narrow terminal clips the hint rather than wrapping the row", () => {
        const frame = renderFrame(picker({ columns: 44 }), { columns: 44 })
        expect(overflowing(frame, 44)).toEqual([])
    })
})

describe("Brandmark", () => {
    test("it draws from the name it is given", () => {
        // Rendered from `BRAND.name`, never a literal — hard rule 3 means a rename is one commit, and an
        // ASCII wordmark would otherwise be the largest brand string in the tree.
        const frame = renderFrame(
            h(Brandmark, { lines: wordmark("Kit", { columns: 100, rows: 6 }).lines }),
            {
                columns: 100,
            },
        )
        expect(frame.text).toContain("█")
        expect(overflowing(frame, 100)).toEqual([])
    })

    test("it degrades to the letter-spaced name rather than overflowing", () => {
        const frame = renderFrame(
            h(Brandmark, { lines: wordmark("Kitchens", { columns: 44, rows: 6 }).lines }),
            {
                columns: 44,
            },
        )
        expect(frame.text).toContain("K I T C H E N S")
        expect(overflowing(frame, 44)).toEqual([])
    })

    test("it draws exactly the rows it was handed", () => {
        // The property the frame's arithmetic rests on: the caller measures the mark to charge the
        // conversation for it, so a component that drew a different number would make the layout wrong by
        // however many rows it disagreed about.
        for (const rows of [1, 3, 5, 8]) {
            const mark = wordmark("Castle", { columns: 100, rows })
            const frame = renderFrame(h(Brandmark, { lines: mark.lines }), { columns: 100 })
            expect(frame.lines.length).toBe(mark.lines.length)
            expect(mark.lines.length).toBeLessThanOrEqual(rows)
        }
    })
})

describe("App, the landing state", () => {
    test("a fresh session opens with the brand mark and a placeholder", () => {
        const harness = mount(h(App, { ...stubAppProps(), freshSession: true }), {
            columns: 100,
            rows: 30,
        })
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("█")
        expect(frame.text).toContain("Ask anything")
        // The one-line header is there too, and is the line that outlives the mark.
        expect(frame.text).toContain("milo")
    })

    test("a resumed session does not, even though its transcript is also empty", () => {
        // The chat never renders stored history — a resumed conversation's messages reach the model, not the
        // screen — so "the transcript is empty" is true of both, and deriving from it would put a welcome
        // screen in front of a conversation somebody is trying to continue.
        const harness = mount(h(App, { ...stubAppProps(), freshSession: false }), {
            columns: 100,
            rows: 30,
        })
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).not.toContain("█")
        expect(frame.text).not.toContain("Ask anything")
    })

    test("a slash command keeps the brand mark — it is setup, not conversation", async () => {
        // The bug this covers, and the reason the splash stopped being a screen: `/help` writes a note, the
        // transcript stops being empty, and the whole branch used to be swapped out. Almost every command
        // "removed the landing screen".
        const harness = mount(h(App, { ...stubAppProps(), freshSession: true }), {
            columns: 100,
            rows: 30,
        })
        await harness.press("/help", KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("█")
        // The help text is longer than the window the mark leaves, so it is scrolled to its tail rather
        // than replacing the screen — which is the whole point: the transcript grew, nothing was swapped.
        expect(frame.text).toContain("rows above")
        expect(frame.text).toContain("esc")
    })

    test("sending a message collapses it, and the header line survives", async () => {
        const harness = mount(h(App, { ...stubAppProps(), freshSession: true }), {
            columns: 100,
            rows: 30,
        })
        await harness.press("hello", KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).not.toContain("█")
        expect(frame.text).toContain("hello")
        // Nothing appears or disappears on the collapse — a block above the header goes.
        expect(frame.text).toContain("milo")
    })

    test("/exit's confirmation is visible while landing", async () => {
        // It was rendered only in the transcript layout, so `/exit` on the landing screen asked for a
        // confirmation nobody could see: the session appeared to ignore the command entirely.
        const harness = mount(h(App, { ...stubAppProps(), freshSession: true }), {
            columns: 100,
            rows: 30,
        })
        await harness.press("/exit", KEY.enter)
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("press y to confirm")
    })

    test("the palette shows every command while landing", async () => {
        const harness = mount(h(App, { ...stubAppProps(), freshSession: true }), {
            columns: 100,
            rows: 30,
        })
        await harness.press("/")
        const frame = harness.frame()
        harness.unmount()
        // Every command rather than six behind a counter: there is no conversation to hide behind the list.
        expect(frame.text).toContain("/help")
        expect(frame.text).toContain("/daemon")
        expect(frame.text).not.toContain("below")
    })

    test("the frame still fits, landing or not, at every size", () => {
        for (const rows of [10, 16, 24, 40]) {
            for (const columns of [44, 60, 80, 100, 140]) {
                for (const freshSession of [true, false]) {
                    const harness = mount(
                        h(App, { ...stubAppProps(), freshSession, initial: longHistory(40) }),
                        { columns, rows },
                    )
                    const frame = harness.frame()
                    harness.unmount()
                    expect(frame.lines.length).toBeLessThanOrEqual(rows)
                    expect(overflowing(frame, columns)).toEqual([])
                }
            }
        }
    })

    test("a short terminal loses the picture, not the banner", () => {
        // The banner is written into the transcript, so a brand mark that squeezed it to nothing would hide
        // the boot notes and every load warning behind a picture.
        const banner = {
            items: [{ id: "b", role: "banner" as const, text: "Kit 0.1.0\nsession local:abc123" }],
            live: undefined,
            status: "idle" as const,
            nextId: 1,
        }
        const harness = mount(h(App, { ...stubAppProps(), freshSession: true, initial: banner }), {
            columns: 100,
            rows: 12,
        })
        const frame = harness.frame()
        harness.unmount()
        expect(frame.text).toContain("session local:abc123")
    })
})
