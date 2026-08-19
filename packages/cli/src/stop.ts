/**
 * `stop [agent]` — the switch that turns everything off.
 *
 * Every other way to stop an agent needs you to know what is running first: `daemon stop` needs the
 * label, ctrl-c needs the terminal that started it, `kill` needs the pid. This one needs nothing —
 * it finds the services *and* the loose `serve` you left in a tab three days ago, stops both, and
 * says what it stopped. That is the whole design brief: a person reaching for this is not in a
 * position to go looking.
 *
 * **Stopped means stopped.** A service is disabled as well as unloaded, because `bootout` alone
 * comes back at the next login and "I stopped it and it was running again after lunch" is the exact
 * failure a safety switch may not have. Reversible, loudly: the output names `daemon start`.
 *
 * **SIGTERM first, always.** A graceful stop is the only path that runs `provider.stop()`, which
 * reaps the child processes `exec` backgrounded — so killing hard to be thorough is how you end up
 * with the orphans that took this machine to a load average of 351. SIGKILL is the last resort,
 * after a grace period, and it says out loud what may have been left behind.
 */

import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { labelFor } from "#lib/launchd"
import { bullet, keyValue, type Row } from "#lib/render"
import { storePath } from "#lib/sandbox"
import { type Exec, resolveServiceManager, type ServiceManager } from "#lib/service"
import { BRAND, HarnessError, processAlive, readManifestHeader, SqliteStore } from "@dispach/core"
import { homedir } from "node:os"

/** How long a process gets to shut down cleanly before the last resort. */
const GRACE_MS = 12_000
const POLL_MS = 250

export interface StopOptions {
    /** Absolute manifest path. Omitted means every agent — the point of the command. */
    readonly manifestPath?: string
    readonly dryRun?: boolean
    readonly json?: boolean
    /** Test seams. Nothing in `src/` outside this file passes them. */
    readonly exec?: Exec
    readonly platform?: string
}

interface Target {
    readonly agentId: string
    /** A LaunchAgent exists for it. */
    readonly service: boolean
    /** A live process holds its runtime lease. */
    readonly pid?: number
    readonly mode?: string
}

type Outcome = Target & {
    readonly stopped: boolean
    /** Present when the graceful stop ran out of time. */
    readonly forced?: boolean
    readonly note: string
}

export async function stopCommand(options: StopOptions): Promise<number> {
    const platform = options.platform ?? process.platform
    // Only launchd is managed, but the lease half works everywhere — a `serve` in a terminal is a
    // process with a pid on any platform, and refusing to stop it because this is not macOS would
    // make the safety switch useless exactly where there is no service manager to fall back on.
    const manager =
        platform === "darwin"
            ? resolveServiceManager(platform, {
                  home: homedir(),
                  uid: process.getuid?.() ?? 0,
                  envPrefix: BRAND.envPrefix,
                  ...(options.exec === undefined ? {} : { exec: options.exec }),
              })
            : undefined

    const only = options.manifestPath === undefined ? undefined : agentIdOf(options.manifestPath)
    const targets = (await findTargets(manager)).filter(
        (target) => only === undefined || target.agentId === only,
    )

    if (targets.length === 0) {
        const scope = only === undefined ? "Nothing is running" : `"${only}" is not running`
        process.stdout.write(
            options.json === true
                ? `${JSON.stringify({ stopped: [] })}\n`
                : `${scope} — no service is installed and no process holds an agent.\n`,
        )
        // Zero. For a command whose job is to reach a state, already being in it is success.
        return EXIT_OK
    }

    if (options.dryRun === true) {
        process.stdout.write(
            `would stop ${targets.length} ${targets.length === 1 ? "agent" : "agents"}:\n${targets
                .map((target) => bullet(describe(target)))
                .join("\n")}\n`,
        )
        return EXIT_OK
    }

    const outcomes: Outcome[] = []
    for (const target of targets) outcomes.push(await stopOne(target, manager))

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ stopped: outcomes }, null, 2)}\n`)
    } else {
        const rows: Row[] = outcomes.map((outcome) => ({
            label: outcome.agentId,
            value: outcome.stopped ? "stopped" : "STILL RUNNING",
            note: outcome.note,
        }))
        process.stdout.write(`${keyValue(rows)}\n`)

        if (outcomes.some((outcome) => outcome.service && outcome.stopped)) {
            process.stdout.write(
                `\nServices are disabled as well as unloaded, so they stay stopped across a reboot.\nStart one again with \`${BRAND.slug} daemon start <agent>\`.\n`,
            )
        }
        if (outcomes.some((outcome) => outcome.forced === true)) {
            process.stdout.write(
                `\nSomething had to be killed rather than asked. A forced stop skips the runtime's own\ncleanup, so a command the agent had left running in the background may still be alive —\n\`ps\` will show it if so.\n`,
            )
        }
    }

    return outcomes.every((outcome) => outcome.stopped) ? EXIT_OK : EXIT_FAILURE
}

