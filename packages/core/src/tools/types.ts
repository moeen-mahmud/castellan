/**
 * The tool layer's vocabulary.
 *
 * **One schema, two renderings.** A tool declares its parameters as a JSON Schema object — which
 * is what a provider hands over anyway — and the dialect decides how the model sees it: NLT renders
 * prose, `native` passes the schema to the provider's `tools` parameter. Anything else would mean
 * two descriptions of the same tool that can disagree, and an eval comparing the dialects would no
 * longer be comparing the same tools.
 *
 * The schema subset here is deliberately small. It covers what a line-oriented invocation format
 * can actually express, and a provider tool needing more than this is a tool whose arguments a
 * small model was never going to get right.
 */

import type { ErrorDetail } from "../errors.ts"

export type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object"

export interface JsonSchemaNode {
    readonly type: JsonType
    readonly description?: string
    /** Coercion matches case-insensitively against these, then reports the allowed set. */
    readonly enum?: readonly (string | number | boolean)[]
    readonly items?: JsonSchemaNode
    readonly properties?: Readonly<Record<string, JsonSchemaNode>>
    readonly required?: readonly string[]
    readonly default?: unknown
}

/** A tool's arguments are always an object at the top level, as in every provider's format. */
export interface ToolParameters {
    readonly type: "object"
    readonly properties: Readonly<Record<string, JsonSchemaNode>>
    readonly required?: readonly string[]
}

export interface ToolSpec {
    /** Unique across the catalogue. Case-sensitive, matched tolerantly when parsing. */
    readonly slug: string
    /** Which provider resolved it. Named in a resolution failure so the fix is obvious. */
    readonly provider: string
    /** One line: what it does. */
    readonly summary: string
    /** When the model should reach for it. */
    readonly whenToUse: string
    /**
     * When it should not. Optional in the type, required by the catalogue: negative examples are
     * the cheapest available routing-accuracy improvement, so a spec without one renders a visible
     * placeholder and the registry warns naming the slug. Fabricating the line would be worse than
     * admitting the provider did not supply it.
     */
    readonly whenNotToUse?: string
    /** Mutating tools serialise, hold reserved budget slots, and are never retried. */
    readonly mutating: boolean
    /** Matched by `phases.*.allow` as `tag:<name>`. */
    readonly tags: readonly string[]
    readonly parameters: ToolParameters
}

/**
 * What a handler is given besides its arguments.
 *
 * `now` is injected rather than read from the global clock so that a tool reading the time is
 * testable without freezing the process clock.
 */
export interface ToolContext {
    readonly agentId: string
    readonly sessionKey: string
    readonly turnId: string
    /** The turn's signal. A handler that ignores it will be abandoned, not killed. */
    readonly signal: AbortSignal
    readonly now: () => Date
}

/** Returns the observation text the model will see. Throwing is a failed call, reported as one. */
export type ToolHandler = (
    args: Readonly<Record<string, unknown>>,
    context: ToolContext,
) => Promise<string> | string

export interface Tool {
    readonly spec: ToolSpec
    readonly handler: ToolHandler
}

export interface ToolProvider {
    readonly id: string
    /**
     * Resolve slugs to tools. Return one entry per slug understood, in any order, and **omit**
     * the rest — the registry diffs what came back against what was asked for and fails loudly on
     * the difference. A provider must never substitute a near match of its own.
     *
     * One slug may resolve to several tools (a toolkit name expanding to its members). The
     * registry's budget applies to the result, not to the request.
     */
    resolve(slugs: readonly string[]): Promise<readonly Tool[]>
    /** Optional, and only used to suggest a nearest match when resolution fails. */
    list?(): Promise<readonly string[]>
}

export interface ToolIntent {
    /** Stable within a step. Synthesised for NLT; the provider's id under `native`. */
    readonly callId: string
    readonly slug: string
    /** Pre-coercion: NLT yields strings, `native` yields already-parsed JSON. */
    readonly args: Readonly<Record<string, unknown>>
}

/** One field's worth of "what you sent cannot work", quoted back in the single repair step. */
export interface FieldError {
    readonly field: string
    readonly message: string
    readonly hint: string
}

export interface ToolResult {
    readonly callId: string
    readonly slug: string
    readonly ok: boolean
    /** What the model sees. On failure this is the error text, not an empty string. */
    readonly output: string
    readonly error?: ErrorDetail
    readonly latencyMs: number
    readonly bytes: number
    /** True when the observation was capped. Never silent — the marker is in `output`. */
    readonly truncated: boolean
}
