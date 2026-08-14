/**
 * Measure `perRuleSuccess` against a real model, so the rule guard stops running on a guess.
 *
 * The guard in `workspace/rules.ts` refuses a manifest when the stated rule count exceeds what
 * `perRuleSuccess ** n >= reliabilityTarget` permits. Shipped, that constant is 0.90 — a plausible
 * figure from the literature and, for any particular endpoint, a guess. A guard whose input is
 * guessed validates nothing: set it too high and it waves through a workspace the model cannot
 * follow, too low and it refuses one it could.
 *
 * ## What is measured
 *
 * For each rule count n, a system prompt states n orthogonal, programmatically-verifiable rules and
 * the model answers T neutral questions under them. Every rule is checked independently on every
 * reply, so one run of n rules over T tasks yields n×T observations.
 *
 *   perRuleSuccess = satisfied observations / total observations
 *
 * The rules are stated through the real `renderPromptStyle` path at the model's own resolved
 * `promptStyle`, so the number describes the pipeline that will actually carry them rather than a
 * bare list this script invented.
 *
 * ## The independence check, which is the interesting part
 *
 * The guard's arithmetic assumes the rules fail independently — that all-of-n compliance is
 * `p ** n`. That assumption is doing real work and is nowhere verified. So this also reports the
 * *observed* all-followed rate beside the predicted one at each n. If observed sits consistently
 * below predicted, rules interfere and the guard is optimistic; consistently above, and it is
 * pessimistic. Either way it is a finding rather than an assumption.
 *
 * Usage:
 *   bun scripts/eval-rules.ts --model <id> --base-url <url> --api-key-env SMALL_MODEL_API_KEY
 *   bun scripts/eval-rules.ts --model deepseek-chat --base-url https://api.deepseek.com/v1 \
 *       --api-key-env DEEPSEEK_API_KEY
 *   bun scripts/eval-rules.ts --manifest examples/minimal/agent.yaml
 *   bun scripts/eval-rules.ts --tasks 5 --out evals/rules
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RULE_COUNTS, RULE_TASKS, VERIFIABLE_RULES } from "../evals/fixtures/rules.ts"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { loadManifest } from "../packages/core/src/manifest/load.ts"
import { resolveCapabilities } from "../packages/core/src/model/capabilities.ts"
import { createChatCompletionsProvider } from "../packages/core/src/model/chat-completions.ts"
import { renderPromptStyle } from "../packages/core/src/model/prompt-style.ts"
import { allowedRules } from "../packages/core/src/workspace/rules.ts"

const FLAGS = [
    "model",
    "base-url",
    "api-key-env",
    "manifest",
    "tasks",
    "out",
    "max-tokens",
    "reasoning",
    "help",
] as const

/**
 * Generous on purpose, and the first run proved why.
 *
 * A reasoning model bills its thinking against the output budget. `qwen3.5:9b` reasons about 350
 * tokens on a bare question and about 380 under a rules prompt, so a 300-token ceiling returned
 * **empty content on every single call** — and an empty reply passes `no-commas`, `lowercase`,
 * `brevity`, `no-questions` and `digits` vacuously. The run reported a confident 0.688 that measured
 * nothing whatsoever. This is the same failure `CLAUDE.md` records for `deepseek`, on a model whose
 * capability row does not mention reasoning at all.
 */
const DEFAULT_MAX_TOKENS = 2000

/**
 * At or above this, the probe told us nothing about the model.
 *
 * Not 1.0: a run that misses one observation out of two hundred is saturated in every sense that
 * matters, and treating 0.995 as a real measurement would put a guard-disabling figure in a manifest
 * on the strength of one unlucky token.
 */
const SATURATED = 0.99

/**
 * Above this share of empty replies the run measured nothing.
 *
 * A fifth of the sample missing is already enough to distrust the rest — whatever suppressed those
 * replies was present for all of them.
 */
const UNUSABLE_EMPTY_RATE = 0.2

