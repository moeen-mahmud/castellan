/**
 * Contracts between modules — what the parser produces, what a command takes, what a component
 * receives. Domain shapes live in `types.ts`.
 */

import type { Agent, EventBus } from "@castellan/core"
import type {
    EditorState,
    EnvFacts,
    LiveTurn,
    RenderMode,
    TranscriptItem,
    TranscriptState,
    TurnStats,
    TurnStatus,
} from "#lib/types"

// ─── the command table ───────────────────────────────────────────────────────────────────

export type FlagKind = "boolean" | "string" | "number"

export interface FlagSpec {
    /** Long form, written without the leading dashes. */
    readonly name: string
    readonly short?: string
    readonly kind: FlagKind
    readonly help: string
    /** Shown in help as `--session <key>`. Value-taking flags should set it. */
    readonly placeholder?: string
    /** Appended to the help line in parentheses. */
    readonly defaultHelp?: string
    /** Numbers only. Both are enforced by the parser, not by the call site. */
    readonly min?: number
    readonly integer?: boolean
}

export interface ArgSpec {
    readonly name: string
    readonly required: boolean
    readonly variadic?: boolean
    readonly help: string
    /**
     * The fixed set this argument accepts, when it is a verb rather than a value.
     *
     * Structured rather than prose in `help`, because prose is invisible to every check. `soul`'s
     * single action lived inside its help string for three phases, so nothing could tell whether
     * the command still accepted what the help claimed — and a second action-taking command made
     * that a class of drift rather than one oddity. `help.ts` renders these as an `actions:` block
     * and a test asserts every action the command body accepts appears here, which is the same
     * guarantee the flag table already gives flags.
     */
    readonly choices?: readonly { readonly value: string; readonly help: string }[]
}

export interface CommandSpec {
    readonly name: string
    readonly summary: string
    readonly args: readonly ArgSpec[]
    readonly flags: readonly FlagSpec[]
}

// ─── parser output ───────────────────────────────────────────────────────────────────────

export type FlagValue = string | number | boolean

export interface FlagValues {
    /** Throws if the spec declares this flag as something other than a string. */
    str(name: string): string | undefined
    num(name: string): number | undefined
    /** Absent switches are `false`, never `undefined` — there is no third state. */
    bool(name: string): boolean
    has(name: string): boolean
}

export interface Parsed {
    readonly command: CommandSpec
    readonly positionals: readonly string[]
    readonly flags: FlagValues
}

export type ParseResult =
    | { readonly kind: "command"; readonly parsed: Parsed }
    | { readonly kind: "help"; readonly command: CommandSpec | undefined }
    | { readonly kind: "version" }
    /** Invoked with nothing to do. Print help, exit non-zero — being lost is not success. */
    | { readonly kind: "usage" }

// ─── rendering ───────────────────────────────────────────────────────────────────────────

export interface ModeInputs {
    readonly json: boolean
    readonly plain: boolean
    /** `--input <text>`: one turn, print, exit. */
    readonly oneShot: boolean
    readonly stdinIsTTY: boolean
    readonly stdoutIsTTY: boolean
    readonly env: EnvFacts
}

export interface ModeDecision {
    readonly mode: RenderMode
    /** Printable, and what makes this resolution debuggable rather than mysterious. */
    readonly because: string
}

// ─── process teardown ────────────────────────────────────────────────────────────────────

export interface TerminalHandles {
    readonly out: { write(chunk: string): boolean; readonly isTTY?: boolean | undefined }
    readonly in: {
        readonly isTTY?: boolean | undefined
        setRawMode?: ((mode: boolean) => void) | undefined
    }
}

// ─── command options ─────────────────────────────────────────────────────────────────────

/**
 * Every command takes a plain options object and returns an exit code. It never calls
 * `process.exit` itself: that would discard buffered stdout on a pipe, and it makes a command
 * impossible to call from a test.
 */
