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
import { SLOT } from "../context/blocks.ts"
import { type Calibration, comparableEstimate, observe, UNCALIBRATED } from "../context/budget.ts"
import { runLadder, type Thresholds } from "../context/compaction/ladder.ts"
import type { Displaced } from "../context/compaction/stages.ts"
import { estimateMessageTokens } from "../context/tokens.ts"
import { type ErrorDetail, HarnessError, toolRepairFailed } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import type { TurnEndReason } from "../events/types.ts"
import type { ChatMessage, ToolDefinition } from "../model/provider.ts"
import { type ResolvedRole, requestParamsFor } from "../model/roles.ts"
import type { ParsedOutput, StepOutput, ToolDialect } from "../tools/dialect/dialect.ts"
import { nativeWireTokens } from "../tools/dialect/native.ts"
import { type ApprovalRequest, executeIntents } from "../tools/execute.ts"
import { phaseSetTool } from "../tools/local.ts"
import type { PolicyConfig } from "../tools/policy.ts"
import type { ToolRegistry } from "../tools/registry.ts"
import type { OnMutate } from "../tools/trust.ts"
import type { DisplacedArtifact, Tool, ToolResult, WorkspaceWriteTarget } from "../tools/types.ts"
import { newStepId, newTurnId } from "./ids.ts"
import { allowFor, otherPhases, type PhaseMap } from "./phases.ts"
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
    /**
     * Where eviction files older notes: `memory.dir`, resolved. Forwarded to `ToolContext.memoryDir`.
     *
     * Declared here rather than only on the context because this object is built with conditional
     * spreads, so an undeclared property is **not** excess-property-checked — it type-checks, lands
     * nowhere, and `memory_write` silently degrades to appending without eviction. That is the fifth
     * time this exact shape has cost a debugging round in this repo (`apiKeyEnv`,
     * `ChatMessage.toolCalls`, `TurnInput.skills`, `ToolContext.readArtifact`), and it cost one here.
     */
    readonly memoryDir?: string
    readonly observationMaxTokens: number
    /**
     * What to do when untrusted content is in the turn and the model asks for a mutating tool.
     *
     * Resolved once at agent construction, like `writeTarget`. `confirm` is settled before it gets
     * here — it needs an approver, which is a question about the front end rather than the loop.
     */
    readonly untrustedOnMutate: OnMutate
    /** Which calls run, ask, or are refused. Resolved once at agent construction. */
    readonly policy: PolicyConfig
    /**
     * How to ask a person, when one is reachable. Supplied by the front end — a terminal, a
     * channel, an HTTP surface — and absent for an unattended run, which is what makes
     * `tools.policy.onNoApprover` the answer there rather than an indefinite wait.
     */
    readonly approve?: (request: ApprovalRequest) => Promise<boolean>
    /** Injected so a tool that reads the clock is testable. */
    readonly now?: () => Date
}

export interface TurnInput {
    readonly agentId: string
    readonly sessionKey: string
    readonly input: string
    readonly history: readonly ChatMessage[]
    readonly identity: string
    /** Slot 2: the agent's own configuration, rendered once at load. See `config-summary.ts`. */
    readonly configSummary?: string
    /** Workspace example blocks as a user message, slot 2 — under `examplesIn: user`. */
    readonly examples?: string
    /** Workspace `volatile` tier, slot 3 — after the cache breakpoint. */
    readonly volatile?: string
    /**
     * Activated knowledge entries, `SLOT.knowledge`. Selected by the caller *per turn* — activation
     * depends on the turn's input and nothing else, so it is stable across the steps within one.
     */
    readonly knowledge?: readonly { readonly name: string; readonly content: string }[]
    /**
     * Activated skills: the body for `SLOT.skill`, and the script tools callable for this turn.
     *
     * Both halves travel together on purpose. A body describing `skill.pdf-processing.extract` while the
     * executor has never heard of it is an agent that reads an instruction it cannot follow, and the
     * reverse — a callable tool nothing told the model about — is a capability it cannot know it has.
     *
     * `tools` are layered onto the registry for the duration of the turn and are **never** rendered into
     * slot 1, which is built once at load and must stay byte-identical.
     */
    /**
     * Retrieved memory passages, `SLOT.memory`. Selected by the caller *per turn*, for the same reason
     * knowledge is: two steps of one turn must not argue from different remembered facts.
     */
    readonly memory?: readonly {
        readonly source: string
        readonly at: string
        readonly text: string
    }[]
    readonly skills?: readonly {
        readonly name: string
        readonly content: string
        readonly role: "system" | "user"
        readonly tools: readonly Tool[]
    }[]
    /** Workspace `reminder` tier, slot 9 — after the history. */
    readonly reminder?: string
    readonly role: ResolvedRole
    readonly window: number
    readonly reserveOutput: number
    readonly limits: TurnLimits
    /**
     * Compaction, when the caller has a store and thresholds to give it.
     *
     * Absent means the blunt oldest-first window in `assembleContext` is the only protection, which is
     * what every phase before this one had. Present is not a promise that anything runs: the ladder does
     * nothing until a threshold is crossed, which on an ordinary turn is never.
     */
    readonly compaction?: TurnCompaction
    /** Declared phases and where this session currently is. Absent means one implicit phase. */
    readonly phases?: TurnPhases
    readonly tools?: ToolRuntime
    readonly bus: EventBus
    /** Where the turn came from, for the `turn.start` event: `repl`, `api`, `schedule`, … */
    readonly source: string
    /** Caller's cancellation. A disconnect must never be wired to this. */
    readonly signal?: AbortSignal
    readonly turnId?: string
}