/**
 * Above this many permitted rules, the probe is easier than the thing it stands in for.
 *
 * The rules here are mechanical — no commas, lower case, end with a marker. Real workspace rules are
 * behavioural: "confirm before anything that sends, spends or deletes", "say when you do not know".
 * A model can obey formatting almost perfectly and still fail those, so a rate measured on this
 * probe transfers *upward* and a figure that permits twenty rules is not a licence to write twenty.
 *
 * Six is where the published table stops being reassuring — 0.90^6 is a coin flip — so a probe
 * permitting more than that has stopped discriminating and should say so rather than encourage.
 */
const PROBE_CEILING = 6

function arg(name: string): string | undefined {
    const prefix = `--${name}`
    const argv = process.argv.slice(2)
    for (const [index, token] of argv.entries()) {
        if (token === prefix) return argv[index + 1]
        if (token.startsWith(`${prefix}=`)) return token.slice(prefix.length + 1)
    }
    return undefined
}

/**
 * An unknown flag exits 2 rather than being ignored.
 *
 * Learned the hard way on `eval-tools`: `--only` was silently dropped, so a run believed to be one
 * model over one group swept everything and took eleven minutes instead of three. A script that
 * ignores a flag is a script that quietly does something other than what was asked.
 */
function checkFlags(): string | undefined {
    const unknown = process.argv
        .slice(2)
        .filter((token) => token.startsWith("--"))
        .map((token) => token.slice(2).split("=")[0] ?? "")
        .filter((name) => !FLAGS.includes(name as (typeof FLAGS)[number]))
    if (unknown.length === 0) return undefined
    return `eval-rules: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `--${name}`).join(", ")}. Known: ${FLAGS.map((name) => `--${name}`).join(", ")}.`
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

/**
 * Where the model under test comes from.
 *
 * `--manifest` is the path that matters: it measures the model the agent will actually run on,
 * through that agent's own resolved capabilities. The explicit flags exist for probing a model no
 * manifest names yet.
 */
function resolveTarget(env: Record<string, string | undefined>): Target | string {
    const manifestPath = arg("manifest")
    if (manifestPath !== undefined) {
        const loaded = loadManifest(manifestPath)
        const main = loaded.manifest.model.main
        return {
            id: main.id,
            baseUrl: main.baseUrl,
            ...(main.apiKeyEnv === undefined ? {} : { apiKeyEnv: main.apiKeyEnv }),
        }
    }

    const id = arg("model")
    if (id === undefined) {
        return "eval-rules: name a model with --model, or point at an agent with --manifest."
    }
    const baseUrl = arg("base-url") ?? env.SMALL_MODEL_BASE_URL
    if (baseUrl === undefined || baseUrl === "") {
        return "eval-rules: give --base-url, or set SMALL_MODEL_BASE_URL. There is no default — one pointing at localhost turns 'not configured' into 'connection refused'."
    }
    const apiKeyEnv = arg("api-key-env")
    if (apiKeyEnv !== undefined && env[apiKeyEnv] === undefined) {
        return `eval-rules: ${apiKeyEnv} is not set, so ${id} cannot be reached.`
    }
    return { id, baseUrl, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) }
}

interface Observation {
    readonly n: number
    readonly task: string
    readonly ruleId: string
    readonly satisfied: boolean
}

interface Reply {
    readonly n: number
    readonly task: string
    readonly text: string
    readonly reasoningChars: number
    readonly empty: boolean
}

interface CountResult {
    readonly n: number
    readonly observations: number
    readonly satisfied: number
    readonly perRule: number
    /** Replies where every stated rule held. */
    readonly allFollowed: number
    readonly replies: number
    readonly observedAll: number
    readonly predictedAll: number
}

