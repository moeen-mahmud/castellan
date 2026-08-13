/**
 * The lifecycle event schema. Append-only within `v: 1` — consumers key off `type`, and
 * removing or repurposing one breaks them silently.
 *
 * Core emits; consumers persist. The runtime writes no rows it does not own, so everything a
 * platform wants to know about an agent arrives here.
 */

import type { ErrorDetail } from "../errors.ts"

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
 * Event type → shape of its `data`. Phase 1 covers boot, turn, and model events; tool,
 * skill, compaction, delivery, and schedule events arrive with their subsystems.
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
    }
    /**
     * A step's tool calls could not be used as written. The first occurrence is followed by one
     * correction request; a second in a row ends the turn with `tool_repair_failed` rather than
     * asking again. Two of these back to back is the signal that a catalogue needs work.
     */
    "tool.repair": { slugs: string[]; errors: string[] }
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
