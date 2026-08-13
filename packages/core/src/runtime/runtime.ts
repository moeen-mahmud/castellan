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

import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { BRAND } from "../brand.ts"
import { HarnessError } from "../errors.ts"
import { EventBus } from "../events/bus.ts"
import type { EnvSource } from "../manifest/env.ts"
import { type LoadedManifest, loadManifest, loadManifestFromObject } from "../manifest/load.ts"
import type { FetchLike } from "../model/provider.ts"
import { TurnStreams } from "../store/buffer.ts"
import { SqliteStore } from "../store/sqlite/store.ts"
import type { Store } from "../store/store.ts"
import { ToolRegistry } from "../tools/registry.ts"
import { Agent } from "./agent.ts"

export type AgentSource = string | Record<string, unknown>

/**
 * Where sessions live.
 *
 * - a path — a SQLite file, created along with its parent directory
 * - `":memory:"` — anonymous, gone at exit
 * - a `Store` — an already-open store the caller owns and will close itself
 * - omitted — `":memory:"`
 *
 * **Persistence is opt-in.** Defaulting to a file would mean `Runtime.create` creates a
 * directory in the caller's working directory as a side effect of being constructed, which is
 * not a library's business to do uninvited. The CLI passes `defaultStorePath()` because a REPL
 * genuinely wants history across restarts; an embedder decides for itself. Either way
 * `store.ready` reports the location, so which one is in use is observable rather than guessed.
 */
export type StoreSource = string | Store

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
    readonly store?: StoreSource
}

export interface BootReport {
    /** Time inside `Runtime.create`. */
    readonly bootMs: number
    /** Time since process start — what the sub-second claim is actually about. */
    readonly processMs: number
    readonly phases: Record<string, number>
}

/** Default database location, derived from the brand so a rename moves it. */
export function defaultStorePath(cwd: string = process.cwd()): string {
    return resolve(cwd, BRAND.stateDir, "store.db")
}

export class Runtime {
    readonly runtimeId: string
    readonly bus: EventBus
    readonly boot: BootReport
    readonly store: Store
    /** Per-turn event buffers, for reattaching a client to a turn already in flight. */
    readonly streams: TurnStreams

    #agents = new Map<string, Agent>()
    #stopped = false
    /** False when the caller passed an already-open store, which stays theirs to close. */
    #ownsStore: boolean

    private constructor(init: {
        runtimeId: string
        bus: EventBus
        boot: BootReport
        store: Store
        streams: TurnStreams
        ownsStore: boolean
    }) {
        this.runtimeId = init.runtimeId
        this.bus = init.bus
        this.boot = init.boot
        this.store = init.store
        this.streams = init.streams
        this.#ownsStore = init.ownsStore
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
        const markAsync = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
            const from = performance.now()
            try {
                return await work()
            } finally {
                phases[name] = Math.round((performance.now() - from) * 100) / 100
            }
        }

        // Buffering starts before anything is emitted, so an early turn cannot be half-recorded.
        const streams = new TurnStreams()
        streams.listen(bus)

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

        // 2. Store: open the file, run pending migrations, reap turns a dead process left running.
        //    Disk only — a database file is not network I/O, so this belongs before readiness.
        const { store, ownsStore } = await markAsync("store", () => openStore(options))
        const reaped = await store.turns.reapRunning("the process exited before the turn finished")

        // A caller-supplied store need not be the SQLite one — a plugin driver reports no
        // migration numbers, and inventing some would misreport rather than under-report.
        const sqlite = store instanceof SqliteStore ? store : undefined
        bus.emit("store.ready", {
            location: store.location,
            driver: sqlite?.driver ?? "node",
            from: sqlite?.migrations.from ?? 0,
            to: sqlite?.migrations.to ?? 0,
            applied: [...(sqlite?.migrations.applied ?? [])],
            reaped: [...reaped],
        })

        // 3. Tools: resolve the catalogue from the manifest. Local tools resolve from memory, so
        //    this touches nothing. A network provider resolves from its on-disk cache here and
        //    refreshes after readiness — hard rule 4 has no exception for "just this one call".
        const registries = await markAsync("tools", () =>
            Promise.all(
                loaded.map((entry: LoadedManifest) =>
                    ToolRegistry.create({
                        pinned: entry.manifest.tools.pinned,
                        local: entry.manifest.tools.local,
                        budget: entry.manifest.tools.budget,
                    }),
                ),
            ),
        )

        // 4. Agents: identity files, capability resolution, provider construction. Still no network
        //    — constructing a provider allocates no socket.
        const agents = mark("agents", () =>
            loaded.map((entry: LoadedManifest, index) =>
                Agent.create(entry, bus, store, {
                    ...(registries[index] === undefined ? {} : { tools: registries[index] }),
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
            store,
            streams,
            ownsStore,
        })

        for (const agent of agents) {
            if (runtime.#agents.has(agent.id)) {
                throw new Error(
                    `Two agents share the id "${agent.id}". ` +
                        "hint: agent ids are used in session keys and API paths, so they must be unique within a runtime.",
                )
            }
            runtime.#agents.set(agent.id, agent)

            // Whatever the budget trimmed, and whatever tool arrived without negative guidance, is
            // said out loud here. A catalogue quietly smaller than the manifest asked for is the
            // exact failure the loud resolution path exists to prevent.
            for (const warning of agent.tools.warnings) {
                bus.emit("agent.warning", warning, { agentId: agent.id })
            }

            bus.emit(
                "agent.loaded",
                {
                    tools: agent.tools.size,
                    skills: 0,
                    schedules: 0,
                    model: agent.manifest.model.main.id,
                },
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

        // In-flight turns are deliberately not cancelled here — a turn ends because it finished or
        // because someone stopped it, never because the process was asked to wind down politely.
        // Their rows stay `running` and the next boot reaps them, which is the honest record of
        // what happened: the process went away mid-generation.
        this.streams.close()

        // Channels and schedules arrive in later phases. A caller-supplied store is not closed
        // here: it was open before this runtime existed and may outlive it.
        if (this.#ownsStore) await this.store.close()
    }
}

function envOptions(options: RuntimeOptions): { env?: EnvSource } {
    return options.env === undefined ? {} : { env: options.env }
}

/**
 * Resolve the `store` option to an open store.
 *
 * The parent directory is created because the alternative — refusing to boot until the operator
 * runs `mkdir` — is a worse first-run experience for no safety gain. A path that cannot be
 * created is still a hard failure naming the path.
 */
async function openStore(options: RuntimeOptions): Promise<{ store: Store; ownsStore: boolean }> {
    const source = options.store

    if (typeof source === "object") return { store: source, ownsStore: false }

    const path =
        source === undefined || source === ":memory:"
            ? ":memory:"
            : isAbsolute(source)
              ? source
              : resolve(options.dir ?? process.cwd(), source)

    if (path !== ":memory:") {
        const dir = dirname(path)
        try {
            mkdirSync(dir, { recursive: true })
        } catch (cause) {
            throw new HarnessError({
                code: "store_dir_uncreatable",
                message: `Cannot create the directory ${dir} for the session database.`,
                hint: `Check permissions on the parent directory, or point Runtime's store option at a writable path. In a read-only container, use ":memory:" and accept that sessions do not survive a restart.`,
                cause,
            })
        }
    }

    return { store: await SqliteStore.open({ path }), ownsStore: true }
}