export interface TurnPhases {
    readonly config: PhaseMap
    /** Where the session is when the turn begins. */
    readonly current: string
    /**
     * Persists a change. Awaited inside the turn, so a crash right after the model was told its tools
     * changed does not resume in the phase it thought it had left.
     */
    readonly persist?: (to: string) => Promise<void>
}

export interface TurnCompaction {
    readonly thresholds: Thresholds
    /**
     * What the estimator has learned about its own bias, carried in by the caller.
     *
     * Passed in and handed back on `TurnResult` rather than mutated through a callback, because it is
     * session state and the session's owner is the only thing that can decide how long it lives. A
     * fresh `UNCALIBRATED` is correct and merely means the first turn runs on the raw estimate.
     */
    readonly calibration: Calibration
    /** The `compactor` role. Absent, throwing and empty-returning are all handled the same way. */
    readonly summarise?: (messages: readonly ChatMessage[]) => Promise<string>
    /**
     * Persists what a stage displaced. Awaited *inside* the step loop, not at the end of the turn.
     *
     * The pointer a stage leaves behind can be followed by the very next model call, so an artifact
     * written at turn end is one the model was invited to read and could not.
     */
    readonly persist?: (artifacts: readonly Displaced[]) => Promise<void>
    /** Backs `artifact_read`. Scoped to this session by whoever supplies it. */
    readonly read?: (id: string) => Promise<DisplacedArtifact | undefined>
    /** How many times S5 has already fired in this session. A second is a misconfiguration. */
    readonly resets?: number
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
    /**
     * The calibration after this turn's observations, for the caller to carry to the next one.
     *
     * Absent when no compaction seam was supplied or no endpoint reported `prompt_tokens` — and those
     * are different states with the same shape here, which is why `context.pressure` carries its own
     * `source` rather than leaving anyone to infer it from this.
     */
    readonly calibration?: Calibration
    /** Stages that ran across every step of this turn. Zero on an ordinary turn. */
    readonly compactions?: number
    /** S5 firings in this turn, to be added to the session's running count. */
    readonly resets?: number
    /** The phase the turn ended in. Absent when the agent declares no phases. */
    readonly phase?: string
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
    /**
     * Turn-scoped, and outside the `try` because the result is built after it.
     *
     * The calibration is carried in and handed back rather than owned here: it is session state, and a
     * turn is the wrong lifetime for it — one turn's worth of observations is a sample, not a bias.
     */
    let calibration = input.compaction?.calibration ?? UNCALIBRATED
    let compactions = 0
    let resets = 0
    /**
     * The current phase, outside the `try` because the result is built after it and a turn that failed
     * still moved phase if `phase_set` succeeded before the failure. Losing that would resume the next
     * turn in a phase the agent had already left.
     */
    let phase = input.phases?.current ?? ""
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
    /**
     * Untrusted output reached this turn, and which tool brought it.
     *
     * Turn-scoped by decision 4.26: the injected text stays in the context influencing every later
     * step, so clearing it between steps would gate the wrong thing. It does *not* survive into the
     * next turn — a known, deliberate boundary, since a taint that outlives a human message is a
     * different control and the human message is what a `confirm` policy consults.
     */
    let untrustedSeen = false
    let untrustedSource: string | undefined

