/**
 * NLT versus native, on the same fixtures, against real endpoints.
 *
 * This script exists to settle decision O.4 with data instead of intuition, and decision 4.1's
 * numbers are borrowed from a published replication rather than measured here — so until this runs,
 * "NLT is the default" rests on someone else's experiment. Phase 3's gate is explicit: **NLT must be
 * at least as good as native on the smallest model tested**, and if it is not, that is a finding to
 * investigate rather than a result to bury.
 *
 * ## What is measured, and what deliberately is not
 *
 * One model call per fixture. Scoring is `planIntents` — resolution and coercion — with **nothing
 * executed**. That is not a shortcut: the claim under test is about routing and argument accuracy on
 * the step where the model decides, and running the tools would add side effects, latency, and a
 * second thing to attribute a difference to. `planIntents` is exported from `execute.ts` for exactly
 * this, and the fixture handlers throw if anything ever calls them.
 *
 * The consequence, stated plainly: this measures the *first* step. A dialect that routes well and
 * then loses its way across four steps would look identical here. Multi-step behaviour is covered by
 * `tool-loop.test.ts` against a scripted endpoint, and by the live runs recorded in the plan — not
 * by this number.
 *
 * ## Fairness
 *
 * Both dialects get the same catalogue, the same guidance text (asserted by `native.test.ts`), the
 * same fixtures in the same order, the same temperature, and the same system identity. The only
 * difference is the channel the protocol travels on. Where a model is asked twice, the two runs are
 * interleaved per fixture rather than run as two blocks, so endpoint drift lands on both dialects.
 *
 * Usage:
 *   bun scripts/eval-tools.ts                    # every configured model whose key is set
 *   bun scripts/eval-tools.ts --model qwen3.5:9b # one model
 *   bun scripts/eval-tools.ts --repeats 3        # median of N passes per fixture
 *   bun scripts/eval-tools.ts --tasks route,abstain
 *   bun scripts/eval-tools.ts --out evals/tools  # where results are written
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EVAL_TOOL_SLUGS, evalToolProvider, MUTATING_SLUGS } from "../evals/fixtures/catalogue.ts"
import { EVAL_TASKS, EVAL_TODAY, type EvalTask, type TaskGroup } from "../evals/fixtures/tasks.ts"
import { assembleContext } from "../packages/core/src/context/assemble.ts"
import { parseDotEnv } from "../packages/core/src/manifest/env.ts"
import { resolveCapabilities } from "../packages/core/src/model/capabilities.ts"
import { createChatCompletionsProvider } from "../packages/core/src/model/chat-completions.ts"
import type { ChatChunk, ToolCallRequest } from "../packages/core/src/model/provider.ts"
import type { ToolDialect } from "../packages/core/src/tools/dialect/dialect.ts"
import { nativeDialect, nativeWireTokens } from "../packages/core/src/tools/dialect/native.ts"
import { nltDialect } from "../packages/core/src/tools/dialect/nlt.ts"
import { planIntents } from "../packages/core/src/tools/execute.ts"
import { ToolRegistry } from "../packages/core/src/tools/registry.ts"

// ─── models under test ───────────────────────────────────────────────────────────────────

interface ModelUnderTest {
    readonly label: string
    readonly id: string
    readonly baseUrl: string
    readonly apiKeyEnv?: string
    /** Roughly, for ordering the report. The gate applies to the smallest that ran. */
    readonly params: number
    /** Sent as OpenAI's `reasoning_effort`. `none` on a thinking model is the difference between
     * a two-second call and a two-minute one. */
    readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high"
    /**
     * True only for a model whose weights and size are published.
     *
     * The gate turns on this rather than on `params` alone, because `params` for a closed model is a
     * guess. `gpt-4o-mini` sits here at 8B on nothing but rumour, and letting a guessed 8 satisfy a
     * claim about small models would decide the gate on a number nobody can check.
     */
    readonly openWeight?: boolean
    readonly streamUsage?: boolean
}

/**
 * Ordered smallest first, because the gate is about the smallest model that actually ran and the
 * report should read in the direction the claim is strongest.
 */
