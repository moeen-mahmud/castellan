/**
 * Starting a command, waiting for it, and stopping it — the part that touches the operating system.
 *
 * ## Output goes to a file, never through a pipe
 *
 * The child's stdout and stderr are both handed the same open file descriptor, so it writes straight
 * to disk and this process never buffers a byte of it. Three things fall out of that, and each one
 * was a design problem before it was a consequence:
 *
 * - **Memory is bounded by construction.** A command printing a gigabyte costs nothing here; only the
 *   preview is ever read back.
 * - **Backgrounding actually works.** A child whose output is piped to us dies of `EPIPE` the moment
 *   we stop reading, so "background it instead of killing it" is not implementable over pipes. With a
 *   file it is `unref()` and nothing else.
 * - **Interleaving is preserved.** One descriptor for both streams means the file holds them in the
 *   order they were written, which is the order a person would have seen at a terminal. The cost is
 *   that the two are no longer distinguishable, and that is the right trade: a compiler's error is
 *   useless without the line of output it refers to.
 *
 * ## The status sidecar
 *
 * A second, tiny file receives the exit code and the final working directory, written by the wrapper
 * after the command finishes. It exists because neither can be trusted from the spawn alone:
 *
 * - Under `pty: true` the command runs beneath `script`, whose own exit status is not the command's
 *   on every platform. A wrong exit code is a *silent* wrong answer — a failed build reported as
 *   green — so it is read from the shell that ran the command rather than inferred from the wrapper.
 * - `cd` changes a directory this process cannot see. Carrying it forward is what makes a sequence of
 *   calls behave like a session (see `session.ts`), and the only way to learn it is to ask the shell.
 *
 * ## Process groups
 *
 * Every child is spawned `detached`, which makes it a process-group leader. That is not about
 * outliving this process — it is what makes `kill(-pid)` reach the whole tree. `sh -c "a | b | c"`
 * killed by pid leaves `b` and `c` running; killed by group, nothing survives.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { open, readFile } from "node:fs/promises"
import { subcommands } from "@castellan/core"
import { execPtyUnavailable, execSpawnFailed } from "./errors.ts"

export type RunEnding = "finished" | "backgrounded" | "killed"

export interface RunRequest {
    readonly command: string
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    /** After this, the command is either backgrounded or killed — never silently waited on. */
    readonly timeoutMs: number
    readonly pty: boolean
    /** Detach as soon as it is clear the command started, rather than waiting for it. */
    readonly background: boolean
    readonly signal: AbortSignal
    /** Merged stdout and stderr. */
    readonly outPath: string
    /** Exit code on the first line, final working directory on the second. */
    readonly statusPath: string
}

export interface RunResult {
    readonly ending: RunEnding
    /** From the sidecar where there is one, from the spawn otherwise. Absent when nothing waited. */
    readonly code?: number
    readonly killedBy?: string
    readonly cwdAfter?: string
    readonly pid?: number
}

/** Long enough for a command that cannot start to say so, short enough to feel immediate. */
const BACKGROUND_GRACE_MS = 250

/** Between asking a process group to stop and insisting. */
const KILL_GRACE_MS = 2_000

/**
 * Commands that are killed at the deadline rather than backgrounded.
 *
 * Not a risk list — a *pointlessness* list. Every entry either has nothing to gain from continuing
 * (`sleep`) or is hanging precisely because it wants an answer from a person: git waiting on
 * credentials or an editor, ssh on a passphrase, sudo on a password. Detaching one of those leaves an
 * invisible process holding a lock or a terminal, waiting for input that can no longer arrive.
 */
const NEVER_BACKGROUNDED = new Set(["sleep", "git", "ssh", "scp", "sudo", "su", "doas"])

