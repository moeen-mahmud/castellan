import { describe, expect, test } from "bun:test"
import type { AnyEvent } from "@castellan/core"
import type { TranscriptState } from "#lib/types"
import { EMPTY_TRANSCRIPT, reduce, type TranscriptAction } from "#transcript"

/**
 * Envelope fields the reducer never reads. The cast is needed only because TypeScript cannot check
 * a generic object literal against a mapped discriminated union; every field is real.
 */
function ev<K extends AnyEvent["type"]>(
    type: K,
    data: Extract<AnyEvent, { type: K }>["data"],
): AnyEvent {
    return {
        v: 1,
        ts: "2026-08-13T00:00:00.000Z",
        runtimeId: "test",
        type,
        data,
    } as Extract<AnyEvent, { type: K }>
}

function run(actions: readonly TranscriptAction[], from = EMPTY_TRANSCRIPT): TranscriptState {
    return actions.reduce(reduce, from)
}

const START = {
    kind: "event",
    event: ev("turn.start", { source: "repl", inputTokens: 4 }),
} as const

function chunk(delta: string, kind: "text" | "reasoning" = "text"): TranscriptAction {
    return { kind: "event", event: ev("model.chunk", { delta, kind }) }
}

function end(reason: "final" | "stopped" | "error" | "timeout" | "max_steps"): TranscriptAction {
    return {
        kind: "event",
        event: ev("turn.end", {
            reason,
            steps: 1,
            tokens: { prompt: 10, output: 5 },
            durationMs: 250,
        }),
    }
}

describe("a clean turn", () => {
    test("a typed line becomes a user item immediately", () => {
        const state = run([{ kind: "user", text: "hello" }])
        expect(state.items).toHaveLength(1)
        expect(state.items[0]?.role).toBe("user")
        expect(state.items[0]?.text).toBe("hello")
    })

    test("turn.start opens an empty live turn and reports thinking", () => {
        const state = run([START])
        expect(state.status).toBe("thinking")
        expect(state.live).toEqual({ text: "", reasoning: "", last: undefined })
    })

    test("chunks accumulate in the live turn, not in the transcript", () => {
        const state = run([START, chunk("Hel"), chunk("lo")])
        expect(state.status).toBe("streaming")
        expect(state.live?.text).toBe("Hello")
        // Nothing has finished, so nothing may be committed — <Static> would freeze a partial line.
        expect(state.items).toHaveLength(0)
    })

    test("turn.end commits the reply with its stats and closes the live turn", () => {
        const state = run([{ kind: "user", text: "hi" }, START, chunk("there"), end("final")])
        expect(state.status).toBe("idle")
        expect(state.live).toBeUndefined()
        expect(state.items.map((i) => i.role)).toEqual(["user", "assistant"])
        expect(state.items[1]?.text).toBe("there")
        expect(state.items[1]?.stats).toEqual({
            promptTokens: 10,
            outputTokens: 5,
            durationMs: 250,
            steps: 1,
            reason: "final",
        })
    })
})

