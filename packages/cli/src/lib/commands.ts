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
        // Distinct from `validate`, which asks whether the manifest loads. This asks whether the
        // *writing* is any good — the authoring rules of 07-SPEC-WORKSPACE.md, which are judgements
        // rather than facts and are therefore warnings that never fail the command.
        name: "workspace",
        summary: "check the workspace files against the authoring rules",
        args: [MANIFEST],
        flags: [
            {
                name: "strict",
                kind: "boolean",
                help: "exit non-zero when any authoring warning is reported",
            },
            JSON_FLAG,
        ],
    },
    {
        // A scaffold, never a summary: headings and <rules> blocks survive verbatim, prose becomes
        // placeholders a person fills. Automatic distillation of an identity document drops exactly
        // the parts that produce voice, which is why this is a command and not something load does.
        name: "soul",
        summary: "scaffold a hand-edited compact identity from a long-form document",
        args: [
            { name: "action", required: true, help: "distill" },
            { name: "file", required: true, help: "path to the long-form identity document" },
        ],
        flags: [
            {
                name: "out",
                kind: "string",
                placeholder: "path",
                help: "where to write the scaffold",
                defaultHelp: "<file>.compact.md beside the source",
            },
        ],
    },
    {
        name: "agents",
        summary: "list the agents one or more manifests produce",
        args: [{ ...MANIFEST, variadic: true, help: "one or more paths to an agent.yaml" }],
        flags: [JSON_FLAG],
    },
    {
        // The one command whose whole purpose is to make a network call, which is why it is a command
        // rather than something boot does: boot resolves a remote catalogue from disk so that nothing
        // touches the network before readiness, and an empty cache would otherwise deadlock — the load
        // fails on unresolved slugs, so the post-readiness refresh that would have filled it never runs.
        name: "tools",
        summary:
            "show the resolved tool catalogue, or fetch a remote provider's schemas into the cache",
        args: [MANIFEST],
        flags: [
            {
                name: "warm",
                kind: "boolean",
                help: "fetch every pinned slug from the provider and write the resolution cache",
            },
            JSON_FLAG,
        ],
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
