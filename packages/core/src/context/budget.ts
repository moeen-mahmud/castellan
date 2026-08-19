/**
 * How full the context is, and how much to trust that number.
 *
 * The compaction ladder is a control loop, and every stage threshold is meaningless if the figure
 * driving it is wrong. Two facts make that figure harder than it looks.
 *
 * **The estimator is deliberately biased high.** `estimateTokens` divides characters by a constant
 * and adds newlines, roughly 10% over for English prose, because over-estimating wastes a little
 * budget while under-estimating overflows the window — waste is a rounding error and an overflow is
 * a hard failure. That bias is correct for *assembly* and wrong for a *control*: a ladder run on it
 * fires every stage early, spends model calls on digests nothing needed, and reports pressure a
 * person can see is not there.
 *
 * **The endpoint knows the real number, one call late.** `prompt_tokens` on the previous response is
 * authoritative for the prompt that produced it. So the estimator is calibrated against it — a
 * correction learned from pairs of (what we predicted, what it cost) and applied to the next
 * prediction. One call of lag is acceptable because a prompt grows by a turn at a time, not by an
 * order of magnitude.
 *
 * ## Two things that will silently break this
 *
 * **Comparing an estimate with a reported figure that counted different bytes.** Under the `native`
 * dialect the tool schemas travel in the request body, so they are absent from
 * `assembleContext`'s total and present in the endpoint's `prompt_tokens`. Handing that pair to
 * `observe` teaches it that the estimator runs (say) 40% low, and every later projection is inflated
 * by the whole catalogue. The caller must add `wireTokens` back before observing — `comparableEstimate`
 * exists to make that step impossible to forget, and it is why `observe` takes a labelled object
 * rather than two bare numbers.
 *
 * **Calibrating against a figure that was never reported.** `StepResult.promptTokens` is *seeded*
 * with our estimate and overwritten only when a `usage` chunk arrives, so a reported and an estimated
 * figure are indistinguishable by value. Feeding an unreported one back converges the correction on
 * exactly 1.0 and makes every accuracy check pass by construction. `StepResult.promptTokensReported`
 * is the guard, and it exists for this.
 *
 * ## The denominator is the prompt budget, not the window
 *
 * `manifest/validate.ts` describes the thresholds as fractions of the *context window*. Read
 * literally, the ladder protects nothing on the models this runtime is built for: with an 8,000
 * window and a 2,000 `reserveOutput`, a 5,800-token prompt is 72% of the window — stage `snip` — and
 * 97% of the space `assembleContext` will actually let it have, so the blunt oldest-first trim is
 * already dropping turns while the ladder reports mild pressure. Reasoning models need a large
 * reserve, because reasoning is billed to the output budget, so that is the common case. Pressure is
 * therefore a fraction of `window - reserveOutput`, and the manifest spec says so.
 */

/**
 * What the estimator has learned about its own bias.
 *
 * `ratio` is the multiplier that turns an estimate into a prediction of what the endpoint will
 * charge: above 1 the estimator runs low, below 1 it runs high. Held with the sample count because
 * the count is what tells a reader whether the ratio means anything yet — and because an endpoint
 * that reports no usage at all never leaves zero, which is a state worth being able to see.
 */
export interface Calibration {
    readonly ratio: number
    readonly samples: number
}

/** No observations yet: the estimate is passed through untouched. */
export const UNCALIBRATED: Calibration = { ratio: 1, samples: 0 }

/**
 * The band a single observation must fall inside to be believed.
 *
 * The estimator's bias is a fraction, not a factor. A pair implying it is out by more than double in
 * either direction is describing an accounting difference — a catalogue in the request body, a
 * system prompt the endpoint prepends, a provider that counts images — and absorbing that into the
 * bias correction would move the control for a reason that has nothing to do with the estimator.
 * Such a sample is ignored rather than clamped: a clamp still drags the ratio toward the edge of the
 * band, which is the same wrong lesson learned more slowly.
 */
const RATIO_MIN = 0.5
const RATIO_MAX = 2

/**
 * The estimate that is comparable with a reported figure.
 *
 * `assembleContext` counts the blocks it built. Under `native` the tool schemas are not among them —
 * they go in the request body — so the endpoint charges for tokens the total never saw. Adding them
 * back is what makes the two numbers describe the same prompt.
 */
export function comparableEstimate(assembledTotal: number, wireTokens: number): number {
    return assembledTotal + wireTokens
}

export interface Observation {
    /** What we predicted the prompt would cost, counting the same bytes the endpoint counted. */
    readonly estimated: number
    /** `prompt_tokens` from the response. Only pass a figure the endpoint actually reported. */
    readonly reported: number
}

/**
 * Fold one observation into the calibration.
 *
 * Non-positive numbers teach nothing: a zero reported figure is an endpoint that sent no usage, and
 * a zero estimate is an empty prompt that never happened. Implausible ratios are dropped per the
 * band above. Everything that survives is a real statement about the estimator's bias.
 */
export function observe(current: Calibration, sample: Observation): Calibration {
    if (sample.estimated <= 0 || sample.reported <= 0) return current

    const ratio = sample.reported / sample.estimated
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) return current

    return combine(current, ratio)
}

