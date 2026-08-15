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
    readonly onRestart?: () => void
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
