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

import { existsSync } from "node:fs"
import { createInterface, type Interface } from "node:readline"
import {
    Agent,
    type AnyEvent,
    BRAND,
    defaultStorePath,
    HarnessError,
    processAlive,
    Runtime as RuntimeClass,
    VERSION,
} from "@castellan/core"
import { initInteractive } from "#init"
import { ambientEnv, demotedKeys } from "#lib/ambient"
import { EXIT_FAILURE, EXIT_OK, PROMPT } from "#lib/const"
import { flushOutput, markTerminalDirty, onExit } from "#lib/exit"
import { resolveModeFromProcess } from "#lib/output"
import { CHANNELS, scriptRunner, TOOL_PROVIDERS } from "#lib/providers"
import { keyValue } from "#lib/render"
import { listAgents, storePath } from "#lib/sandbox"
import type { RunOptions } from "#lib/schema"
import {
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import { seed } from "#transcript"

/** Opening lines: what is loaded, what session, and whether the last turn finished. */
async function bannerLines(
    agent: Agent,
    sessionKey: string,
    storeLocation: string,
    bootMs: number,
    restarted: boolean,
    demoted: readonly string[] = [],
) {
    const described = agent.describe()
    const [turns, resumed] = await Promise.all([
        agent.turns(sessionKey, 1),
        agent.store.messages.count(agent.id, sessionKey),
    ])

    const lines = [
        `${BRAND.name} ${VERSION} · ${described.id} · ${described.model} · window ${described.window}`,
        `session ${sessionKey} · ${resumed} message(s) · store ${storeLocation}`,
        // Points at `/help` rather than listing commands: the list belongs to the table that
        // implements them, and a banner enumerating a subset is the drift this change removed.
        `ready in ${bootMs.toFixed(0)} ms · /help for commands and keys · /exit to leave`,
    ]

    if (restarted) {
        lines.push(
            "restarted — the configuration on disk is now the one in force; the conversation continues from the store.",
        )
    }

    // Naming a reaped turn is the point of reaping it: the previous run died mid-generation, and the
    // person restarting is the one who needs to know.
    if (turns[0]?.errorCode === "turn_abandoned") {
        lines.push(
            "note: the previous turn in this session did not finish — the process exited while it was generating.",
        )
    }

    // Load warnings, read off the agent rather than caught on the bus.
    //
    // `Runtime.create` emits them as `agent.warning` during boot — which finishes *before* this
    // command subscribes to anything, so every one of them has been landing in an empty room: a
    // trimmed catalogue, a tool declared trusted by its provider, a shell that can only run once a
    // turn. Silent, and precisely the class of thing the loud resolution path exists to prevent.
    //
    // Reading the resolved state instead of racing the bus is also the more honest fix. These are
    // properties of the loaded agent, not events, and something that is true for the whole session
    // belongs where a person will still see it after scrolling.
    for (const warning of [...agent.warnings, ...agent.tools.warnings]) {
        lines.push(`note: ${warning.message}\n      ${warning.hint}`)
    }

    // The other half of the same honesty. Core warns when the environment *took* a variable from the
    // agent's own .env; this says when the CLI decided a .env in the current directory should not
    // have. Someone who just wrote MODEL_ID into a project file and finds their agent ignoring it
    // needs the sentence as much as the person who found their agent obeying it.
    if (demoted.length > 0) {
        lines.push(
            `note: ${demoted.join(", ")} in the .env here ${demoted.length === 1 ? "was" : "were"} ignored — this agent's own .env sets ${demoted.length === 1 ? "it" : "them"}.\n      A .env in the directory you launched from configures that project, not an agent living somewhere else. Export the variable to override the agent's own file.`,
        )
    }

    return lines
}

export async function runCommand(options: RunOptions): Promise<number> {
    const oneShot = options.once !== undefined
    const decision = resolveModeFromProcess({
        json: false,
        plain: options.plain === true,
        oneShot,
    })
    const { mode } = decision

    // No agent named: the sandbox decides. One agent auto-runs; several open the picker at a
    // terminal and list plainly everywhere else; none goes straight to the wizard (rich) or an
    // error naming `init` (plain) — an empty sandbox with no guidance is a dead end.
    if (options.manifestPath === undefined) {
        const picked = await pickFromSandbox(mode, decision.because, options)
        if (typeof picked === "number") return picked
        return runCommand({ ...options, manifestPath: picked })
    }

    // The CLI opts into persistence explicitly — core defaults to memory so that embedding the
    // library never writes to someone's working directory uninvited. The default store lives at
    // the sandbox root: one store for every agent, wherever `run` is invoked from — a cwd-relative
    // default gave the same agent a different session history in every directory.
    const legacy = defaultStorePath()
    if (options.store === undefined && options.ephemeral !== true && existsSync(legacy)) {
        process.stdout.write(
            `note: a session store exists at ${legacy} from an earlier version — pass --store ${legacy} to keep using it; the default is now ${storePath()}\n`,
        )
    }
    // One teardown for however many runtimes this call goes through. Registering inside the loop
    // would hold a reference to every dead one; `Runtime.stop` is already idempotent, so the live
    // reference is the only thing that has to move.
    let current: RuntimeClass | undefined
    onExit(() => current?.stop("cli-exit"))

    // Outlives every runtime this call builds. See `Wired.reader`.
    const reader: { current: Interface | undefined } = { current: undefined }

    const sessionKey = options.sessionKey ?? Agent.DEFAULT_SESSION
    const quiet = options.quiet === true
    let restarted = false

    // `/restart` rebuilds the agent in this process rather than replacing the process.
    //
    // The settings an agent booted with are fixed for its lifetime — the catalogue is resolved once,
    // and slot 1 is rendered once, both deliberately — so a configuration change genuinely needs a new
    // agent and there is no honest way to apply one in place. Re-execing would work and would throw
    // away the terminal; this keeps the scrollback, and the conversation was never in memory anyway.
    for (;;) {
        const runtime = await RuntimeClass.create({
            agents: [options.manifestPath],
            emitChunks: true,
            toolProviders: TOOL_PROVIDERS,
            scriptRunner: scriptRunner(),
            channels: CHANNELS,
            // A `.env` in the directory this was launched from loses to the agent's own. See
            // `lib/ambient.ts` — core's "real environment wins" is untouched; this decides what
            // counts as the real environment.
            env: ambientEnv([options.manifestPath]),
            store: options.ephemeral === true ? ":memory:" : (options.store ?? storePath()),
        })
        current = runtime

        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("The manifest produced no agent.")

        // Reasoning is shown by default on a model that has any.
        //
        // It used to be opt-in behind --show-reasoning, which meant the normal experience of a
        // reasoning model was a cursor sitting still for thirty seconds with nothing to look at,
        // and no indication anything was happening. The thinking is the only signal there is
        // during that time, and it is already being streamed and thrown away. `--no-reasoning`
        // turns it off; `--show-reasoning` stays, and is now a no-op that harms nobody's scripts.
        const reasons = agent.roles.main.capabilities.thinking !== "none"
        const showReasoning = options.noReasoning === true ? false : reasons

        const banner =
            quiet || oneShot
                ? []
                : await bannerLines(
                      agent,
                      sessionKey,
                      runtime.store.location,
                      // After a restart the process has been alive for however long the conversation
                      // lasted, so time-since-process-start stops meaning anything. The first boot
                      // reports it because that is the number the sub-second claim is about.
                      restarted ? runtime.boot.bootMs : runtime.boot.processMs,
                      restarted,
                      demotedKeys([options.manifestPath]),
                  )

        const wired = {
            ...options,
            agent,
            runtime,
            sessionKey,
            banner,
            quiet,
            reader,
            showReasoning,
        }
        const outcome = mode === "rich" ? await runRich(wired) : await runPlain(wired)

        await runtime.stop(outcome === RESTART ? "restart" : "cli-exit")
        if (outcome !== RESTART) return outcome
        restarted = true
    }
}

/**
 * What a renderer returns when the answer is "build it again", not "we are done".
 *
 * A symbol rather than a magic exit code: every other value this returns is a process exit status, and
 * a status that secretly means something else is the kind of overload that survives until someone
 * returns it by accident.
 */
const RESTART = Symbol("restart")
type RunOutcome = number | typeof RESTART

/**
 * Bare `run`: resolve the sandbox into either a manifest path to run or an exit code.
 *
 * The picker is the third Ink surface, mounted the same lazy way; picking unmounts it before the
 * chat mounts, so the two screens stack naturally in scrollback. "Create a new agent" chains
 * through `initInteractive` — one wizard entry point — and straight into the chat with the result.
 */
async function pickFromSandbox(
    mode: string,
    because: string,
    options: RunOptions,
): Promise<string | number> {
    const agents = listAgents()

    if (agents.length === 0) {
        if (mode === "rich") {
            // First run, empty sandbox: the wizard IS the answer to "run what?".
            const created = await initInteractive({ plain: options.plain === true })
            if (created.kind === "aborted") {
                process.stdout.write("nothing to run\n")
                return EXIT_OK
            }
            if (created.kind === "failed") return created.code
            return created.manifestPath
        }
        throw new HarnessError({
            code: "cli_sandbox_empty",
            message: "No agent named, and the sandbox is empty.",
            hint: `Create one with \`${BRAND.slug} init\`, or pass a path to an agent.yaml.`,
        })
    }

    if (agents.length === 1 && agents[0] !== undefined) {
        // The overwhelmingly common case costs zero keystrokes; saying so keeps it explicable.
        process.stdout.write(`running ${agents[0].ref} — the only agent in the sandbox\n`)
        return agents[0].manifestPath
    }

    if (mode !== "rich") {
        // Scriptable contexts get the list and a non-zero exit: nothing ran.
        for (const agent of agents) {
            process.stdout.write(
                `${agent.ref}\t${agent.problem ?? agent.modelId ?? "?"}\t${agent.dir}\n`,
            )
        }
        process.stderr.write(
            `pass an agent name or a manifest path — the picker needs a terminal (${because})\n`,
        )
        return EXIT_FAILURE
    }

    const [{ render }, { createElement }, { Picker }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/Picker"),
    ])
    let result: { kind: "run"; manifestPath: string } | { kind: "create" } | { kind: "quit" } = {
        kind: "quit",
    }
    // eslint-free narrowing escape: the callback assignment below is invisible to control-flow
    // analysis, so the read after waitUntilExit goes through a widened alias.
    markTerminalDirty()
    const instance = render(
        createElement(Picker, {
            title: `${BRAND.name} ${VERSION}`,
            agents,
            onDone: (picked) => {
                result = picked
            },
        }),
        { exitOnCtrlC: false },
    )
    onExit(() => instance.unmount())
    await instance.waitUntilExit()
    instance.unmount()

    const picked = result as
        | { kind: "run"; manifestPath: string }
        | { kind: "create" }
        | { kind: "quit" }
    if (picked.kind === "quit") {
        process.stdout.write("nothing run\n")
        return EXIT_OK
    }
    if (picked.kind === "create") {
        const created = await initInteractive({ plain: options.plain === true })
        if (created.kind === "aborted") {
            process.stdout.write("nothing to run\n")
            return EXIT_OK
        }
        if (created.kind === "failed") return created.code
        return created.manifestPath
    }
    return picked.manifestPath
}

