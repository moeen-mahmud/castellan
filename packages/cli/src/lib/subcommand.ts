/**
 * Running one of this binary's own commands, for a pane inside a session.
 *
 * ## Why a child process rather than calling the function
 *
 * The obvious implementation is to call `validateCommand()` and swap `process.stdout.write` for a
 * collector. It is also wrong here: Ink *owns* stdout while a session is mounted, and it writes a frame
 * whenever anything re-renders. A frame drawn during the capture window lands in the collector instead of
 * on the terminal — so the screen silently misses a repaint and the pane shows a frame of itself. Nothing
 * errors; the display is just wrong, intermittently, depending on timing.
 *
 * A child writes to its own pipe. Nothing is hijacked, the frame keeps rendering, and the pane shows
 * exactly what the command prints — which is also the honest thing to show, since "run this command" is
 * what the palette offered. The cost is process startup, which is the same ~100 ms every command in this
 * CLI already pays and is invisible next to reading the result.
 *
 * `--plain` is forced, for the reason it exists: a child that thought it had a terminal would return
 * escape sequences, and the pane would render them as text.
 */

import { spawnCaptureAsync } from "#lib/spawn"

export interface SubcommandResult {
    readonly lines: readonly string[]
    readonly code: number
}

export interface SubcommandRequest {
    readonly name: string
    /** Arguments as typed after the command word, split on whitespace. */
    readonly rest: string
    /** The agent this session is running, passed to any command that takes a manifest. */
    readonly manifestPath: string
    /** Injected by tests. `process.execPath` and `process.argv[1]` otherwise. */
    readonly interpreter?: string
    readonly script?: string
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly timeoutMs?: number
}

/** Commands whose first positional argument is *not* a manifest, so the path must not be prepended. */
const NO_MANIFEST = new Set(["sources", "agents", "daemon", "skills"])

/**
 * The argv for a request.
 *
 * Pure and exported so the assembly is testable without starting anything — which matters because
 * getting it wrong means a command runs against the wrong agent, and that is not visible in the output.
 */
export function subcommandArgv(request: SubcommandRequest): readonly string[] {
    const rest = request.rest.trim() === "" ? [] : request.rest.trim().split(/\s+/)
    const manifest = NO_MANIFEST.has(request.name) ? [] : [request.manifestPath]
    // A command that takes an action first — `daemon status`, `skills list` — keeps its own order, and
    // the manifest is not inserted ahead of it. `--plain` last, so it cannot be swallowed as a value.
    return [request.name, ...manifest, ...rest, "--plain"]
}

export async function runSubcommand(request: SubcommandRequest): Promise<SubcommandResult> {
    const interpreter = request.interpreter ?? process.execPath
    const script = request.script ?? process.argv[1] ?? ""
    const result = await spawnCaptureAsync({
        command: interpreter,
        args: [script, ...subcommandArgv(request)],
        ...(request.env === undefined ? {} : { env: request.env }),
        timeoutMs: request.timeoutMs ?? 30_000,
    })

    // stderr is shown, not dropped. A command that failed says why on stderr, and a pane that showed only
    // stdout would render an empty box for the case a person most needs to read.
    const body = [result.stdout, result.stderr].filter((part) => part.trim() !== "").join("\n")
    const lines = body === "" ? [] : body.replace(/\n+$/, "").split("\n")
    if (result.notFound) {
        return { lines: [`could not run ${interpreter}`], code: 1 }
    }
    if (result.signalled) {
        return { lines: [...lines, `${request.name} was stopped before it finished`], code: 1 }
    }
    return { lines, code: result.code }
}
