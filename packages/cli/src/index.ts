/**
 * The command line surface.
 *
 * Two commands in Phase 1: `run` for an interactive REPL against any OpenAI-compatible
 * endpoint, and `validate` for checking a manifest without starting anything.
 *
 * Exit codes are load-bearing: 0 only when the thing asked for actually happened. Nothing here
 * prints a warning and exits 0.
 */

import { BRAND, HarnessError, Runtime, VERSION } from "@castellan/core"
import { runRepl } from "./repl.ts"
import { validateCommand } from "./validate.ts"

interface ParsedArgs {
    command: string | undefined
    positionals: string[]
    flags: Map<string, string | true>
}

function parseArgs(argv: readonly string[]): ParsedArgs {
    const positionals: string[] = []
    const flags = new Map<string, string | true>()

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === undefined) continue

        if (arg.startsWith("--")) {
            const body = arg.slice(2)
            const eq = body.indexOf("=")
            if (eq !== -1) {
                flags.set(body.slice(0, eq), body.slice(eq + 1))
                continue
            }
            const next = argv[i + 1]
            if (next !== undefined && !next.startsWith("-")) {
                flags.set(body, next)
                i += 1
            } else {
                flags.set(body, true)
            }
            continue
        }

        if (arg.startsWith("-") && arg.length > 1) {
            flags.set(arg.slice(1), true)
            continue
        }

        positionals.push(arg)
    }

    return { command: positionals[0], positionals: positionals.slice(1), flags }
}

const USAGE = `${BRAND.name} ${VERSION} — a lightweight, model-agnostic agent runtime

usage:
  ${BRAND.slug} run <manifest>        start an interactive session against the manifest's model
  ${BRAND.slug} validate <manifest>   load and validate a manifest, then exit
  ${BRAND.slug} --version
  ${BRAND.slug} --help

run:
  --session <key>     session key to use            (default local:default)
  --input <text>      run one turn, print, exit     (non-interactive)
  --quiet             suppress the banner and stats
  --show-reasoning    print reasoning blocks as they stream

validate:
  --json              machine-readable output

environment:
  ${BRAND.envPrefix}BRAND        rebrand every derived path, env prefix, and apiVersion
`

function fail(error: unknown): never {
    if (error instanceof HarnessError) {
        process.stderr.write(`${error.format()}\n`)
    } else if (error instanceof Error) {
        process.stderr.write(`${error.message}\n`)
        if (process.env.DEBUG !== undefined && error.stack !== undefined) {
            process.stderr.write(`${error.stack}\n`)
        }
    } else {
        process.stderr.write(`${String(error)}\n`)
    }
    process.exit(1)
}

async function main(): Promise<void> {
    const { command, positionals, flags } = parseArgs(process.argv.slice(2))

    if (flags.has("version") || flags.has("v") || command === "version") {
        process.stdout.write(`${VERSION}\n`)
        return
    }

    if (command === undefined || flags.has("help") || flags.has("h") || command === "help") {
        process.stdout.write(USAGE)
        if (command === undefined) process.exitCode = 1
        return
    }

    const manifestPath = positionals[0]

    switch (command) {
        case "run": {
            if (manifestPath === undefined) {
                throw new Error(`run needs a manifest path. hint: ${BRAND.slug} run ./agent.yaml`)
            }
            const input = flags.get("input")
            await runRepl({
                manifestPath,
                ...(typeof flags.get("session") === "string"
                    ? { sessionKey: flags.get("session") as string }
                    : {}),
                ...(typeof input === "string" ? { once: input } : {}),
                quiet: flags.get("quiet") === true,
                showReasoning: flags.get("show-reasoning") === true,
            })
            return
        }

        case "validate": {
            if (manifestPath === undefined) {
                throw new Error(
                    `validate needs a manifest path. hint: ${BRAND.slug} validate ./agent.yaml`,
                )
            }
            await validateCommand({ manifestPath, json: flags.get("json") === true })
            return
        }

        case "agents": {
            // Small, and it proves the runtime hosts N agents from one process.
            if (manifestPath === undefined) {
                throw new Error(`agents needs at least one manifest path.`)
            }
            const runtime = await Runtime.create({ agents: positionals })
            for (const agent of runtime.list()) {
                const d = agent.describe()
                process.stdout.write(`${d.id}\t${d.model}\twindow=${d.window}\t${d.name}\n`)
            }
            await runtime.stop("cli-exit")
            return
        }

        default:
            throw new Error(
                `Unknown command "${command}". hint: run \`${BRAND.slug} --help\` for the command list.`,
            )
    }
}

main().catch(fail)
