/**
 * A single agent: a manifest plus its resolved model roles, identity, and persisted sessions.
 *
 * Identity is read from `context.files` **once, at load**, and held as one string. That is not
 * an optimisation. Slot 0 is half of the cache-stable prefix, and re-reading the files per turn
 * would let an editor save change the prefix mid-session, quietly destroying prompt caching
 * with no error and no symptom other than the bill.
 *
 * Session history lives in the store, and there is no in-memory fallback. A second code path
 * for "no store configured" would be the one exercised by every test and none of production —
 * so the store is a required constructor argument and `Runtime` always supplies one, defaulting
 * to an in-memory SQLite database rather than to a different implementation.
 */

import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { EventBus } from "../events/bus.ts"
import { newTurnId } from "../loop/ids.ts"
import { runTurn, type ToolRuntime, type TurnResult } from "../loop/turn.ts"
import type { LoadedManifest } from "../manifest/load.ts"
import type { AgentManifest } from "../manifest/schema.ts"
import type { ChatMessage } from "../model/provider.ts"
import { type ResolvedRoles, type ResolveRolesOptions, resolveRoles } from "../model/roles.ts"
import type { SessionSummary, Store, TurnRecord } from "../store/store.ts"
import { nltDialect } from "../tools/dialect/nlt.ts"
import { ToolRegistry } from "../tools/registry.ts"

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
    readonly contextFiles: readonly string[]
    readonly dialect: string
    readonly tools: readonly string[]
    /** Slot 1's cost. Paid on every turn, so it is worth being able to see it. */
    readonly catalogueTokens: number
}

export class Agent {
    readonly id: string
    readonly manifest: AgentManifest
    readonly dir: string
    readonly window: number
    readonly roles: ResolvedRoles
    /** Concatenated `context.files`. Byte-stable for the lifetime of the agent. */
    readonly identity: string
    readonly store: Store
    /** Resolved once, at load. Never searched, never extended at runtime. */
    readonly tools: ToolRegistry

    #bus: EventBus
    #toolRuntime: ToolRuntime | undefined

    private constructor(init: {
        loaded: LoadedManifest
        roles: ResolvedRoles
        identity: string
        bus: EventBus
        store: Store
        tools: ToolRegistry
    }) {
        this.id = init.loaded.manifest.id
        this.manifest = init.loaded.manifest
        this.dir = init.loaded.dir
        this.window = init.loaded.window
        this.roles = init.roles
        this.identity = init.identity
        this.#bus = init.bus
        this.store = init.store
        this.tools = init.tools

        // The catalogue is rendered here, once, for the same reason the identity files are read
        // here: slot 1 is half of the cache-stable prefix. Rendering it per turn — or letting its
        // order depend on anything that varies — silently stops prompt caching working, and the only
        // symptom is the bill.
        const dialect = nltDialect
        this.#toolRuntime =
            init.tools.size === 0
                ? undefined
                : {
                      registry: init.tools,
                      dialect,
                      blocks: dialect.renderCatalogue(init.tools.specs()),
                      observationMaxTokens: this.manifest.context.observationMaxTokens,
                  }
    }

    static create(
        loaded: LoadedManifest,
        bus: EventBus,
        store: Store,
        options: AgentCreateOptions = {},
    ): Agent {
        const identity = readIdentity(loaded)
        const roles = resolveRoles(loaded.manifest, options)
        return new Agent({
            loaded,
            roles,
            identity,
            bus,
            store,
            tools: options.tools ?? ToolRegistry.empty(),
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

        const result = await runTurn({
            agentId: this.id,
            sessionKey,
            turnId,
            input,
            history,
            identity: this.identity,
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

        return result
    }

    describe(): AgentDescription {
        return {
            id: this.id,
            name: this.manifest.name ?? this.id,
            model: this.manifest.model.main.id,
            window: this.window,
            identityTokensApprox: Math.ceil(this.identity.length / 3.8),
            contextFiles: this.manifest.context.files,
            dialect: this.#toolRuntime?.dialect.id ?? this.manifest.tools.dialect,
            tools: this.tools.specs().map((spec) => spec.slug),
            catalogueTokens: (this.#toolRuntime?.blocks ?? []).reduce(
                (sum, block) => sum + block.tokens,
                0,
            ),
        }
    }
}

/**
 * Read and concatenate `context.files` in declared order. Existence and readability were
 * already checked by `validateManifest`, so a failure here is a race with the filesystem
 * rather than a configuration error — and it is still loud.
 */
function readIdentity(loaded: LoadedManifest): string {
    const parts: string[] = []
    for (const file of loaded.manifest.context.files) {
        const path = isAbsolute(file) ? file : resolve(loaded.dir, file)
        parts.push(readFileSync(path, "utf8").trimEnd())
    }
    return parts.join("\n\n")
}
