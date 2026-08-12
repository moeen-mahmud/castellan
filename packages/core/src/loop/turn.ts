/**
 * One turn: one inbound input to one delivered reply, containing 1..N steps.
 *
 * **The turn is not bound to whoever asked for it.** Nothing in this file takes a connection,
 * a socket, or a response object, and nothing cancels on disconnect. A turn ends when it is
 * finished, when it is explicitly stopped, when it times out, or when it fails — and each of
 * those is reported as what it is. `max_steps` in particular is an honest failure rather than a
 * completion dressed up as one.
 *
 * Cancellation is a state, not an exception: an aborted turn returns a `TurnResult` with
 * `reason: "stopped"` and whatever text had accumulated. No rejected promise, so nothing
 * upstream has to remember to catch one.
 */

import { assembleContext, slotReport } from "../context/assemble.ts"
import { estimateMessageTokens } from "../context/tokens.ts"
import { type ErrorDetail, HarnessError } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { TurnEndReason } from "../events/types.ts"
import type { ChatMessage } from "../model/provider.ts"
import { type ResolvedRole, requestParamsFor } from "../model/roles.ts"
import { newStepId, newTurnId } from "./ids.ts"
import { runStep } from "./step.ts"

export interface TurnLimits {
    readonly maxSteps: number
    readonly turnTimeoutMs: number
}

export interface TurnInput {
    readonly agentId: string
    readonly sessionKey: string
    readonly input: string
    readonly history: readonly ChatMessage[]
    readonly identity: string
    readonly role: ResolvedRole
    readonly window: number
    readonly reserveOutput: number
    readonly limits: TurnLimits
    readonly bus: EventBus
    /** Where the turn came from, for the `turn.start` event: `repl`, `api`, `schedule`, … */
    readonly source: string
    /** Caller's cancellation. A disconnect must never be wired to this. */
    readonly signal?: AbortSignal
    readonly turnId?: string
}

export interface TurnResult {
    readonly turnId: string
    readonly text: string
    readonly reasoning: string
    readonly reason: TurnEndReason
    readonly steps: number
    readonly tokens: { readonly prompt: number; readonly output: number }
    readonly durationMs: number
    /** Present when `reason` is `error`. Carries a field path when one applies. */
    readonly error?: ErrorDetail
    /** Messages appended to the session by this turn. */
    readonly appended: readonly ChatMessage[]
}

/**
 * Links a caller signal and a timeout into one signal, and remembers which of them fired —
 * `stopped` and `timeout` are different outcomes and collapsing them loses the diagnosis.
 */