/**
 * The small open-weight slot, configured by environment rather than hardcoded.
 *
 * This is the model the Phase 3 gate is about — NLT's claim is specifically that it helps *small*
 * models, and a sweep of frontier models tests nothing that decision rests on.
 *
 * Not pinned to a provider or a model id, because those are exactly the details that go stale
 * without anyone noticing — a hardcoded id that a host has since renamed fails as "model not found"
 * halfway through a sweep. Any OpenAI-compatible host serving open weights works:
 *
 *   SMALL_MODEL_BASE_URL=http://localhost:11434/v1     SMALL_MODEL_ID=qwen3.5:9b
 *   SMALL_MODEL_BASE_URL=https://api.groq.com/openai/v1  SMALL_MODEL_ID=...  SMALL_MODEL_API_KEY=...
 *
 * **Local Ollama is viable, and the thing that made it look otherwise was reasoning.** A sweep once
 * took eighteen minutes, which was read as local inference being too slow. It was not: throughput
 * measured 16–20 tok/s, normal for an M1 Pro on a 9B Q4, and the model was fully GPU-resident. The
 * cost was that `qwen3.5` thinks by default and thinks *more* the more constrained the request —
 * 151 reasoning tokens unconstrained, 1,778 under six simultaneous rules, at which point it burned
 * a 2,000-token budget and returned empty. With `reasoning_effort: "none"` the same call is 2.1 s.
 * Set `SMALL_MODEL_REASONING=none` for a model that thinks and does not need to here.
 *
 * Unset, the slot is skipped like any other model whose key is missing — and the gate reports that
 * it could not run rather than quietly passing on frontier models alone.
 */
function smallModel(env: Record<string, string | undefined>): ModelUnderTest | undefined {
    const id = env.SMALL_MODEL_ID
    const baseUrl = env.SMALL_MODEL_BASE_URL
    if (id === undefined || id === "" || baseUrl === undefined || baseUrl === "") return undefined
    const params = Number(env.SMALL_MODEL_PARAMS ?? "9")
    return {
        label: `${id} (open-weight)`,
        id,
        baseUrl,
        // Only when a key exists. Declaring `apiKeyEnv` unconditionally made the candidate filter
        // skip every keyless endpoint — which is every local one — so configuring a local Ollama
        // correctly still produced "skipping … SMALL_MODEL_API_KEY is not set".
        ...(env.SMALL_MODEL_API_KEY === undefined || env.SMALL_MODEL_API_KEY === ""
            ? {}
            : { apiKeyEnv: "SMALL_MODEL_API_KEY" }),
        params: Number.isFinite(params) ? params : 9,
        openWeight: true,
        ...(env.SMALL_MODEL_REASONING === undefined
            ? {}
            : {
                  reasoningEffort: env.SMALL_MODEL_REASONING as
                      | "none"
                      | "minimal"
                      | "low"
                      | "medium"
                      | "high",
              }),
        // Ask for usage explicitly: several open-weight hosts report none without it, and token
        // figures would silently fall back to the estimator.
        streamUsage: true,
    }
}

const MODELS: readonly ModelUnderTest[] = [
    {
        label: "deepseek-chat",
        id: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        params: 685,
    },
    {
        label: "deepseek-reasoner",
        id: "deepseek-reasoner",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        params: 685,
    },
    {
        label: "gpt-4o-mini",
        id: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        // Unpublished. 8 is a widely repeated guess and is here only to order the report — it is
        // explicitly not open-weight, so it can never stand in for the gate's small model.
        params: 8,
    },
]

const IDENTITY = `You are a careful assistant with access to tools.

Today is ${EVAL_TODAY}. Times are UTC unless the person says otherwise.
Reply directly when no tool is needed. Never invent a value for a field you were not given.`

// ─── scoring ─────────────────────────────────────────────────────────────────────────────

type Outcome =
    /** Right tool, right arguments. */
    | "correct"
    /** Right tool, at least one argument wrong or missing. */
    | "args_wrong"
    /** Wrong tool, or a tool when none was wanted, or none when one was. */
    | "misrouted"
    /** A mutating tool fired that must not have. Counted separately — this one has consequences. */
    | "critical"
    /** The output could not be read as a call at all. */
    | "unparseable"

