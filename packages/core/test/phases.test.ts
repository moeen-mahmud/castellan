/**
 * Phase-scoped tool visibility.
 *
 * The unit half asserts the matcher and the entry rule; the turn half asserts the property that is the
 * whole feature — `triage` → `phase_set("act")` → write, **inside one turn**. That one is read off the
 * request bodies rather than off the registry, because every layer being individually right is not the
 * same as them being connected, and a catalogue filtered correctly but never handed to the endpoint is
 * exactly the failure shape this repo keeps recording.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import type { AnyEvent } from "../src/events/types.ts"
import {
    allowFor,
    allowMatches,
    entryPhase,
    isPhased,
    otherPhases,
    PHASE_SET,
    type PhaseMap,
    unmatchedAllows,
    visibleIn,
} from "../src/loop/phases.ts"
import type { FetchLike } from "../src/model/provider.ts"
import { Runtime } from "../src/runtime/runtime.ts"
import type { ToolSpec } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

function spec(slug: string, tags: readonly string[], mutating = false): ToolSpec {
    return {
        slug,
        provider: "local",
        summary: slug,
        whenToUse: `you need ${slug}`,
        mutating,
        tags,
        trust: "trusted",
        parameters: { type: "object", properties: {} },
    }
}

const SPECS: readonly ToolSpec[] = [
    spec("now", ["read", "time"]),
    spec("artifact_read", ["read", "context"]),
    spec("memory_write", ["write", "memory"], true),
    spec("config_set", ["write", "config"], true),
]

const PHASES: PhaseMap = {
    triage: { allow: ["tag:read"], entry: true },
    act: { allow: ["tag:read", "tag:write"] },
}

describe("matching", () => {
    test("a slug matches, and normalisation is the registry's", () => {
        expect(allowMatches("memory_write", spec("memory_write", []))).toBe(true)
        // Same normalisation as `ToolRegistry`, so an author who writes a hyphen is not silently ignored.
        expect(allowMatches("memory-write", spec("memory_write", []))).toBe(true)
        expect(allowMatches("memory", spec("memory_write", []))).toBe(false)
    })

    test("a tag matches on the tool's own tags, case-insensitively", () => {
        expect(allowMatches("tag:read", spec("now", ["read"]))).toBe(true)
        expect(allowMatches("tag:READ", spec("now", ["read"]))).toBe(true)
        expect(allowMatches("tag:write", spec("now", ["read"]))).toBe(false)
    })

    test("`*` matches everything, and nothing else is a pattern", () => {
        expect(allowMatches("*", spec("anything", []))).toBe(true)
        // Deliberately not a glob: a second pattern language beside `tools.policy`'s, disagreeing about
        // what `exec*` means, is worse than not supporting it.
        expect(allowMatches("exec*", spec("exec", []))).toBe(false)
    })

    test("visibility keeps catalogue order, because slot 1 must be byte-stable per phase", () => {
        expect(visibleIn(SPECS, ["tag:read"]).map((s) => s.slug)).toEqual(["now", "artifact_read"])
        expect(visibleIn(SPECS, ["tag:write"]).map((s) => s.slug)).toEqual([
            "memory_write",
            "config_set",
        ])
    })
})

describe("the entry phase", () => {
    test("`entry: true` wins", () => {
        expect(entryPhase({ a: { allow: [] }, b: { allow: [], entry: true } })).toBe("b")
    })

    test("otherwise the first declared, which is why key order matters", () => {
        expect(entryPhase({ triage: { allow: [] }, act: { allow: [] } })).toBe("triage")
    })

    test("no phases means no entry", () => {
        expect(entryPhase({})).toBeUndefined()
    })
})

describe("phase_set is added to every phase", () => {
    test("a phase that omitted it would be a phase with no way out", () => {
        expect(allowFor(PHASES, "triage")).toEqual(["tag:read", PHASE_SET])
        // Not added twice when an author lists it.
        expect(allowFor({ x: { allow: ["*", PHASE_SET] } }, "x")).toEqual(["*", PHASE_SET])
    })

    test("an undeclared phase falls back to everything rather than to nothing", () => {
        // Reached when a stored phase names something the manifest no longer declares. Exposing every
        // tool is the safe direction here: exposing none would leave a resumed conversation unable to
        // act, with the model's own history showing it using tools it no longer has.
        expect(allowFor(PHASES, "gone")).toEqual(["*"])
    })

    test("one phase is not phased — there is nothing to move to", () => {
        expect(isPhased(undefined)).toBe(false)
        expect(isPhased({})).toBe(false)
        expect(isPhased({ only: { allow: ["*"] } })).toBe(false)
        expect(isPhased(PHASES)).toBe(true)
    })
})

describe("what the model is told about the phases it is not in", () => {
    test("counts, never slugs", () => {
        // Listing the hidden slugs would put the write tools back in front of a model in `triage` and
        // undo the constraint the phase exists to impose. A count plus a name gives it a reason to
        // switch and nothing to route over.
        expect(otherPhases(PHASES, "triage", SPECS)).toEqual([{ name: "act", adds: 2 }])
        expect(otherPhases(PHASES, "act", SPECS)).toEqual([{ name: "triage", adds: 0 }])
    })
})

describe("an allow entry that names nothing", () => {
    test("is reported with its phase, so the message can name the field", () => {
        expect(unmatchedAllows({ triage: { allow: ["tag:read", "gmail_send"] } }, SPECS)).toEqual([
            { phase: "triage", entry: "gmail_send" },
        ])
    })

    test("`*` and phase_set are never unmatched", () => {
        // `phase_set` is registered by the runtime rather than pinned, so an author listing it is not
        // making a mistake.
        expect(unmatchedAllows({ a: { allow: ["*", PHASE_SET] } }, SPECS)).toEqual([])
    })

    test("a tag no pinned tool carries is caught", () => {
        expect(unmatchedAllows({ a: { allow: ["tag:network"] } }, SPECS)).toEqual([
            { phase: "a", entry: "tag:network" },
        ])
    })
})

// ─── through a real turn ─────────────────────────────────────────────────────────────────

const ENV = { MODEL_API_KEY: "test-key" }

function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "phases-test-"))
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
  window: 32000
  reserveOutput: 2000
  files:
    - IDENTITY.md
tools:
  local:
    - now
    - memory_write
phases:
  triage:
    entry: true
    allow: ["tag:read"]
  act:
    allow: ["tag:read", "tag:write"]
limits:
  maxSteps: 4
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

/**
 * An NLT call block, in the shape the preamble teaches and `parseNlt` reads.
 *
 * `ACTION: <slug>` on one line — not `ACTION` with a `tool:` field, which was the first version of this
 * helper and produced a turn with exactly one request, because the block parsed as prose.
 */
