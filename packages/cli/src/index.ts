/**
 * The entry point: parse, dispatch, exit.
 *
 * No shebang here — the build prepends one via `--banner`. Two would be a syntax error, and the
 * source is never executed directly: `bun run src/index.ts` and `node dist/index.js` are the two
 * supported ways in.
 *
 * Three rules hold here and nowhere else.
 *
 * **It imports no Ink and no React.** The rich renderer is reached through a dynamic `import()` in
 * `run.ts`, because loading it costs ~170-210 ms under Node — more than the entire runtime of
 * `validate --json`. A static import anywhere on this path would be paid by every command.
 *
 * **Commands return exit codes; they never call `process.exit`.** Exiting mid-write discards buffered
 * stdout when the output is a pipe, which is how `--json` gets read.
 *
 * **Asking for help is a success.** The previous entry point set exit code 1 for `--help` given
 * without a command, reporting failure for the one thing that had worked.
 */

import { HarnessError, VERSION } from "@castellan/core"
import { agentsCommand } from "#agents"
import { initCommand } from "#init"
import { parse } from "#lib/args"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { readEnv } from "#lib/env"
import { finish, installGuards } from "#lib/exit"
import { helpText } from "#lib/help"
import { resolveAgentRef } from "#lib/sandbox"
import { runCommand } from "#run"
import { sessionsCommand } from "#sessions"
import { soulCommand } from "#soul"
import { toolsCommand } from "#tools"
import { validateCommand } from "#validate"
import { workspaceCommand } from "#workspace"

function report(error: unknown): number {
    if (error instanceof HarnessError) {
        // `format()` prints the code, the field, the hint, and every sub-failure — so a command line
        // with two mistakes in it reports both rather than one at a time.
        process.stderr.write(`${error.format()}\n`)
    } else if (error instanceof Error) {
        process.stderr.write(`${error.message}\n`)
        if (readEnv().debug && error.stack !== undefined) process.stderr.write(`${error.stack}\n`)
    } else {
        process.stderr.write(`${String(error)}\n`)
    }
    return EXIT_FAILURE
}

async function dispatch(argv: readonly string[]): Promise<number> {
    const result = parse(argv)

    switch (result.kind) {
        case "version":
            process.stdout.write(`${VERSION}\n`)
            return EXIT_OK

        case "help":
            process.stdout.write(helpText(result.command))
            return EXIT_OK

        case "usage":
            // Invoked with nothing to do. The help goes to stdout because it was not an error in the
            // arguments — but the code is non-zero, because nothing was accomplished.
            process.stdout.write(helpText())
            return EXIT_FAILURE

        case "command":
            break
    }

    const { command, positionals, flags } = result.parsed
    // Present when the command's first argument is required; `init` and `run` legitimately take
    // none. Each case knows which it is.
    const manifestPath = positionals[0] as string
    // Every manifest-taking command accepts a sandbox agent name too — one resolver, applied
    // here at the dispatch layer, so `sessions milo` works the moment `run milo` does. The
    // resolution throws with the candidate list and a nearest-match hint.
    const resolved = (): string => resolveAgentRef(manifestPath)

    switch (command.name) {
        case "init": {
            const dir = positionals[0]
            const user = flags.str("user")
            const name = flags.str("name")
            const purpose = flags.str("purpose")
            const preset = flags.str("preset")
            const model = flags.str("model")
            const baseUrl = flags.str("base-url")
            const apiKeyEnv = flags.str("api-key-env")
            const system = flags.str("system")
            const web = flags.str("web")
            const webBackend = flags.str("web-backend")
            return await initCommand({
                ...(dir === undefined ? {} : { dir }),
                ...(user === undefined ? {} : { user }),
                ...(name === undefined ? {} : { name }),
                ...(purpose === undefined ? {} : { purpose }),
                ...(preset === undefined ? {} : { preset }),
                ...(model === undefined ? {} : { model }),
                ...(baseUrl === undefined ? {} : { baseUrl }),
                ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
                ...(system === undefined ? {} : { system }),
                ...(web === undefined ? {} : { web }),
                ...(webBackend === undefined ? {} : { webBackend }),
                yes: flags.bool("yes"),
                plain: flags.bool("plain"),
            })
        }

        case "run": {
            const session = flags.str("session")
            const input = flags.str("input")
            const store = flags.str("store")
            return await runCommand({
                // Bare `run` hands the sandbox the decision; a given ref resolves path-or-name.
                ...(positionals[0] === undefined ? {} : { manifestPath: resolved() }),
                ...(session === undefined ? {} : { sessionKey: session }),
                ...(input === undefined ? {} : { once: input }),
                ...(store === undefined ? {} : { store }),
                ephemeral: flags.bool("ephemeral"),
                quiet: flags.bool("quiet"),
                showReasoning: flags.bool("show-reasoning"),
                plain: flags.bool("plain"),
            })
        }

        case "sessions": {
            const session = flags.str("session")
            const store = flags.str("store")
            const limit = flags.num("limit")
            return await sessionsCommand({
                manifestPath: resolved(),
                ...(session === undefined ? {} : { sessionKey: session }),
                ...(store === undefined ? {} : { store }),
                ...(limit === undefined ? {} : { limit }),
                json: flags.bool("json"),
                clear: flags.bool("clear"),
                turns: flags.bool("turns"),
            })
        }

        case "validate":
            return validateCommand({ manifestPath: resolved(), json: flags.bool("json") })

        case "workspace":
            return workspaceCommand({
                manifestPath: resolved(),
                json: flags.bool("json"),
                strict: flags.bool("strict"),
            })

        case "soul": {
            const out = flags.str("out")
            return soulCommand({
                // For this command the first positional is the action, not a manifest.
                action: manifestPath,
                file: positionals[1] as string,
                ...(out === undefined ? {} : { out }),
            })
        }

        case "agents":
            return await agentsCommand({
                manifestPaths: positionals.map((ref) => resolveAgentRef(ref)),
                json: flags.bool("json"),
            })

        case "tools":
            return await toolsCommand({
                manifestPath: resolved(),
                warm: flags.bool("warm"),
                json: flags.bool("json"),
            })

        default:
            // Unreachable: `parse` refuses an unknown command with a suggestion. Present so that
            // adding a command to lib/commands.ts without wiring it fails loudly rather than
            // silently doing nothing and exiting 0.
            throw new HarnessError({
                code: "cli_command_unwired",
                message: `Command "${command.name}" is declared but not wired up.`,
                hint: "Add a case for it in src/index.ts.",
            })
    }
}

installGuards()

// One `finish` for every route out, so the terminal is restored and buffered output drains before
// the process ends.
await dispatch(process.argv.slice(2))
    .catch(report)
    .then((code) => finish(code))