interface Attempt {
    readonly task: string
    readonly group: TaskGroup
    readonly outcome: Outcome
    readonly called: readonly string[]
    readonly promptTokens: number
    readonly outputTokens: number
    readonly latencyMs: number
    /** Present when something went wrong, so a bad number can be read rather than guessed at. */
    readonly note?: string
    /**
     * What the model actually produced, kept on every outcome that is not `correct`.
     *
     * Without it a committed result can be read but not diagnosed: a number that looks like a model
     * failure and a number that is a parser defect are indistinguishable, and telling them apart means
     * re-running against a live endpoint and hoping it answers the same way. Correct attempts are
     * omitted — they are the bulk of the file and there is nothing to investigate in them.
     */
    readonly raw?: { readonly text: string; readonly calls: readonly ToolCallRequest[] }
}

/**
 * Which mutating tools this task forbids.
 *
 * For `abstain` and `restraint` that is *all* of them — the point of both groups is that nothing with
 * a side effect should fire — so the fixtures state only the specific trap and this fills in the rest.
 * Leaving it to each fixture would mean thirty chances to forget one.
 */
function forbidden(task: EvalTask): readonly string[] {
    const explicit = task.forbidden ?? []
    if (task.group !== "abstain" && task.group !== "restraint") return explicit
    return [...new Set([...explicit, ...MUTATING_SLUGS])]
}

function argsMatch(task: EvalTask, args: Readonly<Record<string, unknown>>): string | undefined {
    for (const [field, expected] of Object.entries(task.args ?? {})) {
        const actual = args[field]
        if (actual === undefined) return `${field} missing`
        const text = Array.isArray(actual) ? actual.join(",") : String(actual)
        const ok = expected instanceof RegExp ? expected.test(text) : text === expected
        if (!ok) return `${field} was ${JSON.stringify(text)}`
    }
    return undefined
}

function score(
    task: EvalTask,
    registry: ToolRegistry,
    parsed: { intents: readonly { slug: string; args: Readonly<Record<string, unknown>> }[] },
    malformedCount: number,
): { outcome: Outcome; called: readonly string[]; note?: string } {
    const called = parsed.intents.map((intent) => intent.slug)

    // Checked before anything else, and *before* correctness: a task can be routed to the right tool
    // and still have fired a forbidden one alongside it, and that is the outcome that matters.
    const banned = called.filter((slug) => forbidden(task).includes(slug))
    if (banned.length > 0) {
        return { outcome: "critical", called, note: `fired ${banned.join(", ")}` }
    }

    if (malformedCount > 0) {
        return { outcome: "unparseable", called, note: `${malformedCount} unreadable call(s)` }
    }

    if (task.expect === null) {
        return called.length === 0
            ? { outcome: "correct", called }
            : {
                  outcome: "misrouted",
                  called,
                  note: `called ${called.join(", ")} when none was wanted`,
              }
    }

    if (called.length === 0) {
        return { outcome: "misrouted", called, note: `called nothing; wanted ${task.expect}` }
    }

    // The *first* call is the decision under test. A model that calls the right tool second has still
    // planned the step wrong, and scoring "did it appear anywhere" would hide that.
    const [first] = parsed.intents
    if (first === undefined || first.slug !== task.expect) {
        return { outcome: "misrouted", called, note: `wanted ${task.expect}` }
    }

    // Coercion runs here rather than against the raw arguments, because coercion is part of both
    // dialects and `native.strictSchema` is false on most endpoints anyway.
    const { planned, repair } = planIntents(registry, [
        { callId: "eval", slug: first.slug, args: first.args },
    ])
    if (planned.length === 0) {
        // Field *and* message, every error, not just the first. A `FieldError.message` is a sentence
        // fragment written to sit after the field name — reporting the message alone renders every
        // distinct failure as the same anonymous string, which is how one parser defect can read as
        // twenty-five unrelated model mistakes.
        const detail = repair.map((error) => `${error.field} ${error.message}`).join(" · ")
        return { outcome: "args_wrong", called, note: detail === "" ? "did not coerce" : detail }
    }
    const mismatch = argsMatch(task, planned[0]?.args ?? {})
    return mismatch === undefined
        ? { outcome: "correct", called }
        : { outcome: "args_wrong", called, note: mismatch }
}

