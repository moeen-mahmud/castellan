/**
 * The safety switch, driven against a fake service manager.
 *
 * `stop` is the one command whose correctness is about *coverage* — it has to find things nobody
 * told it about — so the assertions are mostly about what it looked at and what it did to each,
 * with a real process for the half that genuinely needs one.
 */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, SqliteStore } from "@castellan/core"
import type { Exec } from "#lib/service"
import { stopCommand } from "#stop"

const HOME_VAR = `${BRAND.envPrefix}HOME`

/** A sandbox of our own, so the real one is never touched. */
function sandbox(): { home: string; restore: () => void } {
    const home = mkdtempSync(join(tmpdir(), "stop-test-"))
    const previous = process.env[HOME_VAR]
    process.env[HOME_VAR] = home
    return {
        home,
        restore: () => {
            if (previous === undefined) delete process.env[HOME_VAR]
            else process.env[HOME_VAR] = previous
            rmSync(home, { recursive: true, force: true })
        },
    }
}

/** Records every `launchctl` invocation and answers `list` with the labels it was given. */
function fakeLaunchctl(labels: readonly string[]): { exec: Exec; calls: string[][] } {
    const calls: string[][] = []
    const exec: Exec = (command, args) => {
        calls.push([command, ...args])
        if (args[0] === "list") {
            return { code: 0, stdout: labels.map((l) => `-\t0\t${l}`).join("\n"), stderr: "" }
        }
        return { code: 0, stdout: "", stderr: "" }
    }
    return { exec, calls }
}

async function seedLease(home: string, agentId: string, pid: number, mode: "daemon" | "terminal") {
    const store = await SqliteStore.open({ path: join(home, "store.db") })
    await store.leases.claim({
        agentId,
        runtimeId: `rt_${agentId}`,
        pid,
        mode,
        now: new Date().toISOString(),
    })
    await store.close()
}

describe("stop", () => {
    test("nothing running is success, not a failure", async () => {
        const box = sandbox()
        try {
            const { exec } = fakeLaunchctl([])
            // Zero on purpose: this command's job is to reach a state, and already being in it is
            // the outcome asked for. Exiting non-zero would make it useless in a shutdown script.
            expect(await stopCommand({ exec, platform: "darwin" })).toBe(0)
        } finally {
            box.restore()
        }
    })

    /**
     * The coverage property. Neither source is complete on its own — `launchctl` cannot see a
     * `serve` started by hand, and the lease table cannot see a service that is installed but
     * currently down — so a switch consulting one of them leaves the other running and says it
     * finished.
     */
    test("it finds an installed service and a loose process that launchd knows nothing about", async () => {
        const box = sandbox()
        try {
            // Alive, and not us: a process that will outlive the assertion and can be signalled.
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                stdio: "ignore",
            })
            await seedLease(box.home, "loose", child.pid ?? 0, "terminal")

            const { exec } = fakeLaunchctl([`${BRAND.slug}.agent.installed`])
            const lines: string[] = []
            const write = process.stdout.write.bind(process.stdout)
            process.stdout.write = ((chunk: string) => {
                lines.push(String(chunk))
                return true
            }) as typeof process.stdout.write
            try {
                await stopCommand({ exec, platform: "darwin", dryRun: true })
            } finally {
                process.stdout.write = write
            }

            const out = lines.join("")
            expect(out).toContain("installed")
            expect(out).toContain("loose")
            expect(out).toContain("would stop 2 agents")

            child.kill("SIGKILL")
        } finally {
            box.restore()
        }
    })

    test("a dry run touches nothing", async () => {
        const box = sandbox()
        try {
            const { exec, calls } = fakeLaunchctl([`${BRAND.slug}.agent.milo`])
            await stopCommand({ exec, platform: "darwin", dryRun: true })
            // `list` to discover, and nothing else. A preview that unloaded a service would be the
            // worst possible reading of the word.
            expect(calls.map((call) => call[1])).toEqual(["list"])
        } finally {
            box.restore()
        }
    })

    /**
     * `bootout` alone comes back at the next login, which for a safety switch is the one behaviour
     * it may not have — "I stopped it and it was running again after lunch".
     */
    test("stopping a service disables it as well as unloading it", async () => {
        const box = sandbox()
        try {
            const { exec, calls } = fakeLaunchctl([`${BRAND.slug}.agent.milo`])
            expect(await stopCommand({ exec, platform: "darwin", json: true })).toBe(0)
            const verbs = calls.map((call) => call[1])
            expect(verbs).toContain("disable")
            expect(verbs).toContain("bootout")
            expect(verbs.indexOf("disable")).toBeLessThan(verbs.indexOf("bootout"))
        } finally {
            box.restore()
        }
    })

    test("a real process is asked to stop, and does", async () => {
        const box = sandbox()
        try {
            // Handles SIGTERM the way `serve` does — cleanly, on its own terms.
            const child = spawn(
                process.execPath,
                ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
                { stdio: "ignore" },
            )
            await new Promise((resolve) => setTimeout(resolve, 300))
            await seedLease(box.home, "milo", child.pid ?? 0, "terminal")

            const exited = new Promise<number | null>((resolve) => child.on("exit", resolve))
            const { exec } = fakeLaunchctl([])
            expect(await stopCommand({ exec, platform: "darwin", json: true })).toBe(0)
            expect(await exited).toBe(0)
        } finally {
            box.restore()
        }
    }, 30_000)

    test("a stale lease is not reported as something it stopped", async () => {
        const box = sandbox()
        try {
            // A pid that cannot be running. Counting it would make the command overstate its work,
            // which for a safety switch is the direction that matters.
            await seedLease(box.home, "ghost", 999_999_998, "daemon")
            const { exec } = fakeLaunchctl([])
            const lines: string[] = []
            const write = process.stdout.write.bind(process.stdout)
            process.stdout.write = ((chunk: string) => {
                lines.push(String(chunk))
                return true
            }) as typeof process.stdout.write
            try {
                expect(await stopCommand({ exec, platform: "darwin" })).toBe(0)
            } finally {
                process.stdout.write = write
            }
            expect(lines.join("")).toContain("Nothing is running")
        } finally {
            box.restore()
        }
    })

    test("it works off darwin, where there is no service manager to ask", async () => {
        const box = sandbox()
        try {
            // The lease half is platform-independent, and refusing here would make the switch
            // useless exactly where there is no `daemon stop` to fall back on.
            expect(await stopCommand({ platform: "linux" })).toBe(0)
        } finally {
            box.restore()
        }
    })
})