    try {
        const history: ChatMessage[] = [...input.history]
        /**
         * Where the current turn's trace begins — the protected tail's boundary.
         *
         * Fixed before the loop, because `history` grows during the turn as calls and observations are
         * pushed onto it. Without this a stage firing at step three could replace the observation the
         * model is about to reason over: a compaction that breaks the turn it was called to rescue.
         */
        const initialHistoryLength = history.length
        // The active skills' script tools, layered on for this turn only. `withTurnTools` returns a new
        // registry and leaves the one slot 1 was rendered from untouched, which is what keeps the cached
        // prefix out of reach — `tools.blocks` is still the catalogue built at load.
        const turnScripts = (input.skills ?? []).flatMap((skill) => skill.tools)
        const baseTools =
            input.tools === undefined || turnScripts.length === 0
                ? input.tools
                : { ...input.tools, registry: input.tools.registry.withTurnTools(turnScripts) }

        /**
         * The catalogue as one phase sees it, rebuilt only when the phase changes.
         *
         * Memoised per phase name rather than per step, because rendering it is the expensive half and
         * a phase is stable across most turns. `wireTokens` is recomputed with it: under `native` the
         * schemas travel in the request body, so a phase that hides four tools makes the body smaller
         * and a stale figure would have the budget reserving room for tools that are no longer sent.
         */
        const views = new Map<string, ToolRuntime>()
        const viewFor = (phase: string): ToolRuntime | undefined => {
            if (baseTools === undefined || input.phases === undefined) return baseTools
            const cached = views.get(phase)
            if (cached !== undefined) return cached

            const allow = allowFor(input.phases.config, phase)
            const all = baseTools.registry.specs()
            const registry = baseTools.registry.inPhase(allow).withTurnTools([
                phaseSetTool({
                    phases: Object.keys(input.phases.config),
                    current: phase,
                    others: otherPhases(input.phases.config, phase, all),
                }),
            ])
            const specs = registry.specs()
            const requestTools = baseTools.dialect.requestTools(specs)
            const view: ToolRuntime = {
                ...baseTools,
                registry,
                blocks: baseTools.dialect.renderCatalogue(specs, registry.notEnabled),
                ...(requestTools === undefined ? {} : { requestTools }),
                wireTokens: requestTools === undefined ? 0 : nativeWireTokens(requestTools),
            }
            views.set(phase, view)
            return view
        }

        // Reassigned by `setPhase` below — the whole point is that a phase change takes effect for the
        // rest of *this* turn. Biome's linter would rather this were const; it cannot be.
        let tools = viewFor(phase)

        while (steps < input.limits.maxSteps) {
            if (link.signal.aborted) break

            const assembleWith = (messages: readonly ChatMessage[]) =>
                assembleContext({
                    identity: input.identity,
                    ...(tools === undefined ? {} : { toolBlocks: tools.blocks }),
                    ...(input.configSummary === undefined
                        ? {}
                        : { configSummary: input.configSummary }),
                    ...(input.examples === undefined ? {} : { examples: input.examples }),
                    ...(input.volatile === undefined ? {} : { volatile: input.volatile }),
                    ...(input.memory === undefined || input.memory.length === 0
                        ? {}
                        : { memory: input.memory }),
                    ...(input.knowledge === undefined || input.knowledge.length === 0
                        ? {}
                        : { knowledge: input.knowledge }),
                    ...(input.skills === undefined || input.skills.length === 0
                        ? {}
                        : {
                              skills: input.skills.map((skill) => ({
                                  name: skill.name,
                                  content: skill.content,
                                  role: skill.role,
                              })),
                          }),
                    ...(input.reminder === undefined ? {} : { reminder: input.reminder }),
                    history: messages,
                    input: input.input,
                    // Reduced by whatever the dialect puts in the request body rather than in a block.
                    // Zero under NLT, so this is the same arithmetic it always was.
                    window: Math.max(1, input.window - (tools?.wireTokens ?? 0)),
                    reserveOutput: input.reserveOutput,
                })

            let assembled = assembleWith(history)

            if (input.compaction !== undefined) {
                // Everything that is not history: pinned blocks, the input, the reminder. Taken from
                // the assembled blocks rather than recomputed, so the ladder's arithmetic and the
                // prompt's cannot disagree — and taken from the *kept* history, because a blunt trim
                // may already have dropped some and charging the ladder for messages the prompt does
                // not contain would make it compact against a fiction.
                const historyCost = assembled.blocks
                    .filter((b) => b.slot === SLOT.history)
                    .reduce((sum, b) => sum + b.tokens, 0)
                const fixed = Math.max(0, assembled.totalTokens - historyCost)

                const result = await runLadder({
                    history,
                    protectedTail: history.length - initialHistoryLength,
                    budget: assembled.promptBudget,
                    fixed,
                    thresholds: input.compaction.thresholds,
                    calibration,
                    ...(input.compaction.summarise === undefined
                        ? {}
                        : { summarise: input.compaction.summarise }),
                })

                // After the ladder, describing the prompt that will actually be sent. Emitting
                // `result.before` here put `ctx 128%` on a status line for a session compaction had
                // handled — a true statement about a prompt nobody sent, and indistinguishable from a
                // window that had just overflowed. `peak` keeps the diagnostic figure.
                input.bus.emit(
                    "context.pressure",
                    {
                        fraction: result.after,
                        tokens: Math.round(result.after * assembled.promptBudget),
                        budget: assembled.promptBudget,
                        source: calibration.samples === 0 ? "estimated" : "corrected",
                        ...(result.before === result.after ? {} : { peak: result.before }),
                    },
                    context,
                )

                for (const record of result.stages) {
                    input.bus.emit(
                        "compaction.stage",
                        {
                            stage: record.stage,
                            before: record.before,
                            after: record.after,
                            changed: record.changed,
                            ...(result.digestSource === undefined
                                ? {}
                                : { digest: result.digestSource }),
                        },
                        context,
                    )
                    if (record.stage === "reset" && record.changed) {
                        resets += 1
                        const count = (input.compaction.resets ?? 0) + resets
                        input.bus.emit(
                            "context.reset",
                            {
                                count,
                                // Not an error: the session keeps working. But a second reset means the
                                // window is too small for how this agent is configured, and saying so
                                // once is the difference between a fixable setting and a session that
                                // mysteriously forgets everything twice an hour.
                                ...(count > 1
                                    ? {
                                          warning:
                                              "The whole conversation has now been replaced by a digest more than once. That is a configuration problem rather than a busy session: raise context.window, lower context.reserveOutput, or cut what slots 0-2 carry.",
                                      }
                                    : {}),
                            },
                            context,
                        )
                    }
                }

                if (result.stages.length > 0) {
                    compactions += result.stages.length
                    // Awaited before the next model call, not at turn end: the pointer a stage just
                    // wrote into history can be followed by the very next reply.
                    if (result.displaced.length > 0 && input.compaction.persist !== undefined) {
                        await input.compaction.persist(result.displaced)
                    }
                    history.length = 0
                    history.push(...result.history)
                    assembled = assembleWith(history)
                }
            }

            input.bus.emit(
                "context.assembled",
                { slots: slotReport(assembled.blocks), total: assembled.totalTokens },
                context,
            )

            steps += 1
            const stepContext = { ...context, stepId: newStepId() }
            const params = requestParamsFor(input.role, input.window)

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

            // The anchor. Only a figure the endpoint actually reported teaches anything — `promptTokens`
            // is seeded with our own estimate, so feeding back an unreported one converges the
            // correction on exactly 1.0 and makes every accuracy check pass by construction.
            if (input.compaction !== undefined && step.promptTokensReported) {
                calibration = observe(calibration, {
                    // Compared against the same bytes the endpoint counted: under `native` the tool
                    // schemas travel in the request body, absent from the assembled total and present
                    // in `prompt_tokens`. Skip this and the correction absorbs the whole catalogue.
                    estimated: comparableEstimate(assembled.totalTokens, tools?.wireTokens ?? 0),
                    reported: step.promptTokens,
                })
            }
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
                // `max_tokens` is only sent when configured, so the limit that was hit is either
                // that number or the endpoint's own — and saying which is the whole value of the
                // message. Reporting a cap this runtime never sent is what made the previous
                // version read as "the harness truncated me" when it had not.
                const cap =
                    params.maxTokens === undefined
                        ? "the endpoint's own output limit"
                        : `the configured limit of ${params.maxTokens} tokens`
                const spent =
                    step.outputTokens > 0
                        ? `${step.outputTokens} output tokens were reported`
                        : "the endpoint reported no usage, so how much it actually generated is unknown"
                const detail: ErrorDetail = {
                    code: "empty_reply_output_exhausted",
                    message: `The model produced no text and stopped at ${cap} — ${spent}${reasoning === "" ? "" : `, and ${reasoning.length} characters arrived as reasoning`}.`,
                    hint:
                        input.role.capabilities.thinking === "none"
                            ? "Set model.<role>.maxTokens to raise the ceiling, if one is configured. Otherwise this is the endpoint's own limit and the request needs to ask for less."
                            : "This model bills its thinking to the output budget and thinks harder the more it is constrained, so a ceiling that fits a bare question may leave nothing for the answer under a longer prompt. Either raise model.<role>.maxTokens, or set model.<role>.reasoningEffort — `none` is the measured fix when the work is short and well specified.",
                    field: "model.main.maxTokens",
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
            // Tagged here rather than in each dialect: `origin` is a fact about who produced the
            // message, and the loop is the only place that knows. Compaction reads it to tell a tool
            // observation from a human message, which under a text dialect the *role* cannot.
            const call: ChatMessage = { ...tools.dialect.renderCall(output), origin: "call" }
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
                              ...(tools.memoryDir === undefined
                                  ? {}
                                  : { memoryDir: tools.memoryDir }),
                              // Wired from the compaction seam rather than from `tools`, because the
                              // artifact store and the compaction that fills it are one capability:
                              // an agent with a store but no thresholds has no pointers to follow,
                              // and one with thresholds but no store has pointers that resolve to
                              // nothing. Passing them together is what keeps those two from drifting.
                              ...(input.compaction?.read === undefined
                                  ? {}
                                  : { readArtifact: input.compaction.read }),
                              // The three things a phase change has to reach, none of which the tool
                              // can see: the catalogue for the rest of this turn, the store, and the
                              // event stream. `tools` is reassigned here, which is what makes the
                              // change take effect on the *next step of this turn* rather than the next
                              // turn — deferring it would recreate the two-hop shape 4.7 refuses in the
                              // feature that exists for the models which fail it.
                              ...(input.phases === undefined
                                  ? {}
                                  : {
                                        setPhase: async (to: string) => {
                                            phase = to
                                            tools = viewFor(to)
                                            await input.phases?.persist?.(to)
                                            input.bus.emit(
                                                "phase.changed",
                                                { to, tools: tools?.registry.size ?? 0 },
                                                stepContext,
                                            )
                                        },
                                    }),
                              signal: link.signal,
                              // Overwritten per call by `runOne`, which is the only place that knows
                              // the deadline actually in force. Seeded here so the shape is complete.
                              deadlineMs: input.limits.toolTimeoutMs,
                              now: tools.now ?? (() => new Date()),
                          },
                          bus: input.bus,
                          eventContext: stepContext,
                          timeoutMs: input.limits.toolTimeoutMs,
                          maxParallel: input.limits.maxParallelTools,
                          observationMaxTokens: tools.observationMaxTokens,
                          untrustedInTurn: untrustedSeen,
                          onMutate: tools.untrustedOnMutate,
                          policy: tools.policy,
                          ...(tools.approve === undefined ? {} : { approve: tools.approve }),
                          ...(untrustedSource === undefined ? {} : { untrustedSource }),
                      })

