/**
 * The authoring checks.
 *
 * Each test builds the smallest file that trips exactly one of them, because a check that fires on
 * everything is one people learn to ignore — and a check that fires on nothing is one nobody notices
 * has broken. The shipped example files are asserted to produce no findings for the same reason.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
    type AuthoringInput,
    checkAuthoring,
    EXAMPLES_MIN,
    PROHIBITION_LIMIT,
} from "../src/workspace/authoring.ts"
import { parseWorkspaceFile } from "../src/workspace/frontmatter.ts"
import { describe, expect, test } from "./_harness.ts"

function file(authored: string, tier = "static"): AuthoringInput {
    return { name: "AGENT.md", authored, tier }
}

function codes(input: AuthoringInput): string[] {
    return checkAuthoring([input]).map((finding) => finding.code)
}

const EXAMPLE = (body: string) => `<example>\n${body}\n</example>`

describe("unfilled placeholders", () => {
    test("a template still carrying placeholders is reported as that, not as something else", () => {
        // Before this check existed, an unfilled template reported as a *diversity* failure — its
        // placeholder examples are identical to each other — which sends the author to fix the
        // wrong thing entirely.
        const found = checkAuthoring([file("# {{AGENT_NAME}}\n\n{{VOICE_PARAGRAPH}}")])
        expect(found.map((f) => f.code)).toEqual(["workspace_unfilled_placeholder"])
        expect(found[0]?.message).toContain("{{AGENT_NAME}}")
    })

    test("the other checks are suppressed while placeholders remain", () => {
        // Otherwise one finding that matters arrives buried under four that restate it.
        const text = ["# {{NAME}}", EXAMPLE("{{A}}"), EXAMPLE("{{A}}")].join("\n")
        expect(codes(file(text))).toEqual(["workspace_unfilled_placeholder"])
    })
})

describe("examples", () => {
    test("fewer than three is reported", () => {
        const text = [EXAMPLE("moeen: deploy failed\nVex: Same TLS error as Tuesday?")].join("\n")
        expect(codes(file(text))).toContain("workspace_example_count")
    })

    test("three distinct examples pass", () => {
        const text = [
            EXAMPLE("moeen: deploy failed\nVex: Same certificate error as Tuesday?"),
            EXAMPLE(
                "moeen: should I rewrite the scheduler\nVex: No, four hundred lines, not your bottleneck",
            ),
            EXAMPLE(
                "moeen: send release notes to the team\nVex: Drafted, seven recipients, read first?",
            ),
        ].join("\n")
        expect(codes(file(text))).toEqual([])
    })

    test("three examples about the same subject are reported as undiverse", () => {
        // The failure this prevents: three examples about deploys produce an agent that steers
        // every conversation toward deploys, because the model cannot tell whether the subject or
        // the voice was the thing being demonstrated.
        const text = [
            EXAMPLE("moeen: deploy failed\nVex: deploy failed again, check deploy logs"),
            EXAMPLE("moeen: deploy failed\nVex: deploy failed, check deploy logs again"),
            EXAMPLE("moeen: deploy logs\nVex: deploy failed, deploy logs checked"),
        ].join("\n")
        expect(codes(file(text))).toContain("workspace_example_diversity")
    })

    test("a file with no examples is not nagged about examples", () => {
        expect(codes(file("Some prose with no examples in it at all."))).toEqual([])
    })

    test("only the static tier is expected to carry examples", () => {
        expect(codes(file("Working memory notes.", "volatile"))).toEqual([])
    })
})

describe("rules", () => {
    test("a rule with no reason is reported, and one with a reason is not", () => {
        expect(codes(file("Always cite a source."))).toContain("workspace_rule_no_rationale")
        expect(codes(file("Always cite a source, because the reader has to check it."))).toEqual([])
    })

    test("a contrast clause counts as a reason", () => {
        // "rather than X" states the alternative being avoided, which is a reason. This was a live
        // false positive on the shipped example files before the pattern learned it.
        expect(codes(file("I say so rather than producing something plausible."))).toEqual([])
    })
})

describe("framing and structure", () => {
    test("heavy prohibition counts are reported", () => {
        const text = Array.from(
            { length: PROHIBITION_LIMIT + 2 },
            (_, i) => `Never do thing ${i}, because it is bad.`,
        ).join("\n")
        expect(codes(file(text))).toContain("workspace_negative_framing")
    })

    test("a bulleted identity file is reported", () => {
        // Models imitate form as readily as content, so a bulleted file produces a bulleted agent
        // regardless of what the file says about formatting.
        const text = [
            "- Answer briefly, because the window is small.",
            "- Cite sources, so they can be checked.",
            "- Ask first, since mistakes are expensive.",
            "- Prefer prose, because it reads better.",
            "- Keep it short, as attention is finite.",
        ].join("\n")
        expect(codes(file(text))).toContain("workspace_bullet_density")
    })

    test("prose of the same length is not", () => {
        const text = [
            "I answer briefly, because the window is small.",
            "I cite sources, so they can be checked.",
            "I ask first, since mistakes are expensive.",
            "I prefer prose, because it reads better.",
            "I keep it short, as attention is finite.",
        ].join("\n")
        expect(codes(file(text))).toEqual([])
    })
})

describe("the shipped example files", () => {
    test.each([
        ["examples/minimal/AGENT.md"],
        ["examples/reference/AGENT.md"],
        ["examples/telegram-assistant/workspace/AGENT.md"],
        ["examples/telegram-assistant/workspace/POLICY.md"],
    ] as [string][])("%s produces no findings", (path) => {
        // An example that trips the project's own checks teaches the wrong thing, and is the first
        // place a reader looks for what good looks like.
        // `import.meta.dir` is Bun-only and this suite runs under Node's runner too, where the
        // whole point is that the same assertions execute unchanged.
        const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
        const { body } = parseWorkspaceFile(path, readFileSync(join(root, path), "utf8"))
        expect(codes({ name: path, authored: body, tier: "static" })).toEqual([])
    })

    test("EXAMPLES_MIN is the figure the hint quotes", () => {
        expect(EXAMPLES_MIN).toBe(3)
    })
})
