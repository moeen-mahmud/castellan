/**
 * One process, N agents. Owns the event bus and, from Phase 8, the single timer.
 *
 * **No network I/O before `runtime.ready`.** This is the rule the project exists for: the
 * runtime being replaced blocks roughly four minutes on network calls during hook
 * initialisation. Booting here reads files and the environment, and nothing else. The first
 * packet leaves when a turn runs or, from Phase 4, when channels connect *after* readiness.
 *
 * Hosting N agents rather than one is a library decision, not a deployment one. A platform that
 * runs one agent per container is welcome to; forcing 1:1 would make the embedded case
 * impossible.
 */

import { EventBus } from "../events/bus.ts"
import type { EnvSource } from "../manifest/env.ts"
import { type LoadedManifest, loadManifest, loadManifestFromObject } from "../manifest/load.ts"
import type { FetchLike } from "../model/provider.ts"
import { Agent } from "./agent.ts"

export type AgentSource = string | Record<string, unknown>

export interface RuntimeOptions {
    /** Manifest paths, or already-parsed manifest objects. */
    readonly agents: readonly AgentSource[]
    readonly runtimeId?: string
    readonly env?: EnvSource
    readonly fetch?: FetchLike
    /** Emit per-token `model.chunk` events. Off by default; the REPL turns it on. */
    readonly emitChunks?: boolean
    /** Bring your own bus, to subscribe before boot events fire. */
    readonly bus?: EventBus
    /** Directory for relative paths in object-form manifests. Defaults to `process.cwd()`. */
    readonly dir?: string
}

export interface BootReport {
    /** Time inside `Runtime.create`. */
    readonly bootMs: number
    /** Time since process start — what the sub-second claim is actually about. */
    readonly processMs: number
    readonly phases: Record<string, number>
}

export class Runtime {
    readonly runtimeId: string
    readonly bus: EventBus
    readonly boot: BootReport

    #agents = new Map<string, Agent>()
    #stopped = false

    private constructor(init: { runtimeId: string; bus: EventBus; boot: BootReport }) {
        this.runtimeId = init.runtimeId
        this.bus = init.bus
        this.boot = init.boot
    }

    static async create(options: RuntimeOptions): Promise<Runtime> {
        const startedAt = performance.now()
        const runtimeId = options.runtimeId ?? `rt_${Date.now().toString(36)}`
        const bus =
            options.bus ??
            new EventBus({
                runtimeId,
                ...(options.emitChunks === undefined ? {} : { emitChunks: options.emitChunks }),
            })

        const phases: Record<string, number> = {}
        const mark = <T>(name: string, work: () => T): T => {
            const from = performance.now()
            try {
                return work()
            } finally {
                phases[name] = Math.round((performance.now() - from) * 100) / 100
            }
        }

        // 1. Manifests: file reads, env expansion, schema, rules. No network.
        const loaded = mark("manifest", () =>
            options.agents.map((source) =>
                typeof source === "string"
                    ? loadManifest(source, envOptions(options))
                    : loadManifestFromObject(source, {
                          ...envOptions(options),
                          dir: options.dir ?? process.cwd(),
                      }),
            ),
        )

        // 2. Agents: identity files, capability resolution, provider construction. Still no network
        //    — constructing a provider allocates no socket.
        const agents = mark("agents", () =>
            loaded.map((entry: LoadedManifest) =>
                Agent.create(entry, bus, {
                    // The manifest's live env, not the ambient one: it layers the real environment
                    // over any `.env` beside the manifest, which is what the load-time key check
                    // validated against. Passing `process.env` here instead is how `validate` and
                    // `run` end up disagreeing about whether a key exists.
                    env: entry.env,
                    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                    onRetry: (info) => {
                        bus.emit("model.retry", info, { agentId: entry.manifest.id })
                    },
                }),
            ),
        )

        const runtime = new Runtime({
            runtimeId,
            bus,
            boot: { bootMs: 0, processMs: 0, phases },
        })

        for (const agent of agents) {
            if (runtime.#agents.has(agent.id)) {
                throw new Error(
                    `Two agents share the id "${agent.id}". ` +
                        "hint: agent ids are used in session keys and API paths, so they must be unique within a runtime.",
                )
            }
            runtime.#agents.set(agent.id, agent)
            bus.emit(
                "agent.loaded",
                { tools: 0, skills: 0, schedules: 0, model: agent.manifest.model.main.id },
                { agentId: agent.id },
            )
        }

        const bootMs = Math.round((performance.now() - startedAt) * 100) / 100
        const report: BootReport = {
            bootMs,
            processMs: Math.round(performance.now() * 100) / 100,
            phases,
        }
        Object.assign(runtime.boot, report)

        bus.emit("runtime.ready", {
            bootMs: report.bootMs,
            processMs: report.processMs,
            phases: report.phases,
            agents: agents.length,
        })

        return runtime
    }

    get ready(): boolean {
        return !this.#stopped
    }

    agent(id: string): Agent {
        const agent = this.#agents.get(id)
        if (agent === undefined) {
            const known = [...this.#agents.keys()].join(", ") || "(none)"
            throw new Error(`No agent with id "${id}". hint: this runtime hosts: ${known}.`)
        }
        return agent
    }

    list(): readonly Agent[] {
        return [...this.#agents.values()]
    }

    async stop(reason = "requested"): Promise<void> {
        if (this.#stopped) return
        this.#stopped = true
        this.bus.emit("runtime.stopping", { reason })
        // Channels, schedules, and the store arrive in later phases; there is nothing to close yet.
        // In-flight turns are deliberately not cancelled here — a turn ends because it finished or
        // because someone stopped it, never because the process was asked to wind down politely.
    }
}

function envOptions(options: RuntimeOptions): { env?: EnvSource } {
    return options.env === undefined ? {} : { env: options.env }
}
