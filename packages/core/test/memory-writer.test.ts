/**
 * Eviction: the half of `memory_write` that keeps the carried file inside its budget.
 *
 * The test that matters is `stays under budget across two hundred saves`. Before eviction existed, a
 * freshly scaffolded agent that used `memory_write` about two hundred times could no longer load —
 * `workspace_budget_exceeded: MEMORY.md is 7843 tokens against its 2000-token budget` — because the
 * budget is a hard load failure by design and `eviction: oldest` was declared vocabulary nothing
 * consumed. A memory tool that bricks the agent when used is the shape this file exists to prevent, so
 * the assertion is deliberately about the loader's own measurement rather than about an entry count.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    appendNote,
    archiveNameFor,
    entriesIn,
    injectedTokens,
    planEviction,
} from "../src/memory/writer.ts"
import { writeTarget } from "../src/workspace/load.ts"
import { describe, expect, test } from "./_harness.ts"

const HEADER = [
    "---",
    "tier: volatile",
    "editable: replace",
    "budget: 2000",
    "eviction: oldest",
    "---",
    "",
    "<!-- Guidance the model must never be billed for. -->",
    "",
    "# What I know",
    "",
]

function scratch(): { dir: string; file: string; archive: string } {
    const dir = mkdtempSync(join(tmpdir(), "memory-writer-"))
    return { dir, file: join(dir, "MEMORY.md"), archive: join(dir, "memory") }
}

function note(i: number, month = 8): string {
    return (
        `- **2026-${`${month}`.padStart(2, "0")}-${`${(i % 28) + 1}`.padStart(2, "0")}T10:00:00Z** ` +
        `_(project)_ Note number ${i}: the person prefers tabs over spaces in generated YAML ` +
        "and wants boot to stay under one second."
    )
}

describe("entriesIn", () => {
    test("finds top-level items and leaves structure alone", () => {
        const lines = [...HEADER, "- one", "- two", "", "## Later", "", "- three"]
        const entries = entriesIn(lines)
        expect(entries.length).toBe(3)
        expect(entries[0]?.text).toBe("- one")
        expect(entries[2]?.text).toBe("- three")
    })

    test("an item absorbs its wrapped and indented continuation", () => {
        const entries = entriesIn(["- first line", "  wrapped", "    - nested", "- second"])
        expect(entries.length).toBe(2)
        expect(entries[0]?.text).toBe("- first line\n  wrapped\n    - nested")
    })

    test("a heading ends an item without becoming one", () => {
        const entries = entriesIn(["- a note", "## Heading", "- another"])
        expect(entries.length).toBe(2)
        expect(entries.some((e) => e.text.includes("Heading"))).toBe(false)
    })
})

describe("planEviction", () => {
    test("evicts from the top until the file fits", () => {
        const raw = [...HEADER, ...Array.from({ length: 40 }, (_, i) => note(i))].join("\n")
        expect(injectedTokens(raw) > 500).toBe(true)

        const plan = planEviction(raw, 500)
        expect(plan.evict.length > 0).toBe(true)
        expect(plan.tokens <= 500).toBe(true)
        expect(plan.shortfall).toBe(undefined)
        // Oldest means highest in the file: a stamp is hand-editable, a position is not.
        expect(plan.evict[0]?.text.includes("Note number 0")).toBe(true)
        expect(plan.remaining.includes("Note number 0")).toBe(false)
        expect(plan.remaining.includes("Note number 39")).toBe(true)
    })

    test("frontmatter, comments and headings survive eviction untouched", () => {
        const raw = [...HEADER, ...Array.from({ length: 40 }, (_, i) => note(i))].join("\n")
        const plan = planEviction(raw, 400)
        expect(plan.remaining.includes("tier: volatile")).toBe(true)
        expect(plan.remaining.includes("eviction: oldest")).toBe(true)
        expect(plan.remaining.includes("<!-- Guidance")).toBe(true)
        expect(plan.remaining.includes("# What I know")).toBe(true)
    })

    test("a file already inside its budget is left alone", () => {
        const raw = [...HEADER, note(1)].join("\n")
        const plan = planEviction(raw, 2000)
        expect(plan.evict.length).toBe(0)
        expect(plan.remaining).toBe(raw)
    })

    test("one note over budget reports a shortfall rather than emptying the file", () => {
        // Emptying would hide a configuration problem while still failing the load — the budget is
        // smaller than one thing the agent is meant to remember, and only a person can resolve that.
        const raw = [...HEADER, note(1)].join("\n")
        const plan = planEviction(raw, 5)
        expect(plan.evict.length).toBe(0)
        expect(plan.shortfall === undefined).toBe(false)
        expect(plan.shortfall?.includes("eviction cannot help")).toBe(true)
        expect(plan.remaining.includes("Note number 1")).toBe(true)
    })
})

describe("archiveNameFor", () => {
    test("a stamped note goes to its own month", () => {
        expect(archiveNameFor(note(3, 7), new Date("2026-08-19T00:00:00Z"))).toBe("2026-07.md")
    })

    test("an unstamped note goes to the current month", () => {
        expect(archiveNameFor("- no stamp here", new Date("2026-08-19T00:00:00Z"))).toBe(
            "2026-08.md",
        )
    })
})

describe("appendNote", () => {
    const NOW = new Date("2026-08-19T10:00:00Z")

    test("appends without evicting when there is room", async () => {
        const { file, archive } = scratch()
        writeFileSync(file, `${HEADER.join("\n")}\n`)
        const result = await appendNote({
            path: file,
            name: "MEMORY.md",
            budget: 2000,
            archiveDir: archive,
            text: "Moeen prefers tabs.",
            tags: ["style"],
            now: NOW,
        })

        expect(result.evicted).toBe(0)
        expect(result.archives).toEqual([])
        const written = readFileSync(file, "utf8")
        expect(written.includes("**2026-08-19T10:00:00.000Z** _(style)_ Moeen prefers tabs.")).toBe(
            true,
        )
        // No eviction means no directory: the archive is created on first use, never speculatively.
        expect(() => readdirSync(archive)).toThrow()
    })

    test("the note being saved is never the one evicted", async () => {
        // Reachable whenever the file is already at its limit, and it would be the worst possible
        // outcome: a save that silently discarded the thing it was asked to remember.
        const { file, archive } = scratch()
        writeFileSync(
            file,
            `${[...HEADER, ...Array.from({ length: 40 }, (_, i) => note(i))].join("\n")}\n`,
        )
        const result = await appendNote({
            path: file,
            name: "MEMORY.md",
            budget: 300,
            archiveDir: archive,
            text: "THE NEWEST FACT",
            tags: [],
            now: NOW,
        })

        expect(result.evicted > 0).toBe(true)
        expect(readFileSync(file, "utf8").includes("THE NEWEST FACT")).toBe(true)
    })

    test("evicted notes land in month files and nothing is lost", async () => {
        const { file, archive } = scratch()
        const notes = [
            ...Array.from({ length: 12 }, (_, i) => note(i, 6)),
            ...Array.from({ length: 12 }, (_, i) => note(i + 100, 7)),
        ]
        writeFileSync(file, `${[...HEADER, ...notes].join("\n")}\n`)

        const result = await appendNote({
            path: file,
            name: "MEMORY.md",
            budget: 300,
            archiveDir: archive,
            text: "the newest",
            tags: [],
            now: NOW,
        })

        expect(result.evicted > 0).toBe(true)
        const files = readdirSync(archive).sort()
        expect(files.includes("2026-06.md")).toBe(true)

        const archived = files.map((name) => readFileSync(join(archive, name), "utf8")).join("\n")
        const kept = readFileSync(file, "utf8")
        // Every evicted note is readable somewhere: the carried file or an archive. Nothing evaporates.
        for (let i = 0; i < 12; i += 1) {
            const body = `Note number ${i}:`
            expect(archived.includes(body) || kept.includes(body)).toBe(true)
        }
    })

    test("stays under budget across two hundred saves", async () => {
        // The regression this file exists for. Asserted against `injectedTokens`, which is the loader's
        // own measurement — an entry count would pass while the agent still refused to boot.
        const { file, archive } = scratch()
        writeFileSync(file, `${HEADER.join("\n")}\n`)

        for (let i = 0; i < 200; i += 1) {
            const result = await appendNote({
                path: file,
                name: "MEMORY.md",
                budget: 2000,
                archiveDir: archive,
                text: `Note number ${i}: the person prefers tabs over spaces in generated YAML.`,
                tags: ["project"],
                now: new Date(NOW.getTime() + i * 3_600_000),
            })
            expect(result.shortfall).toBe(undefined)
        }

        const raw = readFileSync(file, "utf8")
        expect(injectedTokens(raw) <= 2000).toBe(true)
        // And the older notes are still on disk, retrievable rather than deleted.
        const archived = readdirSync(archive)
        expect(archived.length > 0).toBe(true)
        expect(raw.includes("Note number 199")).toBe(true)
    })
})

describe("which file memory_write targets", () => {
    /**
     * A workspace whose volatile tier lists a person's file first and the notes file second.
     *
     * This is what `init` generates, and under plain declared order it resolved to `USER.md`: every
     * saved note appended to the hand-written description of the person, which then grew until it burst
     * its own 1,500-token budget and the agent refused to boot — while `MEMORY.md`, the file that exists
     * for notes and declares how to trim them, was never written to at all.
     */
    function workspace(files: readonly { name: string; editable: string; eviction?: string }[]) {
        return {
            files: files.map((file) => ({
                name: file.name,
                path: `/tmp/${file.name}`,
                tier: "volatile" as const,
                editable: file.editable,
                eviction: file.eviction ?? "none",
                budget: 2000,
                content: "",
                tokens: 0,
                rules: 0,
                authored: "",
                examples: "",
            })),
            static: "",
            examples: "",
            volatile: "",
            reminder: "",
            tokens: { static: 0, volatile: 0, reminder: 0, total: 0 },
        } as unknown as Parameters<typeof writeTarget>[0]
    }

    test("the file declaring eviction wins over declared order", () => {
        const target = writeTarget(
            workspace([
                { name: "USER.md", editable: "append" },
                { name: "MEMORY.md", editable: "replace", eviction: "oldest" },
            ]),
        )
        expect(target?.name).toBe("MEMORY.md")
        expect(target?.eviction).toBe("oldest")
    })

    test("declared order still decides when nothing declares eviction", () => {
        const target = writeTarget(
            workspace([
                { name: "USER.md", editable: "append" },
                { name: "MEMORY.md", editable: "replace" },
            ]),
        )
        expect(target?.name).toBe("USER.md")
    })

    test("a read-only evicting file does not win — it cannot be written at all", () => {
        const target = writeTarget(
            workspace([
                { name: "USER.md", editable: "append" },
                { name: "MEMORY.md", editable: "none", eviction: "oldest" },
            ]),
        )
        expect(target?.name).toBe("USER.md")
    })
})
