/**
 * Context assembly's reported shape.
 *
 * `slotReport` feeds `GET /v1/agents/:id/context` and the `context.assembled` event, and it had no
 * tests at all — which is how it came to drop `label` while `ContextBlock.label`'s own comment
 * described it as existing for that endpoint. An unasserted wire field is one nobody notices the
 * absence of.
 */

import { assembleContext, slotReport } from "../src/context/assemble.ts"
import { SLOT } from "../src/context/blocks.ts"
import { describe, expect, test } from "./_harness.ts"

function assemble() {
    return assembleContext({
        identity: "You are a test fixture.",
        history: [
            { role: "user", content: "first" },
            { role: "assistant", content: "second" },
            { role: "user", content: "third" },
        ],
        input: "what now",
        lastError: "something went wrong earlier",
        window: 8192,
        reserveOutput: 1024,
    })
}

describe("slotReport", () => {
    test("every reported slot carries a label, not just a number", () => {
        // The regression guard. Slot numbers are positional and renumber whenever a slot is inserted,
        // so a consumer reading meaning from the number breaks on the next insertion.
        const report = slotReport(assemble().blocks)
        expect(report.length > 0).toBe(true)
        for (const entry of report) {
            expect(entry.label.length > 0).toBe(true)
        }
    })

    test("labels name the slots actually assembled", () => {
        const byLabel = new Map(slotReport(assemble().blocks).map((e) => [e.label, e.slot]))
        expect(byLabel.get("identity")).toBe(SLOT.identity)
        expect(byLabel.get("history")).toBe(SLOT.history)
        expect(byLabel.get("input")).toBe(SLOT.input)
        expect(byLabel.get("last-error")).toBe(SLOT.error)
    })

    test("blocks sharing a slot collapse to one entry whose tokens sum", () => {
        // Three history messages are three blocks in slot 6. The report is per slot, not per block.
        const assembled = assemble()
        const historyBlocks = assembled.blocks.filter((b) => b.slot === SLOT.history)
        expect(historyBlocks.length).toBe(3)

        const entry = slotReport(assembled.blocks).find((e) => e.slot === SLOT.history)
        const summed = historyBlocks.reduce((total, b) => total + b.tokens, 0)
        expect(entry?.tokens).toBe(summed)
    })

    test("entries are ordered by slot, which is prompt order", () => {
        const slots = slotReport(assemble().blocks).map((e) => e.slot)
        expect([...slots].sort((a, b) => a - b)).toEqual(slots)
    })

    test("pinned survives into the report — it is what says a slot outlives compaction", () => {
        const report = slotReport(assemble().blocks)
        expect(report.find((e) => e.slot === SLOT.identity)?.pinned).toBe(true)
        expect(report.find((e) => e.slot === SLOT.history)?.pinned).toBe(false)
    })

    test("reported tokens total the assembled total", () => {
        const assembled = assemble()
        const total = slotReport(assembled.blocks).reduce((sum, e) => sum + e.tokens, 0)
        expect(total).toBe(assembled.totalTokens)
    })
})

describe("slot numbering", () => {
    test("every slot number is distinct — a collision would merge two slots in the report", () => {
        const numbers = Object.values(SLOT)
        expect(new Set(numbers).size).toBe(numbers.length)
    })

    test("declared order matches numeric order, so the architecture table reads top to bottom", () => {
        // The invariant that makes slot number mean prompt position. Inserting a slot out of order
        // here is how the doc table and the assembled prompt quietly stop agreeing.
        const numbers = Object.values(SLOT)
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers)
    })

    test("the workspace tiers sit where the cache and recency arguments put them", () => {
        // volatile after the cached prefix; reminder after the history and before the input.
        expect(SLOT.volatile > SLOT.tools).toBe(true)
        expect(SLOT.reminder > SLOT.history).toBe(true)
        expect(SLOT.reminder < SLOT.input).toBe(true)
    })
})

