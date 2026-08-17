import { afterEach, describe, expect, test } from "bun:test"
import {
    ACCEPTED_WARNINGS,
    isAcceptedWarning,
    quietAcceptedWarnings,
    resetForTests,
    tracingWarnings,
} from "../src/lib/warnings"

const QUIET = { execArgv: [] as readonly string[], nodeOptions: undefined }

afterEach(() => {
    resetForTests()
})

describe("the accepted table", () => {
    test("every entry carries a reason", () => {
        // An entry nobody can review is an entry that grows into "drop all warnings" one line at a
        // time. The reason is what a reviewer reads instead of the warning text.
        for (const accepted of ACCEPTED_WARNINGS) {
            expect(accepted.because.length).toBeGreaterThan(20)
            expect(accepted.name.length).toBeGreaterThan(0)
            expect(accepted.contains.length).toBeGreaterThan(0)
        }
    })

    test("node:sqlite's experimental warning is accepted", () => {
        expect(
            isAcceptedWarning(
                "ExperimentalWarning",
                "SQLite is an experimental feature and might change at any time",
            ),
        ).toBe(true)
    })

    test("a different experimental warning is not", () => {
        // The point of the table being specific: the next experimental API this CLI depends on is
        // news, and a blanket `ExperimentalWarning` filter would swallow it.
        expect(
            isAcceptedWarning("ExperimentalWarning", "Type stripping is an experimental feature"),
        ).toBe(false)
        expect(isAcceptedWarning("ExperimentalWarning", "vm modules are experimental")).toBe(false)
    })

    test("the name must match, not only the text", () => {
        expect(isAcceptedWarning("Warning", "SQLite is an experimental feature")).toBe(false)
        expect(isAcceptedWarning("DeprecationWarning", "SQLite is an experimental feature")).toBe(
            false,
        )
    })
})

describe("--trace-warnings turns the filter off", () => {
    test("in execArgv", () => {
        expect(tracingWarnings({ execArgv: ["--trace-warnings"], nodeOptions: undefined })).toBe(
            true,
        )
    })

    test("in NODE_OPTIONS", () => {
        expect(
            tracingWarnings({ execArgv: [], nodeOptions: "--enable-source-maps --trace-warnings" }),
        ).toBe(true)
    })

    test("absent from both", () => {
        expect(tracingWarnings({ execArgv: ["--enable-source-maps"], nodeOptions: "" })).toBe(false)
    })

    test("so nothing is wrapped, and an accepted warning still reaches a listener", async () => {
        const seen = await capture(() => {
            quietAcceptedWarnings({ execArgv: ["--trace-warnings"], nodeOptions: undefined })
            process.emitWarning(
                "SQLite is an experimental feature and might change at any time",
                "ExperimentalWarning",
            )
        })
        expect(seen).toEqual([
            "ExperimentalWarning: SQLite is an experimental feature and might change at any time",
        ])
    })
})

describe("installed", () => {
    test("an accepted warning never reaches a listener; anything else does", async () => {
        const seen = await capture(() => {
            quietAcceptedWarnings(QUIET)
            process.emitWarning(
                "SQLite is an experimental feature and might change at any time",
                "ExperimentalWarning",
            )
            process.emitWarning("something worth reading", "ExperimentalWarning")
            process.emitWarning("a plain one")
        })
        expect(seen).toEqual([
            "ExperimentalWarning: something worth reading",
            "Warning: a plain one",
        ])
    })

    test("an Error carries its own name, so the second argument is not consulted", async () => {
        const accepted = new Error("SQLite is an experimental feature and might change")
        accepted.name = "ExperimentalWarning"
        const kept = new Error("SQLite is an experimental feature and might change")
        kept.name = "DeprecationWarning"

        const seen = await capture(() => {
            quietAcceptedWarnings(QUIET)
            process.emitWarning(accepted)
            process.emitWarning(kept)
        })
        expect(seen).toEqual([
            "DeprecationWarning: SQLite is an experimental feature and might change",
        ])
    })

    test("a second call does not wrap the wrapper", () => {
        quietAcceptedWarnings(QUIET)
        const first = process.emitWarning
        quietAcceptedWarnings(QUIET)
        expect(process.emitWarning).toBe(first)
    })

    test("reset puts the real emitter back", () => {
        const real = process.emitWarning
        quietAcceptedWarnings(QUIET)
        expect(process.emitWarning).not.toBe(real)
        resetForTests()
        expect(process.emitWarning).toBe(real)
    })
})

test("the module imports nothing", async () => {
    // Not decoration: this is the one module that may need to move to the front of the import graph
    // if `node:sqlite` ever stops being reached through a dynamic `import()`. A single import here
    // would make it capable of evaluating core — and therefore of opening a store — before the
    // filter it exists to install.
    const source = await Bun.file(
        new URL("../src/lib/warnings.ts", import.meta.url).pathname,
    ).text()
    expect(source).not.toMatch(/^\s*import\s/m)
})

/**
 * Run `emit` with the runtime's own `warning` handlers detached, and return what a listener saw.
 *
 * Detaching matters twice: it keeps Node's default printer from writing the unsuppressed warnings
 * into the test runner's output, and it is the only way to observe that a *suppressed* warning was
 * never dispatched at all rather than merely not printed. `emitWarning` dispatches on a next tick,
 * so the await is required — asserting synchronously sees an empty array whatever the filter does.
 */
async function capture(emit: () => void): Promise<string[]> {
    const seen: string[] = []
    const previous = process.listeners("warning")
    process.removeAllListeners("warning")
    process.on("warning", (warning: Error) => {
        seen.push(`${warning.name}: ${warning.message}`)
    })
    try {
        emit()
        await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
        process.removeAllListeners("warning")
        for (const listener of previous) process.on("warning", listener)
    }
    return seen
}
