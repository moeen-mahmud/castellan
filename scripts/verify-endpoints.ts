#!/usr/bin/env bun
/**
 * The three-endpoint acceptance check, as a reproducible script.
 *
 *   bun scripts/verify-endpoints.ts
 *
 * Phase 1's criterion is that the *same code and the same manifest shape* work unchanged against
 * OpenAI, an Anthropic-compatible base URL, and a local Ollama. That is a claim about
 * portability, so it has to be run rather than asserted — and it needs credentials this
 * repository does not and should not contain.
 *
 * Configure whichever endpoints you have and run it. Anything unconfigured is reported as
 * SKIPPED, and the script says plainly whether the criterion was met, because "2 of 3 passed and
 * one was skipped" is not the same as "verified".
 *
 *   OPENAI_API_KEY=...      [OPENAI_MODEL=gpt-4o-mini]
 *   ANTHROPIC_API_KEY=...   [ANTHROPIC_MODEL=claude-sonnet-4-20250514]
 *   DEEPSEEK_API_KEY=...     [DEEPSEEK_MODEL=deepseek-v4-flash]
 *   OLLAMA_BASE_URL=http://localhost:11434/v1   [OLLAMA_MODEL=qwen3:8b]
 *
 * Add `--mock` to include the local mock endpoint from `scripts/mock-endpoint.ts`, which proves
 * the transport without proving portability.
 */

import { BRAND } from "../packages/core/src/brand.ts"
import { HarnessError } from "../packages/core/src/errors.ts"
import { Runtime } from "../packages/core/src/runtime/runtime.ts"

const PROMPT = "Reply with exactly the word: ready"

interface Target {
    readonly label: string
    readonly modelId: string
    readonly baseUrl: string
    readonly apiKeyEnv?: string
    readonly required: boolean
}

const env = process.env

const targets: Target[] = [
    {
        label: "OpenAI",
        modelId: env.OPENAI_MODEL ?? "gpt-4o-mini",
        baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        required: true,
    },
    {
        label: "Anthropic (OpenAI-compat)",
        modelId: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
        baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        required: true,
    },
    {
        label: "Ollama (local)",
        modelId: env.OLLAMA_MODEL ?? "qwen3:8b",
        baseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
        required: true,
    },
    // Not one of the three the acceptance criterion names, but a fourth provider on the same code
    // path is the strongest evidence the portability claim is real rather than curve-fitted to
    // three endpoints.
    {
        label: "DeepSeek",
        modelId: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
        baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        required: false,
    },
    {
        label: "DeepSeek (flash)",
        modelId: "deepseek-v4-flash",
        baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        required: false,
    },
]

if (process.argv.includes("--mock")) {
    targets.push({
        label: "Mock endpoint",
        modelId: "mock-model",
        baseUrl: env.MOCK_BASE_URL ?? "http://localhost:8787/v1",
        required: false,
    })
}

type Outcome =
    | { status: "pass"; label: string; detail: string }
    | { status: "fail"; label: string; detail: string }
    | { status: "skip"; label: string; detail: string }

