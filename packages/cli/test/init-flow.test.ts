/**
 * The init flow as pure data: sequencing, validation, and the file plan.
 *
 * The property that matters most is the ollama one — `apiKeyEnv` must be *absent* from the
 * generated manifest, not empty, because `apiKeyEnv: ""` fails schema while an omitted field is
 * a keyless endpoint. An empty-string slip here would generate agents that refuse to load.
 */

import { describe, expect, test } from "bun:test"
import { countRules, LOCAL_TOOL_SLUGS, parseWorkspaceFile, rulesBlocksOnly } from "@castellan/core"
import {
    INIT_LOCAL_TOOL_SLUGS,
    type InitAnswers,
    nextQuestion,
    PRESETS,
    planFiles,
    slugify,
    validateAnswer,
} from "#lib/init-flow"

const ANSWERS: InitAnswers = {
    user: "Moeen",
    name: "Milo",
    purpose: "keeps my week on track",
    preset: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "MODEL_API_KEY",
    dir: "./milo",
}

describe("slugify", () => {
    test.each([
        ["Milo", "milo"],
        ["Vela Ops Bot", "vela-ops-bot"],
        ["  weird -- name!! ", "weird-name"],
        ["!!!", "agent"],
    ] as [string, string][])("%s → %s", (name, slug) => {
        expect(slugify(name)).toBe(slug)
    })
})

describe("nextQuestion", () => {
    test("asks in order and completes", () => {
        const partial: Record<string, string> = {}
        const seen: string[] = []
        for (;;) {
            const question = nextQuestion(partial)
            if (question === undefined) break
            seen.push(question.step)
            partial[question.step] =
                question.step === "preset" ? "deepseek" : question.fallback || "x"
        }
        expect(seen).toEqual([
            "user",
            "name",
            "purpose",
            "preset",
            "model",
            "baseUrl",
            "apiKeyEnv",
            "dir",
        ])
    })

    test("a keyless preset skips the key question entirely", () => {
        const partial: Record<string, string> = {
            user: "Moeen",
            name: "Milo",
            purpose: "x",
            preset: "ollama",
        }
        const steps: string[] = []
        for (;;) {
            const question = nextQuestion(partial)
            if (question === undefined) break
            steps.push(question.step)
            partial[question.step] = question.fallback || "x"
        }
        expect(steps.includes("apiKeyEnv")).toBe(false)
    })

    test("model and base URL default from the chosen preset; custom offers nothing", () => {
        expect(
            nextQuestion({ user: "a", name: "b", purpose: "c", preset: "deepseek" })?.fallback,
        ).toBe("deepseek-chat")
        expect(
            nextQuestion({ user: "a", name: "b", purpose: "c", preset: "custom" })?.fallback,
        ).toBe("")
    })

    test("the directory default derives from the agent name", () => {
        const { dir: _dir, ...answered } = ANSWERS
        const question = nextQuestion(answered)
        expect(question?.step).toBe("dir")
        expect(question?.fallback).toBe("./milo")
    })

    test("with a sandbox base, the directory default lands inside it", () => {
        const { dir: _dir, ...answered } = ANSWERS
        const question = nextQuestion(answered, { agentDirBase: "/home/x/.brand/agents" })
        expect(question?.fallback).toBe("/home/x/.brand/agents/milo")
    })
})

describe("validateAnswer", () => {
    test("presets accept a number or a name", () => {
        expect(validateAnswer("preset", "3")).toEqual({ ok: true, value: "deepseek" })
        expect(validateAnswer("preset", "OLLAMA")).toEqual({ ok: true, value: "ollama" })
        expect(validateAnswer("preset", "9").ok).toBe(false)
    })

    test("the base URL rules are the loader's own, applied at the question", () => {
        expect(validateAnswer("baseUrl", "https://api.deepseek.com/v1").ok).toBe(true)
        expect(validateAnswer("baseUrl", "not a url").ok).toBe(false)
        expect(validateAnswer("baseUrl", "ftp://x.example/v1").ok).toBe(false)
        // The mistake the loader names at load, refused here instead — at the question.
        expect(validateAnswer("baseUrl", "https://api.example.com/v1/chat/completions").ok).toBe(
            false,
        )
    })

    test("env var names are names", () => {
        expect(validateAnswer("apiKeyEnv", "MODEL_API_KEY").ok).toBe(true)
        expect(validateAnswer("apiKeyEnv", "sk-abc123").ok).toBe(false)
        expect(validateAnswer("apiKeyEnv", "lower_case").ok).toBe(false)
    })

    test("names cannot be empty", () => {
        expect(validateAnswer("user", "  ").ok).toBe(false)
        expect(validateAnswer("name", "Milo")).toEqual({ ok: true, value: "Milo" })
    })
})