/**
 * Everything that could be running, from both sources.
 *
 * Two sources because neither is complete. `launchctl` knows about installed services and nothing
 * about the `serve` you started by hand; the lease table knows about any live process and nothing
 * about a service that is installed but currently down. A safety switch that consulted one of them
 * would leave the other running and report success.
 */
async function findTargets(manager: ServiceManager | undefined): Promise<readonly Target[]> {
    const prefix = `${BRAND.slug}.agent.`
    const byId = new Map<string, Target>()

    for (const label of manager?.labels(prefix) ?? []) {
        const agentId = label.slice(prefix.length)
        byId.set(agentId, { agentId, service: true })
    }

    try {
        const store = await SqliteStore.open({ path: storePath() })
        for (const lease of await store.leases.all()) {
            // Not this process, and not a row whose process is already gone — a stale lease is not
            // something to stop, and reporting it as one would make the command lie about its work.
            if (lease.pid === process.pid || !processAlive(lease.pid)) continue
            byId.set(lease.agentId, {
                agentId: lease.agentId,
                service: byId.get(lease.agentId)?.service === true,
                pid: lease.pid,
                mode: lease.mode,
            })
        }
        await store.close()
    } catch {
        // No store yet means nothing has ever run. Not an error for this command.
    }

    return [...byId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId))
}

async function stopOne(target: Target, manager: ServiceManager | undefined): Promise<Outcome> {
    const notes: string[] = []

    // The service first. Unloading it sends SIGTERM to the process itself, so doing this before the
    // direct signal avoids racing launchd's own restart policy — and disabling means it will not be
    // back at the next login.
    if (target.service && manager !== undefined) {
        try {
            manager.stop(labelFor(BRAND.slug, target.agentId))
            notes.push("service disabled and unloaded")
        } catch (error) {
            notes.push(
                `service could not be unloaded: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    if (target.pid === undefined) {
        return { ...target, stopped: true, note: notes.join(" · ") || "no process was running" }
    }

    // Already gone, most likely because unloading the service took it with it.
    if (!processAlive(target.pid)) {
        return { ...target, stopped: true, note: notes.join(" · ") || `pid ${target.pid} exited` }
    }

    const graceful = await signalAndWait(target.pid, "SIGTERM")
    if (graceful) {
        notes.push(`pid ${target.pid} stopped cleanly`)
        return { ...target, stopped: true, note: notes.join(" · ") }
    }

    // Last resort, and by process *group* — `sh -c "a | b | c"` killed by pid orphans two of three,
    // which is the shape decision 4.88 was written about.
    const forced = await signalAndWait(target.pid, "SIGKILL", true)
    notes.push(
        forced
            ? `pid ${target.pid} did not stop in ${Math.round(GRACE_MS / 1000)}s and was killed`
            : `pid ${target.pid} would not stop, even killed — check it by hand`,
    )
    return { ...target, stopped: forced, forced: true, note: notes.join(" · ") }
}

async function signalAndWait(pid: number, signal: NodeJS.Signals, group = false): Promise<boolean> {
    try {
        process.kill(group ? -pid : pid, signal)
    } catch (error) {
        // ESRCH means it went away between the check and the signal, which is the outcome we want.
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
        // A group kill can fail where the single-pid kill would not; fall back rather than give up.
        if (group) {
            try {
                process.kill(pid, signal)
            } catch {
                return !processAlive(pid)
            }
        }
    }

    const deadline = Date.now() + (signal === "SIGKILL" ? 3_000 : GRACE_MS)
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return true
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    return !processAlive(pid)
}

function describe(target: Target): string {
    const parts: string[] = []
    if (target.service) parts.push("background service")
    if (target.pid !== undefined)
        parts.push(`pid ${target.pid}${target.mode === undefined ? "" : ` (${target.mode})`}`)
    return `${target.agentId} — ${parts.join(", ")}`
}

function agentIdOf(manifestPath: string): string {
    const header = readManifestHeader(manifestPath)
    if (header.id === undefined || header.id === "") {
        throw new HarnessError({
            code: "cli_stop_agent_id_missing",
            message: `${manifestPath} declares no id, so there is nothing to match a running agent against.`,
            hint: `Add \`id: <name>\` to the manifest, or run \`${BRAND.slug} stop\` with no argument to stop everything.`,
        })
    }
    return header.id
}
