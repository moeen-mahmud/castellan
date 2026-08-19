/**
 * One test vocabulary, two runners.
 *
 * Phase 2 requires the same suite to pass under `bun test` and `node --test`, because that is the
 * only thing that actually proves the SQLite adapter rather than asserting it. `bun:test` and
 * `node:test` agree on `describe`/`test` and share no assertion library at all — Node ships
 * `assert`, Bun ships `expect` — so this module supplies the missing half.
 *
 * Under Bun it re-exports `bun:test` untouched: the real runner, not an emulation of it. Under
 * Node it wraps `node:test` and implements the twelve matchers this suite actually uses. The list
 * is deliberately closed. A shim that grows to cover a whole assertion library stops being a
 * compatibility layer and becomes a second framework to debug, and a matcher that behaves subtly
 * differently under the two runners is worse than no dual-runtime test.
 *
 * `toEqual` follows Bun's semantics rather than `assert.deepStrictEqual`'s: properties whose
 * value is `undefined` are ignored, and prototypes are not compared. Both matter here —
 * `node:sqlite` returns null-prototype rows, and `exactOptionalPropertyTypes` means records
 * legitimately differ in whether an optional key is present at all.
 */

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

export type TestFn = () => void | Promise<void>

/**
 * `test`, plus `test.each` — a table runner Bun has and `node:test` does not.
 *
 * Only `%s` and `%p` are interpolated into the name, because those are the only placeholders this
 * suite uses. An unrecognised placeholder is left alone rather than guessed at.
 */
export interface TestFunction {
    (name: string, fn: TestFn): void
    each<TRow extends readonly unknown[]>(
        rows: readonly TRow[],
    ): (name: string, fn: (...row: TRow) => void | Promise<void>) => void
}

export interface Suite {
    describe(name: string, fn: () => void): void
    test: TestFunction
    expect(actual: unknown): Expectation
    /**
     * Lifecycle, not assertion — which is why it is here despite the closed-list rule above.
     *
     * The rule is about *matchers*: a shim reimplementing an assertion library drifts from both
     * runners. `beforeEach` and `afterEach` are native to `bun:test` and `node:test` alike, so this
     * re-exports rather than emulates, and there is no behaviour to get subtly wrong. Cleanup is worth
     * having a hook for: a test that leaves temporary directories behind is the same class of litter as
     * the one that left 33 orphaned shells on this machine.
     */
    beforeEach(fn: TestFn): void
    afterEach(fn: TestFn): void
}

export interface Expectation {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toContainEqual(expected: unknown): void
    toThrow(expected?: string | RegExp): void
    toMatch(expected: string | RegExp): void
    toBeGreaterThan(expected: number): void
    toBeGreaterThanOrEqual(expected: number): void
    /**
     * `digits` is decimal places, matching bun's signature: the tolerance is `0.5 * 10 ** -digits`,
     * not `10 ** -digits`. Getting that wrong makes this harness stricter than `bun test`, so a test
     * would pass under one runner and fail under the other — the exact drift this file exists to
     * prevent.
     */
    toBeCloseTo(expected: number, digits?: number): void
    toBeLessThan(expected: number): void
    toBeLessThanOrEqual(expected: number): void
    toBeUndefined(): void
    toBeDefined(): void
    /**
     * Every synchronous matcher, inverted.
     *
     * Derived from the matchers rather than written out, which is the only version worth having: a
     * hand-listed `not` covering three of eleven matchers would pass under `bun test` and fail under
     * this runner with "not a function", which is precisely the drift this file exists to prevent.
     * `rejects` is excluded because inverting it needs the await and a rejection that *matches nothing*
     * is a different claim from one that does not reject at all.
     */
    readonly not: Omit<Expectation, "not" | "rejects">
    readonly rejects: { toThrow(expected?: string | RegExp): Promise<void> }
}

// ─── Node implementation ─────────────────────────────────────────────────────────────────

/** Strip `undefined`-valued keys so `{a: 1}` and `{a: 1, b: undefined}` compare equal. */
function normalise(value: unknown, seen = new Set<object>()): unknown {
    if (value === null || typeof value !== "object") return value
    if (seen.has(value)) return "[circular]"
    seen.add(value)

    if (Array.isArray(value)) return value.map((item) => normalise(item, seen))
    if (value instanceof Date) return `date:${value.toISOString()}`
    if (value instanceof Map) {
        return {
            "@map": [...value.entries()].map(([k, v]) => [normalise(k, seen), normalise(v, seen)]),
        }
    }
    if (value instanceof Set) return { "@set": [...value].map((v) => normalise(v, seen)) }

    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
        const item = (value as Record<string, unknown>)[key]
        if (item === undefined) continue
        out[key] = normalise(item, seen)
    }
    return out
}

function deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b))
}

function show(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "bigint") return `${value}n`
    if (value instanceof RegExp) return String(value)
    try {
        return JSON.stringify(normalise(value)) ?? String(value)
    } catch {
        return String(value)
    }
}

class AssertionFailure extends Error {
    constructor(message: string) {
        super(message)
        this.name = "AssertionFailure"
    }
}

function fail(message: string): never {
    throw new AssertionFailure(message)
}

function matchesError(error: unknown, expected: string | RegExp | undefined): boolean {
    if (expected === undefined) return true
    const message = error instanceof Error ? error.message : String(error)
    return typeof expected === "string" ? message.includes(expected) : expected.test(message)
}

function nodeExpect(actual: unknown): Expectation {
    const requireNumber = (label: string): number => {
        if (typeof actual !== "number") {
            fail(`${label} needs a number, got ${show(actual)}`)
        }
        return actual
    }

    return {
        toBe(expected) {
            if (!Object.is(actual, expected)) {
                fail(`expected ${show(actual)} to be ${show(expected)}`)
            }
        },
        toEqual(expected) {
            if (!deepEqual(actual, expected)) {
                fail(`expected ${show(actual)} to equal ${show(expected)}`)
            }
        },
        toContain(expected) {
            if (typeof actual === "string") {
                if (!actual.includes(String(expected))) {
                    fail(`expected ${show(actual)} to contain ${show(expected)}`)
                }
                return
            }
            if (Array.isArray(actual)) {
                if (!actual.some((item) => Object.is(item, expected))) {
                    fail(`expected ${show(actual)} to contain ${show(expected)}`)
                }
                return
            }
            fail(`toContain needs a string or array, got ${show(actual)}`)
        },
        toContainEqual(expected) {
            if (!Array.isArray(actual)) fail(`toContainEqual needs an array, got ${show(actual)}`)
            if (!actual.some((item) => deepEqual(item, expected))) {
                fail(`expected ${show(actual)} to contain an item equal to ${show(expected)}`)
            }
        },
        toThrow(expected) {
            if (typeof actual !== "function") {
                fail(`toThrow needs a function, got ${show(actual)}`)
            }
            const invoke = actual as () => unknown
            try {
                invoke()
            } catch (error) {
                if (!matchesError(error, expected)) {
                    const message = error instanceof Error ? error.message : String(error)
                    fail(`threw ${show(message)}, which does not match ${show(expected)}`)
                }
                return
            }
            fail(
                `expected the function to throw${expected === undefined ? "" : ` ${show(expected)}`}`,
            )
        },
        toMatch(expected) {
            if (typeof actual !== "string") fail(`toMatch needs a string, got ${show(actual)}`)
            const ok =
                typeof expected === "string" ? actual.includes(expected) : expected.test(actual)
            if (!ok) fail(`expected ${show(actual)} to match ${show(expected)}`)
        },
        toBeGreaterThan(expected) {
            const value = requireNumber("toBeGreaterThan")
            if (!(value > expected)) fail(`expected ${value} > ${expected}`)
        },
        toBeCloseTo(expected, digits = 2) {
            const value = requireNumber("toBeCloseTo")
            const tolerance = 0.5 * 10 ** -digits
            if (!(Math.abs(value - expected) < tolerance)) {
                fail(`expected ${value} to be within ${tolerance} of ${expected}`)
            }
        },
        toBeGreaterThanOrEqual(expected) {
            const value = requireNumber("toBeGreaterThanOrEqual")
            if (!(value >= expected)) fail(`expected ${value} >= ${expected}`)
        },
        toBeLessThan(expected) {
            const value = requireNumber("toBeLessThan")
            if (!(value < expected)) fail(`expected ${value} < ${expected}`)
        },
        toBeLessThanOrEqual(expected) {
            const value = requireNumber("toBeLessThanOrEqual")
            if (!(value <= expected)) fail(`expected ${value} <= ${expected}`)
        },
        toBeUndefined() {
            if (actual !== undefined) fail(`expected ${show(actual)} to be undefined`)
        },
        toBeDefined() {
            if (actual === undefined) fail("expected the value to be defined")
        },
        rejects: {
            async toThrow(expected) {
                if (!(actual instanceof Promise)) {
                    fail(`rejects needs a promise, got ${show(actual)}`)
                }
                try {
                    await actual
                } catch (error) {
                    if (!matchesError(error, expected)) {
                        const message = error instanceof Error ? error.message : String(error)
                        fail(
                            `rejected with ${show(message)}, which does not match ${show(expected)}`,
                        )
                    }
                    return
                }
                fail("expected the promise to reject")
            },
        },
        get not() {
            return invert(nodeExpect(actual))
        },
    }
}

