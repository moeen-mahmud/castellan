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
 * Phase 8, and `artifacts` with compaction in Phase 7. They are absent here rather than stubbed:
 * an empty interface that nothing implements is indistinguishable from a working one at the type
 * level, and would let a later phase quietly ship a no-op. `outbox` arrived in Phase 4.
 */

import type { TurnEndReason } from "../events/types.ts"
import type { ChatMessage, ToolCallRequest } from "../model/provider.ts"

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
    /**
     * Native tool calling's two extra facts, persisted and read back.
     *
     * Present only under the `native` dialect, where a message is genuinely more than `{role, content}`:
     * an assistant turn carries the calls it made, and a `tool` observation names the call it answers.
     * Losing either turns a resumed session's history into an orphaned trace — a 400 from a strict
     * endpoint, and a silently confused model on a lenient one.
     */
    readonly toolCalls?: readonly ToolCallRequest[]
    readonly toolCallId?: string
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
     *
     * `agentIds` is **required**, and it is the list this process holds a lease for — never
     * "every agent in the manifest" and never, now, "all of them". Unfiltered was correct while
     * one process owned one database and became wrong the moment two shared a file: the second
     * one's boot marked the first one's *live* turn failed, silently, with the row's own error
     * text claiming the process had exited. Required rather than optional because an optional
     * "all" leaves that behaviour one omitted argument away from returning, and the resulting bug
     * is invisible until somebody reads a turn record.
     *
     * Rows belonging to no live lease are still reachable — see `LeaseStore.orphans`.
     */
    reapRunning(agentIds: readonly string[], reason: string): Promise<readonly string[]>
}

/** How a runtime was started. Reported in a refusal, so it has to be a fact rather than a guess. */
export type RuntimeMode = "daemon" | "terminal" | "embedded"

export interface LeaseRecord {
    readonly agentId: string
    readonly runtimeId: string
    readonly pid: number
    readonly mode: RuntimeMode
    readonly startedAt: string
    readonly heartbeatAt: string
}

/**
 * The outcome of asking to serve an agent.
 *
 * A discriminated result rather than a throw, because the store does not know how to phrase the
 * refusal: `serve` wants a `HarnessError` naming the other process, an embedder may want to wait,
 * and a test wants neither. The store reports who holds it; the caller decides what that means.
 */
export type LeaseClaim =
    | { readonly ok: true; readonly lease: LeaseRecord; readonly tookOver?: LeaseRecord }
    | { readonly ok: false; readonly held: LeaseRecord }

/**
 * Who is serving which agent — the mutual exclusion that stops two pollers on one bot token.
 *
 * Liveness is **not** decided here. The store records a pid and a heartbeat; whether that pid is
 * alive is an operating-system question, and a store that answered it would be untestable without
 * spawning processes. The caller probes and passes its verdict to `claim` as `stealFrom`.
 */
export interface LeaseStore {
    /**
     * Take the lease for an agent, or report who holds it.
     *
     * `stealFrom` is the runtime id the caller has established is dead. Passing it makes the claim
     * succeed against exactly that holder and no other — so a lease that changed hands between the
     * liveness probe and the claim is still refused, rather than being stolen from a process that
     * has just legitimately started.
     */
    claim(input: {
        readonly agentId: string
        readonly runtimeId: string
        readonly pid: number
        readonly mode: RuntimeMode
        readonly now: string
        readonly stealFrom?: string
    }): Promise<LeaseClaim>
    /** Refresh `heartbeat_at`. A no-op when this runtime no longer holds the lease. */
    beat(agentId: string, runtimeId: string, now: string): Promise<boolean>
    release(agentId: string, runtimeId: string): Promise<void>
    get(agentId: string): Promise<LeaseRecord | undefined>
    all(): Promise<readonly LeaseRecord[]>
    /**
     * Agent ids with `running` turns or `inflight` deliveries and no lease row at all.
     *
     * The escape hatch that keeps ownership-scoped recovery honest. Narrowing recovery to leased
     * agents means a deleted or renamed agent's rows are nobody's to reap; this names them so
     * `sessions --reap-orphans` can, rather than leaving a permanent lie in the turn list.
     */
    orphans(): Promise<readonly string[]>
}

