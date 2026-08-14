/**
 * Settle the two `promptStyle` questions the spec left open, with numbers instead of vendor advice.
 *
 * **A — `examplesIn`.** Anthropic and OpenAI give opposite guidance on where examples belong. The
 * probe puts the same authored identity through both placements — embedded in the system prompt,
 * or moved to a user message through the same `extractExamples` path the runtime uses — and
 * measures whether the model adopts a reply format the examples demonstrate and no rule states.
 *
 * **B — `intensity`.** The shipped default gives small models emphatic rule framing on the
 * assumption that the advice to remove it (written for frontier models, which overtrigger) inverts
 * below ~14B. The probe renders the same verifiable rules under `emphatic` and `neutral` and
 * measures rule adherence under each.
 *
 * Both questions use the runtime's own rendering path, both are scored by functions rather than
 * judgements, and both keep every raw reply — the lesson of every eval before this one is that the
 * number cannot be believed until what the model actually wrote has been read.
 *
 * Usage:
 *   bun scripts/eval-prompt-style.ts                       # both questions, all reachable models
 *   bun scripts/eval-prompt-style.ts --question examples   # A only
 *   bun scripts/eval-prompt-style.ts --question intensity  # B only
 *   SMALL_MODEL_REASONING=none is not read here — pass --reasoning; the default is none, because
 *   what is measured is imitation and compliance, not deliberation.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
    IMITATION_AGENT,
    IMITATION_CHECKS,
    INTENSITY_RULE_COUNT,
} from "../evals/fixtures/prompt-style.ts"
import { RULE_TASKS, VERIFIABLE_RULES } from "../evals/fixtures/rules.ts"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { resolveCapabilities } from "../packages/core/src/model/capabilities.ts"
import { createChatCompletionsProvider } from "../packages/core/src/model/chat-completions.ts"
import {
    extractExamples,
    type PromptStyle,
    renderPromptStyle,
} from "../packages/core/src/model/prompt-style.ts"
import type { ChatMessage } from "../packages/core/src/model/provider.ts"

const FLAGS = [
    "question",
    "tasks",
    "repeats",
    "rules",
    "out",
    "max-tokens",
    "reasoning",
    "help",
] as const

/** Same figure and same reasoning as eval-rules: a reasoning model bills thinking against this. */
const DEFAULT_MAX_TOKENS = 2000

/** Above this share of empty replies, a condition measured nothing and must say so. */
const UNUSABLE_EMPTY_RATE = 0.2

function arg(name: (typeof FLAGS)[number]): string | undefined {
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
    return `eval-prompt-style: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `--${name}`).join(", ")}. Known: ${FLAGS.map((name) => `--${name}`).join(", ")}.`
}

function loadEnv(): Record<string, string | undefined> {
    try {
        return { ...process.env, ...parseDotEnv(readFileSync(".env", "utf8")) }
    } catch {
        return { ...process.env }
    }
}

interface ModelUnderTest {
    readonly label: string
    readonly id: string
    readonly baseUrl: string
    readonly apiKeyEnv?: string
    readonly smallOpenWeight: boolean
    readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high"
}

/**
 * The same two slots eval-tools reads: the small open-weight endpoint the defaults are *for*, and
 * deepseek-chat as the frontier contrast. The questions are about the small model — a sweep with
 * only deepseek reachable runs, but says so.
 */
function models(
    env: Record<string, string | undefined>,
    reasoning: ModelUnderTest["reasoningEffort"] | undefined,
): ModelUnderTest[] {
    const out: ModelUnderTest[] = []

    const smallId = env.SMALL_MODEL_ID
    const smallBase = env.SMALL_MODEL_BASE_URL
    if (smallId !== undefined && smallId !== "" && smallBase !== undefined && smallBase !== "") {
        out.push({
            label: `${smallId} (open-weight)`,
            id: smallId,
            baseUrl: smallBase,
            ...(env.SMALL_MODEL_API_KEY === undefined || env.SMALL_MODEL_API_KEY === ""
                ? {}
                : { apiKeyEnv: "SMALL_MODEL_API_KEY" }),
            smallOpenWeight: true,
            ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }),
        })
    }

    if (env.DEEPSEEK_API_KEY !== undefined && env.DEEPSEEK_API_KEY !== "") {
        out.push({
            label: "deepseek-chat",
            id: "deepseek-chat",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyEnv: "DEEPSEEK_API_KEY",
            smallOpenWeight: false,
        })
    }

    return out
}

