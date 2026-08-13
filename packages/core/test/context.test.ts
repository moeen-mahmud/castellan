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
