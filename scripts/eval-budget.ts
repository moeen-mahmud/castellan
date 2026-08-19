/**
 * Measure how the estimator's bias drifts inside one session, and pick the smoothing weight from it.
 *
 * `context/budget.ts` corrects `estimateTokens` against the endpoint's own `prompt_tokens`, one call
 * late. How that correction is folded — last value, running mean, or an exponential moving average —
 * is a claim about the bias, and the claim decides when the compaction ladder fires. This script
 * settles it with numbers instead of taste.
 *
 * ## What is measured
 *
 * A synthetic session (`evals/fixtures/budget.ts`) grows turn by turn from prose into
 * observation-heavy work, which is the arc of a real session and the mechanism by which the bias
 * could drift: JSON and shell output tokenise worse per character than English, so a constant
 * characters-per-token divisor gets progressively more wrong as a conversation fills with tool
 * results. At each turn the prompt is assembled through the **real** `assembleContext`, sent with
 * `max_tokens: 1`, and the reply discarded — only `prompt_tokens` is read.
 *
 * That yields a sequence of (estimated, reported) pairs. Each candidate strategy is then scored the
 * way the runtime will actually use it: **one-step-ahead**. Learn from turns 1..t-1, predict turn t,
 * compare with what the endpoint charged. The error reported is therefore the error the ladder would
 * have run on, not a retrospective fit.
 *
 * ## What it does not measure
 *
 * The *value* of the ratio is a fact about one tokeniser and does not transfer between endpoints. The
 * drift and the noise are what α is chosen from, and those are properties of prompt composition — so
 * they transfer in direction, not in magnitude. A run names its endpoint for that reason.
 *
 * Usage:
 *   bun scripts/eval-budget.ts --model <id> --base-url <url> --api-key-env MODEL_API_KEY
 *   bun scripts/eval-budget.ts --manifest examples/reference/agent.yaml
 *   bun scripts/eval-budget.ts --turns 16 --out evals/budget
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SESSION_TURNS } from "../evals/fixtures/budget.ts"
import { assembleContext } from "../packages/core/src/context/assemble.ts"
import { EMA_ALPHA } from "../packages/core/src/context/budget.ts"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { loadManifest } from "../packages/core/src/manifest/load.ts"
import { createChatCompletionsProvider } from "../packages/core/src/model/chat-completions.ts"
import type { ChatMessage } from "../packages/core/src/model/provider.ts"

const FLAGS = [
    "model",
    "base-url",
    "api-key-env",
    "manifest",
    "turns",
    "out",
    "from",
    "help",
] as const

/**
 * Below this prompt size, an error is recorded and excluded from the ranking.
 *
 * The metric has to weight errors the way the ladder does, and the ladder does nothing at all until a
 * prompt is a real fraction of the budget. The first run made the problem obvious: `last` won on mean
 * error while carrying the worst maximum, and every one of those large errors was on a prompt of a
 * few hundred tokens — where the endpoint's fixed chat-template overhead is most of the total and the
 * pressure is indistinguishable from zero. Ranking on those tunes the control for the one regime in
 * which it is switched off.
 *
 * A thousand tokens is chosen as the smallest prompt at which the fixed overhead (~60 tokens here) is
 * under 10% of the total, so the figure being learned is the multiplicative bias rather than the
 * template.
 */
const SCORE_FLOOR_TOKENS = 1000

/**
 * How close on mean error counts as indistinguishable.
 *
 * One percentage point. The committed run put nine strategies inside it, which is the finding: mean
 * error does not choose α, and treating a 0.6-point gap as a result would bake one endpoint's noise
 * into a runtime constant.
 */
const FLAT_BAND = 0.01

/**
 * The identity block, so the assembled prompt has the shape a real one has.
 *
 * Short on purpose: a long fixed prefix would dilute the drift this script exists to see, because a
 * constant block's estimation error is constant and averages the interesting part away.
 */
const IDENTITY =
    "You are a release assistant. You keep entries to one line, change first and reason second."

/** Fractions of the window, matching the shipped defaults so the reported pressures are real. */
const WINDOW = 131_072
const RESERVE_OUTPUT = 4_096

function arg(name: string): string | undefined {
    const prefix = `--${name}`
    const argv = process.argv.slice(2)
    for (const [index, token] of argv.entries()) {
        if (token === prefix) return argv[index + 1]
        if (token.startsWith(`${prefix}=`)) return token.slice(prefix.length + 1)
    }
    return undefined
}

