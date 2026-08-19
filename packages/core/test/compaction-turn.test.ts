/**
 * Compaction inside a real turn, through `Runtime.create`.
 *
 * The unit tests in `compaction.test.ts` prove the stages and the ladder in isolation. This one exists
 * because every layer being individually right is not the same as the layers being connected — the
 * repeated lesson in this repo, from `ChatMessage.toolCalls` to `TurnInput.skills`, is that a field
 * threaded through a pipeline needs one test at the *end* of it. So these assertions read the events a
 * subscriber actually receives and the rows the store actually holds, never the ladder's return value.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { AnyEvent } from "../src/events/types.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import { describe, expect, test } from "./_harness.ts"

const ENV = { MODEL_API_KEY: "test-key" }

/**
 * A window small enough that a couple of turns crosses `trim`, with an observation-producing tool.
 *
 * `window` is set explicitly rather than left to capability resolution: the point is to reach a
 * threshold in a handful of turns, and doing that on a 128k window would need a fixture nobody would
 * read.
 */
function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "compaction-turn-"))
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 4000
  reserveOutput: 500
  files:
    - IDENTITY.md
  thresholds:
    trim: 0.60
    snip: 0.70
    micro: 0.80
    collapse: 0.88
    reset: 0.95
tools:
  local:
    - now
    - artifact_read
limits:
  maxSteps: 2
  turnTimeoutMs: 5000
`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")
    return dir
}

function sse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
        },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

function delta(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

/** A long reply, so history grows fast enough to cross a threshold within a readable fixture. */
const LONG = "This is a filler sentence that exists only to consume prompt budget. ".repeat(12)

const longFetch: FetchLike = async () => sse([delta(LONG), "data: [DONE]\n\n"])

async function runtimeWith(bus: AnyEvent[]) {
    const runtime = await Runtime.create({
        agents: [join(workspace(), "agent.yaml")],
        env: ENV,
        fetch: longFetch,
    })
    runtime.bus.on("*", (event) => bus.push(event))
    return runtime
}

describe("a session under pressure", () => {
    test("pressure is reported on every step, with its provenance", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        await runtime.agent("test").send("hello")
        await runtime.stop()

        const pressure = seen.filter((event) => event.type === "context.pressure")
        expect(pressure.length).toBeGreaterThan(0)
        const data = pressure[0]?.data as { fraction: number; source: string; budget: number }
        expect(data.budget).toBe(3500)
        // No endpoint reported `prompt_tokens` here — the stub sends no usage — so the figure is the
        // raw estimate and says so. A bare fraction would be indistinguishable from a corrected one.
        expect(data.source).toBe("estimated")
        expect(data.fraction).toBeGreaterThan(0)
    })

    test("the ladder fires as history grows, and never exceeds the window", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        const agent = runtime.agent("test")

        for (let turn = 0; turn < 12; turn += 1) {
            await agent.send(`turn ${turn}: tell me something at length`)
        }
        await runtime.stop()

        const stages = seen.filter((event) => event.type === "compaction.stage")
        expect(stages.length).toBeGreaterThan(0)
        expect(stages.map((event) => (event.data as { stage: string }).stage)).toContain("trim")

        // The whole point: no assembled prompt ever exceeds what the budget allows. `context.assembled`
        // is emitted *after* compaction, so this reads the prompt that was actually sent.
        const totals = seen
            .filter((event) => event.type === "context.assembled")
            .map((event) => (event.data as { total: number }).total)
        expect(totals.length).toBeGreaterThan(0)
        expect(Math.max(...totals)).toBeLessThanOrEqual(3500)
    })

    test("compaction leaves the cache-stable prefix byte-identical", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        const agent = runtime.agent("test")
        for (let turn = 0; turn < 12; turn += 1) await agent.send(`turn ${turn}: go on`)
        await runtime.stop()

        // Slots 0-2 are the cached prefix. If a stage touched them the cost would rise with no error
        // anywhere and no symptom but the bill, which is why this is asserted on the reported slots
        // rather than trusted to the ladder's protected-tail arithmetic.
        const reports = seen
            .filter((event) => event.type === "context.assembled")
            .map((event) => event.data as { slots: { slot: number; tokens: number }[] })
        const prefixes = reports.map((report) =>
            report.slots
                .filter((slot) => slot.slot <= 2)
                .map((slot) => `${slot.slot}:${slot.tokens}`)
                .join("|"),
        )
        expect(new Set(prefixes).size).toBe(1)
    })
})

describe("the compaction notice", () => {
    test("reaches the model, and mentions artifact_read because this agent has it", async () => {
        // Asserted on the **request body**, not on a rendered block. `previewContext` reports slot
        // sizes rather than content, and a unit test of the renderer would have passed while the
        // notice was never wired in — which is the exact failure shape this repo keeps recording for
        // fields threaded through a pipeline. Recording `fetch` and grepping the prompt is the cheap
        // guard for it.
        let body = ""
        const recording: FetchLike = async (_url: unknown, init?: { body?: unknown }) => {
            body = String(init?.body ?? "")
            return sse([delta("ok"), "data: [DONE]\n\n"])
        }
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: recording,
        })
        await runtime.agent("test").send("hi")
        await runtime.stop()

        expect(body).toContain("context is managed for you")
        expect(body).toContain("do not shorten your work")
        // Named only because the tool is pinned. Naming a tool an agent lacks is how a model comes to
        // report that it tried something it never could.
        expect(body).toContain("artifact_read")
    })
})

describe("the pressure gauge describes the prompt that was sent", () => {
    test("under compaction it reports the settled figure and keeps the peak", async () => {
        const seen: AnyEvent[] = []
        const runtime = await runtimeWith(seen)
        const agent = runtime.agent("test")
        for (let turn = 0; turn < 12; turn += 1) await agent.send(`turn ${turn}: at length`)
        await runtime.stop()

        const compacted = seen
            .filter((event) => event.type === "context.pressure")
            .map((event) => event.data as { fraction: number; peak?: number })
            .filter((data) => data.peak !== undefined)

        expect(compacted.length).toBeGreaterThan(0)
        for (const data of compacted) {
            // The peak is what the ladder faced; the fraction is what went out. Reporting the peak as
            // the fraction put `ctx 128%` on a real status line for a prompt nobody ever sent.
            expect(data.peak ?? 0).toBeGreaterThan(data.fraction)
            expect(data.fraction).toBeLessThanOrEqual(1)
        }
    })
})
