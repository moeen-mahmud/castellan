/**
 * The command table — data only, no rendering and no parsing.
 *
 * One source of truth for three consumers: `args.ts` parses against it, `help.ts` renders from it,
 * and error messages look flags up in it to say which command *does* accept a flag. Before this
 * existed the usage text was a hand-maintained string with no link to the parser, and it had
 * already drifted — `agents` accepted flags it never documented.
 *
 * Nothing here contains the product name. Command names come from `BRAND.slug`, so a rename stays
 * the one-commit operation hard rule 3 requires.
 */

import { BRAND } from "@castellan/core"
import { DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT } from "#lib/const"
import type { ArgSpec, CommandSpec, FlagSpec } from "#lib/schema"

/** Accepted by every command, so the render mode is answered the same way everywhere. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
    {
        name: "plain",
        kind: "boolean",
        help: "force plain text — no interactive rendering, no colour",
    },
    { name: "help", short: "h", kind: "boolean", help: "show this help and exit" },
    { name: "version", short: "v", kind: "boolean", help: "print the version and exit" },
]

const MANIFEST: ArgSpec = {
    name: "manifest",
    required: true,
    help: "path to an agent.yaml",
}

const STORE: FlagSpec = {
    name: "store",
    kind: "string",
    placeholder: "path",
    help: "session database",
    defaultHelp: `${BRAND.stateDir}/store.db`,
}

const SESSION: FlagSpec = {
    name: "session",
    kind: "string",
    placeholder: "key",
    help: "session key",
}

const JSON_FLAG: FlagSpec = { name: "json", kind: "boolean", help: "machine-readable output" }

export const COMMANDS: readonly CommandSpec[] = [
    {
        name: "run",
        summary: "start an interactive session against the manifest's model",
        args: [MANIFEST],
        flags: [
            { ...SESSION, defaultHelp: "local:default" },
            {
                name: "input",
                kind: "string",
                placeholder: "text",
                help: "run one turn, print the reply, exit",
            },
            STORE,
            {
                name: "ephemeral",
                kind: "boolean",
                help: "keep this session in memory only; nothing is written",
            },
            { name: "quiet", kind: "boolean", help: "suppress the banner and per-turn stats" },
            {
                name: "show-reasoning",
                kind: "boolean",
                help: "print reasoning blocks as they stream",
            },
        ],
    },
    {
        name: "sessions",
        summary: "list stored sessions, or inspect one",
        args: [MANIFEST],
        flags: [
            { ...SESSION, help: "show one session instead of the list" },
            { name: "turns", kind: "boolean", help: "show turn records instead of messages" },
            {
                name: "clear",
                kind: "boolean",
                help: "delete the named session's history; memory files are untouched",
            },
            {
                name: "limit",
                kind: "number",
                placeholder: "n",
                help: "rows to show",
                defaultHelp: String(DEFAULT_ROW_LIMIT),
                min: MIN_ROW_LIMIT,
                integer: true,
            },
            STORE,
            JSON_FLAG,
        ],
    },
    {
        name: "validate",
        summary: "load and validate a manifest, then exit",
        args: [MANIFEST],
        flags: [JSON_FLAG],
    },
    {
        name: "agents",
        summary: "list the agents one or more manifests produce",
        args: [{ ...MANIFEST, variadic: true, help: "one or more paths to an agent.yaml" }],
        flags: [JSON_FLAG],
    },
]

export function findCommand(name: string): CommandSpec | undefined {
    return COMMANDS.find((command) => command.name === name)
}

/** Every flag a command accepts: its own plus the global ones. */
export function flagsFor(command: CommandSpec): readonly FlagSpec[] {
    return [...command.flags, ...GLOBAL_FLAGS]
}

/**
 * Commands other than `exclude` that declare `flag`.
 *
 * Turns "unknown flag --json" — true but useless, since `--json` plainly exists — into a message
 * that names where it does work.
 */
export function commandsAccepting(flag: string, exclude: string): readonly string[] {
    return COMMANDS.filter(
        (command) => command.name !== exclude && command.flags.some((f) => f.name === flag),
    ).map((command) => command.name)
}