function checkFlags(): string | undefined {
    const unknown = process.argv
        .slice(2)
        .filter((token) => token.startsWith("--"))
        .map((token) => token.slice(2).split("=")[0] ?? "")
        .filter((name) => !FLAGS.includes(name as (typeof FLAGS)[number]))
    if (unknown.length === 0) return undefined
    return `eval-budget: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `--${n}`).join(", ")}. Known: ${FLAGS.map((n) => `--${n}`).join(", ")}.`
}

function loadEnv(): Record<string, string | undefined> {
    try {
        return { ...process.env, ...parseDotEnv(readFileSync(".env", "utf8")) }
    } catch {
        return { ...process.env }
    }
}

interface Target {
    readonly id: string
    readonly baseUrl: string
    readonly apiKeyEnv?: string
}

function resolveTarget(env: Record<string, string | undefined>): Target | string {
    const manifestPath = arg("manifest")
    if (manifestPath !== undefined) {
        const main = loadManifest(manifestPath).manifest.model.main
        return {
            id: main.id,
            baseUrl: main.baseUrl,
            ...(main.apiKeyEnv === undefined ? {} : { apiKeyEnv: main.apiKeyEnv }),
        }
    }
    const id = arg("model") ?? env.MODEL_ID
    if (id === undefined || id === "") {
        return "eval-budget: name a model with --model, set MODEL_ID, or point at an agent with --manifest."
    }
    const baseUrl = arg("base-url") ?? env.MODEL_BASE_URL ?? env.SMALL_MODEL_BASE_URL
    if (baseUrl === undefined || baseUrl === "") {
        return "eval-budget: give --base-url, or set MODEL_BASE_URL. There is no default — one pointing at localhost turns 'not configured' into 'connection refused'."
    }
    const apiKeyEnv =
        arg("api-key-env") ?? (env.MODEL_API_KEY === undefined ? undefined : "MODEL_API_KEY")
    if (apiKeyEnv !== undefined && env[apiKeyEnv] === undefined) {
        return `eval-budget: ${apiKeyEnv} is not set, so ${id} cannot be reached.`
    }
    return { id, baseUrl, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) }
}

interface Sample {
    readonly turn: number
    readonly messages: number
    readonly estimated: number
    readonly reported: number
    readonly ratio: number
    /**
     * `reported - estimated`. Recorded beside the ratio because the first run showed the error is
     * substantially *affine*, not multiplicative: a near-constant +60 from the endpoint's chat
     * template and per-message framing. Averaged into a ratio that offset reads as a wild bias on a
     * small prompt and as nothing on a large one, so keeping both is what makes the shape visible.
     */
    readonly offset: number
    /** Share of history characters that came from a tool observation, the drift mechanism. */
    readonly observationShare: number
}

/** A way of folding observed ratios into one number. Named so the report can rank them. */
interface Strategy {
    readonly name: string
    readonly fold: (previous: number, ratio: number, samples: number) => number
}

