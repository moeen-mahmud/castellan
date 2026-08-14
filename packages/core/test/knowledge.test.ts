/**
 * Tier 3: the keyword gate, its budgets, and the refusals that keep a knowledge entry from being
 * silently unreachable.
 *
 * The assertion that matters most is the over-budget refusal: an entry larger than the whole
 * activation budget would sit in the catalogue and never be selected, which is the same
 * starved-by-configuration shape as a dropped tool call — invisible in use, because the agent
 * still answers.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessError } from "../src/errors.ts"
import { parseKnowledgeFile } from "../src/workspace/frontmatter.ts"
import {
    activateKnowledge,
    type KnowledgeBase,
    keywordSelector,
    loadKnowledge,
} from "../src/workspace/knowledge.ts"
import { describe, expect, test } from "./_harness.ts"

function knowledgeDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-test-"))
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content, "utf8")
    }
    return dir
}

function entry(keywords: readonly string[], body: string): string {
    return `---\nkeywords: [${keywords.join(", ")}]\n---\n${body}\n`
}

function caught(fn: () => unknown): HarnessError {
    try {
        fn()
    } catch (error) {
        if (error instanceof HarnessError) return error
        throw error
    }
    throw new Error("expected a HarnessError, but nothing was thrown")
}

describe("parseKnowledgeFile", () => {
    test("keywords are required — a file without them can never activate", () => {
        const error = caught(() => parseKnowledgeFile("deploys.md", "No frontmatter here.\n"))
        expect(error.code).toBe("knowledge_file_invalid")
        expect(error.message).toContain("deploys.md")
    })

    test("an empty keyword list is refused, not tolerated", () => {
        const error = caught(() =>
            parseKnowledgeFile("deploys.md", "---\nkeywords: []\n---\nBody.\n"),
        )
        expect(error.code).toBe("knowledge_file_invalid")
    })

    test("an unknown frontmatter key is refused by name", () => {
        const error = caught(() =>
            parseKnowledgeFile("deploys.md", "---\nkeywords: [deploy]\ntier: static\n---\nBody.\n"),
        )
        expect(error.message).toContain('"tier"')
    })

    test("keywords are lowercased and comments are stripped from the body", () => {
        const parsed = parseKnowledgeFile(
            "deploys.md",
            "---\nkeywords: [Deploy, Rollback]\n---\n<!-- authoring note -->\nUse blue-green.\n",
        )
        expect(parsed.keywords).toEqual(["deploy", "rollback"])
        expect(parsed.body).toBe("Use blue-green.")
    })
})

describe("loadKnowledge", () => {
    test("a configured directory that does not exist is a load failure, not an empty catalogue", () => {
        const error = caught(() =>
            loadKnowledge({ dir: "/nonexistent/knowledge", maxActive: 2, budget: 600 }),
        )
        expect(error.code).toBe("knowledge_dir_missing")
    })

    test("entries load sorted by filename, so ties break the same way on every machine", () => {
        const dir = knowledgeDir({
            "b-second.md": entry(["two"], "Second."),
            "a-first.md": entry(["one"], "First."),
        })
        const base = loadKnowledge({ dir, maxActive: 2, budget: 600 })
        expect(base.entries.map((e) => e.name)).toEqual(["a-first.md", "b-second.md"])
    })

    test("an entry larger than the whole budget is refused at load — it could never activate", () => {
        const dir = knowledgeDir({
            "huge.md": entry(["deploy"], "word ".repeat(3000)),
        })
        const error = caught(() => loadKnowledge({ dir, maxActive: 2, budget: 600 }))
        expect(error.code).toBe("knowledge_entry_over_budget")
        expect(error.message).toContain("huge.md")
    })
})

describe("keywordSelector", () => {
    const base = (bodies: Record<string, readonly string[]>): KnowledgeBase => ({
        entries: Object.entries(bodies).map(([name, keywords]) => ({
            name,
            keywords,
            content: `content of ${name}`,
            tokens: 10,
        })),
        maxActive: 2,
        budget: 600,
    })

    test("matches whole words case-insensitively", () => {
        const entries = base({ "deploys.md": ["deploy"] }).entries
        expect(keywordSelector("How do I Deploy this?", entries).length).toBe(1)
        expect(keywordSelector("The deployment failed", entries).length).toBe(0)
    })

    test("a substring inside a longer word does not activate", () => {
        const entries = base({ "art.md": ["art"] }).entries
        expect(keywordSelector("let's start over", entries).length).toBe(0)
        expect(keywordSelector("this art is fine", entries).length).toBe(1)
    })

    test("phrases match as phrases", () => {
        const entries = base({ "bg.md": ["blue-green"] }).entries
        expect(keywordSelector("use blue-green here", entries).length).toBe(1)
        expect(keywordSelector("blue and green", entries).length).toBe(0)
    })

    test("more matched keywords ranks higher; ties keep filename order", () => {
        const b = base({
            "a-one.md": ["deploy"],
            "b-two.md": ["deploy", "rollback"],
            "c-tie.md": ["rollback"],
        })
        const ranked = keywordSelector("deploy then rollback", b.entries)
        expect(ranked.map((e) => e.name)).toEqual(["b-two.md", "a-one.md", "c-tie.md"])
    })
})

describe("activateKnowledge", () => {
    const withEntries = (
        tokens: readonly number[],
        maxActive: number,
        budget: number,
    ): KnowledgeBase => ({
        entries: tokens.map((cost, index) => ({
            name: `${index}.md`,
            keywords: ["deploy"],
            content: `entry ${index}`,
            tokens: cost,
        })),
        maxActive,
        budget,
    })

    test("respects maxActive", () => {
        const active = activateKnowledge("deploy", withEntries([10, 10, 10], 2, 600))
        expect(active.length).toBe(2)
    })

    test("stops at the first entry that does not fit, never skipping past it", () => {
        // Entry 1 busts the budget; entry 2 would fit, but selecting it would let a worse-ranked
        // entry displace a better-ranked one purely by being short.
        const active = activateKnowledge("deploy", withEntries([100, 550, 10], 3, 600))
        expect(active.map((e) => e.name)).toEqual(["0.md"])
    })

    test("no keyword match means nothing activates", () => {
        expect(activateKnowledge("hello there", withEntries([10], 2, 600)).length).toBe(0)
    })

    test("maxActive: 0 disables activation entirely", () => {
        expect(activateKnowledge("deploy", withEntries([10], 0, 600)).length).toBe(0)
    })
})
