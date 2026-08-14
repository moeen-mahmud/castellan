/**
 * What you can type at a running prompt, as data.
 *
 * The outer CLI's help is generated from `COMMANDS`, so a flag the parser honours cannot be missing
 * from `--help`. The in-session help had no such link: it was a string in a component, and the two
 * drifted in both directions — `/help` was advertised by the banner and unhandled on the plain path,
 * where it was sent to the model as a prompt, while five working key chords went undocumented.
 *
 * So the same discipline applies here. One table drives dispatch *and* the help text, which closes
 * the drift for commands. Key bindings cannot be generated the same way, because they live in a
 * function rather than a table — `keyToIntent` decides what `^C` means from whether a turn is in
 * flight. The loop is closed by tests instead: every documented chord is walked through the real
 * `keyToIntent`, and every chord it honours is required to appear here.
 *
 * Pure, and free of Ink: both renderers dispatch through this, which is what keeps `--plain` and the
 * rich path from answering the same keystroke differently.
 */

import { nearest } from "@castellan/core"

export type SessionCommandKind = "help" | "tools" | "reset" | "exit"

export interface SessionCommandSpec {
    readonly kind: SessionCommandKind
    readonly word: string
    /** Accepted and not advertised individually; they appear beside the canonical word. */
    readonly aliases: readonly string[]
    readonly summary: string
}

export const SESSION_COMMANDS: readonly SessionCommandSpec[] = [
    { kind: "help", word: "/help", aliases: [], summary: "this list" },
    {
        kind: "tools",
        word: "/tools",
        aliases: [],
        summary: "what the model may call, and what the catalogue costs every turn",
    },
    {
        kind: "reset",
        word: "/reset",
        aliases: [],
        summary: "clear this session's history — memory files on disk are untouched",
    },
    { kind: "exit", word: "/exit", aliases: ["/quit", ":q"], summary: "leave" },
]

export interface KeyBindingSpec {
    /** As shown to a reader. Ctrl chords are written `^X`, and the drift test reads them back out. */
    readonly chord: string
    readonly summary: string
}

export const KEY_BINDINGS: readonly KeyBindingSpec[] = [
    { chord: "^C", summary: "cancel the turn in flight — at an idle prompt, leave" },
    { chord: "^D", summary: "leave when the line is empty; delete forward when it is not" },
    { chord: "^A / ^E", summary: "start of line / end of line" },
    { chord: "^B / ^F", summary: "back one character / forward one" },
    { chord: "^U / ^K", summary: "delete to the start of the line / to the end" },
    { chord: "^W", summary: "delete the word before the cursor" },
    { chord: "^P / ^N", summary: "previous / next of what you have already sent" },
    { chord: "↑ / ↓", summary: "the same history, on the arrows" },
]

/**
 * Every Ctrl letter the table documents, read back out of the chord strings rather than listed
 * again — a second list is one more thing that can disagree with the first. The drift test walks
 * these through `keyToIntent` and requires every letter it honours to appear here.
 */
export const DOCUMENTED_CTRL_LETTERS: readonly string[] = KEY_BINDINGS.flatMap((spec) =>
    [...spec.chord.matchAll(/\^([A-Za-z])/g)].map((match) => (match[1] ?? "").toLowerCase()),
)

export type SessionCommand =
    | { readonly kind: SessionCommandKind }
    /** Looked like a command and was not one. Refused rather than billed as a prompt. */
    | { readonly kind: "unknown"; readonly word: string; readonly nearest?: string }

/**
 * One word starting with a slash, and nothing else on the line.
 *
 * Deliberately narrow, because the alternative costs real messages. `/etc/passwd is world-readable`
 * and `and/or` are things a person says to an agent; a second slash or a space means this is prose
 * and goes to the model untouched. What remains — a lone `/word` — can only have been meant as a
 * command, so getting it wrong is worth reporting.
 */
const COMMAND_SHAPE = /^\/[A-Za-z][\w-]*$/

const KNOWN = new Map<string, SessionCommandKind>(
    SESSION_COMMANDS.flatMap((spec) =>
        [spec.word, ...spec.aliases].map((word) => [word.toLowerCase(), spec.kind] as const),
    ),
)