/**
 * Smoothing weight for the exponential moving average. **Measured, not chosen.**
 *
 * `bun run eval:budget` scores every candidate one-step-ahead against a real endpoint over a session
 * that grows from prose into observation-heavy work, ranking on prompts of 1,000 tokens or more —
 * below that the endpoint's fixed chat-template overhead is most of the total and the ladder is
 * switched off anyway. Committed run: deepseek-v4-pro, 31 turns, `evals/budget/results.json`.
 *
 * | strategy | mean err | worst turn |
 * | --- | --- | --- |
 * | no calibration | 14.21% | 16.60% |
 * | running mean | 14.38% | 47.60% |
 * | last value only | 2.29% | 13.59% |
 * | **ema 0.6** | **2.88%** | **12.00%** |
 * | ema 0.2 | 3.42% | 24.73% |
 *
 * Three things that decided it. Mean error is **flat** from α 0.4 to 1.0 — nine strategies sit within
 * one point of the best — so chasing the argmin there would be fitting one endpoint's noise. Worst
 * turn is not flat, and 0.6 is its minimum across every candidate including `last`. And a control is
 * judged by its worst case: the mean is what it costs on a normal turn, the maximum is what it does
 * on the turn that decides whether a model gets asked for a digest.
 *
 * `last` (α = 1) has the better mean and is not taken, for a reason the eval cannot measure: the
 * fixture is deterministic at temperature 0, so it contains no anomalous sample, and α = 1 hands a
 * single anomaly the entire correction. At 0.6 an outlier moves it by 60% of its deviation and the
 * plausibility band has already refused the extremes. That is a judgement stated rather than
 * smuggled in as a measurement.
 *
 * Exported so the eval can name the shipped value beside its own winner, and asserted in
 * `budget.test.ts` against the committed result — a constant nobody can check is how a measured
 * decision decays back into a guess.
 */
export const EMA_ALPHA = 0.6

/**
 * How a new ratio is folded into the running one: an exponential moving average.
 *
 * A running mean was the alternative and loses because the bias is not constant across a session.
 * As a conversation fills with tool observations the prompt shifts from prose toward JSON and shell
 * output, which tokenise worse per character than the estimator's fixed divisor assumes — so the true
 * ratio drifts, and a mean over two hundred turns lags it the whole way while weighting turn one as
 * heavily as turn two hundred. An EMA (Exponential Moving Average) tracks the drift and still rejects a single odd sample.
 *
 * The first observation is taken whole rather than blended into the 1.0 seed. Blending would spend
 * the first several turns crawling away from a value that was never a measurement — and the early
 * turns are where a session's estimate is smallest, so a lagging correction there is a correction
 * that does nothing.
 */
function combine(current: Calibration, ratio: number): Calibration {
    if (current.samples === 0) return { ratio, samples: 1 }
    return {
        ratio: ratio * EMA_ALPHA + current.ratio * (1 - EMA_ALPHA),
        samples: current.samples + 1,
    }
}

/** Apply the learned correction to a fresh estimate. */
export function corrected(calibration: Calibration, estimated: number): number {
    if (calibration.samples === 0) return estimated
    return Math.ceil(estimated * calibration.ratio)
}

/** Where a pressure figure came from, so nothing has to infer it from the value. */
export type PressureSource = "reported" | "corrected" | "estimated"

export interface Pressure {
    /** Tokens the prompt is believed to cost. */
    readonly tokens: number
    /** `window - reserveOutput`: the space the prompt may actually occupy. */
    readonly budget: number
    /** `tokens / budget`. Above 1 means the prompt does not fit and something must give. */
    readonly fraction: number
    readonly source: PressureSource
}

/** `window - reserveOutput`, floored at 1 — the same arithmetic `assembleContext` performs. */
export function promptBudget(window: number, reserveOutput: number): number {
    return Math.max(1, window - reserveOutput)
}

function pressureOf(tokens: number, budget: number, source: PressureSource): Pressure {
    return { tokens, budget, fraction: budget <= 0 ? 0 : tokens / budget, source }
}

/**
 * Pressure of a prompt about to be sent — an estimate, corrected by what previous calls charged.
 *
 * This is the figure the ladder runs on, because a stage has to be chosen before the prompt is
 * assembled and there is no reported number for a prompt nobody has sent.
 */
export function projectedPressure(input: {
    readonly estimated: number
    readonly window: number
    readonly reserveOutput: number
    readonly calibration: Calibration
}): Pressure {
    const budget = promptBudget(input.window, input.reserveOutput)
    const tokens = corrected(input.calibration, input.estimated)
    return pressureOf(tokens, budget, input.calibration.samples === 0 ? "estimated" : "corrected")
}

/**
 * Pressure of a prompt that has been sent and counted.
 *
 * For the `context.pressure` event and for anything reporting the truth after the fact, where a
 * projection would be a worse answer than the one the endpoint already gave.
 */
export function measuredPressure(input: {
    readonly reported: number
    readonly window: number
    readonly reserveOutput: number
}): Pressure {
    return pressureOf(input.reported, promptBudget(input.window, input.reserveOutput), "reported")
}
