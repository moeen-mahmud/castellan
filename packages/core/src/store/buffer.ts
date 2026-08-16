/**
 * Per-turn event buffers, replayable on attach.
 *
 * Reattach is core, not a convenience: a turn survives the client that started it, so a client
 * that comes back has to be able to find out what it missed. The wire spec spells out the
 * contract — `GET /v1/agents/:id/turns/:turnId/stream` "replays buffered events then tails".
 *
 * **The handover has to be gapless and duplicate-free**, and the order of the two operations is
 * the whole problem. Subscribe first and then replay, and every event that arrives during the
 * replay is delivered twice. Replay first and then subscribe, and everything arriving in between
 * is lost. Neither shows up in a test that attaches to an idle turn; both show up under load.
 *
 * This implementation gets it right by doing both in one synchronous block. `EventBus.emit`
 * dispatches synchronously and JavaScript will not interleave another task inside
 * `attach`, so a snapshot taken and a listener registered without an intervening `await` cannot
 * miss or double-count anything. The absence of `async` on `attach` is the mechanism, not a
 * style choice — adding one would reintroduce the gap.
 *
 * Buffers live in memory only. They hold per-token `model.chunk` events, which are far too
 * chatty to persist and are worthless once the turn's text is in the database.
 */

import type { EventBus } from "../events/bus.ts"
import type { AnyEvent } from "../events/types.ts"

export type TurnBufferState = "running" | "ended"

export interface TurnAttachment {
    readonly turnId: string
    /** Everything the turn has emitted so far, in order. */
    readonly replay: readonly AnyEvent[]
    readonly state: TurnBufferState
    /** Detach. Safe to call more than once, and after the turn has ended. */
    unsubscribe(): void
}

interface Buffered {
    readonly turnId: string
    readonly events: AnyEvent[]
    state: TurnBufferState
    /** `performance.now()` at end, for the retention policy. Absent while running. */
    endedAt?: number
    readonly listeners: Set<(event: AnyEvent) => void>
    /** True once an event was discarded because the cap was reached. */
    truncated: boolean
}

export interface TurnStreamsOptions {
    /**
     * Hard cap on buffered events per turn. A runaway tool loop must not turn into unbounded
     * memory growth, so the *oldest* events are dropped and the attachment is marked truncated —
     * dropping the newest would make a live tail stop updating, which looks like a hang.
     */
    readonly maxEventsPerTurn?: number
    /** How long an ended turn stays attachable. See `RETENTION` below. */
    readonly retainEndedMs?: number
    /** How many ended turns stay attachable at once, newest first. */
    readonly retainEndedCount?: number
    /** Injectable clock, so retention is testable without waiting. */
    readonly now?: () => number
}

const DEFAULT_MAX_EVENTS = 10_000

/**
 * Retention defaults for an *ended* turn's buffer.
 *
 * A running turn is always retained — there is no question there. The decision is what happens
 * after `turn.end`, and both directions have a real cost:
 *
 * - Evict immediately and a client that reconnects a second after completion gets nothing from
 *   the buffer. It can still read the final text from the `turns` table, but the token-level
 *   `model.chunk` events are gone, so a UI that was mid-stream cannot finish the animation and
 *   has to snap to the final text.
 * - Retain generously and an idle process holds the chunk events of every recent turn. At a few
 *   hundred chunks per turn this is small, but it is unbounded in the number of turns.
 */
const RETENTION = {
    ms: 60_000,
    count: 32,
} as const

export class TurnStreams {
    #buffers = new Map<string, Buffered>()
    #maxEvents: number
    #retainMs: number
    #retainCount: number
    #now: () => number
    #unsubscribeBus: (() => void) | undefined

    constructor(options: TurnStreamsOptions = {}) {
        this.#maxEvents = options.maxEventsPerTurn ?? DEFAULT_MAX_EVENTS
        this.#retainMs = options.retainEndedMs ?? RETENTION.ms
        this.#retainCount = options.retainEndedCount ?? RETENTION.count
        this.#now = options.now ?? (() => performance.now())
    }

    /**
     * Buffer every event carrying a `turnId`.
     *
     * A wildcard subscription rather than an enumerated list of types: the event schema is
     * append-only, and a new event type must show up in a replay without anyone remembering to
     * add it here.
     */
    listen(bus: EventBus): () => void {
        this.#unsubscribeBus?.()
        const off = bus.on("*", (event) => {
            this.record(event)
        })
        this.#unsubscribeBus = off
        return off
    }