describe("workspace tiers in the assembled prompt", () => {
    function withTiers(volatileText: string) {
        return assembleContext({
            identity: "You are a test fixture.",
            toolBlocks: [
                {
                    slot: SLOT.tools,
                    role: "system",
                    content: "TOOLS: none",
                    pinned: true,
                    tokens: 4,
                    label: "tools",
                },
            ],
            volatile: volatileText,
            reminder: "Answer in prose.",
            history: [
                { role: "user", content: "first" },
                { role: "assistant", content: "second" },
            ],
            input: "what now",
            window: 8192,
            reserveOutput: 1024,
        })
    }

    test("a volatile change leaves slots 0 and 1 byte-identical", () => {
        // The whole reason slot 2 exists. Prompt caching matches a byte-exact prefix, so a memory
        // write that moved slot 0's bytes would invalidate the cache on every write — with no error,
        // no failed turn, and no symptom other than the bill.
        const before = withTiers("Known: the user prefers metric units.")
        const after = withTiers("Known: the user prefers metric units. Lives in Lisbon.")

        const prefix = (assembled: ReturnType<typeof withTiers>): string =>
            assembled.blocks
                .filter((b) => b.slot === SLOT.identity || b.slot === SLOT.tools)
                .map((b) => b.content)
                .join(" ")

        expect(prefix(after)).toBe(prefix(before))
        expect(before.blocks.some((b) => b.slot === SLOT.volatile)).toBe(true)
    })

    test("volatile follows the catalogue and precedes the history", () => {
        const slots = withTiers("Memory.").blocks.map((b) => b.slot)
        expect(slots.indexOf(SLOT.volatile) > slots.indexOf(SLOT.tools)).toBe(true)
        expect(slots.indexOf(SLOT.volatile) < slots.indexOf(SLOT.history)).toBe(true)
    })

    test("reminder lands after the history and before the input", () => {
        const slots = withTiers("Memory.").blocks.map((b) => b.slot)
        expect(slots.lastIndexOf(SLOT.history) < slots.indexOf(SLOT.reminder)).toBe(true)
        expect(slots.indexOf(SLOT.reminder) < slots.indexOf(SLOT.input)).toBe(true)
    })

    test("both tiers are pinned, so compaction cannot eat them", () => {
        const report = slotReport(withTiers("Memory.").blocks)
        expect(report.find((e) => e.slot === SLOT.volatile)?.pinned).toBe(true)
        expect(report.find((e) => e.slot === SLOT.reminder)?.pinned).toBe(true)
        expect(report.find((e) => e.slot === SLOT.reminder)?.label).toBe("workspace-reminder")
    })

    test("an empty tier produces no block at all", () => {
        const slots = withTiers("").blocks.map((b) => b.slot)
        expect(slots.includes(SLOT.volatile)).toBe(false)
    })
})

describe("examples and knowledge slots", () => {
    function assembleWithExtras() {
        return assembleContext({
            identity: "You are a test fixture.",
            examples: "Example 1:\nuser: hi\nagent: hello",
            volatile: "## Memory\nremembers things",
            knowledge: [
                { name: "deploys.md", content: "Use blue-green." },
                { name: "oncall.md", content: "Page the secondary first." },
            ],
            history: [{ role: "user", content: "first" }],
            input: "what now",
            window: 8192,
            reserveOutput: 1024,
        })
    }

    test("examples travel as a user message between the catalogue and the volatile tier", () => {
        const blocks = assembleWithExtras().blocks
        const examples = blocks.find((b) => b.label === "workspace-examples")
        expect(examples?.role).toBe("user")
        expect(examples?.slot).toBe(SLOT.examples)
        expect(examples?.pinned).toBe(true)
        // Order in the message sequence: identity, examples, volatile — the byte-stable content
        // stays contiguous ahead of the tier that mutates, or prefix caching loses it.
        const labels = blocks.map((b) => b.label)
        expect(labels.indexOf("workspace-examples")).toBeGreaterThan(labels.indexOf("identity"))
        expect(labels.indexOf("workspace-volatile")).toBeGreaterThan(
            labels.indexOf("workspace-examples"),
        )
    })

    test("knowledge blocks are budgeted but not pinned — compaction may drop them", () => {
        const blocks = assembleWithExtras().blocks
        const knowledge = blocks.filter((b) => b.slot === SLOT.knowledge)
        expect(knowledge.length).toBe(2)
        for (const block of knowledge) {
            expect(block.pinned).toBe(false)
            expect(block.role).toBe("system")
        }
        // They sit after the volatile tier and before the history they inform.
        const labels = blocks.map((b) => b.label)
        expect(labels.indexOf("knowledge:deploys.md")).toBeGreaterThan(
            labels.indexOf("workspace-volatile"),
        )
        expect(labels.indexOf("history")).toBeGreaterThan(labels.indexOf("knowledge:oncall.md"))
    })

    test("absent examples and knowledge assemble exactly as before", () => {
        const labels = assemble().blocks.map((b) => b.label)
        expect(labels.includes("workspace-examples")).toBe(false)
        expect(labels.some((label) => label.startsWith("knowledge:"))).toBe(false)
    })
})
