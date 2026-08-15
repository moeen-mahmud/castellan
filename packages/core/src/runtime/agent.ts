/**
 * A single agent: a manifest plus its resolved model roles, identity, and persisted sessions.
 *
 * The workspace is read **once, at load**, and its `static` tier held as one string. That is not
 * an optimization. Slot 0 is half of the cache-stable prefix, and re-reading the files per turn
 * would let an editor save change the prefix mid-session, quietly destroying prompt caching
 * with no error and no symptom other than the bill.
 *
 * Session history lives in the store, and there is no in-memory fallback. A second code path
 * for "no store configured" would be the one exercised by every test and none of production —
 * so the store is a required constructor argument and `Runtime` always supplies one, defaulting
 * to an in-memory SQLite database rather than to a different implementation.
 */

import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { type ErrorDetail, toolGatedAfterFirstUse } from "../errors.ts"
import type { EventBus } from "../events/bus.ts"
import { newTurnId } from "../loop/ids.ts"
import { runTurn, type ToolRuntime, type TurnResult } from "../loop/turn.ts"
import type { LoadedManifest } from "../manifest/load.ts"
import { resolveProviders } from "../manifest/providers.ts"
import type { AgentManifest } from "../manifest/schema.ts"
import type { PromptStyle } from "../model/prompt-style.ts"
import type { ChatMessage } from "../model/provider.ts"

import { type ResolvedRoles, type ResolveRolesOptions, resolveRoles } from "../model/roles.ts"

import type { SessionSummary, Store, TurnRecord } from "../store/store.ts"
import { passThroughFilter, type StreamFilter } from "../tools/dialect/dialect.ts"
import { nativeDialect, nativeWireTokens } from "../tools/dialect/native.ts"
import { nltDialect } from "../tools/dialect/nlt.ts"
import { onceOnlyTools } from "../tools/policy.ts"
import { ToolRegistry } from "../tools/registry.ts"
import { activateKnowledge, type KnowledgeBase, loadKnowledge } from "../workspace/knowledge.ts"
import {
    loadWorkspace,
    planWorkspace,
    ruleBudgetFailure,
    type Workspace,
    type WorkspaceFileRef,
    writeTarget,
} from "../workspace/load.ts"
import { planSoul } from "../workspace/soul.ts"

/** Boot-time mtime, or `undefined` for a manifest that never came from a file. */
function mtimeOf(path: string): number | undefined {
    try {
        return statSync(path).mtimeMs
    } catch {
        return undefined
    }
}

export interface AgentCreateOptions extends ResolveRolesOptions {
    /**
     * The resolved catalogue. Built by `Runtime` rather than here because resolution is
     * asynchronous — a provider is consulted, and `Agent.create` is not the place to await one.
     */
    readonly tools?: ToolRegistry
}

export interface AgentSendOptions {
    readonly sessionKey?: string
    readonly signal?: AbortSignal
    readonly source?: string
    /** Supply a turn id to hand a client its handle before the turn starts. */
    readonly turnId?: string
}

export interface AgentDescription {
    readonly id: string
    readonly name: string
    readonly model: string
    readonly window: number
    readonly identityTokensApprox: number
    /** Every workspace file, in load order, whichever tier listed it. */
    readonly contextFiles: readonly string[]
    readonly workspace: readonly {
        readonly name: string
        readonly tier: string
        readonly editable: string
        readonly tokens: number
        readonly budget: number
    }[]
    readonly dialect: string
    readonly tools: readonly string[]
    /** Tier 3 entries and their gates. Empty when the manifest configures none. */
    readonly knowledge: readonly {
        readonly name: string
        readonly keywords: readonly string[]
        readonly tokens: number
    }[]
    /**
     * What the catalogue costs per turn, whichever channel carries it.
     *
     * Slot 1's blocks under NLT, plus the request's `tools` parameter under native. Summing only the
     * blocks would report a native catalogue as free, which is the reverse of the truth — it is the
     * same schemas, in a place the context budget cannot see.
     */
    readonly catalogueTokens: number
}

