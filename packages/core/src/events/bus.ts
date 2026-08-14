/**
 * In-process event bus. Synchronous fan-out, no I/O, no queue.
 *
 * A subscriber that throws must not break the emitter or any other subscriber: an
 * observability plugin with a bug would otherwise take down the turn it was observing. So
 * handler failures are caught and reported through `onHandlerError` — never swallowed, never
 * allowed to propagate.
 */

import type { AnyEvent, EventContext, EventDataMap, EventEnvelope, EventType } from "./types.ts"

export type EventHandler = (event: AnyEvent) => void

export interface EventBusOptions {
    runtimeId: string
    /**
     * `model.chunk` is per-token. Subscribers opt in rather than paying for it by default.
     */
    emitChunks?: boolean
    /** Called when a subscriber throws. Defaults to `console.error`. */
    onHandlerError?: (error: unknown, event: AnyEvent) => void
    /** Injectable for tests; defaults to `() => new Date().toISOString()`. */
    now?: () => string
}

export class EventBus {
    readonly runtimeId: string

    // '#' is used to make these private fields
    #handlers = new Map<string, Set<EventHandler>>()
    #emitChunks: boolean
    #onHandlerError: (error: unknown, event: AnyEvent) => void
    #now: () => string

    constructor(options: EventBusOptions) {
        this.runtimeId = options.runtimeId
        this.#emitChunks = options.emitChunks ?? false
        this.#now = options.now ?? (() => new Date().toISOString())
        this.#onHandlerError =
            options.onHandlerError ??
            ((error, event) => {
                console.error(`event handler threw while handling ${event.type}:`, error)
            })
    }

    /** Subscribe to one type, or to `"*"` for everything. Returns an unsubscribe function. */
    on(type: EventType | "*", handler: EventHandler): () => void {
        let set = this.#handlers.get(type)
        if (set === undefined) {
            set = new Set()
            this.#handlers.set(type, set)
        }
        set.add(handler)
        return () => {
            set?.delete(handler)
        }
    }

    /** Subscribe until the first matching event, then unsubscribe. */
    once(type: EventType | "*", handler: EventHandler): () => void {
        const off = this.on(type, (event) => {
            off()
            handler(event)
        })
        return off
    }

    /** Resolves on the first matching event. Rejects if `signal` aborts first. */
    next(type: EventType | "*", signal?: AbortSignal): Promise<AnyEvent> {
        return new Promise((resolve, reject) => {
            const off = this.on(type, (event) => {
                off()
                signal?.removeEventListener("abort", onAbort)
                resolve(event)
            })
            const onAbort = () => {
                off()
                reject(signal?.reason ?? new Error("aborted"))
            }
            signal?.addEventListener("abort", onAbort, { once: true })
        })
    }

    /** Turn per-token chunk events on or off at runtime, for an attaching stream client. */
    setEmitChunks(on: boolean): void {
        this.#emitChunks = on
    }

    emit<K extends EventType>(type: K, data: EventDataMap[K], context: EventContext = {}): void {
        if (type === "model.chunk" && !this.#emitChunks) return

        const envelope = {
            v: 1,
            ts: this.#now(),
            runtimeId: this.runtimeId,
            ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
            ...(context.sessionKey === undefined ? {} : { sessionKey: context.sessionKey }),
            ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
            ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
            type,
            data,
        } as EventEnvelope<K, EventDataMap[K]> as AnyEvent

        this.#dispatch(envelope)
    }

    #dispatch(event: AnyEvent): void {
        // Snapshot both sets: a handler that unsubscribes during dispatch must not perturb the
        // iteration order of the current emit.
        const specific = this.#handlers.get(event.type)
        const wildcard = this.#handlers.get("*")
        for (const set of [specific, wildcard]) {
            if (set === undefined) continue
            for (const handler of [...set]) {
                try {
                    handler(event)
                } catch (error) {
                    this.#onHandlerError(error, event)
                }
            }
        }
    }
}
