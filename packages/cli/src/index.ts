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
import { parse } from "#lib/args"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { readEnv } from "#lib/env"
import { finish, installGuards } from "#lib/exit"
import { helpText } from "#lib/help"
import { runCommand } from "#run"
import { sessionsCommand } from "#sessions"
import { toolsCommand } from "#tools"
import { validateCommand } from "#validate"

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
    // Guaranteed by the parser: every command declares a required first argument.
    const manifestPath = positionals[0] as string

    switch (command.name) {
        case "run": {
            const session = flags.str("session")
            const input = flags.str("input")
            const store = flags.str("store")
            return await runCommand({
                manifestPath,
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
                manifestPath,
                ...(session === undefined ? {} : { sessionKey: session }),
                ...(store === undefined ? {} : { store }),
                ...(limit === undefined ? {} : { limit }),
                json: flags.bool("json"),
                clear: flags.bool("clear"),
                turns: flags.bool("turns"),
            })
        }

        case "validate":
            return validateCommand({ manifestPath, json: flags.bool("json") })

        case "agents":
            return await agentsCommand({ manifestPaths: positionals, json: flags.bool("json") })

        case "tools":
            return await toolsCommand({
                manifestPath,
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