export class Agent {
    readonly id: string
    readonly manifest: AgentManifest
    readonly dir: string
    readonly window: number
    readonly roles: ResolvedRoles
    /** The workspace's `static` tier. Byte-stable for the lifetime of the agent. */
    readonly identity: string
    /** Tiers, budgets, and per-file editability. Slot 0's text is `workspace.static`. */
    readonly workspace: Workspace
    /** Non-fatal load findings, emitted as `agent.warning` by `Runtime`. */
    readonly warnings: readonly ErrorDetail[]
    readonly store: Store
    /** Resolved once, at load. Never searched, never extended at runtime. */
    readonly tools: ToolRegistry
    /** Tier 3, read once at load. `undefined` when the manifest configures none. */
    readonly knowledge: KnowledgeBase | undefined

    #bus: EventBus
    #toolRuntime: ToolRuntime | undefined
    /** Absolute path, or `(object)` for the programmatic path — which has no file to watch. */
    readonly #manifestPath: string
    /** `undefined` when there is no file. Compared after each turn, never polled. */
    #manifestMtime: number | undefined
    #manifestChangeReported = false

    private constructor(init: {
        loaded: LoadedManifest
        roles: ResolvedRoles
        workspace: Workspace
        warnings: readonly ErrorDetail[]
        bus: EventBus
        store: Store
        tools: ToolRegistry
        knowledge: KnowledgeBase | undefined
    }) {
        this.id = init.loaded.manifest.id
        this.manifest = init.loaded.manifest
        this.dir = init.loaded.dir
        this.window = init.loaded.window
        this.roles = init.roles
        this.workspace = init.workspace
        this.identity = init.workspace.static
        this.warnings = init.warnings
        this.#bus = init.bus
        this.store = init.store
        this.tools = init.tools
        this.knowledge = init.knowledge

        this.#manifestPath = init.loaded.path
        this.#manifestMtime = mtimeOf(init.loaded.path)

        // Configuration, never inference. Reading the model id to pick a dialect would mean behaviour
        // changing silently when someone edits `model.main.id`, and a per-model difference nobody can
        // reproduce is exactly the bug class decision 4.1's opt-in avoids.
        const dialect = this.manifest.tools.dialect === "native" ? nativeDialect : nltDialect

        // Resolved once, here, rather than per call: which file a note goes to is a property of the
        // manifest, and re-deriving it inside a handler would let it disagree with the tier the
        // model is actually shown in slot 3.
        const target = writeTarget(init.workspace)

        // The catalogue is rendered here, once, for the same reason the identity files are read
        // here: slot 1 is half of the cache-stable prefix. Rendering it per turn — or letting its
        // order depend on anything that varies — silently stops prompt caching working, and the only
        // symptom is the bill.
        //
        // `requestTools` is built here too, and not only for symmetry: under native it is where a slug
        // the wire format cannot carry is refused, and "at load" is the only useful place to refuse it.
        if (init.tools.size === 0) {
            this.#toolRuntime = undefined
        } else {
            const specs = init.tools.specs()
            const requestTools = dialect.requestTools(specs)
            this.#toolRuntime = {
                registry: init.tools,
                dialect,
                dir: init.loaded.dir,
                // The catalogue *and* what was left out of it. Both are settled at load, so both
                // belong to the cache-stable prefix; passing `notEnabled` per turn would be the one
                // way to make slot 1 vary and quietly stop prompt caching.
                blocks: dialect.renderCatalogue(specs, init.tools.notEnabled),
                ...(target === undefined ? {} : { writeTarget: target }),
                ...(requestTools === undefined ? {} : { requestTools }),
                wireTokens: requestTools === undefined ? 0 : nativeWireTokens(requestTools),
                observationMaxTokens: this.manifest.context.observationMaxTokens,
                untrustedOnMutate: this.manifest.tools.untrusted.onMutate,
                // Resolved once, here, so every turn of this agent is decided by the same rules.
                // The approver itself is supplied per run by whichever front end has a person
                // attached — absent for a schedule or a pipe, which is exactly when
                // `onNoApprover` matters.
                policy: this.manifest.tools.policy,
            }

            // Said at load, where it can be fixed. Without it, an agent pinning `exec` runs one
            // command per turn and has the second refused — correct behaviour under A5, and
            // indistinguishable from a broken runtime at the moment it happens.
            const onceOnly = onceOnlyTools({
                tools: specs,
                policy: this.manifest.tools.policy,
                onMutate: this.manifest.tools.untrusted.onMutate,
            })
            if (onceOnly.length > 0) {
                this.warnings = [...this.warnings, toolGatedAfterFirstUse(onceOnly)]
            }
        }
    }

    static create(
        loaded: LoadedManifest,
        bus: EventBus,
        store: Store,
        options: AgentCreateOptions = {},
    ): Agent {
        // Roles first: the workspace is rendered for the model in front of it, so the resolved
        // `promptStyle` has to exist before the files are read.
        const roles = resolveRoles(loaded.manifest, options)
        const style = roles.main.capabilities.promptStyle
        const { workspace, warnings } = readWorkspace(loaded, style)

        // Tier 3, read here for the same reason the workspace is: disk at boot, never per turn.
        // Rendered with the same style so the two cannot drift.
        const knowledgeConfig = loaded.manifest.knowledge
        const knowledge =
            knowledgeConfig === undefined
                ? undefined
                : loadKnowledge({
                      dir: isAbsolute(knowledgeConfig.dir)
                          ? knowledgeConfig.dir
                          : resolve(loaded.dir, knowledgeConfig.dir),
                      maxActive: knowledgeConfig.maxActive,
                      budget: knowledgeConfig.budget,
                      style,
                  })

        // Read here rather than threaded in from `Runtime.create`, which calls the same function for
        // the selections it builds. A warning emitted during boot lands in an empty room — nothing has
        // subscribed yet — so anything true for the whole session belongs on the agent, where a front
        // end still finds it after the banner has scrolled away.
        const providerWarnings = resolveProviders(loaded.manifest.tools).warnings

        return new Agent({
            loaded,
            roles,
            workspace,
            warnings: [...warnings, ...providerWarnings],
            bus,
            store,
            tools: options.tools ?? ToolRegistry.empty(),
            knowledge,
        })
    }

    /** Default session key for a surface with no natural one, such as the REPL. */
    static readonly DEFAULT_SESSION = "local:default"

    history(sessionKey = Agent.DEFAULT_SESSION): Promise<readonly ChatMessage[]> {
        return this.store.messages.history(this.id, sessionKey)
    }

    sessions(): Promise<readonly SessionSummary[]> {
        return this.store.sessions.list(this.id)
    }

    turns(sessionKey = Agent.DEFAULT_SESSION, limit?: number): Promise<readonly TurnRecord[]> {
        return this.store.turns.list(this.id, sessionKey, limit === undefined ? {} : { limit })
    }

    /** Drops history and turn records. Memory files on disk are untouched. */
    clearSession(sessionKey = Agent.DEFAULT_SESSION): Promise<void> {
        return this.store.sessions.clear(this.id, sessionKey)
    }

    /**
     * Run a turn to completion. Detached by design: the returned promise resolves when the turn
     * is done, and abandoning it does not stop the work.
     *
     * The turn row is written `running` *before* the model is called, so a turn is durable from
     * the moment it starts rather than from the moment it finishes. That ordering is what lets a
     * crash be told apart from a turn that never began.
     */
    async send(input: string, options: AgentSendOptions = {}): Promise<TurnResult> {
        const sessionKey = options.sessionKey ?? Agent.DEFAULT_SESSION
        const turnId = options.turnId ?? newTurnId()
        const source = options.source ?? "library"

        await this.store.sessions.ensure(this.id, sessionKey)
        const history = await this.store.messages.history(this.id, sessionKey)

        await this.store.turns.start({
            turnId,
            agentId: this.id,
            sessionKey,
            source,
            input,
        })

        const active = this.knowledge === undefined ? [] : activateKnowledge(input, this.knowledge)

        const result = await runTurn({
            agentId: this.id,
            sessionKey,
            turnId,
            input,
            history,
            identity: this.identity,
            // Read at load, like `static`. The tier's *position* is what Phase 3.5's first half
            // delivers — after the cache breakpoint, so that a write leaves slots 0 and 1
            // byte-identical. Re-reading it mid-session lands with the write path that changes it,
            // since a re-read with nothing writing is a filesystem call per turn for no observable
            // difference.
            ...(this.workspace.examples === "" ? {} : { examples: this.workspace.examples }),
            ...(this.workspace.volatile === "" ? {} : { volatile: this.workspace.volatile }),
            ...(this.workspace.reminder === "" ? {} : { reminder: this.workspace.reminder }),
            // Activated once per turn against the input — the selection is a function of the turn,
            // so it is stable across the steps within one and re-selecting per step would let two
            // steps of the same turn argue from different reference material.
            ...(active.length === 0
                ? {}
                : {
                      knowledge: active.map((entry) => ({
                          name: entry.name,
                          content: entry.content,
                      })),
                  }),
            role: this.roles.main,
            window: this.window,
            reserveOutput: this.manifest.context.reserveOutput,
            limits: {
                maxSteps: this.manifest.limits.maxSteps,
                turnTimeoutMs: this.manifest.limits.turnTimeoutMs,
                toolTimeoutMs: this.manifest.limits.toolTimeoutMs,
                maxParallelTools: this.manifest.limits.maxParallelTools,
            },
            ...(this.#toolRuntime === undefined ? {} : { tools: this.#toolRuntime }),
            bus: this.#bus,
            source,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        })

        // The turn row is the audit trail and records every outcome, including a failure and its
        // hint. `appended` is the conversation, and is empty on failure — a turn that errored
        // must not leave a half-answer in the history the next turn will be conditioned on.
        await this.store.turns.finish(turnId, {
            status: result.reason,
            text: result.text,
            reasoning: result.reasoning,
            steps: result.steps,
            promptTokens: result.tokens.prompt,
            outputTokens: result.tokens.output,
            durationMs: result.durationMs,
            ...(result.error === undefined
                ? {}
                : {
                      errorCode: result.error.code,
                      errorMessage: result.error.message,
                      errorHint: result.error.hint,
                  }),
        })

        if (result.appended.length > 0) {
            await this.store.messages.append(this.id, sessionKey, result.appended, turnId)
        }

        this.#reportManifestChange()
        return result
    }

    /**
     * Say so, once, when the manifest on disk stops matching the one this process is running.
     *
     * `config_set` writes `agent.yaml` and the change takes effect at the next start. The tool says so
     * in its observation, and relying on that means relying on the model to relay it — which it did in
     * testing and will not always. A configuration change that silently does not apply is precisely
     * the shape rule 8 exists to prevent, so the runtime states it rather than delegating it.
     *
     * Here rather than in a front end because it is a fact about the agent, not about a terminal: a
     * server or a scheduled run needs it just as much. Latched, because it is one piece of news and
     * repeating it every turn is how a person learns to skim past it.
     */
    #reportManifestChange(): void {
        if (this.#manifestMtime === undefined || this.#manifestChangeReported) return
        let now: number
        try {
            now = statSync(this.#manifestPath).mtimeMs
        } catch {
            // Moved or deleted mid-session. Not this method's business to report — the next boot will
            // fail loudly and name the path, which is the right place for it.
            return
        }
        if (now === this.#manifestMtime) return
        this.#manifestChangeReported = true
        this.#bus.emit(
            "agent.warning",
            {
                code: "manifest_changed",
                message: `This agent's configuration has been edited since it started: ${this.#manifestPath}`,
                hint: "The running agent still has the settings it booted with — a tool it was just given is not available in this conversation. Restart it to pick the change up.",
                field: "agent.yaml",
            },
            { agentId: this.id },
        )
    }

    /**
     * A filter for one turn's worth of streamed deltas.
     *
     * Every surface that shows tokens as they arrive needs this, because with a line-oriented dialect
     * the invocation *is* text: printing deltas straight through puts `ACTION:` and `END` in front of
     * the person and runs them into the answer. Dialect selection stays here — config, never
     * inference — so a caller asks for a filter rather than choosing one.
     */
    streamFilter(): StreamFilter {
        return this.#toolRuntime?.dialect.createStreamFilter() ?? passThroughFilter()
    }

    describe(): AgentDescription {
        return {
            id: this.id,
            name: this.manifest.name ?? this.id,
            model: this.manifest.model.main.id,
            window: this.window,
            identityTokensApprox: Math.ceil(this.identity.length / 3.8),
            contextFiles: this.workspace.files.map((file) => file.name),
            workspace: this.workspace.files.map((file) => ({
                name: file.name,
                tier: file.tier,
                editable: file.editable,
                tokens: file.tokens,
                budget: file.budget,
            })),
            dialect: this.#toolRuntime?.dialect.id ?? this.manifest.tools.dialect,
            tools: this.tools.specs().map((spec) => spec.slug),
            knowledge: (this.knowledge?.entries ?? []).map((entry) => ({
                name: entry.name,
                keywords: entry.keywords,
                tokens: entry.tokens,
            })),
            catalogueTokens:
                (this.#toolRuntime?.blocks ?? []).reduce((sum, block) => sum + block.tokens, 0) +
                (this.#toolRuntime?.wireTokens ?? 0),
        }
    }
}

/**
 * Plan, gate, and load the workspace: the deprecated-alias resolution, the soul gate, and the
 * tiered load, in that order.
 *
 * Exported because `validate` calls it too. The soul gate and the alias conflict first lived only
 * on this path, which is the asymmetry the rule guard already taught: a check only `run` performs
 * is a check `validate` disagrees with. The rule budget is deliberately *not* applied here — each
 * caller applies `ruleBudgetFailure` under its own `onExceed`.
 */
export function resolveWorkspace(
    loaded: LoadedManifest,
    style: PromptStyle,
): { workspace: Workspace; warnings: ErrorDetail[] } {
    const { context } = loaded.manifest
    const plan = planWorkspace(context, loaded.dir)
    const warnings = [...plan.warnings]

    // The soul gate runs against the model actually configured, and whichever file wins — the full
    // document, the hand-edited compact one, or nothing — loads as an ordinary static ref, ahead of
    // the declared list: identity leads. A second loading path for souls would be the one nobody
    // tests.
    let refs: readonly WorkspaceFileRef[] = plan.refs
    if (context.soul !== undefined) {
        const workspaceDir = isAbsolute(context.workspace)
            ? context.workspace
            : resolve(loaded.dir, context.workspace)
        const soul = planSoul(
            context.soul,
            { id: loaded.manifest.model.main.id, window: loaded.window },
            workspaceDir,
        )
        warnings.push(...soul.warnings)
        if (soul.ref !== undefined) refs = [soul.ref, ...refs]
    }

    const workspace = loadWorkspace({ refs, budgets: context.budgets, style })
    return { workspace, warnings }
}

/**
 * `resolveWorkspace` plus this agent's `onExceed` applied to the rule budget.
 *
 * Counted across static and reminder together, because the model does not know they came from
 * different files. `volatile` is excluded: it holds facts about the person, not obligations.
 */
function readWorkspace(
    loaded: LoadedManifest,
    style: PromptStyle,
): { workspace: Workspace; warnings: ErrorDetail[] } {
    const { workspace, warnings } = resolveWorkspace(loaded, style)

    const failure = ruleBudgetFailure(workspace, loaded.manifest.context.rules)
    if (failure !== undefined) {
        // `warn` is the escape for a miscounted line, and it still says so. Silence is not an
        // option here: an author over budget and unaware of it is the case the guard exists for.
        if (loaded.manifest.context.rules.onExceed === "fail") throw failure
        return { workspace, warnings: [...warnings, failure.toDetail()] }
    }

    return { workspace, warnings }
}