async function check(target: Target): Promise<Outcome> {
    if (target.apiKeyEnv !== undefined && (env[target.apiKeyEnv] ?? "") === "") {
        return { status: "skip", label: target.label, detail: `${target.apiKeyEnv} is not set` }
    }

    // Deliberately the same manifest shape for every endpoint. If any of these needed a
    // per-provider field, the portability claim would be false.
    const manifest = {
        apiVersion: BRAND.apiVersion,
        id: "verify",
        model: {
            main: {
                id: target.modelId,
                baseUrl: target.baseUrl,
                ...(target.apiKeyEnv === undefined ? {} : { apiKeyEnv: target.apiKeyEnv }),
                temperature: 0,
                // Generous on purpose. A reasoning model bills its thinking to the output
                // budget, so a tight allowance returns empty content with finish_reason=length —
                // which reads as "this endpoint is broken" when the fault is in this script.
                maxTokens: 4096,
            },
        },
        context: { reserveOutput: 4096 },
        limits: { turnTimeoutMs: 60_000 },
    }

    let runtime: Runtime | undefined
    try {
        runtime = await Runtime.create({ agents: [manifest] })
        const result = await runtime.agent("verify").send(PROMPT, { source: "verify" })

        if (result.reason !== "final") {
            return {
                status: "fail",
                label: target.label,
                detail: `turn ended as ${result.reason}${result.error === undefined ? "" : `: ${result.error.message}`}`,
            }
        }
        if (result.text.trim() === "") {
            return { status: "fail", label: target.label, detail: "empty reply" }
        }

        const preview = result.text.trim().replace(/\s+/g, " ").slice(0, 40)
        // Reported separately from the reply on purpose: a reasoning model whose chain of thought
        // leaked into `text` would look identical here otherwise, and that is the bug worth
        // catching when a provider's reasoning protocol is new.
        const reasoning =
            result.reasoning.trim() === "" ? "" : ` · reasoning ${result.reasoning.length} chars`
        return {
            status: "pass",
            label: target.label,
            detail: `${target.modelId} · ${result.durationMs} ms${reasoning} · "${preview}"`,
        }
    } catch (error) {
        const detail =
            error instanceof HarnessError
                ? `${error.code}: ${error.message}`
                : error instanceof Error
                  ? error.message
                  : String(error)
        return { status: "fail", label: target.label, detail }
    } finally {
        await runtime?.stop("verify-done")
    }
}

/**
 * Positional arguments filter by label substring, case-insensitively:
 *
 *   bun scripts/verify-endpoints.ts deepseek     just DeepSeek
 *   bun scripts/verify-endpoints.ts openai ollama
 *
 * Filtering exists because the unfiltered run is a *criterion* check and exits non-zero until all
 * three required endpoints answer — correct for the acceptance gate, and useless as feedback when
 * you only want to know whether your new key works.
 */
const filters = process.argv.slice(2).filter((argument) => !argument.startsWith("-"))
const selected =
    filters.length === 0
        ? targets
        : targets.filter((target) =>
              filters.some((filter) => target.label.toLowerCase().includes(filter.toLowerCase())),
          )

if (selected.length === 0) {
    console.error(`verify-endpoints: no endpoint matches ${filters.join(", ")}.`)
    console.error(`  hint: known labels are ${targets.map((t) => t.label).join(", ")}.`)
    process.exit(1)
}

const outcomes: Outcome[] = []
for (const target of selected) outcomes.push(await check(target))

const glyph = { pass: "  ok  ", fail: " FAIL ", skip: " skip " }
const scope = filters.length === 0 ? "all endpoints" : `filtered: ${filters.join(", ")}`
console.log(`verify-endpoints · one turn per endpoint, identical manifest shape · ${scope}\n`)
for (const outcome of outcomes) {
    console.log(`[${glyph[outcome.status]}] ${outcome.label.padEnd(26)} ${outcome.detail}`)
}

const failed = outcomes.filter((o) => o.status === "fail")
const passed = outcomes.filter((o) => o.status === "pass")
const skipped = outcomes.filter((o) => o.status === "skip")
const requiredPassed = outcomes.filter(
    (outcome, index) => outcome.status === "pass" && selected[index]?.required === true,
).length

console.log("")

if (failed.length > 0) {
    console.error(`verify-endpoints: ${failed.length} endpoint(s) failed.`)
    process.exit(1)
}

// A filtered run answers "does this endpoint work", so it succeeds when the thing asked about
// worked. Only the unfiltered run judges the Phase 1 criterion.
if (filters.length > 0) {
    if (passed.length === 0) {
        console.error(
            `verify-endpoints: nothing ran — ${skipped.length} skipped for missing credentials.`,
        )
        for (const outcome of skipped) console.error(`  ${outcome.label}: ${outcome.detail}`)
        process.exit(1)
    }
    console.log(`verify-endpoints: ${passed.length} endpoint(s) answered.`)
    process.exit(0)
}

if (requiredPassed < 3) {
    console.warn(
        `verify-endpoints: ${requiredPassed} of 3 required endpoints verified, ${skipped.length} skipped.\n` +
            "  The Phase 1 criterion needs all three. Configure the missing ones and re-run.\n" +
            "  To check just one provider instead, pass its name: bun run verify:endpoints deepseek",
    )
    process.exit(1)
}
console.log("verify-endpoints: all three endpoints answered with no code or manifest changes.")
