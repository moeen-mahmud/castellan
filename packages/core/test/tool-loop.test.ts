/**
 * The step loop with tools in it, end to end, against a scripted endpoint.
 *
 * A real model is the wrong instrument for these: what matters is that a *given* output produces a
 * given sequence of calls, messages and events, and a live model cannot be asked to produce a
 * malformed block twice in a row on demand. The live runs prove the model can drive this; these
 * prove the harness does the right thing with whatever the model says.
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

function workspace(toolsSection = "  local:\n    - now\n    - memory_write\n"): string {
    const dir = mkdtempSync(join(tmpdir(), "tool-loop-"))
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
  window: 16384
  reserveOutput: 1024
  files:
    - IDENTITY.md
tools:
  dialect: nlt
${toolsSection}limits:
  maxSteps: 4
  turnTimeoutMs: 5000
`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "You are a test fixture.")
    return dir
}

function sse(text: string): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(
                encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
                ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
        },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

interface Scripted {
    readonly fetch: FetchLike
    /** Every request body the loop sent, in order. */
    readonly requests: { messages: { role: string; content: string }[] }[]
}

/** Replies with each script entry in turn, then repeats the last one. */
function scripted(script: readonly string[]): Scripted {
    const requests: { messages: { role: string; content: string }[] }[] = []
    let index = 0
    return {
        requests,
        fetch: async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)))
            const text = script[Math.min(index, script.length - 1)] ?? ""
            index += 1
            return sse(text)
        },
    }
}

async function run(
    script: readonly string[],
    options: { toolsSection?: string } = {},
): Promise<{
    result: Awaited<ReturnType<import("../src/runtime/agent.ts").Agent["send"]>>
    history: readonly { role: string; content: string }[]
    events: AnyEvent[]
    requests: Scripted["requests"]
    runtime: Runtime
}> {
    const dir = workspace(options.toolsSection)
    const { fetch, requests } = scripted(script)
    const runtime = await Runtime.create({ agents: [join(dir, "agent.yaml")], env: ENV, fetch })
    const events: AnyEvent[] = []
    runtime.bus.on("*", (event) => events.push(event))

    const agent = runtime.agent("test")
    const result = await agent.send("what time is it?")
    const history = await agent.history()
    return { result, history, events, requests, runtime }
}

/** An event's payload, asserting it arrived at all — a missing event fails here, not on `.data`. */
function payload<T>(event: AnyEvent | undefined): T {
    expect(event).toBeDefined()
    return (event as AnyEvent).data as T
}

describe("a tool turn", () => {
    test("calls the tool, observes it, and replies", async () => {
        const { result, history, requests, runtime } = await run([
            "Let me check.\nACTION: now\nEND",
            "It is just after nine.",
        ])

        expect(result.reason).toBe("final")
        expect(result.steps).toBe(2)
        // The reply is the prose from both steps — the narration is for the person, the block is not.
        expect(result.text).toBe("Let me check.\n\nIt is just after nine.")

        // The trace is what happened: the call as written, the observation, then the answer.
        expect(history.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
        ])
        expect(history[1]?.content).toContain("ACTION: now")
        expect(history[2]?.content).toContain("OBSERVATION now — ok")

        // The second call carries the first call and its observation.
        expect(requests[1]?.messages.some((m) => m.content.includes("OBSERVATION now"))).toBe(true)
        await runtime.stop()
    })

    test("chains two tools across three steps", async () => {
        const { result, events, runtime } = await run([
            "ACTION: now\nEND",
            "Noting that.\nACTION: memory_write\ntext: the check happened\nEND",
            "Done.",
        ])

        expect(result.reason).toBe("final")
        expect(result.steps).toBe(3)
        expect(
            events
                .filter((event) => event.type === "tool.call")
                .map((event) => (event.data as { slug: string }).slug),
        ).toEqual(["now", "memory_write"])
        await runtime.stop()
    })

    test("emits tool.call and tool.result around the call, with the step id attached", async () => {
        const { events, runtime } = await run(["ACTION: now\nEND", "done"])
        const call = events.find((event) => event.type === "tool.call")
        const done = events.find((event) => event.type === "tool.result")
        expect(call?.stepId).toBeDefined()
        expect(call?.turnId).toBeDefined()
        expect(payload<{ ok: boolean }>(done).ok).toBe(true)
        expect(events.indexOf(call as AnyEvent)).toBeLessThan(events.indexOf(done as AnyEvent))
        await runtime.stop()
    })
})

