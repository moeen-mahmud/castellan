/**
 * The persistence contract.
 *
 * **Every method is async even though the only shipped driver is synchronous.** `bun:sqlite`
 * and `node:sqlite` are both blocking, so the SQLite driver returns already-resolved promises
 * and pays an allocation per call. That cost buys the one thing this interface exists for:
 * a Postgres driver — deferred, but explicitly planned — cannot be synchronous, and a sync
 * interface would mean rewriting every call site to add it. The interface arrives in this phase
 * precisely so that later addition is a new file rather than a refactor.
 *
 * **Sub-stores arrive with their subsystems.** `toolCalls` lands in Phase 3, `schedules` in
 * Phase 8, `artifacts` with compaction in Phase 7, and the outbox in Phase 4. They are absent
 * here rather than stubbed: an empty interface that nothing implements is indistinguishable
 * from a working one at the type level, and would let a later phase quietly ship a no-op.
 */

import type { TurnEndReason } from "../events/types.ts"
import type { ChatMessage } from "../model/provider.ts"

/**
 * A turn's lifecycle state. `running` plus the five ways a turn can end.
 *
 * The plan names four (`running | final | stopped | error`), but `timeout` and `max_steps` are
 * distinct `TurnEndReason`s that the loop goes out of its way not to collapse into `error`.
 * Flattening them at the storage layer would discard the diagnosis one layer below where it
 * was made, so the column holds all six.
 */
export type TurnStatus = "running" | TurnEndReason

export interface SessionRecord {
    readonly agentId: string
    readonly sessionKey: string
    readonly channel: string
    readonly peerId: string
    readonly thread?: string
    /** Phase-scoped tool visibility, persisted per session from Phase 7. */
    readonly phase?: string
    /** RFC 3339 UTC. */
    readonly createdAt: string
    readonly updatedAt: string
}

/** A session plus the aggregates the `sessions` command and `GET /v1/…/sessions` report. */
export interface SessionSummary extends SessionRecord {
    readonly messages: number
    readonly turns: number
    readonly lastActivityAt: string
}

export interface StoredMessage {
    /** Monotonic within a store. Ordering key — never sort by timestamp, which can tie. */
    readonly id: number
    readonly sessionKey: string
    readonly turnId?: string
    readonly role: ChatMessage["role"]
    readonly content: string
    readonly createdAt: string
}

export interface TurnRecord {
    readonly turnId: string
    readonly agentId: string
    readonly sessionKey: string
    readonly status: TurnStatus
    readonly source: string
    readonly input: string
    readonly text: string
    readonly reasoning: string
    readonly steps: number
    readonly promptTokens: number
    readonly outputTokens: number
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly errorHint?: string
    readonly startedAt: string
    readonly endedAt?: string
    readonly durationMs?: number
}

export interface MessagePage {
    readonly messages: readonly StoredMessage[]
    /** Pass as `before` to fetch the previous page. Absent when the first message is included. */
    readonly nextBefore?: number
}

export interface SessionStore {
    /** Create if absent, returning either way. Idempotent — a turn calls this on every send. */
    ensure(agentId: string, sessionKey: string): Promise<SessionRecord>
    get(agentId: string, sessionKey: string): Promise<SessionRecord | undefined>
    list(agentId: string): Promise<readonly SessionSummary[]>
    setPhase(agentId: string, sessionKey: string, phase: string | undefined): Promise<void>
    /** Clears history and turns. Memory files are never touched — they are canonical on disk. */
    clear(agentId: string, sessionKey: string): Promise<void>
    delete(agentId: string, sessionKey: string): Promise<void>
}

export interface MessageStore {
    append(
        agentId: string,
        sessionKey: string,
        messages: readonly ChatMessage[],
        turnId?: string,
    ): Promise<readonly StoredMessage[]>
    /** Oldest-first, the order the model needs. `limit` keeps the most recent N. */
    history(agentId: string, sessionKey: string, limit?: number): Promise<readonly ChatMessage[]>
    /**
     * Newest-first with a cursor, the order a UI pages through.
     *
     * `before` and `limit` accept an explicit `undefined` as well as being absent. Under
     * `exactOptionalPropertyTypes` those are normally different types, but the cursor exists to be
     * fed back in — `page({ before: previous.nextBefore })` is the intended call, and
     * `nextBefore` is absent on the last page. Requiring every caller to spread it conditionally
     * would make the common path the awkward one for no gain in safety: a missing cursor and an
     * undefined cursor both mean "start at the newest".
     */
    page(
        agentId: string,
        sessionKey: string,
        options?: {
            readonly before?: number | undefined
            readonly limit?: number | undefined
        },
    ): Promise<MessagePage>
    count(agentId: string, sessionKey: string): Promise<number>
}

export interface TurnStore {
    start(record: {
        readonly turnId: string
        readonly agentId: string
        readonly sessionKey: string
        readonly source: string
        readonly input: string
    }): Promise<TurnRecord>
    finish(
        turnId: string,
        outcome: {
            readonly status: TurnStatus
            readonly text: string
            readonly reasoning: string
            readonly steps: number
            readonly promptTokens: number
            readonly outputTokens: number
            readonly durationMs: number
            readonly errorCode?: string
            readonly errorMessage?: string
            readonly errorHint?: string
        },
    ): Promise<void>
    get(turnId: string): Promise<TurnRecord | undefined>
    list(
        agentId: string,
        sessionKey: string,
        options?: { readonly limit?: number },
    ): Promise<readonly TurnRecord[]>
    /**
     * Turns left `running` by a crash, marked `error` at boot.
     *
     * A process cannot resume someone else's in-flight generation, and leaving the row
     * `running` forever would make a dead turn indistinguishable from a live one. Returns what
     * it reaped so boot can report it rather than fixing it silently.
     */
    reapRunning(reason: string): Promise<readonly string[]>
}

export interface KVStore {
    get(scope: string, key: string): Promise<string | undefined>
    set(scope: string, key: string, value: string): Promise<void>
    delete(scope: string, key: string): Promise<void>
    all(scope: string): Promise<Readonly<Record<string, string>>>
}

export interface Store {
    readonly sessions: SessionStore
    readonly messages: MessageStore
    readonly turns: TurnStore
    readonly kv: KVStore
    /** Human-readable location, for `store.ready` and the `sessions` command. */
    readonly location: string
    close(): Promise<void>
}
