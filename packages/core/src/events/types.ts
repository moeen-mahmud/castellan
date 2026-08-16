/**
 * The lifecycle event schema. Append-only within `v: 1` — consumers key off `type`, and
 * removing or repurposing one breaks them silently.
 *
 * Core emits; consumers persist. The runtime writes no rows it does not own, so everything a
 * platform wants to know about an agent arrives here.
 */

import type { ErrorDetail } from "../errors.ts"
import type { OnMutate, Trust } from "../tools/trust.ts"

/** Envelope fields shared by every event. */
export interface EventContext {
    readonly agentId?: string
    readonly sessionKey?: string
    readonly turnId?: string
    readonly stepId?: string
}

export interface EventEnvelope<TType extends string = string, TData = unknown> {
    readonly v: 1
    /** RFC 3339 UTC. */
    readonly ts: string
    readonly runtimeId: string
    readonly agentId?: string
    readonly sessionKey?: string
    readonly turnId?: string
    readonly stepId?: string
    readonly type: TType
    readonly data: TData
}

/** Why a turn stopped. `max_steps` and `timeout` are reported honestly, never as `final`. */
export type TurnEndReason = "final" | "max_steps" | "stopped" | "timeout" | "error"

export interface ContextSlotReport {
    readonly slot: number
    readonly tokens: number
    readonly pinned: boolean
}

/**
 * Event type → shape of its `data`. Phase 1 covers boot, turn, and model events; tool events
 * arrived in Phase 3 and channel and delivery events in Phase 4. Skill, compaction, and schedule
 * events arrive with their subsystems.
 */