describe("the catalogue in context", () => {
    test("is a system message in slot 1, teaching the format", async () => {
        const { requests, runtime } = await run(["nothing to do"])
        const system = requests[0]?.messages.filter((message) => message.role === "system") ?? []
        expect(system.length).toBe(2)
        expect(system[0]?.content).toContain("test fixture")
        expect(system[1]?.content).toContain("ACTION: tool_name")
        expect(system[1]?.content).toContain("### now")
        await runtime.stop()
    })

    test("is byte-identical across steps — the prefix has to be cacheable", async () => {
        // Slot 1 varying per turn is the failure with no symptom: prompt caching silently stops
        // working and the only evidence is the bill.
        const { requests, runtime } = await run(["ACTION: now\nEND", "done"])
        const first = requests[0]?.messages[1]?.content
        const second = requests[1]?.messages[1]?.content
        expect(first).toBe(second)
        expect(first).toContain("### memory_write")
        await runtime.stop()
    })

    test("an agent with no tools gets no slot 1 and no parsing at all", async () => {
        // A reply that merely mentions the keyword must not be mistaken for a call.
        const { result, history, requests, runtime } = await run(
            ["To use it you would write ACTION: now\nEND"],
            { toolsSection: "" },
        )
        expect(requests[0]?.messages.filter((m) => m.role === "system").length).toBe(1)
        expect(result.reason).toBe("final")
        expect(result.text).toContain("ACTION: now")
        expect(history.map((message) => message.role)).toEqual(["user", "assistant"])
        await runtime.stop()
    })
})

describe("repair", () => {
    test("a malformed block is corrected once and then works", async () => {
        const { result, events, requests, runtime } = await run([
            "ACTION: memory_write\nEND",
            "ACTION: memory_write\ntext: now with the field\nEND",
            "Saved as asked.",
        ])

        expect(result.reason).toBe("final")
        expect(result.steps).toBe(3)
        const repairs = events.filter((event) => event.type === "tool.repair")
        expect(repairs.length).toBe(1)
        expect(payload<{ errors: string[] }>(repairs[0]).errors[0]).toContain("memory_write.text")
        expect(requests[1]?.messages.some((m) => m.content.includes("only retry"))).toBe(true)
        await runtime.stop()
    })

    test("a second failure ends the turn instead of asking again", async () => {
        const { result, events, runtime } = await run(["ACTION: memory_write\nEND"])

        expect(result.reason).toBe("error")
        expect(result.error?.code).toBe("tool_repair_failed")
        expect(result.error?.hint).toContain("One repair is attempted, never two")
        // Two steps, not four: the step budget is not spent looping on the same broken block.
        expect(result.steps).toBe(2)
        expect(events.filter((event) => event.type === "tool.repair").length).toBe(2)
        await runtime.stop()
    })

    test("an invented tool is a repair, not a crash", async () => {
        const { result, events, runtime } = await run([
            "ACTION: send_email\nto: a@b.com\nEND",
            "Sorry — I cannot send email.",
        ])
        expect(result.reason).toBe("final")
        expect(result.text).toBe("Sorry — I cannot send email.")
        const repair = payload<{ errors: string[] }>(
            events.find((event) => event.type === "tool.repair"),
        )
        expect(repair.errors[0]).toContain("send_email")
        await runtime.stop()
    })

    test("a failed turn keeps its trace when a mutating tool had already succeeded", async () => {
        // The write happened. Discarding the record would let the next turn do it again — which is
        // worse than the half-answer the empty-on-error rule exists to prevent.
        const { result, history, runtime } = await run([
            "ACTION: memory_write\ntext: something durable\nEND",
            "ACTION: memory_write\nEND",
        ])

        expect(result.reason).toBe("error")
        expect(history.length).toBeGreaterThan(0)
        expect(history[1]?.content).toContain("something durable")
        await runtime.stop()
    })

    test("a failed turn with no side effect appends nothing", async () => {
        const { result, history, runtime } = await run(["ACTION: send_email\nEND"])
        expect(result.reason).toBe("error")
        expect(history).toEqual([])
        await runtime.stop()
    })
})

describe("the step cap", () => {
    test("running out of steps mid-task is max_steps, not a completed turn", async () => {
        // The model keeps calling tools and never answers. Reporting `final` here would be the
        // "healthy but does nothing" shape that hard rule 8 exists to prevent.
        const { result, runtime } = await run(["Working on it.\nACTION: now\nEND"])
        expect(result.steps).toBe(4)
        expect(result.reason).toBe("max_steps")
        await runtime.stop()
    })
})
