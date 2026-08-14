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

// ─── the file family ─────────────────────────────────────────────────────────────────────

export function filePathEmpty(): ToolError {
    return new ToolError({
        code: "file_path_empty",
        message: "A file tool was called with no path.",
        hint: "Give the path field a value — either absolute, or relative to the current working directory, which is wherever the last exec call left it.",
    })
}

export function fileMissing(path: string): ToolError {
    return new ToolError({
        code: "file_missing",
        message: `There is no file at ${path}.`,
        hint: "Check the path against what glob returns rather than guessing at it. A relative path is resolved against the current working directory, which starts at the agent's own directory and moves when a shell command changes it.",
        field: "path",
    })
}

export function fileTooLarge(path: string, size: number, max: number): ToolError {
    return new ToolError({
        code: "file_too_large",
        message: `${path} is ${size} bytes, over the ${max}-byte limit for reading.`,
        hint: "Use grep to find the part that matters and read around it with offset and limit, rather than pulling the whole file into the conversation.",
        field: "path",
    })
}

export function fileIsBinary(path: string, size: number): ToolError {
    return new ToolError({
        code: "file_is_binary",
        message: `${path} is not a text file (${size} bytes).`,
        hint: "Refused rather than decoded: a binary rendered as text is thousands of meaningless tokens and no information. If something about the file is needed — its type, its size, what it contains — a shell command that inspects it will answer better.",
        field: "path",
    })
}

/**
 * The refusal that stops an agent editing its own definition.
 *
 * Worded so the model reports rather than retries: there is no argument that gets past this, and a
 * refusal that reads like a transient failure produces the retry storm `memory_write` once caused.
 */
export function fileProtected(path: string, reason: string): ToolError {
    return new ToolError({
        code: "file_protected",
        message: `${path} cannot be written: ${reason}.`,
        hint: "This is a standing rule and no permission setting overrides it — a rule that authorised writing to the agent's own definition would be a rule authorising its own replacement. Say what change was wanted and let the person make it themselves.",
        field: "path",
    })
}

export function fileEditNoMatch(path: string, find: string): ToolError {
    const preview = find.length > 120 ? `${find.slice(0, 120)}…` : find
    return new ToolError({
        code: "file_edit_no_match",
        message: `That text does not appear in ${path}: ${JSON.stringify(preview)}`,
        hint: "The match is exact, including indentation and line breaks. Read the file and copy the text out of it rather than reconstructing it from memory — nothing was changed, so the file is still as it was.",
        field: "find",
    })
}

export function fileEditAmbiguous(path: string, occurrences: number): ToolError {
    return new ToolError({
        code: "file_edit_ambiguous",
        message: `That text appears ${occurrences} times in ${path}, so it does not identify one place.`,
        hint: "Nothing was changed: picking one of several matches would be a guess, and a wrong guess reports success while editing the wrong line. Include a surrounding line or two to make it unique, or pass all: true if every occurrence should change.",
        field: "find",
    })
}

export function grepPatternInvalid(pattern: string, cause: string): ToolError {
    return new ToolError({
        code: "grep_pattern_invalid",
        message: `That is not a valid regular expression: ${pattern}`,
        hint: `${cause}. Refused rather than searched literally — a literalised pattern finds nothing and returns an empty result, which reads as "it is not there" instead of "the pattern was wrong". Escape any regex character meant literally, such as a dot or a bracket.`,
        field: "pattern",
    })
}
