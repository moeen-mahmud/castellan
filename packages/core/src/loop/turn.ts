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
import type { ContextBlock } from "../context/blocks.ts"
import { estimateMessageTokens } from "../context/tokens.ts"
import { type ErrorDetail, HarnessError, toolRepairFailed } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { TurnEndReason } from "../events/types.ts"
import type { ChatMessage, ToolDefinition } from "../model/provider.ts"
import { type ResolvedRole, requestParamsFor } from "../model/roles.ts"
import type { ParsedOutput, StepOutput, ToolDialect } from "../tools/dialect/dialect.ts"
import { executeIntents } from "../tools/execute.ts"
import type { ToolRegistry } from "../tools/registry.ts"
import type { ToolResult, WorkspaceWriteTarget } from "../tools/types.ts"
import { newStepId, newTurnId } from "./ids.ts"
import { runStep } from "./step.ts"

export interface TurnLimits {
    readonly maxSteps: number
    readonly turnTimeoutMs: number
    readonly toolTimeoutMs: number
    readonly maxParallelTools: number
}

/**
 * Everything the step loop needs to run tools. Absent, or with an empty catalogue, the loop behaves
 * exactly as it did before tools existed: the first reply is the answer.
 */
export interface ToolRuntime {
    readonly registry: ToolRegistry
    readonly dialect: ToolDialect
    /** Slot 1, rendered once at agent load. Byte-stable, or prompt caching stops working. */
    readonly blocks: readonly ContextBlock[]
    /**
     * The request's `tools` parameter, built once at agent load beside the catalogue. Present under
     * `native`, absent under a text dialect.
     */
    readonly requestTools?: readonly ToolDefinition[]
    /**
     * What `requestTools` costs in prompt tokens, and why this field exists at all.
     *
     * Under NLT the catalogue is a context block, so `assembleContext` counts it and the budget is
     * honest. Under native it is in the request body, where the assembler cannot see it — so the
     * window handed to the assembler is reduced by this instead. Without it a turn believes it has
     * room it does not have, and the failure arrives as a context-length rejection from the endpoint
     * with nothing local to explain it.
     */
    readonly wireTokens: number
    /** The agent's directory. A tool touching the filesystem resolves against it, not the cwd. */
    readonly dir: string
    /** Where `memory_write` lands, resolved from the workspace at load. Absent means no workspace
     * declared anywhere writable, and the tool falls back to the agent's own directory. */
    readonly writeTarget?: WorkspaceWriteTarget
    readonly observationMaxTokens: number
    /** Injected so a tool that reads the clock is testable. */
    readonly now?: () => Date
}

export interface TurnInput {
    readonly agentId: string
    readonly sessionKey: string
    readonly input: string
    readonly history: readonly ChatMessage[]
    readonly identity: string
    /** Workspace `volatile` tier, slot 2 — after the cache breakpoint. */
    readonly volatile?: string
    /** Workspace `reminder` tier, slot 7 — after the history. */
    readonly reminder?: string
    readonly role: ResolvedRole
    readonly window: number
    readonly reserveOutput: number
    readonly limits: TurnLimits
    readonly tools?: ToolRuntime
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
    /** Consecutive repair attempts. Reset by any step whose calls were usable. */
    let repairs = 0

    input.bus.emit(
        "turn.start",
        { source: input.source, inputTokens: estimateMessageTokens(input.input) },
        context,
    )

    // Built during the loop rather than after it: with tools, what gets persisted is a trace of
    // several messages, and reconstructing it from the final state afterwards loses the order.
    const trace: ChatMessage[] = [{ role: "user", content: input.input }]
    /** Prose from the current step that no history message carries yet. */
    let pendingProse = ""
    /** True when the last step asked for more work, so exhausting the step cap is a failure. */
    let pendingWork = false
    /** A mutating tool succeeded. Its effect happened, whatever the turn's outcome turns out to be. */
    let sideEffects = false