interface Wired extends RunOptions {
    readonly agent: Agent
    /**
     * Resolved, not the raw flag: on by default for a model that reasons, off under
     * `--no-reasoning`. Narrowed to a required boolean here so no renderer has to re-decide.
     */
    readonly showReasoning: boolean
    readonly runtime: Awaited<ReturnType<typeof RuntimeClass.create>>
    readonly sessionKey: string
    readonly banner: readonly string[]
    readonly quiet: boolean
    /**
     * The line reader, owned by `runCommand` so it survives a `/restart`.
     *
     * Rebuilding it per runtime is the obvious thing and it breaks: a second `createInterface` over a
     * pipe that the first one already read to EOF returns immediately, so everything after `/restart`
     * is silently dropped. A terminal probably tolerates it — and "probably" is the problem, since it
     * cannot be tested where there is no tty. Sharing one reader removes the difference rather than
     * betting on it.
     */
    readonly reader: { current: Interface | undefined }
}

/**
 * The Ink app.
 *
 * `exitOnCtrlC: false` is not optional. Ink's default is to handle Ctrl-C itself and exit the
 * process, which would silently undo the contract Phase 1 established and measured — Ctrl-C cancels
 * the turn, not the process — and the failure would look like "cancellation kills the session".
 */
async function runRich(wired: Wired): Promise<RunOutcome> {
    const [{ render }, { createElement }, { App }] = await Promise.all([
        import("ink"),
        import("react"),
        import("#components/App"),
    ])

    // From here on the terminal is in raw mode with the cursor hidden, so every exit route has
    // something to undo. The plain path never marks this, which is what keeps its output free of the
    // trailing reset sequence.
    markTerminalDirty()

    let restart = false
    const instance = render(
        createElement(App, {
            agent: wired.agent,
            onRestart: () => {
                restart = true
            },
            bus: wired.runtime.bus,
            sessionKey: wired.sessionKey,
            model: wired.agent.describe().model,
            initial: seed(wired.banner),
            showReasoning: wired.showReasoning,
            quiet: wired.quiet,
        }),
        { exitOnCtrlC: false },
    )
    onExit(() => instance.unmount())

    await instance.waitUntilExit()
    return restart ? RESTART : EXIT_OK
}