export interface EventDataMap {
    "runtime.ready": {
        /** Time inside `Runtime.create`. */
        bootMs: number
        /** Time since process start — the number the sub-second boot claim refers to. */
        processMs: number
        phases: Record<string, number>
        agents: number
    }
    /**
     * The store is open and migrated. Fires before `runtime.ready`, because nothing can serve a
     * turn until it does.
     *
     * `reaped` names turns a previous process left `running`. It is reported rather than fixed
     * quietly: a non-empty list means that process died mid-generation, which is worth seeing.
     */
    "store.ready": {
        location: string
        driver: "bun" | "node"
        /** Schema version before migrating. 0 for a fresh database. */
        from: number
        to: number
        applied: string[]
        reaped: string[]
    }
    "runtime.stopping": { reason: string }
    "agent.loaded": { tools: number; skills: number; schedules: number; model: string }
    "agent.error": ErrorDetail
    "agent.warning": ErrorDetail
    "turn.start": { source: string; inputTokens: number }
    "context.assembled": { slots: ContextSlotReport[]; total: number }
    "model.call": {
        role: "main" | "selector" | "compactor"
        model: string
        promptTokens: number
        cached: boolean
        attempt: number
    }
    /** Suppressed unless a subscriber opted in — this is per-token and high volume. */
    "model.chunk": { delta: string; kind: "text" | "reasoning" }
    "model.retry": { status: number; attempt: number; delayMs: number }
    "model.result": {
        outputTokens: number
        promptTokens: number
        finishReason: string
        latencyMs: number
    }
    /**
     * A tool is about to run. `argsHash` rather than the arguments themselves: arguments carry
     * whatever the conversation carried, and an event stream is the wrong place to copy it to.
     */
    "tool.call": { slug: string; callId: string; argsHash: string; mutating: boolean }
    "tool.result": {
        slug: string
        callId: string
        ok: boolean
        latencyMs: number
        /** Of the observation before any truncation, so a cut is visible as a size, not a guess. */
        bytes: number
        truncated: boolean
        /** Whether this output may contain text a stranger wrote. */
        trust: Trust
    }
    /**
     * A call was blocked before it ran — by the trust gate, or by a `tools.policy` rule.
     *
     * **Not an error.** The model is told and the turn continues. `reason` says which of the two
     * decided and why; `policy` carries the `tools.untrusted.onMutate` setting, so a surprised
     * operator can see whether they were on the default.
     *
     * A blocked call emits this and nothing else — no `tool.call`, no `tool.result` — because
     * nothing ran, and a consumer pairing call with result would otherwise hold an orphan.
     */
    "tool.gated": { slug: string; callId: string; reason: string; policy: OnMutate }
    /**
     * A step's tool calls could not be used as written. The first occurrence is followed by one
     * correction request; a second in a row ends the turn with `tool_repair_failed` rather than
     * asking again. Two of these back to back is the signal that a catalogue needs work.
     */
    "tool.repair": { slugs: string[]; errors: string[] }
    /**
     * A remote tool provider caught its cached catalogue up, **after** `runtime.ready`.
     *
     * The only observable evidence that the refresh happened, since it is deliberately fire-and-forget:
     * the boot path resolves from disk so that nothing touches the network before readiness, which
     * means the network call has to live somewhere with no caller waiting on it. `ok: false` carries
     * the reason and is not a turn failure — the agent keeps serving the cached catalogue.
     *
     * `changed` is the field worth watching. A slug whose schema moved under a running agent is a
     * catalogue the model has already been told about in the current session's cached prefix.
     */
    "tools.refreshed": {
        provider: string
        ok: boolean
        fetched: number
        changed: string[]
        missing: string[]
        latencyMs: number
        /** Present when `ok` is false. */
        error?: string
    }
    /**
     * A channel's connection state changed.
     *
     * Never blocks readiness. A channel that cannot connect says so here and keeps trying, because
     * a runtime that refused to boot during a Telegram outage would also be unable to serve its
     * HTTP API during one.
     */
    "agent.channel.status": {
        channelId: string
        channelType: string
        status: "starting" | "connected" | "disconnected" | "error"
        detail?: string
    }
    /** A channel failure that did not stop the channel. A bad token lands here, not on `error`. */
    "agent.channel.error": ErrorDetail & { channelId: string }
    /**
     * An inbound message was not turned into a turn.
     *
     * `duplicate` is routine — a provider replaying an unacknowledged update. `denied` is an
     * `allowFrom` refusal, and is reported rather than dropped silently: an allowlist that quietly
     * discards a message is indistinguishable from a channel that is not receiving at all, which is
     * a support conversation nobody enjoys.
     */
    "agent.channel.rejected": {
        channelId: string
        reason: "duplicate" | "denied"
        /** Handle where the provider exposes one, peer id otherwise. Never the message body. */
        sender: string
        detail: string
    }
    /**
     * One chunk reached the provider.
     *
     * `uncertain` means this row was recovered from a dead process and may be a second copy — see
     * `delivery.uncertain`. It is on the success event on purpose: that is where a reader
     * investigating a duplicate will actually be looking.
     */
    "delivery.sent": {
        channelId: string
        providerMessageId?: string
        chunkIndex: number
        chunkTotal: number
        attempts: number
        uncertain: boolean
    }
    /** A retryable send failed and will be tried again after `delayMs`. */
    "delivery.retry": {
        channelId: string
        chunkIndex: number
        attempts: number
        delayMs: number
        error: ErrorDetail
    }
    /**
     * A chunk was abandoned. `exhausted` distinguishes "gave up after N tries" from "the provider
     * said no and meant it", which want different responses from whoever is reading.
     *
     * `abandoned` counts the later chunks of the same reply dropped as a consequence. Half a
     * message is worse than none, so they are not sent on their own — and they are reported as one
     * number rather than as N more failure events, because there was one fault.
     */
    "delivery.failed": {
        channelId: string
        chunkIndex: number
        chunkTotal: number
        attempts: number
        exhausted: boolean
        abandoned: number
        error: ErrorDetail
    }
    /**
     * A delivery was found in flight at boot and re-queued, and may therefore be sent twice.
     *
     * The window is between the bytes leaving the process and the provider's acknowledgement
     * arriving back, and it cannot be closed from this side — only by a provider that deduplicates
     * on a key we supply. `idempotentSend` reports whether this channel is one of those, so the
     * event says how much doubt there actually is rather than implying a fixed amount.
     */
    "delivery.uncertain": {
        channelId: string
        chunkIndex: number
        chunkTotal: number
        attempts: number
        idempotentSend: boolean
    }
    "turn.end": {
        reason: TurnEndReason
        steps: number
        tokens: { prompt: number; output: number }
        durationMs: number
    }
    error: ErrorDetail & { stack?: string }
}

export type EventType = keyof EventDataMap & string

export type AnyEvent = {
    [K in EventType]: EventEnvelope<K, EventDataMap[K]>
}[EventType]