    try {
        const history: ChatMessage[] = [...input.history]
        const tools = input.tools

        while (steps < input.limits.maxSteps) {
            if (link.signal.aborted) break

            const assembled = assembleContext({
                identity: input.identity,
                ...(tools === undefined ? {} : { toolBlocks: tools.blocks }),
                ...(input.volatile === undefined ? {} : { volatile: input.volatile }),
                ...(input.reminder === undefined ? {} : { reminder: input.reminder }),
                history,
                input: input.input,
                // Reduced by whatever the dialect puts in the request body rather than in a block.
                // Zero under NLT, so this is the same arithmetic it always was.
                window: Math.max(1, input.window - (tools?.wireTokens ?? 0)),
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
                ...(tools?.requestTools === undefined ? {} : { tools: tools.requestTools }),
                bus: input.bus,
                context: stepContext,
                signal: link.signal,
            })

            reasoning += step.reasoning
            promptTokens = step.promptTokens
            outputTokens += step.outputTokens
            pendingWork = false

            // With no catalogue there is nothing to look for, and running a parser over the reply
            // could only ever find a false positive in the model's prose.
            //
            // The dialect gets both halves of what the step produced — the text and whatever the
            // transport reported structurally — because which half carries the protocol is the
            // dialect's decision, not this loop's.
            const parsed: ParsedOutput =
                tools === undefined || tools.registry.size === 0
                    ? { intents: [], text: step.text }
                    : tools.dialect.parse({ text: step.text, calls: step.calls })

            // The reply the person reads is the prose *outside* the blocks, accumulated across
            // steps: "let me check the calendar" is narration they should see, and the block that
            // follows it is not.
            if (parsed.text !== "") text = text === "" ? parsed.text : `${text}\n\n${parsed.text}`
            pendingProse = parsed.text

            if (step.aborted) break

            // An empty reply that stopped at the output limit is a failure, and reporting it as
            // `final` would be exactly the "healthy but does nothing" shape rule 8 exists to
            // prevent. It happens for real: on a reasoning model, reasoning tokens are billed to
            // the output budget, so a `max_tokens` that does not cover the thinking returns no
            // content at all. Measured against deepseek-v4-pro with max_tokens=16.
            if (
                step.finishReason === "length" &&
                text.trim() === "" &&
                parsed.intents.length === 0
            ) {
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

            const output: StepOutput = { text: step.text, calls: step.calls }
            /** Calls the dialect could not read at all. Only `native` can produce these. */
            const unreadable = parsed.malformed ?? []

            // No tool call means this reply is the answer. The overwhelming majority of steps.
            // An unreadable call counts as work: breaking here would drop it silently and report the
            // turn as a clean reply, which is the one outcome that must never happen.
            if (tools === undefined || (parsed.intents.length === 0 && unreadable.length === 0)) {
                break
            }

            // What the model just did, as its own dialect records it: the raw text under NLT, prose
            // plus the structured calls under native. Either way the next model call sees the call it
            // made rather than a cleaned-up version that no longer explains the observation below.
            const call = tools.dialect.renderCall(output)
            history.push(call)
            trace.push(call)
            pendingProse = ""

            if (unreadable.length > 0) {
                // Emitted here because nothing was executed, so `executeIntents` — which normally
                // owns this event — never ran. A repair that fired no event looks like a slow turn on
                // every surface subscribed to the bus.
                input.bus.emit(
                    "tool.repair",
                    {
                        slugs: [
                            ...new Set(
                                step.calls
                                    .map((entry) => entry.name.trim())
                                    .filter((name) => name !== ""),
                            ),
                        ],
                        errors: unreadable.map((error) => `${error.field}: ${error.message}`),
                    },
                    stepContext,
                )
            }

            // A step is all-or-nothing, so an unreadable call stops it before anything runs.
            // Executing the readable calls and repairing the rest would re-run a mutating call that
            // had already succeeded, and there is no idempotency key at this layer to make that safe.
            const outcome =
                unreadable.length > 0
                    ? { results: [] as readonly ToolResult[], repair: unreadable }
                    : await executeIntents({
                          registry: tools.registry,
                          intents: parsed.intents,
                          context: {
                              agentId: input.agentId,
                              sessionKey: input.sessionKey,
                              turnId,
                              dir: tools.dir,
                              ...(tools.writeTarget === undefined
                                  ? {}
                                  : { writeTarget: tools.writeTarget }),
                              signal: link.signal,
                              now: tools.now ?? (() => new Date()),
                          },
                          bus: input.bus,
                          eventContext: stepContext,
                          timeoutMs: input.limits.toolTimeoutMs,
                          maxParallel: input.limits.maxParallelTools,
                          observationMaxTokens: tools.observationMaxTokens,
                      })

            if (outcome.results.some((result) => result.ok)) {
                sideEffects ||= outcome.results.some(
                    (result) => result.ok && tools.registry.resolve(result.slug).spec.mutating,
                )
            }

            if (outcome.repair.length > 0) {
                // One repair, and only one. A second identical failure is a catalogue or routing
                // problem that another attempt cannot fix, and looping on it spends the whole step
                // budget producing the same broken block.
                if (repairs > 0) {
                    reason = "error"
                    const detail = toolRepairFailed(
                        outcome.repair.map((field) => ({
                            code: "tool_arguments_invalid",
                            message: `${field.field} ${field.message}`,
                            hint: field.hint,
                            field: field.field,
                        })),
                    ).toDetail()
                    error = detail
                    input.bus.emit("agent.warning", detail, context)
                    break
                }
                repairs += 1
                const repairMessages = tools.dialect.renderRepair(outcome.repair, output)
                history.push(...repairMessages)
                trace.push(...repairMessages)
                pendingWork = true
                continue
            }

            repairs = 0
            const observation = tools.dialect.renderObservation(outcome.results)
            history.push(...observation)
            trace.push(...observation)
            pendingWork = true
        }

        if (link.signal.aborted) {
            reason = link.cause() ?? "stopped"
        } else if (
            reason === "final" &&
            steps >= input.limits.maxSteps &&
            (pendingWork || text === "")
        ) {
            // Guarded on `reason` so a diagnosis already made inside the loop — an exhausted
            // output budget, say — is not overwritten by the coarser one. `pendingWork` is the
            // honest test with tools in play: the model was mid-task and ran out of steps, which is
            // a failure however much narration it produced along the way.
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

    if (pendingProse !== "") trace.push({ role: "assistant", content: pendingProse })

    // Partial content is kept on an explicit stop and on a timeout, both of which are decisions
    // someone made. It is never persisted for a disconnect, which cannot reach this code at all.
    //
    // A failed turn normally appends nothing: a half-answer in the history is something the next
    // turn would be conditioned on as though it were said. **Tool side effects are the exception.**
    // If a mutating tool succeeded, that happened — the email left, the row was written — and
    // discarding the record would let the next turn cheerfully do it again. So a turn that both
    // acted and failed keeps its trace, and the failure itself is on the turn row and in the pinned
    // error slot next turn.
    const appended: ChatMessage[] = reason !== "error" || sideEffects ? trace : []

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