describe("the <Static> contract", () => {
    test("ids are unique across a long session", () => {
        let state = EMPTY_TRANSCRIPT
        for (let i = 0; i < 25; i += 1) {
            state = run(
                [{ kind: "user", text: `q${i}` }, START, chunk(`a${i}`), end("final")],
                state,
            )
        }
        const ids = state.items.map((item) => item.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    test("an item never changes once committed", () => {
        // Ink writes a <Static> node once and never looks at it again, so a mutation here would be
        // a change that silently fails to appear on screen.
        const first = run([{ kind: "user", text: "one" }, START, chunk("reply"), end("final")])
        const snapshot = first.items.map((item) => structuredClone(item))
        const later = run(
            [{ kind: "user", text: "two" }, START, chunk("second"), end("final")],
            first,
        )
        expect(later.items.slice(0, snapshot.length)).toEqual(snapshot)
    })

    test("the dynamic region stays one item however long the conversation gets", () => {
        let state = EMPTY_TRANSCRIPT
        for (let i = 0; i < 50; i += 1) {
            state = run([START, chunk("x"), end("final")], state)
        }
        state = run([START, chunk("in flight")], state)
        expect(state.items.length).toBeGreaterThan(40)
        expect(state.live?.text).toBe("in flight")
    })

    test("the reducer is deterministic — no clock, no randomness", () => {
        const actions = [{ kind: "user", text: "same" } as const, START, chunk("out"), end("final")]
        expect(run(actions)).toEqual(run(actions))
    })
})

describe("cancellation", () => {
    test("asking to cancel is a status, not an item", () => {
        const state = run([START, chunk("partial"), { kind: "cancelling" }])
        expect(state.status).toBe("cancelling")
        expect(state.items).toHaveLength(0)
    })

    test("a token still in flight does not undo the request", () => {
        const state = run([START, chunk("a"), { kind: "cancelling" }, chunk("b")])
        expect(state.status).toBe("cancelling")
        expect(state.live?.text).toBe("ab")
    })

    test("partial text survives the cancellation", () => {
        // The view-layer counterpart of the Phase 1 bug: cancelling discarded partial text because
        // an abort reached the loop as an exception. What was streamed has to end up committed.
        const state = run([START, chunk("half a th"), { kind: "cancelling" }, end("stopped")])
        expect(state.items.map((i) => i.text)).toEqual(["half a th"])
        expect(state.items[0]?.stats?.reason).toBe("stopped")
        expect(state.status).toBe("idle")
    })

    test("cancelling at an idle prompt changes nothing", () => {
        expect(run([{ kind: "cancelling" }])).toEqual(EMPTY_TRANSCRIPT)
    })
})

describe("failure", () => {
    test("an error mid-stream is committed and the partial reply is kept", () => {
        const state = run([
            START,
            chunk("I was saying"),
            {
                kind: "event",
                event: ev("agent.error", {
                    code: "model_http_error",
                    message: "502 from the endpoint",
                    hint: "The provider is failing; retry or switch base URL.",
                }),
            },
            end("error"),
        ])
        expect(state.items.map((i) => i.role)).toEqual(["error", "assistant"])
        expect(state.items[0]?.text).toContain("model_http_error")
        expect(state.items[0]?.text).toContain("hint:")
        expect(state.items[1]?.text).toBe("I was saying")
    })

    test("a clean turn that produced nothing says so rather than looking normal", () => {
        const state = run([START, end("final")])
        expect(state.items).toHaveLength(1)
        expect(state.items[0]?.role).toBe("note")
        expect(state.items[0]?.text).toContain("no text")
    })

    test("max_steps and timeout are reported as themselves, never as success", () => {
        for (const reason of ["max_steps", "timeout"] as const) {
            const state = run([START, chunk("partial"), end(reason)])
            expect(state.items[0]?.stats?.reason).toBe(reason)
        }
    })

    test("a retry is visible — a silent 30-second pause is indistinguishable from a hang", () => {
        const state = run([
            START,
            { kind: "event", event: ev("model.retry", { status: 429, attempt: 2, delayMs: 1200 }) },
        ])
        expect(state.items[0]?.role).toBe("note")
        expect(state.items[0]?.text).toContain("429")
        expect(state.items[0]?.text).toContain("1200")
    })

    test("a warning is a note, not an error", () => {
        const state = run([
            {
                kind: "event",
                event: ev("agent.warning", {
                    code: "channel_degraded",
                    message: "long-poll fell back",
                    hint: "Check the token.",
                }),
            },
        ])
        expect(state.items[0]?.role).toBe("note")
    })
})

describe("reasoning", () => {
    test("is accumulated separately from the reply", () => {
        const state = run([START, chunk("thinking…", "reasoning"), chunk("answer")])
        expect(state.live?.reasoning).toBe("thinking…")
        expect(state.live?.text).toBe("answer")
        expect(state.live?.last).toBe("text")
    })

    test("is committed ahead of the reply it produced", () => {
        const state = run([START, chunk("because…", "reasoning"), chunk("42"), end("final")])
        expect(state.items.map((i) => i.role)).toEqual(["reasoning", "assistant"])
    })

    test("is not invented when the model sent none", () => {
        const state = run([START, chunk("42"), end("final")])
        expect(state.items.map((i) => i.role)).toEqual(["assistant"])
    })
})

describe("events the transcript does not own", () => {
    test("boot and bookkeeping events are inert", () => {
        // They belong to the banner and the status bar. A new event type from a later phase must be
        // inert here rather than a crash.
        const state = run([
            {
                kind: "event",
                event: ev("runtime.ready", { bootMs: 40, processMs: 60, phases: {}, agents: 1 }),
            },
            {
                kind: "event",
                event: ev("store.ready", {
                    location: ":memory:",
                    driver: "bun",
                    from: 0,
                    to: 1,
                    applied: [],
                    reaped: [],
                }),
            },
            {
                kind: "event",
                event: ev("model.call", {
                    role: "main",
                    model: "m",
                    promptTokens: 10,
                    cached: false,
                    attempt: 1,
                }),
            },
            {
                kind: "event",
                event: ev("model.result", {
                    outputTokens: 5,
                    promptTokens: 10,
                    finishReason: "stop",
                    latencyMs: 100,
                }),
            },
            { kind: "event", event: ev("context.assembled", { slots: [], total: 10 }) },
            { kind: "event", event: ev("runtime.stopping", { reason: "cli-exit" }) },
        ])
        expect(state).toEqual(EMPTY_TRANSCRIPT)
    })
})

test("chunks arriving before turn.start do not throw", () => {
    // Ordering is the bus's guarantee, not this reducer's, and a crash in a renderer is a worse
    // failure than a slightly odd transcript.
    const state = run([chunk("orphan")])
    expect(state.live?.text).toBe("orphan")
})