export interface RunOptions {
    /** Absent = bare `run`: the sandbox decides (picker, auto-run, or the wizard). */
    readonly manifestPath?: string
    readonly sessionKey?: string
    /** Run a single turn with this input and exit. Non-interactive, and always plain. */
    readonly once?: string
    readonly store?: string
    readonly ephemeral?: boolean
    readonly quiet?: boolean
    readonly showReasoning?: boolean
    /** Turns off the reasoning stream that a thinking model shows by default. */
    readonly noReasoning?: boolean
    readonly plain?: boolean
}

export interface SessionsOptions {
    readonly manifestPath: string
    /** Inspect this session instead of listing them. */
    readonly sessionKey?: string
    readonly store?: string
    readonly json?: boolean
    readonly limit?: number
    /** Delete the named session's history. Requires `sessionKey`. */
    readonly clear?: boolean
    /** Show turn records rather than messages. Requires `sessionKey`. */
    readonly turns?: boolean
}

export interface ValidateOptions {
    readonly manifestPath: string
    readonly json?: boolean
}

export interface InitOptions {
    readonly dir?: string
    readonly user?: string
    readonly name?: string
    readonly purpose?: string
    readonly preset?: string
    readonly model?: string
    readonly baseUrl?: string
    readonly apiKeyEnv?: string
    /** `none`, `read`, or `full` — how much of this machine the agent may touch. */
    readonly system?: string
    readonly web?: string
    readonly webBackend?: string
    /** `none` or `connected` — whether the agent reaches other apps through Composio. */
    readonly composio?: string
    /** `none` or `connected` — whether people can message it on Telegram. */
    readonly telegram?: string
    /** One Telegram handle, or empty for an allowlist that permits nobody. */
    readonly telegramAllow?: string
    /** `none` or `local` — whether to serve the HTTP API on loopback. */
    readonly server?: string
    /** `none` or `starter` — whether to scaffold a skills directory, and whether to seed it. */
    readonly skills?: string
    readonly daemon?: string
    /** Take every default; never ask, even at a terminal. */
    readonly yes?: boolean
    readonly plain?: boolean
}

export interface AgentsOptions {
    readonly manifestPaths: readonly string[]
    readonly json?: boolean
}

// ─── component props ─────────────────────────────────────────────────────────────────────

export interface AppProps {
    readonly agent: Agent
    readonly bus: EventBus
    readonly sessionKey: string
    readonly model: string
    /** Notes printed once above the conversation: version, session, store, any reaped turn. */
    readonly initial: TranscriptState
    readonly showReasoning: boolean
    readonly quiet: boolean
    /**
     * Asked for `/restart`. The component unmounts; whoever mounted it rebuilds the agent.
     *
     * A callback rather than a return value because Ink owns the exit: the screen has to come down
     * before a new runtime prints its banner, and only `useApp().exit` can bring it down.
     */
    readonly onRestart?: (draft: string) => void
    /**
     * A message that was being written when the last agent was torn down.
     *
     * The only state that has to survive a `/restart`, and the only one that cannot survive it on its
     * own: everything else is either persisted in the store or rebuilt from the manifest, while an
     * unsent draft lives in a component that the restart unmounts. History is not carried across —
     * it is the store's, and a restart re-reads it.
     */
    readonly initialDraft?: string
}

export interface TranscriptProps {
    readonly items: readonly TranscriptItem[]
    readonly showReasoning: boolean
    readonly quiet: boolean
}

export interface LiveProps {
    readonly live: LiveTurn
    readonly showReasoning: boolean
    readonly columns: number
}

export interface StatusBarProps {
    readonly status: TurnStatus
    readonly model: string
    readonly sessionKey: string
    readonly elapsedMs: number
    readonly last: TurnStats | undefined
    readonly quiet: boolean
}

export interface PromptProps {
    readonly editor: EditorState
    readonly busy: boolean
}
