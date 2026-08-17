import { assembleContext } from "../src/context/assemble.ts"
import { SLOT, skillHeader } from "../src/context/blocks.ts"
import { describe, expect, test } from "./_harness.ts"

const TOOL_BLOCK = {
    slot: SLOT.tools,
    role: "system" as const,
    content: "# Tools\n\nexec — run a shell command\nfile_read — read a file",
    pinned: true,
    label: "tools",
    tokens: 0,
}

function assemble(skills?: readonly { name: string; content: string; role: "system" | "user" }[]) {
    return assembleContext({
        identity: "I am a careful assistant.",
        toolBlocks: [TOOL_BLOCK],
        configSummary: "model: test",
        volatile: "Moeen is the person I work for.",
        ...(skills === undefined ? {} : { skills }),
        knowledge: [{ name: "rates.md", content: "The rate is 4%." }],
        reminder: "Answer in one paragraph.",
        history: [],
        input: "what is the rate",
        window: 100_000,
        reserveOutput: 1000,
    })
}

const SKILL = [
    {
        name: "pdf-processing",
        content: "## Extracting tables\n\nRun the extractor.",
        role: "system" as const,
    },
]

describe("the slot-1 catalogue does not move when a skill activates", () => {
    test("slot 0 through 2 are byte-identical with and without an active skill", () => {
        // The regression test for the defect that reshaped this phase. Decision 6.6 says a skill's scripts
        // are visible only while it is active, and `ToolRuntime.blocks` is documented as rendered once and
        // byte-stable "or prompt caching stops working". Rendering per-turn script entries into slot 1
        // would satisfy 6.6 and silently destroy the cached prefix — a failure with no symptom except the
        // bill, which is the first hazard CLAUDE.md lists. Skills live in slot 5 instead, after
        // breakpoint A, so the prefix cannot notice them.
        const without = assemble()
        const with_ = assemble(SKILL)

        const prefix = (blocks: readonly { slot: number; content: string }[]) =>
            blocks.filter((b) => b.slot <= SLOT.config).map((b) => `${b.slot}:${b.content}`)

        expect(prefix(with_.blocks)).toEqual(prefix(without.blocks))
    })

    test("an active skill adds exactly one block, in SLOT.skill", () => {
        const without = assemble().blocks.length
        const with_ = assemble(SKILL)
        expect(with_.blocks.length).toBe(without + 1)
        expect(with_.blocks.filter((b) => b.slot === SLOT.skill).length).toBe(1)
    })
})

describe("where the block sits and what it says", () => {
    test("after the volatile tier and before knowledge, matching the slot numbers", () => {
        // Slot order is prompt order, and the table in 01-ARCHITECTURE.md is meant to be readable top to
        // bottom. Asserted on positions rather than on numbers, so inserting a slot later cannot make
        // this pass while the prompt is wrong.
        const slots = assemble(SKILL).blocks.map((b) => b.slot)
        const skillAt = slots.indexOf(SLOT.skill)
        expect(skillAt).toBeGreaterThan(slots.indexOf(SLOT.volatile))
        expect(skillAt).toBeLessThan(slots.indexOf(SLOT.knowledge))
    })

    test("it is framed, because a procedure with no frame reads as background", () => {
        const block = assemble(SKILL).blocks.find((b) => b.slot === SLOT.skill)
        expect(block?.content).toContain(skillHeader("pdf-processing"))
        expect(block?.content).toContain("Run the extractor.")
    })

    test("the frame names the skill, which is also the prefix of its script slugs", () => {
        expect(skillHeader("pdf-processing")).toContain("pdf-processing")
    })

    test("the authored body is passed through byte-identical after the frame", () => {
        // Framing is allowed; rewriting an authored sentence is decision 4.19 and is not. Asserted so a
        // future renderer cannot start "improving" a procedure nobody re-reads.
        const body = "## Extracting tables\n\nRun the extractor."
        const block = assemble([
            { name: "pdf-processing", content: body, role: "system" },
        ]).blocks.find((b) => b.slot === SLOT.skill)
        expect(block?.content.endsWith(body)).toBe(true)
    })

    test("it is not pinned, so compaction may drop it", () => {
        // A procedure applies to the turn that summoned it. Carrying it through compaction would keep an
        // agent following last hour's instructions — the opposite of a workspace tier.
        const block = assemble(SKILL).blocks.find((b) => b.slot === SLOT.skill)
        expect(block?.pinned).toBe(false)
    })

    test("it is labelled with the skill name, so a slot report names what activated", () => {
        const block = assemble(SKILL).blocks.find((b) => b.slot === SLOT.skill)
        expect(block?.label).toBe("skill:pdf-processing")
    })

    test("it costs tokens, counted like everything else", () => {
        expect(assemble(SKILL).totalTokens).toBeGreaterThan(assemble().totalTokens)
    })
})

describe("skillsIn decides the role", () => {
    test("system", () => {
        const block = assemble([{ name: "a", content: "Body.", role: "system" }]).blocks.find(
            (b) => b.slot === SLOT.skill,
        )
        expect(block?.role).toBe("system")
    })

    test("user", () => {
        const block = assemble([{ name: "a", content: "Body.", role: "user" }]).blocks.find(
            (b) => b.slot === SLOT.skill,
        )
        expect(block?.role).toBe("user")
    })
})

describe("degenerate input", () => {
    test("an empty content string adds no block", () => {
        const without = assemble().blocks.length
        expect(assemble([{ name: "a", content: "   ", role: "system" }]).blocks.length).toBe(
            without,
        )
    })

    test("two active skills produce two blocks, in the order given", () => {
        const blocks = assemble([
            { name: "first", content: "One.", role: "system" },
            { name: "second", content: "Two.", role: "system" },
        ]).blocks.filter((b) => b.slot === SLOT.skill)
        expect(blocks.map((b) => b.label)).toEqual(["skill:first", "skill:second"])
    })
})