    /**
     * Open an empty buffer for a turn that has not emitted yet. Idempotent.
     *
     * Needed because a caller that starts a turn and immediately attaches — which is exactly what
     * `POST /messages` with `stream: true` does — gets there before the first event: `Agent.send`
     * awaits the session write before emitting anything. Without this the stream reported "no
     * buffer" for a turn that was about to run, and the client saw the reply nowhere.
     *
     * **`attach` deliberately does not do this itself.** Creating a buffer on demand would make a
     * typo'd turn id indistinguishable from a real one, and the client would tail an empty stream
     * forever instead of being told the id is unknown. Only whoever starts a turn knows it exists.
     */
    open(turnId: string): void {
        if (this.#buffers.has(turnId)) return
        this.#buffers.set(turnId, {
            turnId,
            events: [],
            state: "running",
            listeners: new Set(),
            truncated: false,
        })
    }

    /** Called for every event. Opens a buffer on first sight of a turn id. */
    record(event: AnyEvent): void {
        const turnId = event.turnId
        if (turnId === undefined) return

        let buffer = this.#buffers.get(turnId)
        if (buffer === undefined) {
            buffer = {
                turnId,
                events: [],
                state: "running",
                listeners: new Set(),
                truncated: false,
            }
            this.#buffers.set(turnId, buffer)
        }

        buffer.events.push(event)
        if (buffer.events.length > this.#maxEvents) {
            buffer.events.shift()
            buffer.truncated = true
        }

        // A listener that throws must not stop the others, nor the turn. Same reasoning as the
        // bus itself: an attached client with a bug is not permitted to break generation.
        for (const listener of [...buffer.listeners]) {
            try {
                listener(event)
            } catch {
                // Deliberately swallowed here: this is a fan-out to observers of a turn, and the
                // bus has already reported the event to its own error channel.
            }
        }

        if (event.type === "turn.end") {
            buffer.state = "ended"
            buffer.endedAt = this.#now()
            this.#evict()
        }
    }

    /**
     * Attach to a turn: get everything so far, plus everything from now on.
     *
     * Returns `undefined` when the turn has no buffer — either it never existed in this process,
     * or it ended and was evicted. The caller distinguishes those two by looking the turn up in
     * the store, and the distinction matters: an unknown turn id is a 404, while a known-but-
     * evicted one is a 200 with the final text and no stream.
     *
     * Not `async`, and must not become so — see the file comment.
     */
    attach(turnId: string, onEvent: (event: AnyEvent) => void): TurnAttachment | undefined {
        const buffer = this.#buffers.get(turnId)
        if (buffer === undefined) return undefined

        // Snapshot and subscribe with no await between them. This is the gapless handover.
        const replay = [...buffer.events]
        buffer.listeners.add(onEvent)

        let detached = false
        return {
            turnId,
            replay,
            state: buffer.state,
            unsubscribe: () => {
                if (detached) return
                detached = true
                buffer.listeners.delete(onEvent)
            },
        }
    }

    /** Whether a turn is still attachable, without subscribing to it. */
    state(turnId: string): TurnBufferState | undefined {
        return this.#buffers.get(turnId)?.state
    }

    /** True when the turn's oldest events were dropped to stay under the cap. */
    truncated(turnId: string): boolean {
        return this.#buffers.get(turnId)?.truncated ?? false
    }

    get size(): number {
        return this.#buffers.size
    }

    /**
     * Drop ended buffers that are past the retention policy.
     *
     * Called on every `turn.end` rather than on a timer: a timer would keep an otherwise idle
     * process awake, and the whole point of the boot-time discipline is that this runtime does
     * nothing when nothing is happening. The consequence is that a buffer can outlive its
     * retention window while the process is idle — which is harmless, because nothing is
     * competing for the memory, and it becomes attachable-but-stale rather than incorrect.
     */
    #evict(): void {
        const now = this.#now()
        const ended: Buffered[] = []

        for (const buffer of this.#buffers.values()) {
            if (buffer.state !== "ended" || buffer.endedAt === undefined) continue
            // A buffer someone is still attached to is never evicted by age. A client mid-replay
            // losing its own stream is a bug that looks exactly like a network fault.
            if (buffer.listeners.size > 0) continue
            if (now - buffer.endedAt >= this.#retainMs) {
                this.#buffers.delete(buffer.turnId)
                continue
            }
            ended.push(buffer)
        }

        if (ended.length <= this.#retainCount) return
        ended.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
        for (const buffer of ended.slice(0, ended.length - this.#retainCount)) {
            this.#buffers.delete(buffer.turnId)
        }
    }

    /** Drop everything and stop listening. Called from `Runtime.stop`. */
    close(): void {
        this.#unsubscribeBus?.()
        this.#unsubscribeBus = undefined
        this.#buffers.clear()
    }
}
