/**
 * Per-model rendering of authored workspace files.
 *
 * The property that matters most here is the one the template promises its authors: **one authored
 * source, several rendered forms, and the prose identical in all of them.** A renderer that quietly
 * rewrote a sentence would be the placeholder-as-instruction failure of decision 4.19 again, in a
 * place the author cannot see the output of.
 */

import { resolveCapabilities } from "../src/model/capabilities.ts"
import {
    DEFAULT_PROMPT_STYLE,
    defaultPromptStyle,
    type PromptStyle,
    type PromptStyleClass,
    parameterBillions,
    promptStyleClass,
    renderPromptStyle,
} from "../src/model/prompt-style.ts"
import { describe, expect, test } from "./_harness.ts"

const AUTHORED = [
    "# Vex",
    "",
    "I answer in one paragraph unless you ask for more.",
    "",
    "## Examples",
    "",
    "<example>",
    "moeen: what time is it in Lisbon?",
    "Vex: Just past nine in the evening.",
    "</example>",
    "",
    "<example>",
    "moeen: send that to the team",
    "Vex: Before I send it — which team, and do you want the summary or the whole thread?",
    "</example>",
].join("\n")

function style(over: Partial<PromptStyle> = {}): PromptStyle {
    return { ...DEFAULT_PROMPT_STYLE, ...over }
}

describe("model classification", () => {
    test.each([
        ["claude-sonnet-4-5", "anthropic"],
        ["claude-opus-4-1-20250805", "anthropic"],
        ["gpt-4o", "openai"],
        ["o3-mini", "openai"],
        ["qwen3.5:9b", "small-open-weight"],
        ["llama3.1:8b", "small-open-weight"],
        ["mixtral-8x7b", "small-open-weight"],
        ["deepseek-v4-pro", "default"],
    ] as [string, PromptStyleClass][])("%s is %s", (id, expected) => {
        expect(promptStyleClass(id)).toBe(expected)
    })

    test("size beats family — the same pattern covers models that want opposite intensities", () => {
        // This is why the size is read from the id rather than tabulated per registry pattern:
        // `qwen3.5*` matches both of these, and one wants emphatic framing while the other does not.
        expect(defaultPromptStyle("qwen3.5:9b").intensity).toBe("emphatic")
        expect(defaultPromptStyle("qwen3.5:72b").intensity).toBe("neutral")
    })

    test.each([
        ["llama3.1:8b", 8],
        ["qwen2.5-14b-instruct", 14],
        ["mixtral-8x7b", 7],
        ["gpt-4o", undefined],
    ] as [string, number | undefined][])("parameterBillions(%s) is %p", (id, expected) => {
        expect(parameterBillions(id)).toBe(expected)
    })

    test("a mixture-of-experts id reads as one expert, not the total", () => {
        // 8x7b activates roughly 7B per token and behaves like the smaller number here. Reading it
        // as 56 would give a small model a frontier model's prompting.
        expect(promptStyleClass("mixtral-8x7b")).toBe("small-open-weight")
    })
})

describe("rendering", () => {
    test("xml keeps the authored example tags", () => {
        const out = renderPromptStyle(AUTHORED, style({ delimiters: "xml" }))
        expect(out).toContain("<example>")
        expect(out).toContain("</example>")
    })

    test("markdown promotes examples to headings and leaves no tags", () => {
        const out = renderPromptStyle(AUTHORED, style({ delimiters: "markdown" }))
        expect(out).toContain("#### Example 1")
        expect(out).toContain("#### Example 2")
        expect(out.includes("<example>")).toBe(false)
    })

    test("plain strips heading markers and tags but keeps the heading text", () => {
        const out = renderPromptStyle(AUTHORED, style({ delimiters: "plain" }))
        expect(out.includes("#")).toBe(false)
        expect(out.includes("<example>")).toBe(false)
        expect(out).toContain("Example 1:")
        // The text of a heading is a section label the file's own prose may refer to. Only the
        // marker goes.
        expect(out).toContain("Vex")
        expect(out).toContain("Examples")
    })

    test("the author's prose is byte-identical across all three renderings", () => {
        // The whole promise of the capability: one authored source, several forms, and nothing
        // rewritten. A renderer that touched a sentence would be decision 4.19 all over again.
        const sentence = "I answer in one paragraph unless you ask for more."
        for (const delimiters of ["xml", "markdown", "plain"] as const) {
            expect(renderPromptStyle(AUTHORED, style({ delimiters }))).toContain(sentence)
        }
    })

    test("a fenced block is left alone — it shows markup rather than using it", () => {
        const text = ["# Heading", "", "```", "# not a heading", "<example>", "```"].join("\n")
        const out = renderPromptStyle(text, style({ delimiters: "plain" }))
        expect(out).toContain("# not a heading")
        expect(out).toContain("<example>")
        // The real heading outside the fence still lost its marker.
        expect(out.startsWith("Heading")).toBe(true)
    })

    test("empty text renders to empty rather than to whitespace", () => {
        expect(renderPromptStyle("", style())).toBe("")
    })
})

