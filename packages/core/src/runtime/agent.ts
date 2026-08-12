/**
 * A single agent: a manifest plus its resolved model roles, identity, and session state.
 *
 * Identity is read from `context.files` **once, at load**, and held as one string. That is not
 * an optimisation. Slot 0 is half of the cache-stable prefix, and re-reading the files per turn
 * would let an editor save change the prefix mid-session, quietly destroying prompt caching
 * with no error and no symptom other than the bill.
 *
 * Session history is in memory here. Phase 2 moves it into SQLite behind the same interface;
 * nothing outside this class knows where it lives.
 */

import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { EventBus } from "../events/bus.ts"
import { runTurn, type TurnResult } from "../loop/turn.ts"
import type { LoadedManifest } from "../manifest/load.ts"
import type { AgentManifest } from "../manifest/schema.ts"
import type { ChatMessage } from "../model/provider.ts"
import { type ResolvedRoles, type ResolveRolesOptions, resolveRoles } from "../model/roles.ts"

export interface AgentSendOptions {
    readonly sessionKey?: string
    readonly signal?: AbortSignal
    readonly source?: string
}

export interface AgentDescription {
    readonly id: string
    readonly name: string
    readonly model: string
    readonly window: number
    readonly identityTokensApprox: number
    readonly contextFiles: readonly string[]
    readonly sessions: number
}

export class Agent {
    readonly id: string
    readonly manifest: AgentManifest
    readonly dir: string
    readonly window: number
    readonly roles: ResolvedRoles
    /** Concatenated `context.files`. Byte-stable for the lifetime of the agent. */
    readonly identity: string

    #bus: EventBus
    #sessions = new Map<string, ChatMessage[]>()

    private constructor(init: {
        loaded: LoadedManifest
        roles: ResolvedRoles
        identity: string
        bus: EventBus
    }) {
        this.id = init.loaded.manifest.id
        this.manifest = init.loaded.manifest
        this.dir = init.loaded.dir
        this.window = init.loaded.window
        this.roles = init.roles
        this.identity = init.identity
        this.#bus = init.bus
    }

    static create(loaded: LoadedManifest, bus: EventBus, options: ResolveRolesOptions = {}): Agent {
        const identity = readIdentity(loaded)
        const roles = resolveRoles(loaded.manifest, options)
        return new Agent({ loaded, roles, identity, bus })
    }

    /** Default session key for a surface with no natural one, such as the REPL. */
    static readonly DEFAULT_SESSION = "local:default"

    history(sessionKey = Agent.DEFAULT_SESSION): readonly ChatMessage[] {
        return this.#sessions.get(sessionKey) ?? []
    }

    clearSession(sessionKey = Agent.DEFAULT_SESSION): void {
        this.#sessions.delete(sessionKey)
    }

    /**
     * Run a turn to completion. Detached by design: the returned promise resolves when the turn
     * is done, and abandoning it does not stop the work.
     */
    async send(input: string, options: AgentSendOptions = {}): Promise<TurnResult> {
        const sessionKey = options.sessionKey ?? Agent.DEFAULT_SESSION
        const history = this.#sessions.get(sessionKey) ?? []

        const result = await runTurn({
            agentId: this.id,
            sessionKey,
            input,
            history,
            identity: this.identity,
            role: this.roles.main,
            window: this.window,
            reserveOutput: this.manifest.context.reserveOutput,
            limits: {
                maxSteps: this.manifest.limits.maxSteps,
                turnTimeoutMs: this.manifest.limits.turnTimeoutMs,
            },
            bus: this.#bus,
            source: options.source ?? "library",
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        })

        if (result.appended.length > 0) {
            this.#sessions.set(sessionKey, [...history, ...result.appended])
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
            sessions: this.#sessions.size,
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
