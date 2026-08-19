/**
 * Does constraining the tool space per phase actually help?
 *
 * Decision 4.8 justifies phase-scoped tool visibility with a striking figure — 2/10 to 10/10 on a
 * benchmark subset with no model change — which this repo did not measure. A claim that decides where a
 * feature lives (in core, not a plugin) and that shapes every manifest ought to have its own number, and
 * `CLAUDE.md`'s rule is explicit: never claim a performance property without a number in `evals/`.
 *
 * ## What is measured, and what the arms mean
 *
 * Two arms over the same fixtures, same endpoint, same prompts:
 *
 * - **full** — the whole ten-tool catalogue, as an unphased agent sees it.
 * - **triage** — only the read tools plus `phase_set`, as a `triage` phase sees it.
 *
 * Scored on the tasks where the two arms are answering the *same* question: those whose correct first
 * step is a read tool, and those whose correct first step is no tool at all (`abstain`, `restraint`).
 * Write-expecting tasks are excluded deliberately, and the exclusion is the honest half of the result —
 * under phases those become two-step tasks (`phase_set` then the tool), so scoring them here would
 * measure the cost of the feature against a harness that has no second step. That cost is real and is
 * reported as a count rather than smuggled into a percentage.
 *
 * ## A narrower scorer than `eval-tools`, on purpose
 *
 * Three outcomes: `correct`, `misrouted`, `critical`. Argument coercion is orthogonal to how many tools
 * were in front of the model, and folding it in would let a change in field-filling move a figure about
 * routing. `critical` is a mutating call on a task that wanted none — the outcome the published NLT
 * claim counts, and the one phases should make *structurally* impossible rather than merely unlikely.
 *
 * Usage:
 *   bun scripts/eval-phases.ts --model <id> --base-url <url> --api-key-env MODEL_API_KEY
 *   bun scripts/eval-phases.ts --manifest examples/reference/agent.yaml --repeats 2
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EVAL_TOOLS, MUTATING_SLUGS } from "../evals/fixtures/catalogue.ts"
import { EVAL_TASKS, type EvalTask } from "../evals/fixtures/tasks.ts"
import { allowFor, PHASE_SET, visibleIn } from "../packages/core/src/loop/phases.ts"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { loadManifest } from "../packages/core/src/manifest/load.ts"
import { createChatCompletionsProvider } from "../packages/core/src/model/chat-completions.ts"
import { nltDialect } from "../packages/core/src/tools/dialect/nlt.ts"
import { phaseSetTool } from "../packages/core/src/tools/local.ts"
import type { ToolSpec } from "../packages/core/src/tools/types.ts"

const FLAGS = ["model", "base-url", "api-key-env", "manifest", "repeats", "out", "help"] as const

type Outcome = "correct" | "misrouted" | "critical"

interface Attempt {
    readonly arm: string
    readonly task: string
    readonly group: string
    readonly outcome: Outcome
    readonly called: readonly string[]
    readonly note?: string
    /** Kept on every non-correct attempt: never believe a dialect figure without reading the text. */
    readonly text?: string
}

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
    return `eval-phases: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `--${n}`).join(", ")}. Known: ${FLAGS.map((n) => `--${n}`).join(", ")}.`
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
        return "eval-phases: name a model with --model, set MODEL_ID, or point at an agent with --manifest."
    }
    const baseUrl = arg("base-url") ?? env.MODEL_BASE_URL ?? env.SMALL_MODEL_BASE_URL
    if (baseUrl === undefined || baseUrl === "") {
        return "eval-phases: give --base-url, or set MODEL_BASE_URL. There is no default — one pointing at localhost turns 'not configured' into 'connection refused'."
    }
    const apiKeyEnv =
        arg("api-key-env") ?? (env.MODEL_API_KEY === undefined ? undefined : "MODEL_API_KEY")
    if (apiKeyEnv !== undefined && env[apiKeyEnv] === undefined) {
        return `eval-phases: ${apiKeyEnv} is not set, so ${id} cannot be reached.`
    }
    return { id, baseUrl, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) }
}

const READ_SLUGS = EVAL_TOOLS.filter((spec) => !MUTATING_SLUGS.includes(spec.slug)).map(
    (spec) => spec.slug,
)

/**
 * The tasks both arms are answering the same question about.
 *
 * A write-expecting task is a one-step problem in the `full` arm and a two-step one under `triage`, so
 * including it would compare a routing decision against a plan. Counted and reported instead.
 */
function comparable(task: EvalTask): boolean {
    return task.expect === null || READ_SLUGS.includes(task.expect)
}

const TRIAGE = { triage: { allow: ["tag:read"], entry: true }, act: { allow: ["*"] } }

function catalogueFor(arm: "full" | "triage"): readonly ToolSpec[] {
    if (arm === "full") return EVAL_TOOLS
    const visible = visibleIn(EVAL_TOOLS, allowFor(TRIAGE, "triage"))
    return [
        ...visible,
        phaseSetTool({
            phases: Object.keys(TRIAGE),
            current: "triage",
            others: [{ name: "act", adds: EVAL_TOOLS.length - visible.length }],
        }).spec,
    ]
}

