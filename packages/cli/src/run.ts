/**
 * The `run` command. Two renderers, one setup.
 *
 * The rich path is the Ink app; the plain path is line-oriented and writes tokens to stdout as they
 * arrive. Which one runs is decided once, by `resolveMode`, and never re-decided mid-process.
 *
 * **Ink is imported lazily, and only on the rich path.** Measured: `react` + `ink` cost ~65 ms to
 * import under Bun and ~170-210 ms under Node, against a ~70 ms total runtime for `validate --json`.
 * A static import at the top of this file would be paid by every invocation of every command, so the
 * dynamic `import()` below is load-bearing rather than stylistic. A test asserts it stays that way.
 *
 * The plain path keeps Phase 1's behaviour deliberately unchanged, including the Ctrl-C contract and
 * the streaming writes, because both were verified against a real endpoint and a real SIGINT.
 */

import { createInterface, type Interface } from "node:readline"
import {
    Agent,
    type AnyEvent,
    BRAND,
    defaultStorePath,
    Runtime as RuntimeClass,
    VERSION,
} from "@castellan/core"
import { EXIT_FAILURE, EXIT_OK, EXIT_WORDS, PROMPT, RESET_WORD } from "#lib/const"
import { flushOutput, markTerminalDirty, onExit } from "#lib/exit"
import { resolveModeFromProcess } from "#lib/output"
import type { RunOptions } from "#lib/schema"
import { seed } from "#transcript"

/** Opening lines: what is loaded, what session, and whether the last turn finished. */
async function bannerLines(
    agent: Agent,
    sessionKey: string,
    storeLocation: string,
    bootMs: number,
) {
    const described = agent.describe()
    const [turns, resumed] = await Promise.all([
        agent.turns(sessionKey, 1),
        agent.store.messages.count(agent.id, sessionKey),
    ])

    const lines = [
        `${BRAND.name} ${VERSION} · ${described.id} · ${described.model} · window ${described.window}`,
        `session ${sessionKey} · ${resumed} message(s) · store ${storeLocation}`,
        `ready in ${bootMs.toFixed(0)} ms · /exit to quit · /reset clears · /help for keys`,
    ]

    // Naming a reaped turn is the point of reaping it: the previous run died mid-generation, and the
    // person restarting is the one who needs to know.
    if (turns[0]?.errorCode === "turn_abandoned") {
        lines.push(
            "note: the previous turn in this session did not finish — the process exited while it was generating.",
        )
    }
    return lines
}

export async function runCommand(options: RunOptions): Promise<number> {
    const oneShot = options.once !== undefined
    const { mode } = resolveModeFromProcess({
        json: false,
        plain: options.plain === true,
        oneShot,
    })

    // The CLI opts into persistence explicitly — core defaults to memory so that embedding the
    // library never writes to someone's working directory uninvited.
    const runtime = await RuntimeClass.create({
        agents: [options.manifestPath],
        emitChunks: true,
        store: options.ephemeral === true ? ":memory:" : (options.store ?? defaultStorePath()),
    })
    onExit(() => runtime.stop("cli-exit"))

    const agent = runtime.list()[0]
    if (agent === undefined) throw new Error("The manifest produced no agent.")

    const sessionKey = options.sessionKey ?? Agent.DEFAULT_SESSION
    const quiet = options.quiet === true
    const banner =
        quiet || oneShot
            ? []
            : await bannerLines(agent, sessionKey, runtime.store.location, runtime.boot.processMs)

    return mode === "rich"
        ? await runRich({ ...options, agent, runtime, sessionKey, banner, quiet })
        : await runPlain({ ...options, agent, runtime, sessionKey, banner, quiet })
}

interface Wired extends RunOptions {
    readonly agent: Agent
    readonly runtime: Awaited<ReturnType<typeof RuntimeClass.create>>
    readonly sessionKey: string
    readonly banner: readonly string[]
    readonly quiet: boolean
}

/**
 * The Ink app.
 *
 * `exitOnCtrlC: false` is not optional. Ink's default is to handle Ctrl-C itself and exit the
 * process, which would silently undo the contract Phase 1 established and measured — Ctrl-C cancels
 * the turn, not the process — and the failure would look like "cancellation kills the session".
 */
async function runRich(wired: Wired): Promise<number> {
    const [{ render }, { createElement }, { App }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/App"),
    ])

    // From here on the terminal is in raw mode with the cursor hidden, so every exit route has
    // something to undo. The plain path never marks this, which is what keeps its output free of the
    // trailing reset sequence.
    markTerminalDirty()

    const instance = render(
        createElement(App, {
            agent: wired.agent,
            bus: wired.runtime.bus,
            sessionKey: wired.sessionKey,
            model: wired.agent.describe().model,
            initial: seed(wired.banner),
            showReasoning: wired.showReasoning === true,
            quiet: wired.quiet,
        }),
        { exitOnCtrlC: false },
    )
    onExit(() => instance.unmount())

    await instance.waitUntilExit()
    return EXIT_OK
}

