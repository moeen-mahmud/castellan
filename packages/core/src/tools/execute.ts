/**
 * Running what the model asked for.
 *
 * Four rules, each the answer to a specific way this goes wrong:
 *
 * **Nothing runs if anything in the step is malformed.** A step can carry several blocks. Executing
 * the good ones and repairing the bad one means the model rewrites the whole step, and the mutating
 * call that already succeeded runs a second time. There is no idempotency key available here, so the
 * step is all-or-nothing and the repair asks for all of it again.
 *
 * **Reads batch, writes serialise, declared order holds.** Consecutive read-only calls run
 * concurrently up to `maxParallelTools`; a mutating call is a barrier with nothing beside it. So
 * `read, read, write, read` is two batches around one write, in the order the model wrote them —
 * parallelism never reorders side effects.
 *
 * **A timeout ends the call, not the handler.** Nothing here can kill a handler that ignores its
 * signal; the call is reported as timed out and the handler is abandoned. Reporting a timeout while
 * quietly waiting forever would be the worse lie.
 *
 * **A failed tool is an observation, not an exception.** The model needs to see what went wrong to
 * do anything about it, so the error text goes back as the observation and the turn continues. Only
 * a broken harness throws out of here.
 */

import { estimateTokens } from "../context/tokens.ts"
import { type ErrorDetail, toolFailed, toolTimedOut } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { EventContext } from "../events/types.ts"
import { coerceArgs } from "./coerce.ts"
import type { ToolRegistry } from "./registry.ts"
import type { FieldError, Tool, ToolContext, ToolIntent, ToolResult } from "./types.ts"

export interface ExecuteInput {
    readonly registry: ToolRegistry
    readonly intents: readonly ToolIntent[]
    readonly context: ToolContext
    readonly bus: EventBus
    readonly eventContext: EventContext
    readonly timeoutMs: number
    /** Read-only calls only. Mutating calls always run one at a time. */
    readonly maxParallel: number
    /** Above this, an observation is cut to head and tail with a visible marker. */
    readonly observationMaxTokens: number
}

export interface ExecuteOutcome {
    readonly results: readonly ToolResult[]
    /**
     * Non-empty when the step could not be executed as written. Exactly one repair follows; a
     * second failure is an honest error rather than another attempt.
     */
    readonly repair: readonly FieldError[]
}

/** A resolved, coerced call: what will actually run. */
export interface PlannedCall {
    readonly intent: ToolIntent
    readonly tool: Tool
    readonly args: Readonly<Record<string, unknown>>
}