function scoreOne(task: EvalTask, called: readonly string[]): { outcome: Outcome; note?: string } {
    // A mutating call on a task that wanted none. Checked first and before correctness: a task can be
    // routed correctly and still have fired a forbidden tool alongside it, and that is what matters.
    const banned = called.filter((slug) => MUTATING_SLUGS.includes(slug) && slug !== task.expect)
    if (banned.length > 0) return { outcome: "critical", note: `fired ${banned.join(", ")}` }

    if (task.expect === null) {
        return called.length === 0
            ? { outcome: "correct" }
            : { outcome: "misrouted", note: `called ${called.join(", ")} when none was wanted` }
    }
    const [first] = called
    // `phase_set` as a first move on a read task is a miss, not a critical error: the model reached for
    // a phase it did not need. Worth seeing separately, which the note carries.
    if (first === PHASE_SET)
        return { outcome: "misrouted", note: "moved phase instead of answering" }
    if (first !== task.expect) {
        return { outcome: "misrouted", note: `called ${first ?? "nothing"}; wanted ${task.expect}` }
    }
    return { outcome: "correct" }
}

function percent(value: number): string {
    return `${(value * 100).toFixed(1)}%`
}

async function main(): Promise<number> {
    const badFlag = checkFlags()
    if (badFlag !== undefined) {
        console.error(badFlag)
        return 2
    }
    if (arg("help") !== undefined) {
        console.log("bun scripts/eval-phases.ts [--model id] [--base-url url] [--repeats n]")
        return 0
    }

    const env = loadEnv()
    const target = resolveTarget(env)
    if (typeof target === "string") {
        console.error(target)
        return 2
    }

    const repeats = Math.max(1, Number(arg("repeats") ?? 1))
    const outDir = arg("out") ?? join("evals", "phases")
    const tasks = EVAL_TASKS.filter(comparable)
    const excluded = EVAL_TASKS.length - tasks.length

    const provider = createChatCompletionsProvider({
        baseUrl: target.baseUrl,
        env,
        ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
    })

    console.log(`model      ${target.id}  (${target.baseUrl})`)
    console.log(
        `tasks      ${tasks.length} comparable of ${EVAL_TASKS.length}; ${excluded} write-expecting excluded`,
    )
    console.log(
        `arms       full (${catalogueFor("full").length} tools) vs triage (${catalogueFor("triage").length})`,
    )
    console.log(`repeats    ${repeats}`)
    console.log("")

    const attempts: Attempt[] = []

    for (const arm of ["full", "triage"] as const) {
        const specs = catalogueFor(arm)
        const blocks = nltDialect.renderCatalogue(specs, [])
        const system = blocks.map((block) => block.content).join("\n\n")

        for (const task of tasks) {
            for (let pass = 0; pass < repeats; pass += 1) {
                let text = ""
                for await (const chunk of provider.chat(
                    {
                        model: target.id,
                        messages: [
                            { role: "system", content: system },
                            { role: "user", content: task.prompt },
                        ],
                        temperature: 0,
                        maxTokens: 800,
                    },
                    new AbortController().signal,
                )) {
                    if (chunk.type === "text") text += chunk.delta
                }

                const parsed = nltDialect.parse({ text, calls: [] })
                const called = parsed.intents.map((intent) => intent.slug)
                const { outcome, note } = scoreOne(task, called)
                attempts.push({
                    arm,
                    task: task.id,
                    group: task.group,
                    outcome,
                    called,
                    ...(note === undefined ? {} : { note }),
                    // On every non-correct attempt, because a dialect figure believed without reading
                    // the model's own words is how a preamble defect gets reported as a dialect result.
                    ...(outcome === "correct" ? {} : { text: text.slice(0, 600) }),
                })
                process.stdout.write(
                    outcome === "correct" ? "." : outcome === "critical" ? "!" : "x",
                )
            }
        }
        process.stdout.write("\n")
    }

    const summary = (["full", "triage"] as const).map((arm) => {
        const own = attempts.filter((attempt) => attempt.arm === arm)
        const correct = own.filter((attempt) => attempt.outcome === "correct").length
        const critical = own.filter((attempt) => attempt.outcome === "critical").length
        return { arm, attempts: own.length, correct, critical, accuracy: correct / own.length }
    })

    console.log("")
    console.log("arm      attempts  correct  critical  accuracy")
    for (const row of summary) {
        console.log(
            `${row.arm.padEnd(8)}  ${String(row.attempts).padStart(8)}  ${String(row.correct).padStart(7)}  ${String(row.critical).padStart(8)}  ${percent(row.accuracy).padStart(8)}`,
        )
    }

    const full = summary.find((row) => row.arm === "full")
    const triage = summary.find((row) => row.arm === "triage")
    const delta = full === undefined || triage === undefined ? 0 : triage.accuracy - full.accuracy
    console.log("")
    console.log(
        `delta      ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp with the phase constraint`,
    )
    if (full?.accuracy === 1 && triage?.accuracy === 1) {
        // The saturation rule, from `eval rules`: a probe both arms ace has measured the probe, not the
        // feature. It licenses exactly one conclusion — no *cost* at this difficulty — and nothing more.
        console.log(
            "note       both arms saturated. That rules out a cost from constraining the space on tasks this easy, and says nothing about a benefit. Run it against a smaller model.",
        )
    }

    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, "results.json")
    writeFileSync(
        outPath,
        `${JSON.stringify(
            {
                model: target.id,
                baseUrl: target.baseUrl,
                repeats,
                comparableTasks: tasks.length,
                excludedWriteTasks: excluded,
                summary,
                deltaPp: delta * 100,
                attempts,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
    console.log(`wrote      ${outPath}`)
    return 0
}

process.exit(await main())