// ─── one attempt ─────────────────────────────────────────────────────────────────────────

interface Runner {
    readonly dialect: ToolDialect
    readonly registry: ToolRegistry
    run(task: EvalTask): Promise<Attempt>
}

function makeRunner(
    model: ModelUnderTest,
    dialect: ToolDialect,
    registry: ToolRegistry,
    env: Record<string, string | undefined>,
): Runner {
    const provider = createChatCompletionsProvider({
        baseUrl: model.baseUrl,
        ...(model.apiKeyEnv === undefined ? {} : { apiKeyEnv: model.apiKeyEnv }),
        ...(model.streamUsage === true ? { streamUsage: true } : {}),
        env,
        // One attempt, no retry beyond a transport hiccup: a retried fixture is a fixture measured
        // under different conditions from its neighbours.
        retry: { attempts: 2, baseDelayMs: 500, maxDelayMs: 4000 },
    })

    const specs = registry.specs()
    const blocks = dialect.renderCatalogue(specs)
    const requestTools = dialect.requestTools(specs)
    const capabilities = resolveCapabilities(model.id)
    const wireTokens = requestTools === undefined ? 0 : nativeWireTokens(requestTools)

    return {
        dialect,
        registry,
        async run(task) {
            const assembled = assembleContext({
                identity: IDENTITY,
                toolBlocks: blocks,
                history: [],
                input: task.prompt,
                window: Math.max(1, capabilities.contextWindow - wireTokens),
                reserveOutput: Math.min(2048, capabilities.maxOutput),
            })

            const started = performance.now()
            let text = ""
            const calls: ToolCallRequest[] = []
            let promptTokens = assembled.totalTokens + wireTokens
            let outputTokens = 0

            try {
                const stream = provider.chat(
                    {
                        model: model.id,
                        messages: assembled.messages,
                        ...(requestTools === undefined ? {} : { tools: requestTools }),
                        temperature: 0,
                        maxTokens: Math.min(2048, capabilities.maxOutput),
                        // Left to the endpoint unless a model asks otherwise. Unlike `eval-rules`,
                        // this one measures routing — deciding *which* tool and *which* arguments —
                        // and deliberation is part of that decision rather than overhead on it.
                        // Forcing it off here would measure a different question than the gate asks.
                        ...(model.reasoningEffort === undefined
                            ? {}
                            : { reasoningEffort: model.reasoningEffort }),
                    },
                    AbortSignal.timeout(180_000),
                )
                for await (const chunk of stream as AsyncIterable<ChatChunk>) {
                    if (chunk.type === "text") text += chunk.delta
                    else if (chunk.type === "tool_call") calls.push(chunk.call)
                    else if (chunk.type === "usage") {
                        promptTokens = chunk.promptTokens
                        outputTokens = chunk.completionTokens
                    }
                }
            } catch (error) {
                // Reported as its own outcome rather than folded into a miss. A transport failure
                // counted as a routing error would make an endpoint problem look like a dialect one.
                return {
                    task: task.id,
                    group: task.group,
                    outcome: "unparseable",
                    called: [],
                    promptTokens,
                    outputTokens,
                    latencyMs: Math.round(performance.now() - started),
                    note: `transport: ${error instanceof Error ? error.message : String(error)}`,
                }
            }

            const parsed = dialect.parse({ text, calls })
            const judged = score(task, registry, parsed, parsed.malformed?.length ?? 0)
            const note = judged.note

            return {
                task: task.id,
                group: task.group,
                outcome: judged.outcome,
                called: judged.called,
                promptTokens,
                // Estimated only when the endpoint reported nothing. Named in the report so a
                // token comparison is never silently the estimator's.
                outputTokens: outputTokens === 0 ? Math.ceil(text.length / 3.8) : outputTokens,
                latencyMs: Math.round(performance.now() - started),
                ...(note === undefined ? {} : { note }),
                ...(judged.outcome === "correct" ? {} : { raw: { text, calls } }),
            }
        },
    }
}

