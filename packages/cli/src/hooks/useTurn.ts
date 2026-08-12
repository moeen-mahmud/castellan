/**
 * The bridge between the event bus and React state.
 *
 * The CLI has always subscribed to `runtime.bus`; this makes it a reducer over that bus rather than
 * a set of callbacks writing to stdout. All the interesting logic lives in `transcript.ts`, which is
 * pure and tested — this hook only owns the subscription, the abort controller, and the promise.
 */

import type { Agent, AnyEvent, EventBus } from "@castellan/core"
import { useCallback, useEffect, useReducer, useRef } from "react"
import type { TranscriptState } from "#lib/types"
import { reduce, type TranscriptAction } from "#transcript"

export interface UseTurn {
    readonly state: TranscriptState
    /** A turn is in flight. Drives the Ctrl-C contract and the status bar. */
    readonly busy: boolean
    send(text: string): void
    cancel(): void
    note(text: string): void
}

export function useTurn(options: {
    readonly agent: Agent
    readonly bus: EventBus
    readonly sessionKey: string
    readonly initial: TranscriptState
}): UseTurn {
    const { agent, bus, sessionKey, initial } = options
    const [state, dispatch] = useReducer(reduce, initial)
    const controller = useRef<AbortController | undefined>(undefined)

    useEffect(() => {
        // One wildcard subscription rather than six by name: the reducer already ignores what it
        // does not own, and a subscription list would silently miss any event a later phase adds.
        return bus.on("*", (event: AnyEvent) => {
            // Other sessions share this bus — from Phase 4, a channel can be delivering a turn for
            // a different peer while this prompt is open. An event with no session key is
            // runtime-wide and belongs to everyone.
            if (event.sessionKey !== undefined && event.sessionKey !== sessionKey) return
            dispatch({ kind: "event", event })
        })
    }, [bus, sessionKey])

    const send = useCallback(
        (text: string) => {
            dispatch({ kind: "user", text })
            const next = new AbortController()
            controller.current = next
            // `send` resolves rather than rejects on abort, so cancellation is not an error path.
            // Anything that does reject got past the loop's own handling, and swallowing it would be
            // the silent failure hard rule 8 forbids — so it is reported and the prompt returns.
            agent
                .send(text, { sessionKey, signal: next.signal, source: "repl" })
                .catch((error: unknown) => {
                    dispatch({
                        kind: "event",
                        event: {
                            v: 1,
                            ts: new Date().toISOString(),
                            runtimeId: "cli",
                            sessionKey,
                            type: "error",
                            data: {
                                code: "cli_turn_failed",
                                message: error instanceof Error ? error.message : String(error),
                                hint: "This escaped the turn loop's own error handling. Re-run with DEBUG=1 for a stack trace.",
                            },
                        },
                    })
                })
                .finally(() => {
                    if (controller.current === next) controller.current = undefined
                })
        },
        [agent, sessionKey],
    )

    const cancel = useCallback(() => {
        const current = controller.current
        if (current === undefined || current.signal.aborted) return
        dispatch({ kind: "cancelling" })
        current.abort()
    }, [])

    const note = useCallback(
        (text: string) => dispatch({ kind: "note", text } as TranscriptAction),
        [],
    )

    return { state, busy: state.status !== "idle", send, cancel, note }
}