/** Line-oriented, and byte-identical whether stdout is a terminal or a pipe. */
async function runPlain(wired: Wired): Promise<number> {
    const { agent, runtime, sessionKey, quiet } = wired
    const write = (text: string) => void process.stdout.write(text)

    if (wired.banner.length > 0) write(`${wired.banner.join("\n")}\n\n`)

    // Streaming goes through the bus rather than a callback: the CLI is a subscriber like any other,
    // which is what keeps the server and the CLI from needing different cores.
    let streaming = false
    let lastKind: "text" | "reasoning" | undefined
    const unsubscribe = runtime.bus.on("model.chunk", (event: AnyEvent) => {
        if (event.type !== "model.chunk") return
        const { delta, kind } = event.data
        if (kind === "reasoning" && wired.showReasoning !== true) return

        // A reasoning model streams its scratchpad and then its answer with no separator of its own,
        // so the two run together mid-sentence. The label is worth two lines: the whole point of
        // showing reasoning is being able to tell it apart from the reply.
        if (kind !== lastKind) {
            if (lastKind !== undefined) write("\n\n")
            if (wired.showReasoning === true) {
                write(kind === "reasoning" ? "· reasoning ·\n" : "· reply ·\n")
            }
            lastKind = kind
        }
        streaming = true
        write(delta)
    })

    let controller: AbortController | undefined
    let cancelledAt = 0
    let exitCode = EXIT_OK

    const onInterrupt = (rl?: Interface): void => {
        if (controller !== undefined && !controller.signal.aborted) {
            cancelledAt = performance.now()
            controller.abort()
            return
        }
        // Closing the readline interface ends the `for await` loop, which returns through the
        // `finally` below. Calling process.exit here would discard a non-zero code set by an earlier
        // failed turn, and could truncate piped output mid-write.
        rl?.close()
        write("\n")
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

        if (streaming) write("\n")
        else if (result.text !== "") write(`${result.text}\n`)

        if (result.reason === "stopped") {
            const elapsed = cancelledAt === 0 ? 0 : performance.now() - cancelledAt
            write(`\n^C cancelled after ${elapsed.toFixed(0)} ms\n`)
        } else if (result.reason === "timeout") {
            write(`\n(timed out after ${result.durationMs} ms)\n`)
        } else if (result.reason === "error" && result.error !== undefined) {
            process.stderr.write(
                `\n${result.error.code}: ${result.error.message}\n  hint: ${result.error.hint}\n`,
            )
            exitCode = EXIT_FAILURE
        } else if (result.reason === "max_steps") {
            write("\n(stopped at maxSteps with no reply — this is a failure, not a completion)\n")
            exitCode = EXIT_FAILURE
        }

        if (!quiet && result.reason === "final") {
            write(
                `  ${result.tokens.prompt} prompt · ${result.tokens.output} output · ${result.durationMs} ms\n\n`,
            )
        }

        // Bound the memory a long piped session can hold: stdout to a pipe is asynchronous, and a
        // slow reader would otherwise let unwritten replies accumulate for the life of the process.
        await flushOutput()
    }

    const sigintHandler = () => onInterrupt()
    process.on("SIGINT", sigintHandler)

    try {
        if (wired.once !== undefined) {
            await runOne(wired.once)
            return exitCode
        }

        if (process.stdin.isTTY !== true) {
            const rl = createInterface({ input: process.stdin })
            for await (const line of rl) {
                const trimmed = line.trim()
                if (trimmed === "" || EXIT_WORDS.includes(trimmed)) continue
                await runOne(trimmed)
            }
            return exitCode
        }

        const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT })
        rl.on("SIGINT", () => onInterrupt(rl))
        rl.prompt()
        for await (const line of rl) {
            const trimmed = line.trim()

            if (EXIT_WORDS.includes(trimmed)) break
            if (trimmed === "") {
                rl.prompt()
                continue
            }
            if (trimmed === RESET_WORD) {
                await agent.clearSession(sessionKey)
                write("session cleared — memory files on disk are untouched\n")
                rl.prompt()
                continue
            }

            await runOne(trimmed)
            rl.prompt()
        }
        rl.close()
        return exitCode
    } finally {
        process.off("SIGINT", sigintHandler)
        unsubscribe()
    }
}