/** Line-oriented, and byte-identical whether stdout is a terminal or a pipe. */
async function runPlain(wired: Wired): Promise<RunOutcome> {
    const { agent, runtime, sessionKey, quiet } = wired

    let atLineStart = true
    const write = (text: string) => {
        if (text === "") return
        process.stdout.write(text)
        atLineStart = text.endsWith("\n")
    }
    /** A line of its own, whatever the reply was part-way through writing. */
    const row = (text: string) => {
        if (!atLineStart) write("\n")
        write(`${text}\n`)
    }

    if (wired.banner.length > 0) write(`${wired.banner.join("\n")}\n\n`)

    // A one-shot run prints the answer and nothing else, because something is parsing it. Tool rows
    // are for a person watching, so they follow the same rule as the banner and the stats line.
    const showRows = !quiet && wired.once === undefined

    // Streaming goes through the bus rather than a callback: the CLI is a subscriber like any other,
    // which is what keeps the server and the CLI from needing different cores.
    let streaming = false
    let lastKind: "text" | "reasoning" | undefined

    // With a line-oriented dialect the invocation *is* text, so raw deltas would put `ACTION:` and
    // `END` in front of the person and run them into the answer. The filter comes from the agent
    // rather than being chosen here: which dialect is in play is config, and one place decides it.
    // One per turn, told where the steps end — it owns the paragraph break between them.
    let filter = agent.streamFilter()

    const show = (text: string) => {
        if (text === "") return
        write(text)
        streaming = true
    }

    const subscriptions = [
        runtime.bus.on("model.result", () => show(filter.endStep())),

        runtime.bus.on("model.chunk", (event: AnyEvent) => {
            if (event.type !== "model.chunk") return
            const { delta, kind } = event.data
            if (kind === "reasoning" && wired.showReasoning !== true) return

            // A reasoning model streams its scratchpad and then its answer with no separator of its
            // own, so the two run together mid-sentence. The label is worth two lines: the whole
            // point of showing reasoning is being able to tell it apart from the reply.
            if (kind !== lastKind) {
                if (lastKind !== undefined) write("\n\n")
                if (wired.showReasoning === true) {
                    write(kind === "reasoning" ? "· reasoning ·\n" : "· reply ·\n")
                }
                lastKind = kind
            }

            // Reasoning is not parsed for tool calls, so it is not filtered for them either.
            if (kind === "reasoning") {
                write(delta)
                streaming = true
                return
            }
            show(filter.push(delta))
        }),

        runtime.bus.on("tool.result", (event: AnyEvent) => {
            if (event.type !== "tool.result" || !showRows) return
            const { slug, ok, latencyMs, truncated } = event.data
            row(
                `  · ${slug} — ${ok ? "ok" : "failed"} · ${latencyMs} ms${truncated ? " · observation trimmed" : ""}`,
            )
        }),

        // Exempt from `showRows`, like a gated call and for the same reason: a one-shot run whose
        // agent just rewrote its own configuration must not be the only surface that does not say so.
        runtime.bus.on("agent.warning", (event: AnyEvent) => {
            if (event.type !== "agent.warning" || event.data.code !== "manifest_changed") return
            row(`  · ${event.data.message}\n    ${event.data.hint}`)
        }),

        runtime.bus.on("tool.repair", (event: AnyEvent) => {
            if (event.type !== "tool.repair" || !showRows) return
            // Worth a line of its own: a silent repair looks like a slow turn.
            row(`  · ${event.data.slugs.join(", ")} — could not be used, asking again`)
        }),

        // Deliberately NOT gated on `showRows`. Every other row here is for a person watching, and
        // suppressing them in a one-shot run is right — but a blocked write is the run doing less
        // than it was asked to, and a scripted caller parsing the output needs to know that even
        // more than a person does.
        runtime.bus.on("tool.gated", (event: AnyEvent) => {
            if (event.type !== "tool.gated") return
            row(`  · ${event.data.slug} — blocked: ${event.data.reason}`)
        }),
    ]
    const unsubscribe = () => {
        for (const off of subscriptions) off()
    }

    /**
     * A typed line that was a command rather than a prompt.
     *
     * Shared by both input branches, and driven by the same table the rich path uses. Before this,
     * the banner advertised `/help` and this path had no case for it, so it went to the model as a
     * prompt — a billed call answering a question about the CLI it knows nothing about.
     */
    const dispatch = async (
        trimmed: string,
    ): Promise<"exit" | "restart" | "handled" | "prompt"> => {
        const command = resolveSessionCommand(trimmed)
        if (command === undefined) return "prompt"
        switch (command.kind) {
            case "exit":
                return "exit"
            case "restart":
                return "restart"
            case "help":
                row(sessionHelpText())
                return "handled"
            case "tools":
                row(toolsReport(toolsView(agent)))
                return "handled"
            case "status":
                row(await sessionStatus(wired))
                return "handled"
            case "reset":
                await agent.clearSession(sessionKey)
                row("session cleared — memory files on disk are untouched")
                return "handled"
            case "unknown":
                row(unknownCommandText(command))
                return "handled"
        }
    }

    let controller: AbortController | undefined
    let cancelledAt = 0
    let exitCode: RunOutcome = EXIT_OK

    const onInterrupt = (rl = wired.reader.current): void => {
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
        filter = agent.streamFilter()

        const result = await agent.send(input, {
            sessionKey,
            signal: controller.signal,
            source: "repl",
        })
        controller = undefined

        // The filter withholds a trailing line break, since it cannot know whether more follows.
        show(filter.end())
        if (streaming && !atLineStart) write("\n")
        else if (!streaming && result.text !== "") write(`${result.text}\n`)

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
            const rl = wired.reader.current ?? createInterface({ input: process.stdin })
            wired.reader.current = rl
            for await (const line of rl) {
                const trimmed = line.trim()
                if (trimmed === "") continue
                // Commands work in a pipe too. A script that pipes `/exit` means it — this branch
                // used to skip the word and keep reading, which is the one place the piped path
                // disagreed with the terminal about what a typed line meant.
                const outcome = await dispatch(trimmed)
                if (outcome === "exit") break
                if (outcome === "restart") {
                    exitCode = RESTART
                    break
                }
                if (outcome === "handled") continue
                await runOne(trimmed)
            }
            return exitCode
        }

        // `terminal: false` is the whole point of this branch.
        //
        // Node's readline decides for itself whether to run in terminal mode, by reading
        // `output.isTTY` — so at a terminal it repaints the prompt with cursor-control sequences
        // (`ESC[1G`, `ESC[0J`, `ESC[3G`) that the same command piped never emits. That silently
        // breaks the property plain mode exists for: `--plain` at a terminal must produce exactly
        // what a pipe produces. Only the rich path is allowed to move a cursor.
        //
        // The cost is that readline no longer echoes or edits: the tty driver does both, because
        // nothing here puts stdin in raw mode. Typing, backspace and Ctrl-D behave as they do in any
        // line-buffered program. Arrow-key history is lost on this path — the rich path owns that.
        const rl =
            wired.reader.current ??
            createInterface({
                input: process.stdin,
                output: process.stdout,
                prompt: PROMPT,
                terminal: false,
            })
        wired.reader.current = rl
        // Outside terminal mode readline never emits its own SIGINT, so the process-level handler
        // installed below is the only one that fires. It closes `reader`, which ends the loop.
        rl.prompt()
        for await (const line of rl) {
            const trimmed = line.trim()

            if (trimmed === "") {
                rl.prompt()
                continue
            }

            const outcome = await dispatch(trimmed)
            if (outcome === "exit") break
            if (outcome === "restart") {
                exitCode = RESTART
                break
            }
            if (outcome === "handled") {
                rl.prompt()
                continue
            }

            await runOne(trimmed)
            rl.prompt()
        }
        // Closed only when this really is the end. A restart hands the same reader to the next
        // runtime, and closing it here would end the session the restart was meant to continue.
        if (exitCode !== RESTART) {
            rl.close()
            wired.reader.current = undefined
        }
        return exitCode
    } finally {
        process.off("SIGINT", sigintHandler)
        unsubscribe()
    }
}

