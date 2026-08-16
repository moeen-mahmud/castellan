/**
 * The `serve` command: `<binary> serve <manifest> [--port N] [--host H]`.
 *
 * Boots a runtime with channels started, binds the HTTP surface, and stays up until interrupted.
 * The only long-running command in the binary, and the only one that opens a listening socket.
 *
 * **Channels start here and nowhere else.** `run` constructs the same runtime with
 * `startChannels: false`, because a REPL that silently began answering Telegram messages while you
 * typed at it would be a surprise, and a one-shot `run --input` that opened a long-poll would hang
 * on exit. The flag decides *whether*, never *when* — either way nothing connects before
 * `runtime.ready`.
 *
 * No Ink. A server writes lines to stdout and is very often not attached to a terminal at all; a
 * rendering framework on this path would cost more than the whole command and produce escape codes
 * in a log file.
 */

import { BRAND, EventBus, HarnessError, loadManifest, Runtime } from "@castellan/core"
import { serve } from "@castellan/server"
import { ambientEnv } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { CHANNEL_IDS, CHANNELS, PROVIDER_IDS, TOOL_PROVIDERS } from "#lib/providers"

export interface ServeOptions {
    readonly manifestPath: string
    readonly port?: number
    readonly host?: string
    readonly store?: string
    readonly json?: boolean
}

export async function serveCommand(options: ServeOptions): Promise<number> {
    const env = ambientEnv([options.manifestPath])
    const loaded = loadManifest(options.manifestPath, {
        knownProviders: PROVIDER_IDS,
        knownChannels: CHANNEL_IDS,
        env,
    })

    const config = loaded.manifest.server
    // Flags win over the manifest: the manifest is the deployment's intent and a flag is this
    // invocation's. `--port 0` is honoured — it means "any free port", which a test wants.
    const port = options.port ?? config.port
    const host = options.host ?? config.host
    // `loaded.env`, never `env`. `ambientEnv` returns the *process* environment — the agent's own
    // `.env` beside the manifest is layered in by `loadManifest`, which is why every other
    // credential in this runtime is read from the manifest's live env. Reading the ambient one
    // here meant a token sitting in the agent's `.env` was invisible, and the banner said
    // "unauthenticated" while the file plainly had it. Same mistake `Agent.create` documents:
    // the manifest's live env, not the ambient one.
    const token = loaded.env[config.tokenEnv]

    // Subscribed BEFORE the runtime exists, which is what the `bus` option is for. Channels start
    // inside `Runtime.create` — after `runtime.ready`, but still inside the call — so a listener
    // attached afterwards misses every status and error they emitted on the way up. Same trap as
    // the boot warnings that landed in an empty room for weeks: anything true during boot has to be
    // subscribed to before boot.
    const bus = new EventBus({ runtimeId: `rt_${Date.now().toString(36)}` })
    if (options.json !== true) {
        bus.on("agent.channel.status", (event) => {
            const data = event.data as { channelId: string; status: string; detail?: string }
            process.stdout.write(
                `  ${data.channelId}: ${data.status}${data.detail === undefined ? "" : ` — ${data.detail}`}\n`,
            )
        })
        bus.on("agent.channel.error", (event) => {
            const data = event.data as { channelId: string; message: string; hint: string }
            process.stderr.write(`  ${data.channelId}: ${data.message}\n    hint: ${data.hint}\n`)
        })
        // The one thing a person watching a bot most wants to see, and it is otherwise only in the
        // event stream: who was refused, and the line that would let them in.
        bus.on("agent.channel.rejected", (event) => {
            const data = event.data as { channelId: string; reason: string; detail: string }
            process.stdout.write(`  ${data.channelId}: ${data.reason} — ${data.detail}\n`)
        })
    }

    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        env,
        bus,
        toolProviders: TOOL_PROVIDERS,
        channels: CHANNELS,
        // The one call site that passes this. See the file comment.
        startChannels: true,
        ...(options.store === undefined ? {} : { store: options.store }),
    })

    let running: Awaited<ReturnType<typeof serve>>
    try {
        running = await serve({
            runtime,
            host,
            port,
            ...(token === undefined || token === "" ? {} : { token }),
        })
    } catch (error) {
        // The runtime is already up; leaving it running after a failed bind would hold the store
        // open and keep channels polling with nothing serving.
        await runtime.stop("server failed to bind")
        if (error instanceof HarnessError) throw error
        throw new HarnessError({
            code: "server_bind_failed",
            message: `Could not bind ${host}:${port}: ${
                error instanceof Error ? error.message : String(error)
            }`,
            hint: "Another process is probably on that port. Pass --port, or set server.port in the manifest.",
            cause: error,
        })
    }

    const agents = runtime.list()
    // The port is bound now, which `Runtime.create` could not know — it returns before `serve` runs.
    // Told before the first turn, so slot 2 says "on" rather than "enabled but not listening".
    for (const agent of agents) agent.reportRuntimeState({ serverListening: true })

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({
                url: running.url,
                websocket: running.websocket,
                authenticated: token !== undefined && token !== "",
                agents: agents.map((agent) => ({
                    id: agent.id,
                    channels: runtime.channels.statusOf(agent.id),
                })),
            })}\n`,
        )
    } else {
        process.stdout.write(`${BRAND.name} serving on ${running.url}\n`)
        for (const agent of agents) {
            const channels = runtime.channels.statusOf(agent.id)
            const suffix =
                channels.length === 0
                    ? "no channels"
                    : channels.map((c) => `${c.id} (${c.type})`).join(", ")
            process.stdout.write(`  ${agent.id} — ${suffix}\n`)
        }
        if (token === undefined || token === "") {
            // Loopback-only, or `serve` would have refused to bind. Said out loud anyway: someone
            // who later changes the host needs to know the token was never set.
            process.stdout.write(
                `  unauthenticated — loopback only. Set ${config.tokenEnv} to bind a public host.\n`,
            )
        }
        if (!running.websocket) {
            process.stdout.write("  /v1/ws unavailable under Node — SSE and HTTP are unaffected.\n")
        }
        process.stdout.write("  ctrl-c to stop\n")
    }

    await waitForShutdown()

    process.stdout.write("stopping\n")
    await running.stop()
    await runtime.stop("interrupted")
    return EXIT_OK
}

/**
 * Resolve on SIGINT or SIGTERM.
 *
 * Both, because SIGINT is a person at a terminal and SIGTERM is an orchestrator, and a container
 * that ignored SIGTERM would be killed after its grace period — mid-delivery, which is the one
 * moment the outbox's recovery path exists to survive and would rather not exercise.
 */
function waitForShutdown(): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            process.off("SIGINT", finish)
            process.off("SIGTERM", finish)
            resolve()
        }
        process.once("SIGINT", finish)
        process.once("SIGTERM", finish)
    })
}

/** Re-exported for the boundaries test, which asserts this module imports no renderer. */
export const SERVE_EXIT_FAILURE = EXIT_FAILURE