export interface KVStore {
    get(scope: string, key: string): Promise<string | undefined>
    set(scope: string, key: string, value: string): Promise<void>
    delete(scope: string, key: string): Promise<void>
    all(scope: string): Promise<Readonly<Record<string, string>>>
}

/**
 * A delivery's lifecycle. Four states, and the two transitions that matter are the ones out of
 * `inflight`: everything else is bookkeeping.
 *
 * `inflight` means *the bytes may already have left*. A row found in this state by a fresh process
 * was owned by a process that died, and no amount of local state can say whether the provider
 * received it. That ambiguity is the whole reason the state exists as a distinct value rather than
 * as `pending` with a timestamp.
 */
export type DeliveryStatus = "pending" | "inflight" | "sent" | "failed"

export interface DeliveryRecord {
    readonly id: number
    readonly agentId: string
    /**
     * The identity of this delivery, derived by the caller and unique per agent.
     *
     * **Derived, never generated.** A UUID minted at enqueue dedupes the outbox against itself, a
     * problem it does not have. The duplicate that actually happens is the *enqueuer* running twice
     * — a turn replayed after a crash, a redelivered webhook — and under a generated id each replay
     * mints a fresh key and sends again. A derived key makes the second enqueue collide with the
     * first row and do nothing. See `deliveryKey` in `channels/outbox.ts`.
     */
    readonly dedupeKey: string
    /** Everything in one reply to one recipient. Ordering and abandonment are group-scoped. */
    readonly groupKey: string
    readonly sessionKey: string
    readonly turnId?: string
    readonly channelId: string
    readonly recipient: string
    readonly thread?: string
    readonly chunkIndex: number
    readonly chunkTotal: number
    readonly body: string
    readonly status: DeliveryStatus
    readonly attempts: number
    /** RFC 3339 UTC. A `pending` row is invisible to `due` until this passes. */
    readonly nextAttemptAt: string
    /**
     * This row was found `inflight` at boot and re-queued.
     *
     * Sticky once set, and carried onto `delivery.sent` — a duplicate that reaches a person should
     * be explicable from the event stream afterwards, not only from a log line at the moment it
     * happened.
     */
    readonly uncertain: boolean
    readonly providerMessageId?: string
    readonly errorCode?: string
    readonly errorMessage?: string
    readonly createdAt: string
    readonly updatedAt: string
}

export interface EnqueueDelivery {
    readonly agentId: string
    readonly dedupeKey: string
    readonly groupKey: string
    readonly sessionKey: string
    readonly turnId?: string
    readonly channelId: string
    readonly recipient: string
    readonly thread?: string
    readonly chunkIndex: number
    readonly chunkTotal: number
    readonly body: string
    /**
     * When this row becomes visible to `due`. Defaults to now.
     *
     * Present so the enqueuer's clock is the one that decides, matching `markRetry`, which has
     * always taken an explicit time. Without it a caller running on an injected clock — the outbox
     * engine, and therefore every test of it — stamps rows from the wall clock and then asks about
     * them from a different one. That does not fail; it produces a queue that is due or not
     * depending on what time of day the suite runs.
     */
    readonly nextAttemptAt?: string
}

/** `inserted: false` means the dedupe key was already present — the re-enqueue did nothing. */
export interface EnqueueResult {
    readonly record: DeliveryRecord
    readonly inserted: boolean
}

