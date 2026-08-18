/**
 * The shared frame, and the harness that reads it.
 *
 * The first test in this repo to mount a component. It asserts the thing every earlier CLI test could
 * not: what is on the screen.
 */

import { describe, expect, test } from "bun:test"
import { Text } from "ink"
import { createElement as h } from "react"
import { Screen, screenWidth } from "#components/Screen"
import { MAX_SCREEN_COLUMNS, MIN_SCREEN_COLUMNS } from "#lib/const"
import { headerLines, hintLine, QUIT_HINT, type ScreenHeader } from "#lib/screen"
import { overflowing, renderFrame, width } from "../helpers/frame.tsx"

const HEADER: ScreenHeader = { title: "castellan 0.1.0", summary: "sources · 2 registered" }

describe("the harness itself", () => {
    test("a mounted component's text reaches the frame", () => {
        const frame = renderFrame(h(Text, {}, "hello from ink"))
        expect(frame.text).toContain("hello from ink")
    })

    test("width counts characters, not bytes", () => {
        // The exact failure that made `awk` report 69 overlong lines where there were none: these
        // three glyphs are 3, 2 and 3 bytes and one column each.
        expect(width("…·◉")).toBe(3)
        expect(Buffer.byteLength("…·◉")).toBeGreaterThan(3)
    })
})

describe("the header", () => {
    test("names the agent and the model when a screen acts on one", () => {
        const lines = headerLines({ ...HEADER, agent: { name: "milo", model: "qwen3.5:9b" } }, 80)
        expect(lines[0]?.text).toBe("castellan 0.1.0")
        expect(lines[1]?.kind).toBe("summary")
        expect(lines[1]?.text).toContain("milo")
        expect(lines[1]?.text).toContain("qwen3.5:9b")
    })

    test("omits the agent row entirely on a machine-level screen", () => {
        // `sources` is shared by every agent on the machine. Naming one there would misstate the
        // scope of what a change affects.
        const lines = headerLines(HEADER, 80)
        expect(lines.some((line) => line.text.includes("milo"))).toBe(false)
    })

    test("keeps session-wide warnings in the frame", () => {
        const lines = headerLines({ ...HEADER, warnings: ["3 tools were trimmed"] }, 80)
        expect(lines.some((line) => line.kind === "warning")).toBe(true)
        expect(lines.at(-1)?.text).toContain("3 tools were trimmed")
    })

    test("counts the warnings it does not show rather than dropping them", () => {
        const lines = headerLines({ ...HEADER, warnings: ["a", "b", "c", "d", "e"] }, 80)
        const warnings = lines.filter((line) => line.kind === "warning")
        expect(warnings).toHaveLength(4)
        expect(warnings.at(-1)?.text).toBe("⚠ and 2 more")
    })

    test("every line is clipped to the width", () => {
        const lines = headerLines(
            {
                title: "castellan 0.1.0",
                summary: "a summary long enough to need cutting at a narrow terminal width",
                agent: { name: "an-agent-with-a-long-name", model: "some/very-long-model-id" },
                warnings: ["a warning that also goes on for a while and must be cut"],
            },
            30,
        )
        for (const line of lines) expect(width(line.text)).toBeLessThanOrEqual(30)
    })
})

describe("the footer", () => {
    test("renders each hint as key then meaning", () => {
        expect(hintLine([{ key: "↑↓", does: "move" }, QUIT_HINT], 80)).toBe("↑↓ move · q back")
    })

    test("drops whole hints rather than cutting one in half", () => {
        // `enter inst…` reads as a different key than the one it is, so the line is built up to the
        // longest prefix that fits instead of being clipped down. Two of these three fit in 20
        // columns (7 + 3 + 8 = 18); the third would take it to 27.
        const hints = [
            { key: "↑↓", does: "move" },
            { key: "enter", does: "go" },
            { key: "q", does: "back" },
        ]
        const line = hintLine(hints, 20)
        expect(width(line)).toBeLessThanOrEqual(20)
        expect(line).toBe("↑↓ move · enter go")
        // And a hint is never half-rendered: whatever survives, every key word is whole.
        expect(line.endsWith("…")).toBe(false)
    })

    test("shows one clipped hint rather than an empty footer", () => {
        // A full-screen surface with no visible way out is the worst thing it can be.
        const line = hintLine([{ key: "escape", does: "leave without saving" }], 8)
        expect(width(line)).toBeLessThanOrEqual(8)
        expect(line.length).toBeGreaterThan(0)
    })
})

describe("the rendered frame", () => {
    test("draws the header, the body and the footer in that order", () => {
        const frame = renderFrame(
            h(Screen, { header: HEADER, footer: [QUIT_HINT] }, h(Text, {}, "the body")),
            { columns: 80 },
        )
        const header = frame.lines.findIndex((line) => line.includes("castellan 0.1.0"))
        const body = frame.lines.findIndex((line) => line.includes("the body"))
        const footer = frame.lines.findIndex((line) => line.includes("q back"))
        expect(header).toBeGreaterThanOrEqual(0)
        expect(body).toBeGreaterThan(header)
        expect(footer).toBeGreaterThan(body)
    })

    test("state chips are rendered once, not twice", () => {
        // The header derivation emits a joined state line *and* the component colours the chips
        // individually. Rendering both is the bug this asserts against.
        const frame = renderFrame(
            h(
                Screen,
                {
                    header: {
                        ...HEADER,
                        state: [
                            { label: "running", tone: "ok" },
                            { label: "telegram off", tone: "off" },
                        ],
                    },
                },
                h(Text, {}, "body"),
            ),
            { columns: 80 },
        )
        expect(frame.text.split("running").length - 1).toBe(1)
    })

    for (const columns of [40, 60, 80, 100, 140]) {
        test(`nothing wraps at ${columns} columns`, () => {
            const frame = renderFrame(
                h(
                    Screen,
                    {
                        header: {
                            title: "castellan 0.1.0",
                            summary:
                                "443 skills across 2 sources, all of them cached on this machine",
                            agent: { name: "milo", model: "qwen3.5:9b" },
                            state: [{ label: "running", tone: "ok" }],
                            warnings: ["config_set is gated after its first use this turn"],
                        },
                        footer: [
                            { key: "↑↓", does: "move" },
                            { key: "space", does: "tick" },
                            QUIT_HINT,
                        ],
                    },
                    h(Text, {}, "body"),
                ),
                { columns },
            )
            expect(overflowing(frame, columns)).toEqual([])
        })
    }
})

describe("the width clamp", () => {
    test("a narrow terminal is floored and a wide one is capped", () => {
        expect(screenWidth(20)).toBe(MIN_SCREEN_COLUMNS)
        expect(screenWidth(300)).toBe(MAX_SCREEN_COLUMNS)
        expect(screenWidth(100)).toBe(100)
    })

    test("a pty reporting zero columns does not produce a zero-width screen", () => {
        // Measured under `script -q`: `columns` can genuinely be 0, and every layout that divides by
        // the width has to survive it.
        expect(screenWidth(0)).toBe(MIN_SCREEN_COLUMNS)
    })
})