function linkSignals(
    external: AbortSignal | undefined,
    timeoutMs: number,
): { signal: AbortSignal; cause: () => "stopped" | "timeout" | undefined; dispose: () => void } {
    const controller = new AbortController()
    let cause: "stopped" | "timeout" | undefined

    const onExternal = () => {
        cause ??= "stopped"
        controller.abort()
    }

    const timer = setTimeout(() => {
        cause ??= "timeout"
        controller.abort()
    }, timeoutMs)

    if (external !== undefined) {
        if (external.aborted) onExternal()
        else external.addEventListener("abort", onExternal, { once: true })
    }

    return {
        signal: controller.signal,
        cause: () => cause,
        dispose: () => {
            clearTimeout(timer)
            external?.removeEventListener("abort", onExternal)
        },
    }
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
    const turnId = input.turnId ?? newTurnId()
    const context = { agentId: input.agentId, sessionKey: input.sessionKey, turnId }
    const started = performance.now()

    const link = linkSignals(input.signal, input.limits.turnTimeoutMs)

    let text = ""
    let reasoning = ""
    let steps = 0
    let promptTokens = 0
    let outputTokens = 0
    let reason: TurnEndReason = "final"
    let error: TurnResult["error"]

    input.bus.emit(
        "turn.start",
        { source: input.source, inputTokens: estimateMessageTokens(input.input) },
        context,
    )

    try {
        const history: ChatMessage[] = [...input.history]

        while (steps < input.limits.maxSteps) {
            if (link.signal.aborted) break

            const assembled = assembleContext({
                identity: input.identity,
                history,
                input: input.input,
                window: input.window,
                reserveOutput: input.reserveOutput,
            })

            input.bus.emit(
                "context.assembled",
                { slots: slotReport(assembled.blocks), total: assembled.totalTokens },
                context,
            )

            steps += 1
            const stepContext = { ...context, stepId: newStepId() }
            const params = requestParamsFor(input.role, input.window, input.reserveOutput)

            const step = await runStep({
                role: input.role,
                provider: input.role.provider,
                messages: assembled.messages,
                params,
                promptTokens: assembled.totalTokens,
                bus: input.bus,
                context: stepContext,
                signal: link.signal,
            })

            text += step.text
            reasoning += step.reasoning
            promptTokens = step.promptTokens
            outputTokens += step.outputTokens

            if (step.aborted) break

            // An empty reply that stopped at the output limit is a failure, and reporting it as
            // `final` would be exactly the "healthy but does nothing" shape rule 8 exists to
            // prevent. It happens for real: on a reasoning model, reasoning tokens are billed to
            // the output budget, so a `max_tokens` that does not cover the thinking returns no
            // content at all. Measured against deepseek-v4-pro with max_tokens=16.
            if (step.finishReason === "length" && text.trim() === "") {
                reason = "error"
                const detail: ErrorDetail = {
                    code: "empty_reply_output_exhausted",
                    message: `The model produced no text and stopped at the output limit (${params.maxTokens} tokens; ${step.outputTokens} spent${reasoning === "" ? "" : `, ${reasoning.length} characters of it on reasoning`}).`,
                    hint:
                        input.role.capabilities.thinking === "deepseek"
                            ? "This model bills reasoning tokens to the output budget, so a small allowance leaves nothing for the answer. Raise context.reserveOutput — or model.<role>.maxTokens — above the reasoning length."
                            : "Raise context.reserveOutput, or set model.<role>.maxTokens explicitly, so the reply has room.",
                    field: "context.reserveOutput",
                }
                error = detail
                input.bus.emit("agent.warning", detail, context)
                break
            }

            // With no tool dialect there is nothing to continue for: the first reply is the answer.
            // Phase 3 replaces this with `parse → intents ? continue : final`.
            break
        }

        if (link.signal.aborted) {
            reason = link.cause() ?? "stopped"
        } else if (reason === "final" && steps >= input.limits.maxSteps && text === "") {
            // Guarded on `reason` so a diagnosis already made inside the loop — an exhausted
            // output budget, say — is not overwritten by the coarser one.
            reason = "max_steps"
        }
    } catch (caught) {
        if (link.signal.aborted) {
            reason = link.cause() ?? "stopped"
        } else {
            reason = "error"
            const harness = caught instanceof HarnessError ? caught : undefined
            error = {
                code: harness?.code ?? "turn_failed",
                message: caught instanceof Error ? caught.message : String(caught),
                hint:
                    harness?.hint ??
                    "Unexpected failure inside the turn. The stack is on the `error` event; this is a bug worth reporting.",
            }
            input.bus.emit(
                "error",
                {
                    ...error,
                    ...(caught instanceof Error && caught.stack !== undefined
                        ? { stack: caught.stack }
                        : {}),
                },
                context,
            )
        }
    } finally {
        link.dispose()
    }

    const durationMs = Math.round(performance.now() - started)

    // Partial content is kept on an explicit stop and on a timeout, both of which are decisions
    // someone made. It is never persisted for a disconnect, which cannot reach this code at all.
    const appended: ChatMessage[] =
        reason === "error"
            ? []
            : [
                  { role: "user", content: input.input },
                  ...(text === "" ? [] : ([{ role: "assistant", content: text }] as ChatMessage[])),
              ]

    input.bus.emit(
        "turn.end",
        { reason, steps, tokens: { prompt: promptTokens, output: outputTokens }, durationMs },
        context,
    )

    return {
        turnId,
        text,
        reasoning,
        reason,
        steps,
        tokens: { prompt: promptTokens, output: outputTokens },
        durationMs,
        ...(error === undefined ? {} : { error }),
        appended,
    }
}