/**
 * `/status` — what this agent is, and what is actually running.
 *
 * The human twin of context slot 2. That block tells the *model* its model, window, channels,
 * server and permissions on every turn; until this existed the person at the prompt could not see
 * any of it, which is the same asymmetry slot 2 was added to remove, pointed the other way.
 *
 * State, not configuration, for the same reason slot 2 is: told only what the manifest says, an
 * agent under `run` concluded its Telegram runtime had died and reported that nothing was listening
 * on its port — from inside the running process. Every statement was true of the file and false of
 * the moment. So a configured-but-not-started channel says exactly that, and names what does start
 * it.
 */
async function sessionStatus(wired: Wired): Promise<string> {
    const agent = wired.agent
    const described = agent.describe()
    const manifest = agent.manifest
    // `channels.started`, never "are any registered". A binding exists under `run` too, so reading
    // its presence as "connected" is decision 5.17's bug wearing a different hat — and it was,
    // until this screen was built and said so out loud.
    const configured = manifest.channels
        .filter((channel) => channel.enabled)
        .map((channel) => `${channel.id} (${channel.type})`)
        .join(", ")
    const channels =
        configured === ""
            ? "none — reached through this session and the HTTP API only"
            : wired.runtime.channels.started
              ? `${configured} — connected in this session`
              : `${configured} — configured, NOT running here; \`serve\` starts channels, \`run\` does not`

    const server = !manifest.server.enabled
        ? "off"
        : `enabled on ${manifest.server.host}:${manifest.server.port}, NOT bound here — \`serve\` binds it`

    return keyValue([
        { label: "agent", value: `${described.id} (${described.name})` },
        {
            label: "model",
            value: `${described.model} · ${manifest.tools.dialect} · ${described.window} token window`,
        },
        { label: "channels", value: channels },
        { label: "http api", value: server },
        { label: "store", value: wired.runtime.store.location },
        { label: "background", value: await supervision(wired, described.id) },
    ])
}

/**
 * Who, if anyone, is keeping this agent up — and the three answers are genuinely different.
 *
 * "Not supervised" was the first version, derived from this runtime not holding the lease. It was
 * wrong in the most misleading direction available: a REPL correctly *declines* the lease when a
 * service already holds it, so an agent that had been running as a daemon for a week reported
 * itself unsupervised to the person looking straight at it.
 */
async function supervision(wired: Wired, agentId: string): Promise<string> {
    if (wired.runtime.owned.includes(agentId)) return "this session is serving this agent"
    const lease = await wired.runtime.store.leases.get(agentId)
    if (lease !== undefined && processAlive(lease.pid)) {
        return lease.mode === "daemon"
            ? `running as a background service · pid ${lease.pid} · \`${BRAND.slug} daemon status ${agentId}\``
            : `served by another session · pid ${lease.pid} (${lease.mode})`
    }
    return `not supervised — \`${BRAND.slug} daemon install ${agentId}\` keeps it running without a terminal`
}