// ─── aggregation ─────────────────────────────────────────────────────────────────────────

interface Summary {
    readonly attempts: number
    readonly correct: number
    readonly argsWrong: number
    readonly misrouted: number
    readonly critical: number
    readonly unparseable: number
    readonly accuracy: number
    readonly criticalRate: number
    readonly promptTokens: number
    readonly outputTokens: number
    readonly medianLatencyMs: number
}

function median(values: readonly number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
        ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
        : (sorted[middle] ?? 0)
}

function summarise(attempts: readonly Attempt[]): Summary {
    const count = (outcome: Outcome) => attempts.filter((a) => a.outcome === outcome).length
    const correct = count("correct")
    const critical = count("critical")
    return {
        attempts: attempts.length,
        correct,
        argsWrong: count("args_wrong"),
        misrouted: count("misrouted"),
        critical,
        unparseable: count("unparseable"),
        accuracy: attempts.length === 0 ? 0 : correct / attempts.length,
        criticalRate: attempts.length === 0 ? 0 : critical / attempts.length,
        promptTokens: attempts.reduce((sum, a) => sum + a.promptTokens, 0),
        outputTokens: attempts.reduce((sum, a) => sum + a.outputTokens, 0),
        medianLatencyMs: median(attempts.map((a) => a.latencyMs)),
    }
}

function byGroup(attempts: readonly Attempt[]): Record<string, Summary> {
    const groups = [...new Set(attempts.map((a) => a.group))]
    return Object.fromEntries(
        groups.map((group) => [group, summarise(attempts.filter((a) => a.group === group))]),
    )
}

// ─── reporting ───────────────────────────────────────────────────────────────────────────

interface ModelResult {
    readonly model: string
    readonly id: string
    readonly params: number
    readonly nlt: { summary: Summary; groups: Record<string, Summary>; attempts: Attempt[] }
    readonly native: { summary: Summary; groups: Record<string, Summary>; attempts: Attempt[] }
}

function pct(value: number): string {
    return `${(value * 100).toFixed(1)}%`
}

function delta(a: number, b: number): string {
    const points = (a - b) * 100
    return `${points >= 0 ? "+" : ""}${points.toFixed(1)}pp`
}