/**
 * Turn every synchronous matcher into its negation by running it and inverting the outcome.
 *
 * A matcher signals failure by throwing, so "it threw" is exactly "the negation holds". Generic on
 * purpose: a new matcher gains a working `not` with nothing to remember, and there is no list to fall
 * out of date. The message names the matcher, because "expected not to be 5" reads as a value problem
 * when it is a matcher problem.
 */
function invert(expectation: Expectation): Omit<Expectation, "not" | "rejects"> {
    const inverted: Record<string, unknown> = {}
    for (const key of Object.keys(expectation) as (keyof Expectation)[]) {
        if (key === "rejects" || key === "not") continue
        const matcher = expectation[key]
        if (typeof matcher !== "function") continue
        inverted[key] = (...args: unknown[]): void => {
            try {
                ;(matcher as (...rest: unknown[]) => void)(...args)
            } catch {
                return
            }
            fail(`expected .not.${String(key)}(${args.map((arg) => show(arg)).join(", ")}) to hold`)
        }
    }
    return inverted as Omit<Expectation, "not" | "rejects">
}

// ─── Wiring ──────────────────────────────────────────────────────────────────────────────

interface BunTestModule {
    describe: (name: string, fn: () => void) => void
    test: TestFunction
    expect: (actual: unknown) => Expectation
    beforeEach: (fn: TestFn) => void
    afterEach: (fn: TestFn) => void
}

interface NodeTestModule {
    describe: (name: string, fn: () => void) => void
    test: (name: string, fn: TestFn) => void
    beforeEach: (fn: TestFn) => void
    afterEach: (fn: TestFn) => void
}

/** `%s`/`%p` substitution, positionally, matching how this suite writes `each` names. */
function interpolate(name: string, row: readonly unknown[]): string {
    let index = 0
    return name.replace(/%[sp]/g, () => {
        const value = row[index]
        index += 1
        return typeof value === "string" ? value : show(value)
    })
}

function withEach(plain: (name: string, fn: TestFn) => void): TestFunction {
    const fn = plain as TestFunction
    fn.each = <TRow extends readonly unknown[]>(rows: readonly TRow[]) => {
        return (name: string, body: (...row: TRow) => void | Promise<void>): void => {
            for (const [index, row] of rows.entries()) {
                const label = interpolate(name, row)
                // Distinct names even when a table has duplicate rows: node:test keys its report
                // by name, and two identical names read as one flaky test rather than two passes.
                plain(label === name ? `${name} [${index}]` : label, () => body(...row))
            }
        }
    }
    return fn
}

const suite: Suite = await (async (): Promise<Suite> => {
    if (isBun) {
        const mod = (await import("bun:test")) as unknown as BunTestModule
        return {
            describe: mod.describe,
            test: mod.test,
            expect: mod.expect,
            beforeEach: mod.beforeEach,
            afterEach: mod.afterEach,
        }
    }
    const mod = (await import("node:test")) as unknown as NodeTestModule
    return {
        describe: mod.describe,
        test: withEach(mod.test),
        expect: nodeExpect,
        beforeEach: mod.beforeEach,
        afterEach: mod.afterEach,
    }
})()

export const describe = suite.describe
export const test = suite.test
export const expect = suite.expect
export const beforeEach = suite.beforeEach
export const afterEach = suite.afterEach
/** Which runner is executing, for a test that legitimately needs to know. */
export const runner: "bun" | "node" = isBun ? "bun" : "node"

/** `Bun.sleep` is not a standard global. Tests that need to yield use this instead. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
