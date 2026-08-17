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
    help: "path to an agent.yaml, or the name of a sandbox agent",
}

const STORE: FlagSpec = {
    name: "store",
    kind: "string",
    placeholder: "path",
    help: "session database",
    defaultHelp: `~/${BRAND.stateDir}/store.db`,
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
        // Interactive at a terminal; every question also has a flag so scripts and CI can run it.
        // It never asks for the API key itself — a prompt invites shoulder-surfing and a flag
        // writes the secret into shell history — so the generated .env has an empty line to fill.
        name: "init",
        summary: "create a new agent: manifest, workspace, and env files",
        args: [
            {
                name: "dir",
                required: false,
                help: "target directory (default: ./<agent-name-slug>)",
            },
        ],
        flags: [
            { name: "user", kind: "string", placeholder: "name", help: "your name" },
            { name: "name", kind: "string", placeholder: "name", help: "the agent's name" },
            {
                name: "purpose",
                kind: "string",
                placeholder: "text",
                help: "one line: what the agent is for",
            },
            {
                name: "preset",
                kind: "string",
                placeholder: "id",
                help: "model endpoint: openai | anthropic | deepseek | ollama | custom",
                defaultHelp: "openai",
            },
            { name: "model", kind: "string", placeholder: "id", help: "model id" },
            { name: "base-url", kind: "string", placeholder: "url", help: "endpoint base URL" },
            {
                name: "api-key-env",
                kind: "string",
                placeholder: "VAR",
                help: "env var that will hold the key; omitted for ollama",
                defaultHelp: "MODEL_API_KEY",
            },
            {
                name: "system",
                kind: "string",
                placeholder: "level",
                help: "what it may touch on this machine: none | read | write | full",
                defaultHelp: "none",
            },
            {
                name: "web",
                kind: "string",
                placeholder: "level",
                help: "internet access: none | fetch | search",
                defaultHelp: "none",
            },
            {
                name: "web-backend",
                kind: "string",
                placeholder: "id",
                help: "search backend when --web search: tavily | brave | exa",
                defaultHelp: "tavily",
            },
            {
                name: "composio",
                kind: "string",
                placeholder: "level",
                help: "your other apps via Composio: none | connected",
                defaultHelp: "none",
            },
            {
                name: "telegram",
                kind: "string",
                placeholder: "level",
                help: "reachable on Telegram: none | connected",
                defaultHelp: "none",
            },
            {
                name: "telegram-allow",
                kind: "string",
                placeholder: "@handle",
                help: "who may message it — empty permits nobody, which is the safe default",
            },
            {
                name: "server",
                kind: "string",
                placeholder: "level",
                help: "serve the HTTP API: none | local",
                defaultHelp: "none",
            },
            {
                name: "skills",
                kind: "string",
                placeholder: "level",
                // A phrase as well as a level, because the interesting answer is "find me one". The
                // default stays `starter` so a scripted run reaches no network.
                help: 'none | starter, or words to search the catalogues for — --skills "pdf tables"',
                defaultHelp: "starter",
            },
            {
                name: "daemon",
                kind: "string",
                placeholder: "level",
                help: "keep it running in the background: none | service",
                defaultHelp: "none",
            },
            {
                name: "yes",
                kind: "boolean",
                help: "take every default; never ask, even at a terminal",
            },
        ],
    },
    {
        name: "run",
        summary: "start an interactive session — bare `run` picks from the sandbox",
        args: [
            {
                ...MANIFEST,
                required: false,
                help: "path or sandbox agent name (omit to pick from the sandbox)",
            },
        ],
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
                name: "no-reasoning",
                kind: "boolean",
                help: "hide the thinking a reasoning model streams (shown by default)",
            },
            {
                // Kept so existing scripts keep working. Reasoning is on by default now, so this
                // asks for what already happens — harmless, and cheaper than breaking a flag people
                // have in their shell history.
                name: "show-reasoning",
                kind: "boolean",
                help: "no-op: reasoning is shown by default when the model has any",
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
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    { value: "distill", help: "scaffold a compact identity beside the source" },
                ],
            },
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
        // Three questions rather than one. `validate` warns and exits 0 like `workspace` does, because
        // everything it reports is a judgement — a skill that does not load has already failed by then.
        name: "skills",
        summary: "this agent's skills: install from a source, scaffold, list, check",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    { value: "list", help: "every skill, its size, and whether it ships scripts" },
                    {
                        value: "show",
                        help: "one skill in full, including what the model never sees",
                    },
                    {
                        value: "new",
                        help: "scaffold a skill, turning skills on for this agent if they are not",
                    },
                    {
                        value: "install",
                        help: "install one by name — anthropic/pdf — or copy from a local path (see `sources`)",
                    },
                    { value: "remove", help: "delete a skill's directory and everything in it" },
                    { value: "validate", help: "authoring warnings — never a refusal" },
                ],
            },
            MANIFEST,
            {
                name: "name",
                required: false,
                help: "the skill for show, new and remove — for install, <source>/<skill> or a local path",
            },
        ],
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
        // Machine-level, so it takes no manifest — the split from `skills` that keeps every positional
        // here meaning one thing. A source is a place the person trusts; a skill is one agent's.
        name: "sources",
        summary: "the repositories skills come from: list, add, search",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    { value: "list", help: "every source, and whether it has been fetched" },
                    { value: "add", help: "add a repository — a URL, or a name and a URL" },
                    { value: "remove", help: "stop searching a source; built-ins included" },
                    { value: "update", help: "re-fetch every source, or the ones named" },
                    {
                        value: "search",
                        help: "find a skill across every source; fetches on first use",
                    },
                ],
            },
            {
                name: "rest",
                required: false,
                variadic: true,
                help: "a name and URL for add, a name for remove or update, words for search",
            },
        ],
        flags: [
            {
                name: "path",
                kind: "string",
                placeholder: "dir",
                help: "subdirectory holding the skills (add)",
                defaultHelp: "the whole repository",
            },
            {
                name: "ref",
                kind: "string",
                placeholder: "branch",
                help: "branch or tag to track (add)",
                defaultHelp: "the remote's default branch",
            },
            JSON_FLAG,
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
    {
        // The only command that opens a listening socket, and the only one that starts channels.
        // `run` builds the same runtime without them: a REPL that quietly began answering Telegram
        // while you typed at it would be a surprise.
        name: "serve",
        summary: "run the HTTP API and connect the agent's channels",
        args: [MANIFEST],
        flags: [
            {
                name: "port",
                kind: "number",
                placeholder: "n",
                help: "port to bind",
                defaultHelp: "server.port, or 7420",
            },
            {
                name: "host",
                kind: "string",
                placeholder: "addr",
                help: "address to bind — a non-loopback host requires an API token",
                defaultHelp: "server.host, or 127.0.0.1",
            },
            STORE,
            JSON_FLAG,
        ],
    },
    {
        // The switch that turns everything off. Separate from `daemon stop`, which needs you to
        // know the agent: this one finds the services *and* a `serve` left in a forgotten tab.
        name: "stop",
        summary: "stop everything — background services and any session serving an agent",
        args: [
            {
                name: "agent",
                required: false,
                help: "path or sandbox agent name (omit to stop every agent)",
            },
        ],
        flags: [
            {
                name: "dry-run",
                kind: "boolean",
                help: "list what would be stopped; stop nothing",
            },
            JSON_FLAG,
        ],
    },
    {
        // `serve` stays up only as long as its terminal, which makes an agent configured for a
        // channel answer only while a window is open. This installs it as a supervised service.
        //
        // Second action-as-positional command after `soul` — and the reason `ArgSpec.choices`
        // exists, since seven verbs hidden inside a prose help string is a set nothing can check.
        name: "daemon",
        summary: "keep an agent serving in the background — starts at login, restarts on crash",
        args: [
            {
                name: "action",
                required: true,
                help: "what to do",
                choices: [
                    {
                        value: "install",
                        help: "check it will boot, write the service, load it, and watch it start",
                    },
                    { value: "uninstall", help: "unload it and remove the service definition" },
                    { value: "start", help: "load it again after a stop" },
                    { value: "stop", help: "unload it, and keep it stopped across a login" },
                    { value: "restart", help: "what you run after editing agent.yaml or .env" },
                    {
                        value: "status",
                        help: "running? how many restarts? why did it stop? — bare, reports every agent",
                    },
                    { value: "logs", help: "the tail of stderr; --lines, --truncate" },
                ],
            },
            {
                name: "agent",
                // Optional so a bare `daemon status` can answer "is anything running?" — the
                // question people actually have, and one that should not require naming an agent.
                required: false,
                help: "path or sandbox agent name (omit only for status)",
            },
        ],
        flags: [
            {
                name: "lines",
                kind: "number",
                placeholder: "n",
                integer: true,
                min: 1,
                help: "how much of the log to show",
                defaultHelp: "40",
            },
            { name: "truncate", kind: "boolean", help: "empty the log files (logs)" },
            {
                name: "dry-run",
                kind: "boolean",
                help: "print the service definition and the checks; write nothing",
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