describe("capability resolution", () => {
    test("promptStyle arrives derived, without a registry row declaring it", () => {
        expect(resolveCapabilities("claude-sonnet-4-5").promptStyle.delimiters).toBe("xml")
        expect(resolveCapabilities("gpt-4o").promptStyle.delimiters).toBe("markdown")
        expect(resolveCapabilities("qwen3.5:9b").promptStyle.delimiters).toBe("plain")
    })

    test("an override merges field by field rather than replacing the whole style", () => {
        // Making an author restate all four to change one is how a config ends up carrying a stale
        // copy of a default that has since moved.
        const resolved = resolveCapabilities("claude-sonnet-4-5", {
            promptStyle: { intensity: "emphatic" },
        })
        expect(resolved.promptStyle.intensity).toBe("emphatic")
        expect(resolved.promptStyle.delimiters).toBe("xml")
        expect(resolved.promptStyle.examplesIn).toBe("system")
    })

    test("overriding promptStyle leaves the other capabilities alone", () => {
        const resolved = resolveCapabilities("gpt-4o", { promptStyle: { delimiters: "plain" } })
        expect(resolved.nativeTools).toBe(true)
        expect(resolved.contextWindow).toBe(128_000)
        expect(resolved.promptStyle.delimiters).toBe("plain")
    })
})

describe("intensity", () => {
    const WITH_RULES = [
        "# Vex",
        "<rules>",
        "I cite a source, so you can check it.",
        "</rules>",
    ].join("\n")

    test("emphatic adds a framing line and leaves the rule untouched", () => {
        const out = renderPromptStyle(WITH_RULES, style({ intensity: "emphatic" }))
        expect(out).toContain("Follow these rules exactly.")
        expect(out).toContain("I cite a source, so you can check it.")
    })

    test("soft frames the same rule differently, still without editing it", () => {
        const out = renderPromptStyle(WITH_RULES, style({ intensity: "soft" }))
        expect(out).toContain("Where it helps:")
        expect(out).toContain("I cite a source, so you can check it.")
        expect(out.includes("Follow these rules exactly.")).toBe(false)
    })

    test("neutral adds nothing at all", () => {
        const out = renderPromptStyle(WITH_RULES, style({ intensity: "neutral" }))
        expect(out.includes("Follow these rules exactly.")).toBe(false)
        expect(out.includes("Where it helps:")).toBe(false)
    })

    test("all three intensities contain the author's sentence byte-identically", () => {
        // The property the whole design turns on. `emphatic` for a 7B model and `neutral` for a
        // frontier one differ by one generated line and nothing else — so the rendered form stays
        // predictable from the authored one, which matters most for a file nobody previews.
        const sentence = "I cite a source, so you can check it."
        for (const intensity of ["emphatic", "neutral", "soft"] as const) {
            expect(renderPromptStyle(WITH_RULES, style({ intensity }))).toContain(sentence)
        }
    })

    test("the rules block takes the delimiter shape the model wants", () => {
        expect(renderPromptStyle(WITH_RULES, style({ delimiters: "xml" }))).toContain("<rules>")
        expect(renderPromptStyle(WITH_RULES, style({ delimiters: "markdown" }))).toContain(
            "#### Rules",
        )
        expect(renderPromptStyle(WITH_RULES, style({ delimiters: "plain" }))).toContain("Rules:")
    })

    test("a small open-weight model gets emphatic framing by default", () => {
        // The inversion, end to end: the same authored file, two models, two framings.
        const small = renderPromptStyle(WITH_RULES, defaultPromptStyle("qwen3.5:9b"))
        const frontier = renderPromptStyle(WITH_RULES, defaultPromptStyle("claude-sonnet-4-5"))
        expect(small).toContain("Follow these rules exactly.")
        expect(frontier.includes("Follow these rules exactly.")).toBe(false)
    })
})
