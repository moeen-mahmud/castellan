/**
 * The interactive session.
 *
 * Two things here are more delicate than they look.
 *
 * **Ctrl-C cancels the turn, not the process.** A turn in flight is aborted and the prompt comes
 * back; Ctrl-C at an idle prompt exits. Both `readline`'s SIGINT event and the process-level
 * signal are handled, because which one fires depends on whether readline currently owns the
 * TTY — and during a streaming turn it does not.
 *
 * **Cancellation must not produce an unhandled rejection.** `Agent.send` resolves rather than
 * rejects on abort, so there is exactly one await to reason about and no floating promise
 * anywhere in this file.
 */

import { createInterface, type Interface } from "node:readline"
import {
    Agent,
    type AnyEvent,
    BRAND,
    defaultStorePath,
    type Runtime,
    Runtime as RuntimeClass,
    VERSION,
} from "@castellan/core"

export interface ReplOptions {
    readonly manifestPath: string
    readonly sessionKey?: string
    /** Run a single turn with this input and exit. Non-interactive. */
    readonly once?: string
    /** Session database. Defaults to `<stateDir>/store.db` under the working directory. */
    readonly store?: string
    /** Keep everything in memory. Nothing is written and nothing survives the process. */
    readonly ephemeral?: boolean
    readonly quiet?: boolean
    readonly showReasoning?: boolean
}

const EXIT_WORDS = new Set(["/exit", "/quit", ":q"])

export async function runRepl(options: ReplOptions): Promise<void> {
    // The CLI opts into persistence explicitly — core defaults to memory so that embedding the
    // library never writes to someone's working directory uninvited.
    const runtime: Runtime = await RuntimeClass.create({
        agents: [options.manifestPath],
        emitChunks: true,
        store: options.ephemeral === true ? ":memory:" : (options.store ?? defaultStorePath()),
    })

    const agent = runtime.list()[0]
    if (agent === undefined) throw new Error("The manifest produced no agent.")

    const sessionKey = options.sessionKey ?? Agent.DEFAULT_SESSION
    const quiet = options.quiet === true

    if (!quiet) {
        const described = agent.describe()
        const turns = await agent.turns(sessionKey, 1)
        const resumed = await agent.store.messages.count(agent.id, sessionKey)
        process.stdout.write(
            `${BRAND.name} ${VERSION} · ${described.id} · ${described.model} · window ${described.window}\n` +
                `session ${sessionKey} · ${resumed} message(s) · store ${runtime.store.location}\n` +
                `ready in ${runtime.boot.processMs.toFixed(0)} ms · /exit to quit · /reset clears · Ctrl-C cancels a reply\n\n`,
        )
        // Naming a reaped turn is the point of reaping it: the previous run died mid-generation
        // and the person restarting is the one who needs to know.
        const last = turns[0]
        if (last?.errorCode === "turn_abandoned") {
            process.stdout.write(
                `note: the previous turn in this session did not finish — the process exited while it was generating.\n\n`,
            )
        }
    }

    // Streaming output is wired through the bus rather than a callback: the CLI is a subscriber
    // like any other, which is what keeps the server and the CLI from needing different cores.
    let streaming = false
    let lastKind: "text" | "reasoning" | undefined
    const unsubscribe = runtime.bus.on("model.chunk", (event: AnyEvent) => {
        if (event.type !== "model.chunk") return
        const data = event.data as { delta: string; kind: "text" | "reasoning" }
        if (data.kind === "reasoning" && options.showReasoning !== true) return

        // A reasoning model streams its scratchpad and then its answer with no separator of its
        // own, so the two run together mid-sentence. The label is worth the two lines: the whole
        // point of showing reasoning is being able to tell it apart from the reply.
        if (data.kind !== lastKind) {
            if (lastKind !== undefined) process.stdout.write("\n\n")
            if (options.showReasoning === true) {
                process.stdout.write(data.kind === "reasoning" ? "· reasoning ·\n" : "· reply ·\n")
            }
            lastKind = data.kind
        }

        streaming = true
        process.stdout.write(data.delta)
    })

    let controller: AbortController | undefined
    let cancelledAt = 0

    const onInterrupt = (rl?: Interface): void => {
        if (controller !== undefined && !controller.signal.aborted) {
            cancelledAt = performance.now()
            controller.abort()
            return
        }
        rl?.close()
        process.stdout.write("\n")
        void runtime.stop("sigint").then(() => process.exit(0))
    }

    const runOne = async (input: string): Promise<void> => {
        controller = new AbortController()
        streaming = false
        lastKind = undefined

        const result = await agent.send(input, {
            sessionKey,
            signal: controller.signal,
            source: "repl",
        })

        controller = undefined

        if (streaming) process.stdout.write("\n")
        else if (result.text !== "") process.stdout.write(`${result.text}\n`)

        if (result.reason === "stopped") {
            const elapsed = cancelledAt === 0 ? 0 : performance.now() - cancelledAt
            process.stdout.write(`\n^C cancelled after ${elapsed.toFixed(0)} ms\n`)
        } else if (result.reason === "timeout") {
            process.stdout.write(`\n(timed out after ${result.durationMs} ms)\n`)
        } else if (result.reason === "error" && result.error !== undefined) {
            process.stderr.write(
                `\n${result.error.code}: ${result.error.message}\n  hint: ${result.error.hint}\n`,
            )
            process.exitCode = 1
        } else if (result.reason === "max_steps") {
            process.stdout.write(
                `\n(stopped at maxSteps with no reply — this is a failure, not a completion)\n`,
            )
            process.exitCode = 1
        }

        if (!quiet && result.reason === "final") {
            process.stdout.write(
                `  ${result.tokens.prompt} prompt · ${result.tokens.output} output · ${result.durationMs} ms\n\n`,
            )
        }
    }

    const sigintHandler = () => onInterrupt()
    process.on("SIGINT", sigintHandler)

    try {
        // Non-interactive: one turn from a flag, or lines piped on stdin.
        if (options.once !== undefined) {
            await runOne(options.once)
            return
        }

        if (!process.stdin.isTTY) {
            const rl = createInterface({ input: process.stdin })
            for await (const line of rl) {
                const trimmed = line.trim()
                if (trimmed === "" || EXIT_WORDS.has(trimmed)) continue
                await runOne(trimmed)
            }
            return
        }

        const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "› " })
        rl.on("SIGINT", () => onInterrupt(rl))

        rl.prompt()
        for await (const line of rl) {
            const trimmed = line.trim()

            if (EXIT_WORDS.has(trimmed)) break
            if (trimmed === "") {
                rl.prompt()
                continue
            }
            if (trimmed === "/reset") {
                await agent.clearSession(sessionKey)
                process.stdout.write("session cleared — memory files on disk are untouched\n")
                rl.prompt()
                continue
            }

            await runOne(trimmed)
            rl.prompt()
        }
        rl.close()
    } finally {
        process.off("SIGINT", sigintHandler)
        unsubscribe()
        await runtime.stop("cli-exit")
    }
}