/** Stable across key order, because the same call written two ways is the same call. */
export function hashArgs(args: Readonly<Record<string, unknown>>): string {
    const canonical = JSON.stringify(
        Object.keys(args)
            .sort()
            .map((key) => [key, args[key]]),
    )
    // FNV-1a: not cryptographic, and does not need to be — this identifies a repeat, it does not
    // protect anything. Cheap matters, because it runs on every call.
    let hash = 0x811c9dc5
    for (let i = 0; i < canonical.length; i += 1) {
        hash ^= canonical.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
}

function truncate(
    output: string,
    maxTokens: number,
): { readonly text: string; readonly truncated: boolean } {
    if (maxTokens <= 0 || estimateTokens(output) <= maxTokens) {
        return { text: output, truncated: false }
    }
    // Head and tail, because the useful parts of a long observation are at both ends: what it is at
    // the top, and the result or error at the bottom. The middle is rows.
    const budget = Math.max(200, Math.floor(maxTokens * 3.8))
    const head = output.slice(0, Math.floor(budget * 0.6))
    const tail = output.slice(-Math.floor(budget * 0.4))
    const elided = output.length - head.length - tail.length
    return {
        text: `${head}\n\n[… ${elided} characters cut from the middle of this observation to fit the context budget …]\n\n${tail}`,
        truncated: true,
    }
}

/**
 * Resolve and coerce every intent before any of them runs.
 *
 * Exported because "what would this step do" is worth asking without doing it — the eval harness
 * scores routing and arguments separately from execution.
 */
export function planIntents(
    registry: ToolRegistry,
    intents: readonly ToolIntent[],
): { readonly planned: readonly PlannedCall[]; readonly repair: readonly FieldError[] } {
    const planned: PlannedCall[] = []
    const repair: FieldError[] = []

    for (const intent of intents) {
        if (!registry.has(intent.slug)) {
            const known = registry.specs().map((spec) => spec.slug)
            // Dialect-neutral wording, and the field is the bare slug. This used to read
            // `ACTION: <slug>` with a hint about ACTION blocks — correct under NLT and nonsense under
            // native, where it would tell the model to fix a block it never wrote. The dialect owns
            // how a repair is *phrased for its protocol*; this layer says only what is wrong, and the
            // bare slug is what `native` matches its per-call messages against.
            repair.push({
                field: intent.slug,
                message: "is not a tool that exists.",
                hint:
                    known.length === 0
                        ? "No tools are available in this conversation. Reply without calling a tool."
                        : `Use one of these exactly as written: ${known.join(", ")}.`,
            })
            continue
        }

        const tool = registry.resolve(intent.slug)
        const coerced = coerceArgs(tool.spec, intent.args)
        if (coerced.ok) {
            planned.push({ intent, tool, args: coerced.args })
            continue
        }
        // Prefixed with the slug: with two blocks in a step, `to: is required` alone does not say
        // which block to fix.
        for (const error of coerced.errors) {
            repair.push({ ...error, field: `${intent.slug}.${error.field}` })
        }
    }

    return { planned, repair }
}

export async function executeIntents(input: ExecuteInput): Promise<ExecuteOutcome> {
    const { planned, repair } = planIntents(input.registry, input.intents)

    if (repair.length > 0) {
        input.bus.emit(
            "tool.repair",
            {
                slugs: [...new Set(input.intents.map((intent) => intent.slug))],
                errors: repair.map((error) => `${error.field}: ${error.message}`),
            },
            input.eventContext,
        )
        return { results: [], repair }
    }

    const results: ToolResult[] = []
    for (const group of batch(planned, input.maxParallel)) {
        // `all` rather than `allSettled`: runOne never rejects, so a rejection here is a bug in the
        // harness and should surface as one instead of being folded into a tool failure.
        results.push(...(await Promise.all(group.map((entry) => runOne(entry, input)))))
    }

    return { results, repair: [] }
}

/**
 * Group into runs of consecutive read-only calls, capped at `maxParallel`, with every mutating call
 * alone in its own group. Order is preserved, so a write never overtakes a read written before it.
 */
export function batch(
    planned: readonly PlannedCall[],
    maxParallel: number,
): readonly PlannedCall[][] {
    const groups: PlannedCall[][] = []
    const cap = Math.max(1, maxParallel)

    for (const entry of planned) {
        const current = groups[groups.length - 1]
        const canJoin =
            current !== undefined &&
            current.length < cap &&
            !entry.tool.spec.mutating &&
            current.every((member) => !member.tool.spec.mutating)
        if (canJoin && current !== undefined) current.push(entry)
        else groups.push([entry])
    }

    return groups
}

async function runOne(entry: PlannedCall, input: ExecuteInput): Promise<ToolResult> {
    const { intent, tool, args } = entry
    const started = performance.now()

    input.bus.emit(
        "tool.call",
        {
            slug: tool.spec.slug,
            callId: intent.callId,
            argsHash: hashArgs(args),
            mutating: tool.spec.mutating,
        },
        input.eventContext,
    )

    const settle = (ok: boolean, output: string, error?: ErrorDetail): ToolResult => {
        const capped = truncate(output, input.observationMaxTokens)
        const result: ToolResult = {
            callId: intent.callId,
            slug: tool.spec.slug,
            ok,
            output: capped.text,
            ...(error === undefined ? {} : { error }),
            latencyMs: Math.round(performance.now() - started),
            bytes: output.length,
            truncated: capped.truncated,
        }
        input.bus.emit(
            "tool.result",
            {
                slug: result.slug,
                callId: result.callId,
                ok: result.ok,
                latencyMs: result.latencyMs,
                bytes: result.bytes,
                truncated: result.truncated,
            },
            input.eventContext,
        )
        return result
    }

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), input.timeoutMs)
    // The turn's cancellation and this call's timeout are different outcomes, so they stay separate
    // controllers and the handler is handed the union.
    const signal = AbortSignal.any([input.context.signal, timeout.signal])

    try {
        const output = await Promise.race([
            Promise.resolve(tool.handler(args, { ...input.context, signal })),
            new Promise<never>((_, reject) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        reject(
                            timeout.signal.aborted
                                ? toolTimedOut(tool.spec.slug, input.timeoutMs)
                                : new DOMException("aborted", "AbortError"),
                        )
                    },
                    { once: true },
                )
            }),
        ])
        return settle(true, output)
    } catch (caught) {
        // A cancelled turn is not a failed tool. Reported as an aborted call so the transcript says
        // what happened, and the turn's own cancellation handling takes it from here.
        if (isAbortError(caught) && !timeout.signal.aborted) {
            return settle(false, "The call was cancelled before it finished.", {
                code: "tool_cancelled",
                message: `${tool.spec.slug} was cancelled.`,
                hint: "The turn was stopped while this tool was running. Any side effect it had already caused still happened.",
            })
        }
        const detail = toolFailed(tool.spec.slug, caught).toDetail()
        return settle(false, `${detail.message}\n${detail.hint}`, detail)
    } finally {
        clearTimeout(timer)
    }
}

function isAbortError(value: unknown): boolean {
    return value instanceof Error && value.name === "AbortError"
}