/** `undefined` means "this is a prompt" — the overwhelming majority of lines. */
export function resolveSessionCommand(text: string): SessionCommand | undefined {
    const trimmed = text.trim()
    const kind = KNOWN.get(trimmed.toLowerCase())
    if (kind !== undefined) return { kind }
    if (!COMMAND_SHAPE.test(trimmed)) return undefined

    const suggestion = nearest(trimmed.toLowerCase(), [...KNOWN.keys()])
    return {
        kind: "unknown",
        word: trimmed,
        ...(suggestion === undefined ? {} : { nearest: suggestion }),
    }
}

const COMMAND_COLUMN = 20

function commandLine(spec: SessionCommandSpec): string {
    const forms = [spec.word, ...spec.aliases].join(" / ")
    return `  ${forms.padEnd(COMMAND_COLUMN)}${spec.summary}`
}

function keyLine(spec: KeyBindingSpec): string {
    return `  ${spec.chord.padEnd(COMMAND_COLUMN)}${spec.summary}`
}

/** Generated, so a command the prompt honours cannot be missing from it. */
export function sessionHelpText(): string {
    return [
        "commands:",
        ...SESSION_COMMANDS.map(commandLine),
        "",
        "keys:",
        ...KEY_BINDINGS.map(keyLine),
    ].join("\n")
}

export function unknownCommandText(command: {
    readonly word: string
    readonly nearest?: string
}): string {
    const suggestion = command.nearest === undefined ? "" : ` Did you mean ${command.nearest}?`
    return `${command.word} is not a command.${suggestion} Type /help for the list — or add a space if you meant to say it to the model.`
}

/** The narrow slice of an agent `/tools` reports on. Structural, so core owns no CLI shapes. */
export interface ToolsView {
    readonly dialect: string
    readonly catalogueTokens: number
    readonly tools: readonly {
        readonly slug: string
        readonly mutating: boolean
        readonly summary: string
    }[]
}

/**
 * The part of an agent this needs, stated structurally.
 *
 * `Agent` satisfies it without being named, which keeps the projection below testable with a plain
 * object rather than a live runtime — and a projection nobody can test is one that quietly stops
 * matching what it projects.
 */
export interface AgentToolsSource {
    describe(): { readonly dialect: string; readonly catalogueTokens: number }
    readonly tools: {
        specs(): readonly {
            readonly slug: string
            readonly mutating: boolean
            readonly summary: string
        }[]
    }
}

/** Here rather than in each renderer, so the two cannot show different things. */
export function toolsView(agent: AgentToolsSource): ToolsView {
    const described = agent.describe()
    return {
        dialect: described.dialect,
        catalogueTokens: described.catalogueTokens,
        tools: agent.tools.specs().map((spec) => ({
            slug: spec.slug,
            mutating: spec.mutating,
            summary: spec.summary,
        })),
    }
}

/**
 * What the model can actually call.
 *
 * Worth a command because the catalogue is resolved once at load and is otherwise invisible: when a
 * model will not call a tool you believe is pinned, whether it is *in* the catalogue is the first
 * question, and `catalogueTokens` is the recurring cost of every turn in the session.
 */
export function toolsReport(view: ToolsView): string {
    if (view.tools.length === 0) {
        return `no tools — this agent pinned none, so the model can only reply. Add them under tools.local or tools.pinned. (call format ${view.dialect})`
    }

    const pad = view.tools.reduce((longest, tool) => Math.max(longest, tool.slug.length), 0)
    const rows = view.tools.map(
        (tool) =>
            `  ${tool.slug.padEnd(pad)}  ${tool.mutating ? "write" : "read "}  ${tool.summary}`,
    )
    return [
        // "dialect nlt" led the line once and read as a third tool — and asked about it, the model
        // guessed NLTK, because the dialect is harness plumbing it is never told the name of. The
        // count leads; the protocol is labelled as what it is.
        `${view.tools.length} tool${view.tools.length === 1 ? "" : "s"} · call format ${view.dialect} · catalogue ${view.catalogueTokens} tokens, on every turn`,
        ...rows,
    ].join("\n")
}
