/**
 * One way out of the process.
 *
 * Two failure modes this exists to prevent, both of which the previous CLI had:
 *
 * **A hidden cursor and a terminal left in raw mode.** Ink hides the cursor and puts stdin in raw
 * mode. `process.exit()` from anywhere else — an error path, a signal, an uncaught rejection —
 * skips React's cleanup, and the shell you get back does not echo what you type. Recovering needs
 * `stty sane`, and nothing tells you that. So the restore is registered on `process.on("exit")`
 * as well as run explicitly: whatever route the process takes out, the terminal is handed back.
 *
 * **Truncated output.** `process.stdout.write` to a *pipe* is asynchronous, and `process.exit()`
 * discards whatever has not flushed — so a `sessions … | head` invocation could lose its last lines,
 * intermittently and only when piped. The rule here is to set `process.exitCode` and let the event
 * loop drain. `process.exit` is called only where the alternative is hanging: a crash guard, or a
 * signal arriving while something unref'd holds the loop open.
 */

import { once } from "node:events"
import { EXIT_FAILURE, EXIT_SIGTERM, RESET_STYLE, SHOW_CURSOR } from "#lib/const"
import type { TerminalHandles } from "#lib/schema"

/**
 * The real streams. Spelled out rather than passing `process` itself, which has no `in`/`out` —
 * that mistake typechecked against the structural type and threw only at runtime, inside the one
 * function whose entire job is to run when things have already gone wrong.
 */
function processHandles(): TerminalHandles {
    return { out: process.stdout, in: process.stdin }
}

type Teardown = () => void | Promise<void>

const teardowns: Teardown[] = []
let guardsInstalled = false
let restored = false
let dirty = false

/**
 * Declare that the terminal has been put into a state that needs undoing — raw mode, a hidden
 * cursor, alternate styling. Only the rich path does this.
 *
 * Without the flag, the restore would fire on *every* exit, including the plain path, which puts a
 * cursor-and-style reset at the end of output that is otherwise pure text. That breaks the property
 * plain mode exists for: `--plain` at a terminal has to produce exactly what a pipe produces.
 */
export function markTerminalDirty(): void {
    dirty = true
}

/**
 * Run before the process ends. Registration order is preserved and reversed on the way out, so a
 * later-registered resource is released before the thing it depends on.
 */
export function onExit(teardown: Teardown): void {
    teardowns.push(teardown)
}

/**
 * Synchronous by necessity — `process.on("exit")` cannot await. Idempotent, because it runs both
 * explicitly and from the exit hook.
 */
export function restoreTerminal(handles: TerminalHandles = processHandles()): void {
    if (restored || !dirty) return
    restored = true
    if (handles.in.isTTY === true && handles.in.setRawMode !== undefined) {
        handles.in.setRawMode(false)
    }
    if (handles.out.isTTY === true) handles.out.write(`${RESET_STYLE}${SHOW_CURSOR}`)
}

/** Test seam. Nothing in `src/` outside this module calls it. */
export function resetForTests(options: { readonly dirty?: boolean } = {}): void {
    teardowns.length = 0
    restored = false
    dirty = options.dirty ?? true
}

async function flush(stream: { writableNeedDrain?: boolean }): Promise<void> {
    if (stream.writableNeedDrain === true) {
        await once(stream as unknown as NodeJS.EventEmitter, "drain")
    }
}

/**
 * Wait for stdout to drain.
 *
 * Writing to a *pipe* is asynchronous, so a long session feeding a slow reader accumulates unwritten
 * output in memory. Awaiting this between turns bounds that to one turn's worth.
 */
export function flushOutput(): Promise<void> {
    return flush(process.stdout)
}

async function runTeardowns(): Promise<void> {
    for (const teardown of [...teardowns].reverse()) {
        try {
            await teardown()
        } catch (error) {
            // A failing teardown must not mask the exit code that brought us here, and must not
            // stop the remaining teardowns — the terminal restore is one of them.
            process.stderr.write(
                `warning: cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
            )
        }
    }
    teardowns.length = 0
}

/**
 * The ordinary way out. Returns rather than exiting so buffered stdout drains on its own; callers
 * return from `main` immediately after.
 */
export async function finish(code: number): Promise<void> {
    await runTeardowns()
    restoreTerminal()
    process.exitCode = code
    await flush(process.stdout)
}

/** For a signal or a crash, where waiting for the loop to drain would mean hanging. */
export async function finishNow(code: number): Promise<never> {
    await finish(code)
    process.exit(code)
}

/**
 * Guards for the ways a process dies without being asked to.
 *
 * `SIGINT` is deliberately **not** handled here. During a turn it means "cancel this turn", not
 * "exit" — the chat path owns it, and a guard that exited would break the contract Phase 1
 * established and measured.
 */
export function installGuards(): void {
    if (guardsInstalled) return
    guardsInstalled = true

    // Last line of defence. Runs even when something calls process.exit directly.
    process.on("exit", () => restoreTerminal())

    process.on("SIGTERM", () => {
        void finishNow(EXIT_SIGTERM)
    })

    const crash = (label: string) => (error: unknown) => {
        restoreTerminal()
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
        // Loud and non-zero. An unexpected failure that exits 0 is the thing hard rule 8 forbids.
        process.stderr.write(`\n${label}: ${message}\n`)
        void finishNow(EXIT_FAILURE)
    }
    process.on("uncaughtException", crash("uncaught exception"))
    process.on("unhandledRejection", crash("unhandled rejection"))
}
