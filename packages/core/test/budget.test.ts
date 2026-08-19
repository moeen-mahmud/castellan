/**
 * The figure the compaction ladder runs on.
 *
 * Two of these tests assert things that are *not* bugs in this module and are the reason it has a
 * shape at all: observing an estimate against itself learns nothing while looking like success, and
 * a `native` prompt's reported cost includes bytes the assembled total never counted. Both mistakes
 * produce a control loop that reports confidently and fires at the wrong time, so both are pinned
 * here rather than left to a comment.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    type Calibration,
    comparableEstimate,
    corrected,
    EMA_ALPHA,
    measuredPressure,
    type Observation,
    observe,
    projectedPressure,
    promptBudget,
    UNCALIBRATED,
} from "../src/context/budget.ts"
import { describe, expect, test } from "./_harness.ts"

describe("calibration", () => {
    test("an uncalibrated estimator is passed through untouched", () => {
        expect(corrected(UNCALIBRATED, 4000)).toBe(4000)
        expect(UNCALIBRATED.samples).toBe(0)
    })

    test("a real observation is learned and applied", () => {
        // The estimator is biased ~10% high by design, so this is the shape of a normal sample.
        const after = observe(UNCALIBRATED, { estimated: 1100, reported: 1000 })
        expect(after.samples).toBe(1)
        expect(after.ratio).toBeCloseTo(0.909, 3)
        expect(corrected(after, 2200)).toBe(2000)
    })

    test("a figure the endpoint never reported teaches ratio 1 — which is why the caller must not pass one", () => {
        // `StepResult.promptTokens` is seeded with our own estimate, so an unreported figure arrives
        // here as an exact match and converges the correction on 1.0. Nothing in this module can tell
        // the difference; `promptTokensReported` is the guard, and this test is why it exists.
        const after = observe(UNCALIBRATED, { estimated: 1000, reported: 1000 })
        expect(after.ratio).toBe(1)
        expect(after.samples).toBe(1)
    })

    const nothing: readonly [string, Observation][] = [
        ["no usage reported", { estimated: 1000, reported: 0 }],
        ["an empty prompt", { estimated: 0, reported: 1000 }],
        ["a negative count", { estimated: 1000, reported: -5 }],
    ]
    test.each(nothing)("%s teaches nothing", (_label, sample) => {
        expect(observe(UNCALIBRATED, sample)).toEqual(UNCALIBRATED)
    })

    const implausible: readonly [string, Observation][] = [
        ["more than double", { estimated: 1000, reported: 2500 }],
        ["less than half", { estimated: 1000, reported: 400 }],
    ]
    test.each(implausible)(
        "a ratio %s is an accounting difference, not bias, and is ignored",
        (_label, sample) => {
            // Ignored rather than clamped: a clamp still drags the ratio to the edge of the band,
            // which is the same wrong lesson learned more slowly.
            expect(observe(UNCALIBRATED, sample)).toEqual(UNCALIBRATED)
        },
    )

    test("an implausible sample does not discard what was already learned", () => {
        const good: Calibration = observe(UNCALIBRATED, { estimated: 1100, reported: 1000 })
        expect(observe(good, { estimated: 1000, reported: 9000 })).toEqual(good)
    })
})

describe("comparing like with like", () => {
    test("wire tokens are added back before an estimate meets a reported figure", () => {
        // Under `native` the tool schemas travel in the request body: absent from the assembled
        // total, present in `prompt_tokens`. Skip this and the correction absorbs the whole
        // catalogue and inflates every later projection.
        expect(comparableEstimate(3000, 900)).toBe(3900)
        expect(comparableEstimate(3000, 0)).toBe(3000)

        const naive = observe(UNCALIBRATED, { estimated: 3000, reported: 3900 })
        const honest = observe(UNCALIBRATED, {
            estimated: comparableEstimate(3000, 900),
            reported: 3900,
        })
        expect(naive.ratio).toBeCloseTo(1.3, 5)
        expect(honest.ratio).toBe(1)
    })
})

describe("pressure", () => {
    test("the denominator is the space the prompt may occupy, not the whole window", () => {
        // The case that made this the denominator: 72% of the window and 97% of the budget
        // `assembleContext` enforces, so the blunt trim is already dropping turns.
        expect(promptBudget(8000, 2000)).toBe(6000)
        const p = projectedPressure({
            estimated: 5800,
            window: 8000,
            reserveOutput: 2000,
            calibration: UNCALIBRATED,
        })
        expect(p.budget).toBe(6000)
        expect(p.fraction).toBeCloseTo(0.967, 3)
    })

    test("a budget cannot be zero or negative, matching assembleContext", () => {
        expect(promptBudget(1000, 1000)).toBe(1)
        expect(promptBudget(1000, 4000)).toBe(1)
    })

    test("a prompt that does not fit reports above 1 rather than clamping", () => {
        const p = projectedPressure({
            estimated: 7000,
            window: 8000,
            reserveOutput: 2000,
            calibration: UNCALIBRATED,
        })
        expect(p.fraction).toBeGreaterThan(1)
    })

    test("the source says where the number came from, so nothing infers it from the value", () => {
        const cold = projectedPressure({
            estimated: 3000,
            window: 8000,
            reserveOutput: 2000,
            calibration: UNCALIBRATED,
        })
        expect(cold.source).toBe("estimated")
        expect(cold.tokens).toBe(3000)

        const warm = projectedPressure({
            estimated: 3300,
            window: 8000,
            reserveOutput: 2000,
            calibration: observe(UNCALIBRATED, { estimated: 1100, reported: 1000 }),
        })
        expect(warm.source).toBe("corrected")
        expect(warm.tokens).toBe(3000)

        const done = measuredPressure({ reported: 3123, window: 8000, reserveOutput: 2000 })
        expect(done.source).toBe("reported")
        expect(done.tokens).toBe(3123)
        expect(done.budget).toBe(6000)
    })
})

describe("the smoothing weight is the one that was measured", () => {
    /**
     * This test exists because a measured constant with no check on it is a guess with better
     * documentation. If somebody changes `EMA_ALPHA` without re-running `bun run eval:budget`, or
     * re-runs it and the endpoint's behaviour has moved, this is what says so.
     */
    test("EMA_ALPHA sits in the committed run's flat band and owns its lowest worst turn", () => {
        const path = join(import.meta.dirname, "..", "..", "..", "evals", "budget", "results.json")
        let raw: string
        try {
            raw = readFileSync(path, "utf8")
        } catch {
            throw new Error(
                `evals/budget/results.json is missing, so the shipped EMA_ALPHA cannot be checked against anything. hint: run \`bun run eval:budget\` against a real endpoint and commit the result.`,
            )
        }

        const results = JSON.parse(raw) as {
            shippedAlpha: number
            flat: readonly string[]
            bestWorstInFlat: string
        }

        expect(results.shippedAlpha).toBe(EMA_ALPHA)
        // Inside the region where mean error cannot tell the strategies apart...
        expect(results.flat).toContain(`ema-${EMA_ALPHA}`)
        // ...and the one inside it with the lowest worst turn, which is what chose it.
        expect(results.bestWorstInFlat).toBe(`ema-${EMA_ALPHA}`)
    })
})
