/**
 * Silence the runtime warnings this project has already decided about, and nothing else.
 *
 * Under Node every command printed two lines of Node's own noise into the middle of its output:
 *
 * ```
 * milo — running
 *   state  running · pid 14922  up 24s
 *
 * (node:30494) ExperimentalWarning: SQLite is an experimental feature and might change at any time
 * (Use `node --trace-warnings ...` to show where the warning was created)
 * ```
 *
 * That warning is true, unavoidable and *already answered*: `node:sqlite` is a deliberate soft-compat
 * target with a documented adapter (`store/sqlite/driver.ts`), CI runs the whole core suite under it,
 * and the six behavioural divergences from `bun:sqlite` are enumerated in that file. Nobody running
 * the binary learns anything from it. It is the same shape as a `trust: "trusted"` declaration with
 * no `trustReason`: **a warning present for every correct run is a warning nobody reads**, and its
 * cost is that it trains the eye to skip the region of the screen where a real warning would appear.
 *
 * Two things keep this from becoming a way to lose warnings that matter.
 *
 * **The list is specific and each entry carries its reason.** Not "drop every `ExperimentalWarning`" —
 * the next experimental API this CLI starts depending on should be loud, because that is news. An
 * entry here is a claim that someone looked at this exact warning and accepted it.
 *
 * **`--trace-warnings` disables the whole mechanism.** Somebody passing it is debugging warnings, and
 * a filter that hides one from the person who explicitly asked to see them is a filter that wastes an
 * afternoon.
 *
 * Wrapping `process.emitWarning` rather than replacing the `warning` listener is deliberate: the
 * listener route means reimplementing Node's `(node:PID) [CODE] Name: message` format and its
 * printed-once `--trace-warnings` hint, and a hand-rolled copy of those drifts from the real thing
 * silently. Wrapping the emitter leaves every warning we do *not* suppress formatted by Node itself.
 *
 * What makes the filter effective is the *call site*, not import order: `openDatabase` reaches
 * `node:sqlite` through a dynamic `import()` inside the function, so the warning fires when a store
 * opens rather than when a module loads, and `index.ts` installs this well before that. The module
 * still imports nothing — pinned by a test — so it stays movable to the front of the graph if an
 * eager `node:sqlite` import ever changes that, and so it can never be the thing that pulls core in
 * early.
 */

interface AcceptedWarning {
    readonly name: string
    /** Matched against the warning text with `includes`, so it is a stable substring, not a regex. */
    readonly contains: string
    /** Why this one is accepted. An entry without a reason is an entry nobody can review. */
    readonly because: string
}

/**
 * Warnings this project has looked at and accepted. Adding a line is a decision; it belongs in a
 * review alongside whatever made the warning appear.
 */
export const ACCEPTED_WARNINGS: readonly AcceptedWarning[] = [
    {
        name: "ExperimentalWarning",
        contains: "SQLite is an experimental feature",
        because:
            "node:sqlite is a declared soft-compat target with an adapter and a dual-runtime test suite; the experimental status is the reason the adapter exists, not news about this run.",
    },
]

/**
 * Whether a warning is one of the accepted set. Pure, so the table above can be asserted without
 * emitting anything into a test runner's output.
 */
export function isAcceptedWarning(name: string, message: string): boolean {
    return ACCEPTED_WARNINGS.some(
        (accepted) => accepted.name === name && message.includes(accepted.contains),
    )
}

/**
 * How the process was invoked. Taken as an argument rather than read here so a test does not depend
 * on the flags its own runner happened to be started with — the filter would silently not install
 * under a `--trace-warnings` test run, and the failure would look like a broken filter.
 */
export interface WarningEnv {
    readonly execArgv: readonly string[]
    readonly nodeOptions: string | undefined
}

/** `--trace-warnings` anywhere in the invocation turns the filter off entirely. */
export function tracingWarnings(env: WarningEnv): boolean {
    const flag = "--trace-warnings"
    return env.execArgv.includes(flag) || (env.nodeOptions ?? "").includes(flag)
}

/** The real emitter, kept so the wrap can be undone and so a second install is a no-op. */
let original: typeof process.emitWarning | undefined

/**
 * Install the filter. Idempotent — wrapping the wrapper would leave the process one frame deeper for
 * every call, and nothing would report it.
 */
export function quietAcceptedWarnings(
    env: WarningEnv = { execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS },
): void {
    if (original) return
    if (tracingWarnings(env)) return

    const emit = process.emitWarning
    original = emit
    process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
        const name = typeof warning === "string" ? nameFrom(rest) : warning.name
        const message = typeof warning === "string" ? warning : warning.message
        if (isAcceptedWarning(name, message)) return
        Reflect.apply(emit, process, [warning, ...rest])
    }
}

/**
 * `process.emitWarning("text", "ExperimentalWarning", code?)` puts the name in the second argument;
 * an omitted one means Node's default of `Warning`.
 */
function nameFrom(rest: readonly unknown[]): string {
    const type = rest[0]
    return typeof type === "string" ? type : "Warning"
}

/** Tests only: put the real emitter back, so each case installs into a fresh process state. */
export function resetForTests(): void {
    if (!original) return
    process.emitWarning = original
    original = undefined
}