interface Attempt {
    readonly question: "examples" | "intensity"
    readonly model: string
    readonly condition: string
    readonly task: string
    readonly pass: number
    readonly reply: string
    readonly empty: boolean
    readonly checks: Record<string, boolean>
}

interface ConditionSummary {
    readonly question: "examples" | "intensity"
    readonly model: string
    readonly condition: string
    readonly replies: number
    readonly empties: number
    readonly usable: boolean
    /** Per check id: satisfied / scored. */
    readonly rates: Record<string, number>
    /** Intensity only: replies where every rule held / scored. */
    readonly allFollowed?: number
}

async function main(): Promise<number> {
    const badFlag = checkFlags()
    if (badFlag !== undefined) {
        console.error(badFlag)
        return 2
    }
    if (arg("help") !== undefined) {
        console.log(
            "bun scripts/eval-prompt-style.ts [--question examples|intensity|both] [--tasks N] [--repeats N]",
        )
        return 0
    }

    const env = loadEnv()
    const question = arg("question") ?? "both"
    if (question !== "examples" && question !== "intensity" && question !== "both") {
        console.error(`eval-prompt-style: --question is ${question}; use examples|intensity|both.`)
        return 2
    }

    const taskCount = Math.max(1, Math.min(RULE_TASKS.length, Number(arg("tasks") ?? 10)))
    const tasks = RULE_TASKS.slice(0, taskCount)
    // Repeats defend against endpoint nondeterminism, nothing else. Measured 2026-08-14: the local
    // qwen endpoint at temperature 0 returns byte-identical replies on every pass, so against it
    // repeats add zero information and `--tasks` is the sample size.
    const repeats = Math.max(1, Number(arg("repeats") ?? 2))
    // The escape from a saturated intensity probe: more simultaneous rules push the all-followed
    // rate off the ceiling, which is where a framing difference could show at all.
    const ruleCount = Math.max(
        1,
        Math.min(VERIFIABLE_RULES.length, Number(arg("rules") ?? INTENSITY_RULE_COUNT)),
    )
    const outDir = arg("out") ?? join("evals", "prompt-style")
    const maxTokens = Number(arg("max-tokens") ?? DEFAULT_MAX_TOKENS)

    // `none` by default, for the eval-rules reason: what is measured is whether the model imitates
    // and complies, not how it deliberates, and on a small reasoning model the deliberation is the
    // entire wall-clock cost. `--reasoning default` measures at the endpoint default instead.
    const reasoningRaw = arg("reasoning") ?? "none"
    const reasoning =
        reasoningRaw === "default"
            ? undefined
            : (reasoningRaw as NonNullable<ModelUnderTest["reasoningEffort"]>)

    const targets = models(env, reasoning)
    if (targets.length === 0) {
        console.error(
            "eval-prompt-style: no model reachable. Set SMALL_MODEL_ID and SMALL_MODEL_BASE_URL, or DEEPSEEK_API_KEY.",
        )
        return 1
    }
    if (!targets.some((target) => target.smallOpenWeight)) {
        console.log(
            "NOTE: no small open-weight model configured. Both questions are *about* small models,",
        )
        console.log("so this run informs the frontier row only and cannot settle either default.")
    }

    const attempts: Attempt[] = []
    const summaries: ConditionSummary[] = []

    for (const target of targets) {
        const provider = createChatCompletionsProvider({
            baseUrl: target.baseUrl,
            env,
            ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
        })
        const style = resolveCapabilities(target.id).promptStyle
        console.log(
            `\n${target.label} — delimiters=${style.delimiters}, reasoning ${target.reasoningEffort ?? "endpoint default"}`,
        )

        if (question !== "intensity") {
            summaries.push(
                ...(await runExamples(
                    provider,
                    target,
                    style,
                    tasks,
                    repeats,
                    maxTokens,
                    attempts,
                )),
            )
        }
        if (question !== "examples") {
            summaries.push(
                ...(await runIntensity(
                    provider,
                    target,
                    style,
                    tasks,
                    repeats,
                    maxTokens,
                    ruleCount,
                    attempts,
                )),
            )
        }
    }

    report(summaries, targets, ruleCount)

    mkdirSync(outDir, { recursive: true })
    writeFileSync(
        join(outDir, "results.json"),
        `${JSON.stringify(
            {
                startedAt: new Date().toISOString(),
                tasks: tasks.length,
                repeats,
                maxTokens,
                reasoning: reasoning ?? "endpoint default",
                intensityRuleCount: ruleCount,
                models: targets.map((target) => ({
                    id: target.id,
                    label: target.label,
                    smallOpenWeight: target.smallOpenWeight,
                    reasoning: target.reasoningEffort ?? "endpoint default",
                })),
                summaries,
                attempts,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
    console.log(`\nwritten  ${join(outDir, "results.json")}`)
    console.log(`Write up the verdicts in ${join(outDir, "README.md")} before quoting a number.`)
    return 0
}

/**
 * Question A. Two conditions from one authored source:
 *
 *   system — the file renders whole, examples in place, exactly what `examplesIn: system` ships.
 *   user   — the examples leave through `extractExamples` and arrive as a user message before the
 *            input, exactly what `examplesIn: user` ships via the assembly's examples slot.
 */
async function runExamples(
    provider: ReturnType<typeof createChatCompletionsProvider>,
    target: ModelUnderTest,
    style: PromptStyle,
    tasks: readonly string[],
    repeats: number,
    maxTokens: number,
    attempts: Attempt[],
): Promise<ConditionSummary[]> {
    const split = extractExamples(IMITATION_AGENT)

    const conditions: { name: string; messages: (task: string) => ChatMessage[] }[] = [
        {
            name: "system",
            messages: (task) => [
                { role: "system", content: renderPromptStyle(IMITATION_AGENT, style) },
                { role: "user", content: task },
            ],
        },
        {
            name: "user",
            messages: (task) => [
                { role: "system", content: renderPromptStyle(split.body, style) },
                { role: "user", content: renderPromptStyle(split.examples, style) },
                { role: "user", content: task },
            ],
        },
    ]

    const out: ConditionSummary[] = []
    for (const condition of conditions) {
        process.stdout.write(`  examples/${condition.name.padEnd(6)} `)
        const scored: Record<string, number> = {}
        const satisfied: Record<string, number> = {}
        let empties = 0
        let replies = 0

        for (let pass = 1; pass <= repeats; pass += 1) {
            for (const task of tasks) {
                const reply = await complete(provider, target, condition.messages(task), maxTokens)
                replies += 1
                const empty = reply.trim() === ""
                const checks: Record<string, boolean> = {}
                if (empty) {
                    empties += 1
                    process.stdout.write("-")
                } else {
                    let all = true
                    for (const check of IMITATION_CHECKS) {
                        const ok = check.check(reply)
                        checks[check.id] = ok
                        scored[check.id] = (scored[check.id] ?? 0) + 1
                        if (ok) satisfied[check.id] = (satisfied[check.id] ?? 0) + 1
                        else all = false
                    }
                    process.stdout.write(all ? "." : "x")
                }
                attempts.push({
                    question: "examples",
                    model: target.id,
                    condition: condition.name,
                    task,
                    pass,
                    reply,
                    empty,
                    checks,
                })
            }
        }
        process.stdout.write("\n")

        const rates: Record<string, number> = {}
        for (const check of IMITATION_CHECKS) {
            const denominator = scored[check.id] ?? 0
            rates[check.id] = denominator === 0 ? 0 : (satisfied[check.id] ?? 0) / denominator
        }
        out.push({
            question: "examples",
            model: target.id,
            condition: condition.name,
            replies,
            empties,
            usable: replies === 0 ? false : empties / replies < UNUSABLE_EMPTY_RATE,
            rates,
        })
    }
    return out
}

/**
 * Question B. The same rules, the same tasks, one changed line — which is the point: `intensity`
 * varies exactly one generated line in front of the rules block, so any adherence difference here
 * is attributable to that line and nothing else.
 */
async function runIntensity(
    provider: ReturnType<typeof createChatCompletionsProvider>,
    target: ModelUnderTest,
    style: PromptStyle,
    tasks: readonly string[],
    repeats: number,
    maxTokens: number,
    ruleCount: number,
    attempts: Attempt[],
): Promise<ConditionSummary[]> {
    const rules = VERIFIABLE_RULES.slice(0, ruleCount)
    const authored = [
        "You answer questions.",
        "<rules>",
        ...rules.map((r) => r.text),
        "</rules>",
    ].join("\n")

    const out: ConditionSummary[] = []
    for (const intensity of ["emphatic", "neutral"] as const) {
        process.stdout.write(`  intensity/${intensity.padEnd(8)} `)
        const system = renderPromptStyle(authored, { ...style, intensity })

        let empties = 0
        let replies = 0
        let scored = 0
        let allFollowed = 0
        const satisfied: Record<string, number> = {}

        for (let pass = 1; pass <= repeats; pass += 1) {
            for (const task of tasks) {
                const reply = await complete(
                    provider,
                    target,
                    [
                        { role: "system", content: system },
                        { role: "user", content: task },
                    ],
                    maxTokens,
                )
                replies += 1
                const empty = reply.trim() === ""
                const checks: Record<string, boolean> = {}
                if (empty) {
                    empties += 1
                    process.stdout.write("-")
                } else {
                    scored += 1
                    let all = true
                    for (const rule of rules) {
                        const ok = rule.check(reply)
                        checks[rule.id] = ok
                        if (ok) satisfied[rule.id] = (satisfied[rule.id] ?? 0) + 1
                        else all = false
                    }
                    if (all) allFollowed += 1
                    process.stdout.write(all ? "." : "x")
                }
                attempts.push({
                    question: "intensity",
                    model: target.id,
                    condition: intensity,
                    task,
                    pass,
                    reply,
                    empty,
                    checks,
                })
            }
        }
        process.stdout.write("\n")

        const rates: Record<string, number> = {}
        for (const rule of rules) {
            rates[rule.id] = scored === 0 ? 0 : (satisfied[rule.id] ?? 0) / scored
        }
        out.push({
            question: "intensity",
            model: target.id,
            condition: intensity,
            replies,
            empties,
            usable: replies === 0 ? false : empties / replies < UNUSABLE_EMPTY_RATE,
            rates,
            allFollowed: scored === 0 ? 0 : allFollowed / scored,
        })
    }
    return out
}

function report(
    summaries: readonly ConditionSummary[],
    targets: readonly ModelUnderTest[],
    ruleCount: number,
): void {
    console.log("")
    for (const target of targets) {
        const examples = summaries.filter((s) => s.model === target.id && s.question === "examples")
        if (examples.length === 2) {
            const [system, user] = examples
            if (system !== undefined && user !== undefined) {
                const delta = (user.rates.prefix ?? 0) - (system.rates.prefix ?? 0)
                console.log(
                    `${target.label}  examplesIn — prefix adoption: system ${pct(system.rates.prefix)}, user ${pct(user.rates.prefix)} (Δ ${pp(delta)}); brevity: system ${pct(system.rates.brevity)}, user ${pct(user.rates.brevity)}`,
                )
                warnUnusable(system)
                warnUnusable(user)
            }
        }

        const intensity = summaries.filter(
            (s) => s.model === target.id && s.question === "intensity",
        )
        if (intensity.length === 2) {
            const emphatic = intensity.find((s) => s.condition === "emphatic")
            const neutral = intensity.find((s) => s.condition === "neutral")
            if (emphatic !== undefined && neutral !== undefined) {
                const delta = (emphatic.allFollowed ?? 0) - (neutral.allFollowed ?? 0)
                console.log(
                    `${target.label}  intensity  — all-${ruleCount}-rules: emphatic ${pct(emphatic.allFollowed)}, neutral ${pct(neutral.allFollowed)} (Δ ${pp(delta)})`,
                )
                warnUnusable(emphatic)
                warnUnusable(neutral)
            }
        }
    }
    console.log("")
    console.log(
        "Margins under ~10pp on a sample this size are inside single-run churn — the eval-tools",
    )
    console.log(
        "lesson applies here verbatim. Read attempts[].reply before believing any figure above.",
    )
}

function warnUnusable(summary: ConditionSummary): void {
    if (summary.usable) return
    console.log(
        `  UNUSABLE: ${summary.model}/${summary.condition} returned ${summary.empties}/${summary.replies} empty replies — this condition measured nothing. Raise --max-tokens or check --reasoning.`,
    )
}

function pct(value: number | undefined): string {
    return `${(100 * (value ?? 0)).toFixed(1)}%`
}

function pp(delta: number): string {
    return `${delta >= 0 ? "+" : ""}${(100 * delta).toFixed(1)}pp`
}

async function complete(
    provider: ReturnType<typeof createChatCompletionsProvider>,
    target: ModelUnderTest,
    messages: ChatMessage[],
    maxTokens: number,
): Promise<string> {
    let text = ""
    const controller = new AbortController()
    for await (const chunk of provider.chat(
        {
            model: target.id,
            messages,
            temperature: 0,
            maxTokens,
            ...(target.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: target.reasoningEffort }),
        },
        controller.signal,
    )) {
        if (chunk.type === "text") text += chunk.delta
    }
    return text
}

process.exit(await main())