function markdown(results: readonly ModelResult[], meta: Record<string, unknown>): string {
    const lines: string[] = [
        "# Tool dialect comparison — NLT vs native",
        "",
        `Run ${String(meta.startedAt)} · ${String(meta.tasks)} of ${String(meta.totalFixtures)} fixtures × ${String(meta.repeats)} pass(es) · temperature 0`,
        "",
        `reasoning_effort: ${Object.entries((meta.reasoning ?? {}) as Record<string, string>)
            .map(([id, effort]) => `${id}=${effort}`)
            .join(" · ")}`,
        "",
        ...(meta.tasks === meta.totalFixtures
            ? []
            : [
                  `> **Partial run** — only the \`${String(meta.groups)}\` group(s). Not a result to cite.`,
                  "",
              ]),
        "Reproduce with `bun scripts/eval-tools.ts`. Fixtures live in `evals/fixtures/`.",
        "",
        "**Scope.** One model call per fixture; scoring is routing plus argument coercion, with no tool",
        "executed. This measures the step where the model decides, which is what the dialect claim is",
        "about — not multi-step behaviour, which `tool-loop.test.ts` and the live runs cover.",
        "",
        "**Before quoting a number here, read what the model actually wrote.** `results.json` keeps the",
        "raw text and calls on every attempt that was not `correct`, under `attempts[].raw`. The first",
        "run of this suite reported NLT at 27% against native's 92% on the smallest model, and the cause",
        "was a placeholder in NLT's own prompt rather than anything about the dialect — see decision 4.19.",
        "",
        "## Accuracy",
        "",
        "| Model | ~B params | NLT | native | Δ | NLT critical | native critical |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]

    for (const result of results) {
        lines.push(
            `| ${result.model} | ${result.params} | ${pct(result.nlt.summary.accuracy)} | ${pct(result.native.summary.accuracy)} | ${delta(result.nlt.summary.accuracy, result.native.summary.accuracy)} | ${pct(result.nlt.summary.criticalRate)} | ${pct(result.native.summary.criticalRate)} |`,
        )
    }

    lines.push("", "## Tokens and latency", "")
    lines.push("| Model | NLT prompt | native prompt | Δ | NLT output | native output |")
    lines.push("| --- | --- | --- | --- | --- | --- |")
    for (const result of results) {
        const n = result.nlt.summary
        const v = result.native.summary
        const change =
            v.promptTokens === 0
                ? "—"
                : `${(((n.promptTokens - v.promptTokens) / v.promptTokens) * 100).toFixed(1)}%`
        lines.push(
            `| ${result.model} | ${n.promptTokens} | ${v.promptTokens} | ${change} | ${n.outputTokens} | ${v.outputTokens} |`,
        )
    }

    lines.push("", "## By fixture group", "")
    for (const result of results) {
        lines.push(`### ${result.model}`, "")
        lines.push("| Group | NLT | native | Δ |", "| --- | --- | --- | --- |")
        for (const group of Object.keys(result.nlt.groups)) {
            const n = result.nlt.groups[group]
            const v = result.native.groups[group]
            if (n === undefined || v === undefined) continue
            lines.push(
                `| ${group} | ${pct(n.accuracy)} | ${pct(v.accuracy)} | ${delta(n.accuracy, v.accuracy)} |`,
            )
        }
        lines.push("")
    }

    // Named individually rather than only counted: a critical error is the outcome worth reading the
    // detail of, and a summary percentage is not enough to act on.
    const criticals = results.flatMap((result) =>
        [
            ...result.nlt.attempts.map((a) => ({ ...a, dialect: "nlt", model: result.model })),
            ...result.native.attempts.map((a) => ({
                ...a,
                dialect: "native",
                model: result.model,
            })),
        ].filter((a) => a.outcome === "critical"),
    )
    if (criticals.length > 0) {
        lines.push("## Critical errors in full", "")
        lines.push("| Model | Dialect | Fixture | What fired |", "| --- | --- | --- | --- |")
        for (const item of criticals) {
            lines.push(`| ${item.model} | ${item.dialect} | ${item.task} | ${item.note ?? ""} |`)
        }
        lines.push("")
    }

    const smallest = results.at(0)
    if (smallest !== undefined) {
        const pass = smallest.nlt.summary.accuracy >= smallest.native.summary.accuracy
        // Same rule as the exit code: a narrowed run reports the comparison but is not allowed to call
        // itself the gate, because the heading is what gets quoted rather than the banner above it.
        const whole = meta.tasks === meta.totalFixtures
        // And the gate needs a model the claim is actually about. NLT's advantage is specifically a
        // small-open-weight result; deciding it on a closed model whose size is a rumour would be a
        // pass nobody could check.
        const decidable = whole && meta.smallOpenWeight === true

        lines.push(
            decidable ? "## Phase 3 gate" : "## Dialect comparison — not the Phase 3 gate",
            "",
            `> NLT ≥ native on the smallest open-weight model tested — if not, stop and investigate before proceeding.`,
            "",
        )

        if (decidable) {
            lines.push(
                `Smallest model tested: **${smallest.model}**. NLT ${pct(smallest.nlt.summary.accuracy)} vs native ${pct(smallest.native.summary.accuracy)} — **${pass ? "PASS" : "FAIL"}**.`,
                "",
            )
        } else if (!whole) {
            lines.push(
                `Smallest model tested: **${smallest.model}**. NLT ${pct(smallest.nlt.summary.accuracy)} vs native ${pct(smallest.native.summary.accuracy)} over the \`${String(meta.groups)}\` group(s) only. The gate is defined over all ${String(meta.totalFixtures)} fixtures; run without \`--tasks\` to decide it.`,
                "",
            )
        } else {
            lines.push(
                `**Undecided — no open-weight model ran.** Smallest tested was **${smallest.model}**, whose parameter count is unpublished. Set \`SMALL_MODEL_ID\` and \`SMALL_MODEL_BASE_URL\` to a hosted open-weight endpoint and run again.`,
                "",
            )
        }
    }

    return `${lines.join("\n")}\n`
}

// ─── main ────────────────────────────────────────────────────────────────────────────────

const FLAGS = ["model", "tasks", "repeats", "out"] as const

function arg(name: (typeof FLAGS)[number]): string | undefined {
    const index = process.argv.indexOf(`--${name}`)
    return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * Refuse a flag this script does not know.
 *
 * Silently ignoring one is how `--only qwen --groups abstain` runs the entire sweep against every
 * model instead: the run looks like it obeyed, takes seven times as long, and reports numbers for a
 * scope nobody asked for. A misspelled narrowing flag has to fail, not widen.
 */
function checkFlags(): string | undefined {
    const unknown = process.argv
        .slice(2)
        .filter((token) => token.startsWith("--"))
        .map((token) => token.slice(2).split("=")[0] ?? "")
        .filter((name) => !FLAGS.includes(name as (typeof FLAGS)[number]))
    if (unknown.length === 0) return undefined
    return `eval-tools: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `--${name}`).join(", ")}. Known flags: ${FLAGS.map((name) => `--${name}`).join(", ")}.`
}

function loadEnv(): Record<string, string | undefined> {
    // The same `.env` the CLI reads, so a key set for one is set for the other.
    try {
        return { ...process.env, ...parseDotEnv(readFileSync(".env", "utf8")) }
    } catch {
        return { ...process.env }
    }
}

async function main(): Promise<number> {
    const badFlag = checkFlags()
    if (badFlag !== undefined) {
        console.error(badFlag)
        return 2
    }

    const env = loadEnv()
    const repeats = Number(arg("repeats") ?? 1)
    const only = arg("model")
    const groups = arg("tasks")?.split(",")
    const outDir = arg("out") ?? join("evals", "tools")

    const tasks =
        groups === undefined ? EVAL_TASKS : EVAL_TASKS.filter((t) => groups.includes(t.group))
    if (tasks.length === 0) {
        console.error("eval-tools: no fixtures matched --tasks")
        return 1
    }

    // The small slot leads, because the whole ordering is smallest-first and the gate is about it.
    const small = smallModel(env)
    const all: readonly ModelUnderTest[] = small === undefined ? MODELS : [small, ...MODELS]
    if (small === undefined) {
        console.log(
            "no small open-weight model configured — set SMALL_MODEL_ID and SMALL_MODEL_BASE_URL.",
        )
        console.log(
            "The gate is about small models specifically, so a sweep without one cannot settle it.",
        )
    }

    const candidates = all
        .filter((model) => only === undefined || model.id === only)
        .filter((model) => {
            if (model.apiKeyEnv === undefined) return true
            const present = (env[model.apiKeyEnv] ?? "") !== ""
            if (!present) console.log(`skipping ${model.label} — ${model.apiKeyEnv} is not set`)
            return present
        })

    if (candidates.length === 0) {
        console.error(
            "eval-tools: no model is reachable. Set an API key, or configure SMALL_MODEL_BASE_URL.",
        )
        return 1
    }

    const registry = await ToolRegistry.create({
        pinned: EVAL_TOOL_SLUGS,
        providers: [evalToolProvider()],
        budget: { max: 32, reserveWrite: 6 },
    })

    const startedAt = new Date().toISOString()
    const results: ModelResult[] = []

    for (const model of [...candidates].sort((a, b) => a.params - b.params)) {
        const runners = {
            nlt: makeRunner(model, nltDialect, registry, env),
            native: makeRunner(model, nativeDialect, registry, env),
        }
        const attempts = { nlt: [] as Attempt[], native: [] as Attempt[] }

        console.log(`\n${model.label} — ${tasks.length} fixtures × ${repeats}, both dialects`)
        for (let pass = 1; pass <= repeats; pass += 1) {
            for (const task of tasks) {
                // Interleaved per fixture, so endpoint drift or a rate limit lands on both dialects
                // rather than on whichever ran second.
                for (const dialect of ["nlt", "native"] as const) {
                    const attempt = await runners[dialect].run(task)
                    attempts[dialect].push(attempt)
                    const mark =
                        attempt.outcome === "correct"
                            ? "ok"
                            : attempt.outcome === "critical"
                              ? "CRITICAL"
                              : attempt.outcome
                    console.log(
                        `  ${dialect.padEnd(6)} ${task.id.padEnd(28)} ${mark}${attempt.note === undefined ? "" : ` — ${attempt.note}`}`,
                    )
                }
            }
        }

        results.push({
            model: model.label,
            id: model.id,
            params: model.params,
            nlt: {
                summary: summarise(attempts.nlt),
                groups: byGroup(attempts.nlt),
                attempts: attempts.nlt,
            },
            native: {
                summary: summarise(attempts.native),
                groups: byGroup(attempts.native),
                attempts: attempts.native,
            },
        })
    }

    const meta = {
        startedAt,
        tasks: tasks.length,
        // Recorded so a partial run cannot be mistaken for a full one after the fact. A `--tasks`
        // subset writes to the same place, and "5 fixtures" in the header is the only thing that
        // distinguishes a smoke test's numbers from the committed result.
        totalFixtures: EVAL_TASKS.length,
        groups: groups ?? "all",
        repeats,
        fixtures: "evals/fixtures",
        // Whether the run included a model the gate is actually about. Recorded rather than derived
        // later: a sweep of closed models can produce every other number in this file and still be
        // unable to decide the one claim Phase 3 turns on.
        smallOpenWeight: candidates.some((model) => model.openWeight === true),
        // Recorded because it changes what the numbers mean. A run with reasoning suppressed is not
        // comparable to one without it — measured on qwen3.5:9b, `none` traded two correct enum
        // fixtures for two empty replies — and a report that omits the setting invites exactly that
        // comparison.
        reasoning: Object.fromEntries(
            candidates.map((model) => [model.id, model.reasoningEffort ?? "endpoint default"]),
        ),
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, "results.json"), `${JSON.stringify({ meta, results }, null, 2)}\n`)
    writeFileSync(join(outDir, "README.md"), markdown(results, meta))

    console.log(`\nwritten to ${outDir}/results.json and ${outDir}/README.md`)
    for (const result of results) {
        console.log(
            `  ${result.model}: nlt ${pct(result.nlt.summary.accuracy)} · native ${pct(result.native.summary.accuracy)} · ${delta(result.nlt.summary.accuracy, result.native.summary.accuracy)}`,
        )
    }

    // The gate is the script's exit code, not a line in a report someone has to read. A failing
    // comparison should stop a pipeline the same way a failing test does.
    //
    // A narrowed run still fails loudly — a subset that regresses is worth stopping for — but it does
    // not get to speak for Phase 3. The gate is defined over the whole fixture set, and a four-group
    // subset invoking it by name is how a `--tasks` result ends up quoted as the decision.
    const smallest = results.at(0)
    const partial = meta.tasks !== meta.totalFixtures
    if (
        smallest !== undefined &&
        smallest.nlt.summary.accuracy < smallest.native.summary.accuracy
    ) {
        console.error(
            `\neval-tools: ${partial ? "SUBSET REGRESSION" : "GATE FAILED"} — on ${smallest.model}, the smallest model tested, NLT (${pct(smallest.nlt.summary.accuracy)}) scored below native (${pct(smallest.native.summary.accuracy)}).${
                partial
                    ? ` Only the ${String(meta.groups)} group(s) ran, so this is not the Phase 3 gate — re-run with no --tasks flag to decide it.`
                    : " Phase 3 says stop and investigate."
            }`,
        )
        return 1
    }

    // A clean sweep with no open-weight model is not a pass, it is an undecided gate — and it exits
    // 0, because nothing regressed. Saying so out loud is the difference between "we checked" and
    // "we ran something green".
    if (!meta.smallOpenWeight && !partial) {
        console.log(
            "\neval-tools: gate UNDECIDED — no open-weight model ran, and NLT's claim is about those specifically.",
        )
        console.log(
            "  Set SMALL_MODEL_ID, SMALL_MODEL_BASE_URL and SMALL_MODEL_API_KEY to a hosted open-weight endpoint.",
        )
    }
    return 0
}

process.exitCode = await main()