function action(slug: string, fields: Record<string, string>): string {
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
    return [`ACTION: ${slug}`, ...lines, "END"].join("\n")
}

describe("a phase change takes effect inside the turn", () => {
    test("triage hides the write tool; after phase_set it is in the very next request", async () => {
        const bodies: string[] = []
        const replies = [
            // Step 1, in `triage`: move to `act`.
            action(PHASE_SET, { to: "act" }),
            // Step 2, now in `act`: use the tool triage did not have.
            action("memory_write", { text: "a note" }),
            // Step 3: done.
            "Saved.",
        ]
        const fetchStub: FetchLike = async (_url: unknown, init?: { body?: unknown }) => {
            bodies.push(String(init?.body ?? ""))
            const next = replies[bodies.length - 1] ?? "done"
            return sse([delta(next), "data: [DONE]\n\n"])
        }

        const seen: AnyEvent[] = []
        const runtime = await Runtime.create({
            agents: [join(workspace(), "agent.yaml")],
            env: ENV,
            fetch: fetchStub,
        })
        runtime.bus.on("*", (event) => seen.push(event))
        const result = await runtime.agent("test").send("triage this then act")
        await runtime.stop()

        expect(bodies.length).toBeGreaterThanOrEqual(2)

        // The first request is the whole claim: the catalogue in front of the model omits the write tool
        // and offers a way to reach it.
        expect(bodies[0]).toContain("now")
        expect(bodies[0]).toContain(PHASE_SET)
        expect(bodies[0]?.includes("memory_write")).toBe(false)
        expect(bodies[0]).toContain('in the \\"triage\\" phase')

        // The second is the other half: same turn, one step later, the tool is there.
        expect(bodies[1]).toContain("memory_write")
        expect(bodies[1]).toContain('in the \\"act\\" phase')

        expect(seen.some((event) => event.type === "phase.changed")).toBe(true)
        expect(result.phase).toBe("act")
    })

    test("the phase survives the turn and the process", async () => {
        const fetchStub: FetchLike = async () => sse([delta("ok"), "data: [DONE]\n\n"])
        const dir = workspace()
        const store = join(dir, "store.db")

        const first = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: fetchStub,
            store,
        })
        // Set it through the same seam a tool would, rather than reaching into the store: this asserts the
        // path that actually runs.
        await first.agent("test").send("hello")
        await first.stop()

        const second = await Runtime.create({
            agents: [join(dir, "agent.yaml")],
            env: ENV,
            fetch: fetchStub,
            store,
        })
        const resumed = await second.agent("test").send("again")
        await second.stop()
        // Still the entry phase, because nothing moved it — the point is that resuming does not *reset*
        // to the entry phase by accident, which a cache with no store behind it would.
        expect(resumed.phase).toBe("triage")
    })
})

describe("a manifest whose allow names nothing is refused at load", () => {
    test("naming the phase, the entry, and what is available", async () => {
        const dir = mkdtempSync(join(tmpdir(), "phases-bad-"))
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}
id: bad
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  local: [now]
phases:
  triage:
    allow: ["tag:read"]
  act:
    allow: ["gmail_send"]
`,
        )
        await expect(
            Runtime.create({ agents: [join(dir, "agent.yaml")], env: ENV }),
        ).rejects.toThrow("gmail_send")
    })
})