describe("planFiles", () => {
    test("plans the full starter set — the soul pair for identity, AGENTS.md for operations", () => {
        expect(planFiles(ANSWERS).map((file) => file.relPath)).toEqual([
            "agent.yaml",
            "workspace/SOUL.md",
            "workspace/SOUL.compact.md",
            "workspace/AGENTS.md",
            "workspace/POLICY.md",
            "workspace/USER.md",
            "workspace/MEMORY.md",
            "workspace/REMINDER.md",
            ".env.example",
            ".env",
            ".gitignore",
        ])
    })

    test("AGENTS.md is operations, fully filled, and adds nothing the rule counter sees", () => {
        const files = planFiles(ANSWERS)
        const ops = files.find((f) => f.relPath === "workspace/AGENTS.md")
        expect(ops?.contents).toContain("# What I do")
        expect(ops?.contents).toContain("memory_write")
        // Fully filled — the dialogue-example nag lives in the soul, not here.
        expect(ops?.contents.includes("{{")).toBe(false)
        // The whole point of the declarative style: an ops file that reads as zero rules.
        const body = parseWorkspaceFile("workspace/AGENTS.md", ops?.contents ?? "").body
        expect(countRules(body)).toHaveLength(0)
    })

    test("both souls are filled; the dialogue examples stay placeholders", () => {
        const files = planFiles(ANSWERS)
        for (const relPath of ["workspace/SOUL.md", "workspace/SOUL.compact.md"]) {
            const soul = files.find((f) => f.relPath === relPath)
            expect(soul?.contents).toContain("# Who Milo is")
            expect(soul?.contents).toContain("I work with Moeen")
            expect(soul?.contents.includes("{{SOUL_")).toBe(false)
            expect(soul?.contents.includes("{{RULE_")).toBe(false)
            // The nag mechanism: examples wait for a person.
            expect(soul?.contents).toContain("{{INPUT_1}}")
            expect(soul?.contents).toContain("{{REPLY_3}}")
        }
    })

    test("the reminder restates the confirm rule byte-for-byte — one rule, one phrasing", () => {
        const files = planFiles(ANSWERS)
        const soul = files.find((f) => f.relPath === "workspace/SOUL.md")
        const reminder = files.find((f) => f.relPath === "workspace/REMINDER.md")
        const confirm = "I confirm before anything that sends, spends, schedules, or deletes"
        expect(soul?.contents).toContain(confirm)
        expect(reminder?.contents).toContain(confirm)
    })

    test("the generated manifest is reference-style: live tools block, commented later phases", () => {
        const yaml = planFiles(ANSWERS).find((f) => f.relPath === "agent.yaml")?.contents ?? ""
        // Active: the soul gate and the local tools.
        expect(yaml).toContain("soul:")
        expect(yaml).toContain("distilled: SOUL.compact.md")
        expect(yaml).toContain("- now")
        expect(yaml).toContain("- memory_write")
        expect(yaml).toContain("- AGENTS.md") // operations file, listed in static
        expect(yaml.includes("- AGENT.md\n")).toBe(false) // the old identity file is gone
        // Commented, with phases: uncommenting early must be a load refusal, not decoration.
        for (const line of [
            "# provider: composio",
            "# web:",
            "# phases:",
            "# skills:",
            "# memory:",
            "# channels:",
            "# schedules:",
            "# plugins:",
            "# selector:",
            "#   promptStyle:",
        ]) {
            expect(yaml).toContain(line)
        }
    })

    test("ollama omits apiKeyEnv from the manifest and the key line from .env", () => {
        const answers: InitAnswers = {
            ...ANSWERS,
            preset: "ollama",
            model: "qwen3.5:9b",
            baseUrl: "http://localhost:11434/v1",
        }
        const { apiKeyEnv: _dropped, ...keyless } = answers
        const files = planFiles(keyless as InitAnswers)
        const manifest = files.find((f) => f.relPath === "agent.yaml")
        const env = files.find((f) => f.relPath === ".env")
        // No ACTIVE apiKeyEnv line — the commented provider examples legitimately mention the
        // field, so the assertion targets the uncommented model-block indent.
        expect(manifest?.contents.includes("\n    apiKeyEnv:")).toBe(false)
        expect(env?.contents.includes("MODEL_API_KEY")).toBe(false)
        expect(env?.contents).toContain("MODEL_ID=qwen3.5:9b")
    })

    test("the key line in .env is present and empty — the wizard never asks for the secret", () => {
        const env = planFiles(ANSWERS).find((f) => f.relPath === ".env")
        expect(env?.contents).toContain("MODEL_API_KEY=\n")
        expect(env?.contents.includes("MODEL_API_KEY=s")).toBe(false)
    })

    test(".gitignore covers the .env that carries the key", () => {
        const gitignore = planFiles(ANSWERS).find((f) => f.relPath === ".gitignore")
        expect(gitignore?.contents).toBe(".env\n")
    })

    test("the chosen preset is the active block in .env.example", () => {
        const example = planFiles(ANSWERS).find((f) => f.relPath === ".env.example")
        expect(example?.contents).toContain("\nMODEL_ID=deepseek-chat")
        expect(example?.contents).toContain("# MODEL_ID=gpt-4o-mini")
    })

    test("no generated file guesses pronouns for the user", () => {
        for (const file of planFiles(ANSWERS)) {
            for (const word of [" he ", " she ", " his ", " her ", " him "]) {
                expect(file.contents.toLowerCase().includes(word)).toBe(false)
            }
        }
    })
})

