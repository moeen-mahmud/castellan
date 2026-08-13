#!/usr/bin/env bun
/**
 * Boot benchmark: process start → `runtime.ready`.
 *
 *   bun scripts/bench-boot.ts [--runs 7] [--ci] [--manifest path]
 *
 * Measured in a fresh child process every run, because the headline number includes interpreter
 * startup and a warm in-process measurement would flatter it by an order of magnitude.
 *
 * Reports the slowest phase, so a regression names its own cause instead of prompting a
 * bisect. The budget is 1000 ms; `--ci` fails the run above 1200 ms.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { Runtime } from "../packages/core/src/runtime/runtime.ts"

const BUDGET_MS = 1000
const CI_FAIL_MS = 1200

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const ROOT = resolve(import.meta.dirname, "..")
const manifestPath = resolve(ROOT, flag("manifest", "examples/minimal/agent.yaml"))

/**
 * The environment a boot needs. Values are placeholders: booting must not talk to the network,
 * so nothing here is ever dialled — which is itself part of what this benchmark proves.
 */
const CHILD_ENV = {
    MODEL_ID: "qwen3.5:9b",
    MODEL_BASE_URL: "http://127.0.0.1:1/v1",
    MODEL_API_KEY: "bench-placeholder",
}

interface ChildReport {
    bootMs: number
    processMs: number
    phases: Record<string, number>
}

if (args.includes("--child")) {
    const runtime = await Runtime.create({ agents: [manifestPath] })
    const report: ChildReport = {
        bootMs: runtime.boot.bootMs,
        processMs: runtime.boot.processMs,
        phases: runtime.boot.phases,
    }
    process.stdout.write(`__BENCH__${JSON.stringify(report)}\n`)
    await runtime.stop("bench")
    process.exit(0)
}

const runs = Math.max(1, Number(flag("runs", "7")))
const reports: ChildReport[] = []

for (let i = 0; i < runs; i += 1) {
    const child = spawnSync(
        process.execPath,
        [import.meta.filename, "--child", "--manifest", manifestPath],
        {
            encoding: "utf8",
            env: { ...process.env, ...CHILD_ENV },
        },
    )

    if (child.status !== 0) {
        console.error(`bench-boot: child run ${i + 1} failed with status ${child.status}`)
        console.error(child.stderr || child.stdout)
        process.exit(1)
    }

    const line = child.stdout.split("\n").find((l) => l.startsWith("__BENCH__"))
    if (line === undefined) {
        console.error("bench-boot: child produced no report")
        console.error(child.stdout)
        process.exit(1)
    }

    reports.push(JSON.parse(line.slice("__BENCH__".length)) as ChildReport)
}

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 1) return sorted[middle] ?? 0
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const processTimes = reports.map((r) => r.processMs)
const medianProcess = median(processTimes)
const minProcess = Math.min(...processTimes)
const maxProcess = Math.max(...processTimes)
const medianCreate = median(reports.map((r) => r.bootMs))

const phaseNames = [...new Set(reports.flatMap((r) => Object.keys(r.phases)))]
const phaseMedians = phaseNames
    .map((name) => ({
        name,
        ms: median(reports.map((r) => r.phases[name] ?? 0)),
    }))
    .sort((a, b) => b.ms - a.ms)

const slowest = phaseMedians[0]

console.log(`bench-boot · ${runs} runs · ${process.execPath.split("/").pop()}`)
console.log(
    `  process start → ready   median ${medianProcess.toFixed(1)} ms  (min ${minProcess.toFixed(1)}, max ${maxProcess.toFixed(1)})`,
)
console.log(`  inside Runtime.create   median ${medianCreate.toFixed(1)} ms`)
console.log(`  interpreter + imports   median ${(medianProcess - medianCreate).toFixed(1)} ms`)
console.log(`  budget                  ${BUDGET_MS} ms (CI fails above ${CI_FAIL_MS} ms)`)
console.log("  phases (median):")
for (const phase of phaseMedians) {
    console.log(`    ${phase.name.padEnd(10)} ${phase.ms.toFixed(2)} ms`)
}
if (slowest !== undefined) {
    console.log(`  slowest phase           ${slowest.name} at ${slowest.ms.toFixed(2)} ms`)
}

if (medianProcess > CI_FAIL_MS) {
    console.error(
        `\nbench-boot: FAIL — median ${medianProcess.toFixed(1)} ms exceeds the CI ceiling of ${CI_FAIL_MS} ms.` +
            `\n  hint: the slowest phase is "${slowest?.name ?? "unknown"}". A benchmark that is not enforced becomes an aspiration.`,
    )
    process.exit(1)
}

if (medianProcess > BUDGET_MS) {
    console.warn(
        `\nbench-boot: over budget — median ${medianProcess.toFixed(1)} ms exceeds the ${BUDGET_MS} ms target but is under the CI ceiling.`,
    )
    if (args.includes("--ci")) process.exit(0)
}

console.log("\nbench-boot: ok")