const STRATEGIES: readonly Strategy[] = [
    { name: "none", fold: () => 1 },
    { name: "last", fold: (_previous, ratio) => ratio },
    // Running mean: every sample weighted equally, so the first turn still moves the answer at turn 24.
    {
        name: "mean",
        fold: (previous, ratio, samples) => previous + (ratio - previous) / (samples + 1),
    },
    ...[0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((alpha) => ({
        name: `ema-${alpha}`,
        fold: (previous: number, ratio: number) => ratio * alpha + previous * (1 - alpha),
    })),
]

interface Score {
    readonly name: string
    /** Mean absolute percentage error one step ahead, over prompts at or above the score floor. */
    readonly meanError: number
    /** Worst single turn at or above the floor. A control is judged by its worst case. */
    readonly maxError: number
    /** Share of scored turns predicted within 10% — Phase 7A's acceptance criterion. */
    readonly withinTenPercent: number
    /** Every turn including the tiny ones, for transparency about what the floor excluded. */
    readonly meanErrorAllSizes: number
    readonly scored: number
}

/**
 * Score one strategy exactly the way the runtime would use it: learn from the past, predict the next.
 *
 * A retrospective fit over the whole sequence would flatter every strategy and rank them wrongly,
 * because the thing that separates them is precisely how they behave with little history.
 */
function score(strategy: Strategy, samples: readonly Sample[]): Score {
    let ratio = 1
    let seen = 0
    const all: number[] = []
    const scored: number[] = []

    for (const sample of samples) {
        if (seen > 0) {
            const predicted = Math.ceil(sample.estimated * ratio)
            const error = Math.abs(predicted - sample.reported) / sample.reported
            all.push(error)
            // Learning still happens on every sample — the runtime has no floor and would be a
            // different algorithm if it did. Only the *scoring* is floored.
            if (sample.reported >= SCORE_FLOOR_TOKENS) scored.push(error)
        }
        ratio = strategy.fold(ratio, sample.ratio, seen)
        seen += 1
    }

    const mean = (values: readonly number[]): number =>
        values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

    return {
        name: strategy.name,
        meanError: mean(scored),
        maxError: scored.reduce((worst, error) => Math.max(worst, error), 0),
        withinTenPercent:
            scored.length === 0 ? 0 : scored.filter((error) => error <= 0.1).length / scored.length,
        meanErrorAllSizes: mean(all),
        scored: scored.length,
    }
}

function percent(value: number): string {
    return `${(value * 100).toFixed(2)}%`
}

async function main(): Promise<number> {
    const badFlag = checkFlags()
    if (badFlag !== undefined) {
        console.error(badFlag)
        return 2
    }
    if (arg("help") !== undefined) {
        console.log("bun scripts/eval-budget.ts [--model id] [--base-url url] [--api-key-env NAME]")
        console.log("bun scripts/eval-budget.ts --manifest path/to/agent.yaml [--turns n]")
        return 0
    }

    const env = loadEnv()

    /**
     * Re-score a previous run's samples without calling anything.
     *
     * Tuning the *metric* is a separate activity from collecting data, and conflating them means
     * paying for a fresh sweep every time a weighting is questioned — which is a good way to stop
     * questioning weightings.
     */
    const fromPath = arg("from")
    if (fromPath !== undefined) {
        const previous = JSON.parse(readFileSync(fromPath, "utf8")) as {
            model: string
            samples: Sample[]
        }
        report(previous.samples, previous.model, arg("out") ?? join("evals", "budget"), true)
        return 0
    }

    const target = resolveTarget(env)
    if (typeof target === "string") {
        console.error(target)
        return 2
    }

    const turnLimit = Math.max(
        3,
        Math.min(SESSION_TURNS.length, Number(arg("turns") ?? SESSION_TURNS.length)),
    )
    const outDir = arg("out") ?? join("evals", "budget")

    const provider = createChatCompletionsProvider({
        baseUrl: target.baseUrl,
        env,
        ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
        // The whole measurement is `prompt_tokens`, and without this the endpoint sends no usage at
        // all — the run would report the estimator agreeing with itself perfectly.
        streamUsage: true,
    })

    console.log(`model      ${target.id}  (${target.baseUrl})`)
    console.log(`session    ${turnLimit} turns, prose then observation-heavy`)
    console.log(`window     ${WINDOW} with ${RESERVE_OUTPUT} reserved`)
    console.log("")
    console.log("turn  msgs  estimated  reported    ratio  offset  obs-share")

    const samples: Sample[] = []
    const history: ChatMessage[] = []
    let observationChars = 0
    let totalChars = 0

    for (const [index, turn] of SESSION_TURNS.slice(0, turnLimit).entries()) {
        // The turn under measurement is the *input*; everything before it is history. That is the
        // same split `runTurn` makes, so the assembled prompt is the one the runtime would send.
        const assembled = assembleContext({
            identity: IDENTITY,
            history,
            input: turn.kind === "user" ? turn.content : "continue",
            window: WINDOW,
            reserveOutput: RESERVE_OUTPUT,
        })

        const controller = new AbortController()
        let reported = 0
        try {
            for await (const chunk of provider.chat(
                {
                    model: target.id,
                    messages: assembled.messages,
                    temperature: 0,
                    maxTokens: 1,
                },
                controller.signal,
            )) {
                if (chunk.type === "usage") reported = chunk.promptTokens
            }
        } catch (error) {
            console.error(`\neval-budget: turn ${index + 1} failed: ${(error as Error).message}`)
            return 1
        }

        if (reported <= 0) {
            console.error(
                "\neval-budget: the endpoint reported no prompt_tokens, so there is nothing to calibrate against.",
            )
            console.error(
                "  hint: this endpoint may reject `stream_options`. Verify with `bun scripts/verify-endpoints.ts` before reading any figure here as a property of the estimator.",
            )
            return 1
        }

        totalChars += turn.content.length
        if (turn.kind === "observation") observationChars += turn.content.length

        const sample: Sample = {
            turn: index + 1,
            messages: assembled.messages.length,
            estimated: assembled.totalTokens,
            reported,
            ratio: reported / assembled.totalTokens,
            offset: reported - assembled.totalTokens,
            observationShare: totalChars === 0 ? 0 : observationChars / totalChars,
        }
        samples.push(sample)
        console.log(
            `${String(sample.turn).padStart(4)}  ${String(sample.messages).padStart(4)}  ${String(sample.estimated).padStart(9)}  ${String(sample.reported).padStart(8)}  ${sample.ratio.toFixed(4).padStart(7)}  ${String(sample.offset).padStart(6)}  ${percent(sample.observationShare).padStart(9)}`,
        )

        // An observation goes back as a `user` message: that is what the NLT dialect sends
        // (`nlt.ts:738`), so this is the prompt shape the runtime would really produce.
        history.push({
            role: turn.kind === "assistant" ? "assistant" : "user",
            content: turn.content,
        })
    }

    report(samples, target.id, outDir, false)
    return 0
}

/** Rank the strategies and write the results. Shared so `--from` cannot drift from a live run. */
function report(
    samples: readonly Sample[],
    model: string,
    outDir: string,
    rescored: boolean,
): void {
    const scores = STRATEGIES.map((strategy) => score(strategy, samples)).sort(
        (a, b) => a.meanError - b.meanError,
    )
    const best = scores[0]
    if (best === undefined) throw new Error("no strategy scored, which means there were no samples")

    const first = samples[0]
    const last = samples[samples.length - 1]
    const drift = first === undefined || last === undefined ? 0 : last.ratio - first.ratio

    console.log("")
    console.log(
        `drift      ${first?.ratio.toFixed(4)} → ${last?.ratio.toFixed(4)}  (${drift >= 0 ? "+" : ""}${drift.toFixed(4)} over ${samples.length} turns)`,
    )
    console.log("")
    console.log(
        `scored on ${scores[0]?.scored ?? 0} turns at or above ${SCORE_FLOOR_TOKENS} prompt tokens; all-sizes column is every turn`,
    )
    console.log("strategy    mean err   max err   within 10%   all sizes")
    for (const entry of scores) {
        console.log(
            `${entry.name.padEnd(10)}  ${percent(entry.meanError).padStart(8)}  ${percent(entry.maxError).padStart(8)}  ${percent(entry.withinTenPercent).padStart(10)}  ${percent(entry.meanErrorAllSizes).padStart(9)}`,
        )
    }

    // A flat region is the normal outcome and is the answer, not a failure to find one: if nine
    // strategies sit within a point of each other, the argmin is this endpoint's noise and picking it
    // is overfitting. So the report names the region and judges the shipped weight against *that*,
    // then falls back to the worst-turn column, which is what actually discriminates.
    const flat = scores.filter((entry) => entry.meanError <= best.meanError + FLAT_BAND)
    const shipped = `ema-${EMA_ALPHA}`
    const inFlat = flat.some((entry) => entry.name === shipped)
    const worstInFlat = flat.reduce(
        (lowest, entry) => (entry.maxError < lowest.maxError ? entry : lowest),
        flat[0] ?? best,
    )

    console.log("")
    console.log(`best mean  ${best.name} at ${percent(best.meanError)}`)
    console.log(
        `flat band  ${flat.map((entry) => entry.name).join(", ")}  (within ${percent(FLAT_BAND)} of best)`,
    )
    console.log(
        `best worst ${worstInFlat.name} at ${percent(worstInFlat.maxError)} — the column that discriminates`,
    )
    console.log(`shipped    ${shipped} in context/budget.ts`)
    if (!inFlat) {
        console.log(
            `note       the shipped weight is OUTSIDE this run's flat band. Re-read the curve: either the endpoint's behaviour has changed or the weight was chosen against different data.`,
        )
    } else if (worstInFlat.name !== shipped) {
        console.log(
            `note       inside the flat band, but ${worstInFlat.name} has the lower worst turn here. A single run is not a reason to move; two are.`,
        )
    }

    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, "results.json")
    writeFileSync(
        outPath,
        `${JSON.stringify(
            {
                model,
                rescored,
                window: WINDOW,
                reserveOutput: RESERVE_OUTPUT,
                turns: samples.length,
                ratioFirst: first?.ratio,
                ratioLast: last?.ratio,
                drift,
                shippedAlpha: EMA_ALPHA,
                scoreFloorTokens: SCORE_FLOOR_TOKENS,
                flatBand: FLAT_BAND,
                bestMean: best.name,
                flat: flat.map((entry) => entry.name),
                bestWorstInFlat: worstInFlat.name,
                scores,
                samples,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
    console.log(`wrote      ${outPath}`)
}

process.exit(await main())