describe("PRESETS", () => {
    test("exactly one preset is keyless, and it is the local one", () => {
        const keyless = PRESETS.filter((preset) => preset.apiKeyEnv === undefined)
        expect(keyless.map((preset) => preset.id)).toEqual(["ollama"])
    })
})

describe("INIT_LOCAL_TOOLS", () => {
    test("pins the runtime's local tool list — a new tool cannot ship without init knowing", () => {
        expect([...INIT_LOCAL_TOOL_SLUGS].sort()).toEqual([...LOCAL_TOOL_SLUGS].sort())
    })
})

describe("rule budget pin", () => {
    // The default guard allows 2 rules (perRuleSuccess .9, target .8). The generated prose is
    // worded to count exactly 1 (RULE_HONESTY's "don't") on EITHER gate path, and this pin is
    // what keeps a future synonym swap ("never guess") from silently busting the load.
    function countedRules(relPaths: readonly string[]): number {
        const files = planFiles(ANSWERS)
        const text = relPaths
            .map((relPath) => {
                const file = files.find((f) => f.relPath === relPath)
                const body = parseWorkspaceFile(relPath, file?.contents ?? "").body
                return relPath === "workspace/SOUL.md" ? rulesBlocksOnly(body) : body
            })
            .join("\n")
        return countRules(text).length
    }

    test("full-document path counts at most 2 rules", () => {
        const counted = countedRules([
            "workspace/SOUL.md",
            "workspace/AGENTS.md",
            "workspace/POLICY.md",
            "workspace/REMINDER.md",
        ])
        expect(counted).toBeLessThanOrEqual(2)
    })

    test("distilled path counts at most 2 rules — the compact file gets no prose exemption", () => {
        const counted = countedRules([
            "workspace/SOUL.compact.md",
            "workspace/AGENTS.md",
            "workspace/POLICY.md",
            "workspace/REMINDER.md",
        ])
        expect(counted).toBeLessThanOrEqual(2)
    })
})
