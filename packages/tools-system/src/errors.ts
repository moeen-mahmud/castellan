/**
 * Every failure this package can produce, each with a hint.
 *
 * Built on core's `ConfigError` / `ToolError` rather than a local error type, so a shell failure is
 * reported and rendered exactly like a manifest or a Composio failure. The package is a provider,
 * not a second error vocabulary.
 */

import { ConfigError, ToolError } from "@castellan/core"

export function execCommandEmpty(): ToolError {
    return new ToolError({
        code: "exec_command_empty",
        message: "exec was called with no command.",
        hint: "Put the whole shell command in the command field, exactly as it would be typed at a prompt — for example `ls -la` or `npm test`.",
    })
}

export function execWorkdirMissing(path: string, remembered: boolean): ConfigError {
    return new ConfigError({
        code: "exec_workdir_missing",
        message: `The directory to run in does not exist: ${path}`,
        hint: remembered
            ? "This is where a previous exec call left the shell, and it has since been removed or renamed. The remembered directory has been cleared, so the next call starts from the agent's own directory; pass workdir to choose a different one."
            : "workdir must name a directory that already exists. A relative path is resolved against the directory the last exec call ended in, the way a shell would.",
        field: "workdir",
    })
}

export function execPtyUnavailable(platform: string, cause: string): ToolError {
    return new ToolError({
        code: "exec_pty_unavailable",
        message: `A terminal was requested and this machine cannot provide one: ${cause}`,
        hint: `pty: true allocates a terminal with the system \`script\` command, which is missing or unusable on this ${platform} host. Refused rather than quietly falling back to a pipe: the fallback would run the command with no terminal while the observation claimed otherwise, and a program that checks isatty() would take the other branch with nothing reporting it. Re-run with pty omitted if the command does not need one.`,
        field: "pty",
    })
}

export function execSpawnFailed(command: string, cause: string): ToolError {
    return new ToolError({
        code: "exec_spawn_failed",
        message: `The shell could not be started for: ${command}`,
        hint: `The operating system refused before the command ran, so nothing was executed: ${cause}. This is a failure of the host rather than of the command — check that /bin/sh exists and that the directory is readable.`,
    })
}
