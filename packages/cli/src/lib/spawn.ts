/**
 * The one place in this package that starts a process.
 *
 * There were two callers before this file existed and the second one is what created it: `lib/service.ts`
 * ran `launchctl`, and fetching a skill source needs `git`. The rule the boundaries test enforces is
 * "exactly one module imports `node:child_process`", and its stated reason is that a second call site is a
 * second place a test has to intercept — the first one that forgets reaches somebody's real machine. Two
 * callers of one seam keeps that property; an allowlist with two entries in it loses it, and would go on
 * losing it once per phase.
 *
 * Deliberately thin, and deliberately not clever. Everything specific to a tool — git's four ways of
 * being told not to prompt, launchd's exit-status decoding — belongs to the caller that knows about it.
 * What lives here is "run this, capture what it said, and tell me honestly how it ended".
 *
 * `notFound` is a field rather than an exception because the two callers want different sentences for it:
 * a missing `git` has a remedy the person can act on, and a missing `launchctl` means this is not the
 * operating system the caller thought it was. A shared error message would be wrong for both.
 */

import { spawnSync } from "node:child_process"

export interface SpawnRequest {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd?: string
    /** Replaces the environment entirely when given. Callers spread `process.env` themselves. */
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly timeoutMs?: number
    readonly maxBuffer?: number
}

export interface SpawnResult {
    readonly code: number
    readonly stdout: string
    readonly stderr: string
    /** True when a timeout or a signal ended it, rather than the process choosing to exit. */
    readonly signalled: boolean
    /** True when the command is not on PATH at all. */
    readonly notFound: boolean
}

export function spawnCapture(request: SpawnRequest): SpawnResult {
    const result = spawnSync(request.command, [...request.args], {
        encoding: "utf8",
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env as NodeJS.ProcessEnv }),
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
        ...(request.maxBuffer === undefined ? {} : { maxBuffer: request.maxBuffer }),
    })
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
    return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        signalled: result.signal !== null,
        notFound: code === "ENOENT",
    }
}