/** The command word, ignoring `VAR=value` prefixes and any path leading to the binary. */
function headWord(fragment: string): string {
    for (const word of fragment.split(/\s+/)) {
        if (/^[A-Za-z_]\w*=/.test(word)) continue
        return word.replace(/^.*\//, "").toLowerCase()
    }
    return ""
}

/**
 * Whether an over-running command should be left to finish instead of killed.
 *
 * Read the same way a policy rule is read — every fragment must qualify — because
 * `npm ci && git push` is not backgroundable just because its first half is.
 */
export function backgroundable(command: string): boolean {
    const fragments = subcommands(command)
    if (fragments.length === 0) return false
    return fragments.every((fragment) => !NEVER_BACKGROUNDED.has(headWord(fragment)))
}

/** POSIX single-quoting: everything is literal inside, and `'` closes, escapes, and reopens. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The command, followed by the two lines that report on it.
 *
 * Newline-separated rather than `{ …; }` or `… ;` because the command is written by a model and may
 * legitimately end in a comment, a background `&`, or a here-document — all of which a wrapper that
 * appends on the same line would break. A newline terminates any of them.
 *
 * `$?` is captured on the very next line, before anything else can overwrite it, and re-raised at the
 * end so the spawn's own exit status stays truthful for the non-pty path.
 */
export function buildWrapper(command: string, statusPath: string): string {
    return [
        command,
        "__code=$?",
        `{ printf '%s\\n' "$__code"; pwd; } > ${shellQuote(statusPath)} 2>/dev/null`,
        "exit $__code",
    ].join("\n")
}

/**
 * How to run the wrapper, with or without a terminal.
 *
 * A pty needs a native module or a helper binary, and `script` is the helper every Unix already has.
 * Its two calling conventions differ, which is the whole reason this is a function: util-linux takes
 * the command as a string after `-c`, BSD (and therefore macOS) takes it as trailing argv. Both forms
 * are passed as separate argv entries, so nothing here has to be shell-quoted a second time.
 *
 * `SHELL` is forced to `/bin/sh` for the pty path: util-linux `script` hands its command string to
 * `$SHELL`, and an interactive user's fish or zsh would parse it under different rules than the one
 * the wrapper was written for.
 */
export function commandLine(
    wrapper: string,
    pty: boolean,
    platform: string = process.platform,
): { file: string; args: string[]; env: Record<string, string> } {
    if (!pty) return { file: "/bin/sh", args: ["-c", wrapper], env: {} }
    if (platform === "linux") {
        return {
            file: "script",
            args: ["-qec", `/bin/sh -c ${shellQuote(wrapper)}`, "/dev/null"],
            env: { SHELL: "/bin/sh" },
        }
    }
    return {
        file: "script",
        args: ["-q", "/dev/null", "/bin/sh", "-c", wrapper],
        env: { SHELL: "/bin/sh" },
    }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid
    if (pid === undefined) return
    try {
        // Negative pid means the group. `detached: true` at spawn is what makes the group exist.
        process.kill(-pid, signal)
    } catch {
        // ESRCH — it is already gone, which is the outcome that was being asked for.
    }
}

/** Exit code and final directory, as the wrapper left them. Absent file means it never got there. */
export async function readStatus(path: string): Promise<{ code?: number; cwd?: string }> {
    try {
        const [first, second] = (await readFile(path, "utf8")).split("\n")
        const code = Number.parseInt(first ?? "", 10)
        const cwd = second?.trim()
        return {
            ...(Number.isNaN(code) ? {} : { code }),
            ...(cwd === undefined || cwd === "" ? {} : { cwd }),
        }
    } catch {
        // The shell exited before reaching the wrapper's tail — `exec`, `exit`, or a fatal signal.
        // The spawn's own exit code is used instead, which is right in exactly those cases.
        return {}
    }
}

export async function runCommand(request: RunRequest): Promise<RunResult> {
    const wrapper = buildWrapper(request.command, request.statusPath)
    const { file, args, env } = commandLine(wrapper, request.pty)

    // Opened before the spawn so a failure to create it is reported as itself rather than as a
    // command that mysteriously produced nothing.
    const handle = await open(request.outPath, "w")

    let child: ChildProcess
    try {
        child = spawn(file, args, {
            cwd: request.cwd,
            env: { ...request.env, ...env } as NodeJS.ProcessEnv,
            // stdin is closed rather than inherited: a command that asks a question gets EOF and
            // fails, instead of hanging until the deadline holding a terminal nobody is watching.
            stdio: ["ignore", handle.fd, handle.fd],
            detached: true,
        })
    } catch (cause) {
        await handle.close()
        throw execSpawnFailed(request.command, String(cause))
    }

    const ending = await new Promise<RunResult>((resolve, reject) => {
        let settled = false
        let killedAtDeadline = false
        const timer = setTimeout(
            onDeadline,
            request.background ? BACKGROUND_GRACE_MS : request.timeoutMs,
        )

        const done = (outcome: RunResult): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            request.signal.removeEventListener("abort", onAbort)
            resolve(outcome)
        }

        function onDeadline(): void {
            if (request.background || backgroundable(request.command)) {
                // Left running on purpose. It keeps writing to the output file, which the model is
                // told the path of — so a long build becomes something to check back on rather than
                // something that was thrown away at 120 seconds.
                child.unref()
                done({
                    ending: "backgrounded",
                    ...(child.pid === undefined ? {} : { pid: child.pid }),
                })
                return
            }
            // No `done` here: the kill produces an `exit`, and that is what settles this — which
            // keeps the promise honest about *when* the process actually went away rather than when
            // it was asked to.
            killedAtDeadline = true
            killGroup(child, "SIGTERM")
            const insist = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS)
            insist.unref?.()
        }

        function onAbort(): void {
            // The turn was cancelled. Nothing here can stop the harness abandoning this call, so the
            // only job left is to make sure the child does not outlive it unnoticed.
            killGroup(child, "SIGTERM")
            setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS).unref?.()
        }

        request.signal.addEventListener("abort", onAbort, { once: true })

        child.on("error", (cause) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            request.signal.removeEventListener("abort", onAbort)
            reject(
                request.pty && isMissingBinary(cause)
                    ? execPtyUnavailable(process.platform, String(cause))
                    : execSpawnFailed(request.command, String(cause)),
            )
        })

        child.on("exit", (code, killedBy) => {
            done({
                ending: killedAtDeadline ? "killed" : "finished",
                ...(code === null ? {} : { code }),
                ...(killedBy === null ? {} : { killedBy }),
                ...(child.pid === undefined ? {} : { pid: child.pid }),
            })
        })
    }).finally(() => handle.close())

    const status = await readStatus(request.statusPath)
    return {
        ...ending,
        // The sidecar wins. Under `pty` the spawn's status is `script`'s, not the command's, and a
        // build that failed being reported as exit 0 is the worst shape a bug in here could take.
        ...(status.code === undefined ? {} : { code: status.code }),
        ...(status.cwd === undefined ? {} : { cwdAfter: status.cwd }),
    }
}

function isMissingBinary(cause: unknown): boolean {
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
}