async function main(): Promise<number> {
    const badFlag = checkFlags()
    if (badFlag !== undefined) {
        console.error(badFlag)
        return 2
    }
    if (arg("help") !== undefined) {
        console.log("bun scripts/eval-rules.ts --model <id> [--base-url url] [--api-key-env NAME]")
        console.log("bun scripts/eval-rules.ts --manifest path/to/agent.yaml")
        return 0
    }

    const env = loadEnv()
    const target = resolveTarget(env)
    if (typeof target === "string") {
        console.error(target)
        return 2
    }

    const taskCount = Math.max(1, Math.min(RULE_TASKS.length, Number(arg("tasks") ?? 6)))
    const tasks = RULE_TASKS.slice(0, taskCount)
    const outDir = arg("out") ?? join("evals", "rules")
    const maxTokens = Number(arg("max-tokens") ?? DEFAULT_MAX_TOKENS)

    // Off by default, and this is the single change that makes the eval usable. What is measured
    // here is whether the model *followed* the rules, not how it deliberated about them — and on a
    // reasoning model the deliberation is the entire cost. Measured on `qwen3.5:9b`, six rules,
    // same machine: reasoning on burned 2,000 tokens in 104 s and returned empty; `none` answered
    // correctly in 2.1 s. Pass `--reasoning low|medium|high` to measure with it on.
    const reasoningRaw = arg("reasoning") ?? "none"
    const reasoningEffort =
        reasoningRaw === "default"
            ? undefined
            : (reasoningRaw as "none" | "minimal" | "low" | "medium" | "high")

    const capabilities = resolveCapabilities(target.id)
    const style = capabilities.promptStyle
    const provider = createChatCompletionsProvider({
        baseUrl: target.baseUrl,
        env,
        ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
    })

    console.log(`model      ${target.id}  (${target.baseUrl})`)
    console.log(
        `rendering  delimiters=${style.delimiters} intensity=${style.intensity}  — the real path, not a bare list`,
    )
    console.log(`tasks      ${tasks.length} per rule count; counts ${RULE_COUNTS.join(", ")}`)
    console.log(
        `reasoning  ${reasoningEffort ?? "endpoint default"}${reasoningEffort === "none" ? " — measuring compliance, not deliberation" : ""}`,
    )
    console.log("")

    const observations: Observation[] = []
    const replies: Reply[] = []
    const results: CountResult[] = []

    for (const n of RULE_COUNTS) {
        const rules = VERIFIABLE_RULES.slice(0, n)
        if (rules.length < n) continue

        // Built through the same renderer the runtime uses, so `intensity` is exercised rather than
        // assumed. A number measured against a bare list would not describe the shipped pipeline.
        const authored = [
            "You answer questions.",
            "<rules>",
            ...rules.map((r) => r.text),
            "</rules>",
        ].join("\n")
        const system = renderPromptStyle(authored, style)

        let allFollowed = 0
        let scored = 0
        for (const task of tasks) {
            const { text, reasoningChars } = await complete(
                provider,
                target.id,
                system,
                task,
                maxTokens,
                reasoningEffort,
            )
            const empty = text.trim() === ""
            replies.push({ n, task, text, reasoningChars, empty })

            // An empty reply is a non-response, not a failure, and above all not a *pass*. Five of
            // the six checks are satisfied trivially by an empty string, so scoring one would
            // manufacture agreement out of silence. It is excluded and counted.
            if (empty) {
                process.stdout.write("-")
                continue
            }

            scored += 1
            let every = true
            for (const rule of rules) {
                const satisfied = rule.check(text)
                if (!satisfied) every = false
                observations.push({ n, task, ruleId: rule.id, satisfied })
            }
            if (every) allFollowed += 1
            process.stdout.write(every ? "." : "x")
        }
        process.stdout.write("\n")

        const forCount = observations.filter((o) => o.n === n)
        const satisfied = forCount.filter((o) => o.satisfied).length
        const perRule = forCount.length === 0 ? 0 : satisfied / forCount.length
        results.push({
            n,
            observations: forCount.length,
            satisfied,
            perRule,
            allFollowed,
            replies: scored,
            observedAll: scored === 0 ? 0 : allFollowed / scored,
            predictedAll: perRule ** n,
        })
    }

    // Pooled across every rule count, which is the figure the guard wants: it asks how likely *any
    // one* rule is to hold, not how likely a particular n is to hold together.
    const totalObs = observations.length
    const totalSat = observations.filter((o) => o.satisfied).length
    const pooled = totalObs === 0 ? 0 : totalSat / totalObs

    const empties = replies.filter((reply) => reply.empty)
    const emptyRate = replies.length === 0 ? 0 : empties.length / replies.length

    console.log("")
    console.log("  n   per-rule   all-followed   predicted p^n   gap")
    console.log("  ─   ────────   ────────────   ─────────────   ────")
    for (const row of results) {
        const gap = row.observedAll - row.predictedAll
        console.log(
            `  ${String(row.n).padStart(1)}   ${row.perRule.toFixed(3).padStart(8)}   ${row.observedAll.toFixed(3).padStart(12)}   ${row.predictedAll.toFixed(3).padStart(13)}   ${(gap >= 0 ? "+" : "") + gap.toFixed(3)}`,
        )
    }

    console.log("")
    console.log(
        `  pooled perRuleSuccess   ${pooled.toFixed(3)}  (${totalSat}/${totalObs} observations)`,
    )

    // Reported before anything that depends on it. A run whose replies were mostly empty is not a
    // measurement with a caveat, it is not a measurement — and the first qwen run showed the cost of
    // finding that out afterwards: 30 of 30 replies were empty, five of the six checks pass
    // vacuously on an empty string, and the script printed a confident 0.688.
    if (empties.length > 0) {
        const worst = empties.reduce((a, b) => (a.reasoningChars > b.reasoningChars ? a : b))
        console.log("")
        console.log(
            `  EMPTY REPLIES           ${empties.length}/${replies.length} (${(emptyRate * 100).toFixed(0)}%) — excluded, never scored as passes`,
        )
        console.log(
            `  longest reasoning behind an empty reply: ${worst.reasoningChars} chars (~${Math.round(worst.reasoningChars / 3.8)} tokens)`,
        )
        console.log(
            `  If that approaches --max-tokens (${maxTokens}), reasoning consumed the budget and the content had none left.`,
        )
    }

    // Per-rule breakdown, because a single hard rule dragging the pool down is a different finding
    // from every rule being followed three-quarters of the time, and the pooled figure hides which.
    console.log("")
    console.log("  per rule:")
    for (const rule of VERIFIABLE_RULES) {
        const forRule = observations.filter((o) => o.ruleId === rule.id)
        if (forRule.length === 0) continue
        const rate = forRule.filter((o) => o.satisfied).length / forRule.length
        console.log(
            `    ${rule.id.padEnd(12)} ${rate.toFixed(3)}  (${forRule.length} observations)`,
        )
    }

    const target80 = allowedRules(pooled, 0.8)
    console.log("")

    // A perfect score is a statement about the probe, not about the model, and reporting it as a
    // measurement would be worse than not measuring. `perRuleSuccess: 1.00` in a manifest disables
    // the guard outright — every rule count is permitted — which is exactly the failure mode of a
    // guard whose input was guessed, arrived at by a different route.
    if (emptyRate >= UNUSABLE_EMPTY_RATE) {
        console.log(
            `  ${(emptyRate * 100).toFixed(0)}% of replies were empty. This run measured nothing.`,
        )
        console.log(`  Raise --max-tokens above ${maxTokens} and run it again. Do not put a number`)
        console.log("  from this run into a manifest.")
    } else if (pooled >= SATURATED) {
        console.log(`  The probe SATURATED: ${totalSat}/${totalObs} observations passed.`)
        console.log("  This says the instructions were easy for this model, not that the model")
        console.log("  follows any rule you write. Do not put 1.00 in a manifest — it permits an")
        console.log("  unbounded rule count and switches the guard off.")
        console.log("")
        console.log("  Run it against the SMALLEST model this agent will actually use. The guard")
        console.log("  exists for those; frontier models are not where rule budgets bite.")
    } else {
        console.log(
            `  At the measured rate, a reliabilityTarget of 0.80 permits ${Number.isFinite(target80) ? target80 : "any number of"} rule(s).`,
        )
        console.log("  Put this in the manifest rather than the shipped 0.90:")
        console.log("")
        console.log("    context:")
        console.log("      rules:")
        console.log(`        perRuleSuccess: ${pooled.toFixed(2)}`)
        console.log("        reliabilityTarget: 0.80")

        if (Number.isFinite(target80) && target80 > PROBE_CEILING) {
            console.log("")
            console.log(
                `  CAUTION: ${target80} permitted rules is more than this probe can justify.`,
            )
            console.log(
                "  These rules are mechanical — no commas, lower case, a suffix marker. The rules in a",
            )
            console.log(
                "  real AGENT.md are behavioural, and a model obeys formatting far more reliably than it",
            )
            console.log(
                "  obeys 'confirm before anything that sends'. Treat this as an upper bound, keep the",
            )
            console.log("  shipped 0.90, and trust the smaller number.")
        }
    }

    const independenceNote = describeIndependence(results)
    console.log("")
    console.log(`  Independence: ${independenceNote}`)

    mkdirSync(outDir, { recursive: true })
    writeFileSync(
        join(outDir, "results.json"),
        `${JSON.stringify(
            {
                model: target.id,
                baseUrl: target.baseUrl,
                promptStyle: style,
                tasks: tasks.length,
                pooledPerRuleSuccess: pooled,
                saturated: pooled >= SATURATED,
                emptyReplies: empties.length,
                emptyRate,
                usable: emptyRate < UNUSABLE_EMPTY_RATE,
                maxTokens,
                reasoningEffort: reasoningEffort ?? null,
                permittedAt080: Number.isFinite(target80) ? target80 : null,
                aboveProbeCeiling: Number.isFinite(target80) && target80 > PROBE_CEILING,
                byCount: results,
                byRule: VERIFIABLE_RULES.map((rule) => {
                    const forRule = observations.filter((o) => o.ruleId === rule.id)
                    return {
                        id: rule.id,
                        observations: forRule.length,
                        rate:
                            forRule.length === 0
                                ? null
                                : forRule.filter((o) => o.satisfied).length / forRule.length,
                    }
                }),
                observations,
                // Raw replies, kept for the reason `evals/tools` keeps them: a number without the
                // text behind it cannot be debugged, and the one time it mattered most the entire
                // explanation was in what the model actually wrote.
                replies,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
    console.log("")
    console.log(`  written  ${join(outDir, "results.json")}`)

    return 0
}

/**
 * Whether the guard's `p ** n` arithmetic held.
 *
 * Reported as a direction rather than a verdict. One run on one model is evidence, not a law, and
 * saying "rules interfere" from six data points would be exactly the kind of unearned confidence
 * this eval exists to replace.
 */
function describeIndependence(results: readonly CountResult[]): string {
    const multi = results.filter((row) => row.n > 1)
    if (multi.length === 0) return "not measured — only one rule count ran."
    const gaps = multi.map((row) => row.observedAll - row.predictedAll)
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
    if (Math.abs(mean) < 0.05) {
        return `observed all-followed tracks p^n within ${(Math.abs(mean) * 100).toFixed(1)}pp on average — the guard's arithmetic holds here.`
    }
    return mean < 0
        ? `observed all-followed runs ${(Math.abs(mean) * 100).toFixed(1)}pp BELOW p^n on average — rules interfere, so the guard is optimistic and permits more rules than the model can carry.`
        : `observed all-followed runs ${(mean * 100).toFixed(1)}pp ABOVE p^n on average — failures cluster on the same replies, so the guard is pessimistic.`
}

async function complete(
    provider: ReturnType<typeof createChatCompletionsProvider>,
    modelId: string,
    system: string,
    task: string,
    maxTokens: number,
    reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | undefined,
): Promise<{ text: string; reasoningChars: number }> {
    let text = ""
    let reasoning = ""
    const controller = new AbortController()
    for await (const chunk of provider.chat(
        {
            model: modelId,
            messages: [
                { role: "system", content: system },
                { role: "user", content: task },
            ],
            temperature: 0,
            maxTokens,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
        controller.signal,
    )) {
        if (chunk.type === "text") text += chunk.delta
        // Kept only to explain an empty reply. A model that reasoned for the whole budget and
        // returned nothing looks identical to one that had nothing to say, and the two need
        // different fixes.
        else if (chunk.type === "reasoning") reasoning += chunk.delta
    }
    return { text, reasoningChars: reasoning.length }
}

process.exit(await main())