export interface OutboxStore {
    /**
     * Insert every delivery whose dedupe key is new, in one transaction.
     *
     * All-or-nothing per call, so a crash cannot leave a reply half-enqueued: three chunks either
     * all exist or none do, and the retry re-enqueues the whole reply against the same keys.
     */
    enqueue(deliveries: readonly EnqueueDelivery[]): Promise<readonly EnqueueResult[]>
    /**
     * Rows ready to send now, oldest first.
     *
     * Returns at most the *head of line* per group: a chunk whose predecessor in the same group is
     * not yet `sent` is withheld, so ordering holds without the caller tracking it. A predecessor
     * left `failed` withholds its successors permanently, which is deliberate — `abandonGroupAfter`
     * is what resolves that, and failing closed means a half-message never ships on its own.
     */
    due(agentId: string, now: string, limit?: number): Promise<readonly DeliveryRecord[]>
    /**
     * `pending` → `inflight`, atomically. `undefined` when another claimant won.
     *
     * The guard is in the `WHERE` clause rather than a read-then-write, because a read-then-write is
     * exactly the race a second drain pass would lose.
     */
    claim(id: number): Promise<DeliveryRecord | undefined>
    markSent(id: number, providerMessageId?: string): Promise<void>
    /** `inflight` → `pending`, attempts incremented, visible again at `nextAttemptAt`. */
    markRetry(
        id: number,
        nextAttemptAt: string,
        error: { readonly code: string; readonly message: string },
    ): Promise<void>
    markFailed(
        id: number,
        error: { readonly code: string; readonly message: string },
    ): Promise<void>
    /**
     * Fail every later chunk of a group after one chunk failed permanently.
     *
     * Half a message is worse than none: the reader gets a fragment with no indication that the
     * rest is missing. Returns the ids it abandoned so one `delivery.failed` names the real cause
     * and the cascade is reported as a cascade.
     */
    abandonGroupAfter(
        agentId: string,
        groupKey: string,
        chunkIndex: number,
        error: { readonly code: string; readonly message: string },
    ): Promise<readonly number[]>
    /**
     * Re-queue everything left `inflight` by a dead process, marking it uncertain.
     *
     * Returns what it recovered so boot reports it. Retrying is the deliberate choice: in a
     * conversational channel a lost reply looks like the agent ignored you, which is worse than a
     * rare duplicate — and the duplicate is at least visible in the event stream, while the silence
     * is not.
     *
     * `nextAttemptAt` defaults to now, and is a parameter for the same reason it is one on
     * `enqueue`: the recovering caller's clock is the one that will later ask `due`, and a store
     * that stamped its own would schedule the row into that caller's future.
     *
     * `agentIds` scopes it the same way and for the same reason as `TurnStore.reapRunning`, except
     * that here the unscoped version does visible damage rather than silent: flipping another live
     * process's `inflight` row back to `pending` makes *that* process re-send a Telegram message it
     * had already sent, flagged `uncertain`. Decision 8.9 built that flag to make a crash
     * explicable; firing it because somebody started an unrelated agent makes it mean nothing.
     */
    recoverInflight(
        agentIds: readonly string[],
        nextAttemptAt?: string,
    ): Promise<readonly DeliveryRecord[]>
    get(id: number): Promise<DeliveryRecord | undefined>
    byDedupeKey(agentId: string, dedupeKey: string): Promise<DeliveryRecord | undefined>
    list(
        agentId: string,
        options?: {
            readonly sessionKey?: string
            readonly status?: DeliveryStatus
            readonly limit?: number
        },
    ): Promise<readonly DeliveryRecord[]>
    /** Drop terminal rows older than `before`. Nothing calls this on a timer yet. */
    prune(before: string): Promise<number>
}

export interface ArtifactRecord {
    /** Derived from the content by `compaction/stages.ts`. Printable ASCII: it is a bound key. */
    readonly id: string
    readonly sessionKey: string
    /** The tool that produced the observation, where it named one. */
    readonly slug?: string
    readonly content: string
    /** Estimated cost of the original, so a reader knows the size before spending a step on it. */
    readonly tokens: number
    readonly createdAt: string
}

/**
 * What compaction displaced, so nothing it removed is unreachable.
 *
 * `put` is idempotent by construction rather than by convention: the id is derived from the content,
 * so the same observation written twice is the same row. That is what lets the ladder escalate over a
 * message across turns — snipped on one, pointer-replaced on a later one — without accumulating a row
 * per stage.
 */
export interface ArtifactStore {
    put(
        agentId: string,
        sessionKey: string,
        artifacts: readonly Omit<ArtifactRecord, "sessionKey" | "createdAt">[],
        now: string,
    ): Promise<void>
    get(agentId: string, sessionKey: string, id: string): Promise<ArtifactRecord | undefined>
    /** Newest first. For a listing; the agent reads one at a time by id. */
    list(agentId: string, sessionKey: string): Promise<readonly ArtifactRecord[]>
}

export interface Store {
    readonly sessions: SessionStore
    readonly messages: MessageStore
    readonly turns: TurnStore
    readonly outbox: OutboxStore
    readonly leases: LeaseStore
    readonly kv: KVStore
    readonly artifacts: ArtifactStore
    /** Human-readable location, for `store.ready` and the `sessions` command. */
    readonly location: string
    close(): Promise<void>
}