            if (outcome.results.some((result) => result.ok)) {
                // Optional-chained rather than narrowed: `tools` became reassignable when phases landed,
                // so TypeScript correctly stops narrowing it across the await above — `phase_set` may
                // have swapped the view in between. The registry wanted here is whichever one resolved
                // the call, and a slug missing from it is not a side effect.
                sideEffects ||= outcome.results.some(
                    (result) =>
                        result.ok && tools?.registry.resolve(result.slug).spec.mutating === true,
                )
            }

            // Seeds the next step's gate. No `ok` guard, for the same reason the executor has none:
            // a failed untrusted call still carries upstream text into the context.
            if (!untrustedSeen) {
                const first = outcome.results.find((result) => result.trust === "untrusted")
                if (first !== undefined) {
                    untrustedSeen = true
                    untrustedSource = first.slug
                }
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
                const repairMessages = tools.dialect
                    .renderRepair(outcome.repair, output)
                    .map((message): ChatMessage => ({ ...message, origin: "repair" }))
                history.push(...repairMessages)
                trace.push(...repairMessages)
                pendingWork = true
                continue
            }

            repairs = 0
            const observation = tools.dialect
                .renderObservation(outcome.results)
                .map((message): ChatMessage => ({ ...message, origin: "observation" }))
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
        ...(input.compaction === undefined ? {} : { calibration, compactions, resets }),
        // The phase the turn *ended* in, which is not always the one it began in. The caller persists
        // it too — `persist` inside the turn covers a crash mid-turn, and this covers the ordinary path
        // without making the caller subscribe to an event to learn where its own session got to.
        ...(input.phases === undefined ? {} : { phase }),
    }
}
