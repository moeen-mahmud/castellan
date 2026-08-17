/**
 * The service-manager seam, and the only place in this package that spawns a subprocess.
 *
 * Deliberately thin. Every decision lives in `daemon-plan.ts` and every string transformation in
 * `launchd.ts`, both pure; what is left here is "run `launchctl` and hand back what it said", which
 * is the part no test should be exercising against a real machine. `Exec` is injectable for that
 * reason — the daemon tests drive a fake and never touch the user's `~/Library/LaunchAgents`.
 *
 * ## The Linux refusal is not a stub
 *
 * A systemd renderer nobody here can execute would be a liability: wrong in ways no test catches,
 * shipped with an acceptance criterion that could not honestly be ticked. So Linux gets a refusal —
 * but one that does the *hard* part of the workaround, which is resolving the absolute interpreter
 * and script paths. Those are what people get wrong by hand, and this process already knows them.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { HarnessError } from "@castellan/core"
import {
    EXIT_TIMEOUT_SECONDS,
    type PrintFacts,
    parseDisabled,
    parseLaunchctlList,
    parseLaunchctlPrint,
    renderPlist,
    type ServicePlan,
} from "#lib/launchd"
import { spawnCapture } from "#lib/spawn"

export interface ExecResult {
    readonly code: number
    readonly stdout: string
    readonly stderr: string
}
export type Exec = (command: string, args: readonly string[]) => ExecResult

export interface ServiceState {
    readonly installed: boolean
    readonly disabled: boolean
    readonly print?: PrintFacts
    readonly pid?: number
}

export interface ServiceManager {
    readonly id: string
    unitPath(label: string): string
    install(plan: ServicePlan): void
    uninstall(label: string): void
    stop(label: string): void
    start(label: string): void
    restart(label: string): void
    state(label: string): ServiceState
    /** Every label this manager knows about that belongs to us, for a bare `status`. */
    labels(prefix: string): readonly string[]
}

const realExec: Exec = (command, args) => {
    const result = spawnCapture({ command, args })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

export interface ManagerOptions {
    readonly home: string
    readonly uid: number
    readonly envPrefix: string
    readonly exec?: Exec
}

export function resolveServiceManager(platform: string, options: ManagerOptions): ServiceManager {
    if (platform === "darwin") return new LaunchdManager(options)
    throw unsupported(platform)
}

/**
 * The refusal, with the workaround's hard part already solved.
 *
 * Filled in by the caller, which knows the resolved paths — a message naming `ExecStart=` with real
 * absolute values is worth more than a paragraph explaining that they matter.
 */
export function unsupported(platform: string, execStart?: string): HarnessError {
    const recipe =
        execStart === undefined
            ? ""
            : ` For a systemd user unit, the line to write is:\n\n      ${execStart}\n      Restart=on-failure\n      RestartSec=30\n\n    Put no secrets in the unit: the agent reads the .env beside its manifest, and \`systemctl show\` echoes Environment= to anyone.`
    return new HarnessError({
        code: "daemon_platform_unsupported",
        message: `daemon installs a macOS LaunchAgent, and this platform is ${platform}.`,
        hint: `Linux service installation is not built — nothing in this project's test environment can run systemctl, and shipping a unit file nobody has executed is how a "supported" platform turns out not to be.${recipe} In a container, run \`serve\` in the foreground and let the container runtime supervise it; that is the deployment this runtime is designed around.`,
    })
}

class LaunchdManager implements ServiceManager {
    readonly id = "launchd"
    readonly #home: string
    readonly #domain: string
    readonly #envPrefix: string
    readonly #exec: Exec

    constructor(options: ManagerOptions) {
        this.#home = options.home
        this.#domain = `gui/${options.uid}`
        this.#envPrefix = options.envPrefix
        this.#exec = options.exec ?? realExec
    }

    unitPath(label: string): string {
        return join(this.#home, "Library", "LaunchAgents", `${label}.plist`)
    }

    install(plan: ServicePlan): void {
        const path = this.unitPath(plan.label)
        // Rendered before anything is written, because `renderPlist` is where the no-secrets rule
        // is enforced — a throw must not leave a half-installed service behind.
        const body = renderPlist(plan, this.#envPrefix)

        mkdirSync(dirname(path), { recursive: true })
        mkdirSync(dirname(plan.stdoutPath), { recursive: true })

        // Unload an existing copy first; `bootstrap` over a loaded job is an error, not an update.
        this.#launchctl(["bootout", `${this.#domain}/${plan.label}`], { tolerate: true })
        // 0600 is not the protection — `launchctl print` reads a loaded job's environment whatever
        // the file mode — but there is no reason for it to be readable and OpenClaw's is 0644.
        writeFileSync(path, body, { encoding: "utf8", mode: 0o600 })
        // Before bootstrap, and not optional: `disable` state persists across boots, so a service
        // that was once `daemon stop`ped would install cleanly here and then silently never start.
        this.#launchctl(["enable", `${this.#domain}/${plan.label}`], { tolerate: true })
        this.#launchctl(["bootstrap", this.#domain, path])
    }

    uninstall(label: string): void {
        this.#launchctl(["bootout", `${this.#domain}/${label}`], { tolerate: true })
        // Re-enabled on the way out so a future install is not gated on a disable nobody remembers.
        this.#launchctl(["enable", `${this.#domain}/${label}`], { tolerate: true })
        rmSync(this.unitPath(label), { force: true })
    }

    stop(label: string): void {
        // Disable *and* unload. `bootout` alone stops it now and launchd loads it again at the next
        // login — the "I stopped it and it was back after lunch" surprise.
        this.#launchctl(["disable", `${this.#domain}/${label}`], { tolerate: true })
        this.#launchctl(["bootout", `${this.#domain}/${label}`], { tolerate: true })
    }

    start(label: string): void {
        this.#launchctl(["enable", `${this.#domain}/${label}`], { tolerate: true })
        this.#launchctl(["bootstrap", this.#domain, this.unitPath(label)])
    }

    restart(label: string): void {
        this.#launchctl(["kickstart", "-k", `${this.#domain}/${label}`])
    }

    state(label: string): ServiceState {
        const print = this.#exec("launchctl", ["print", `${this.#domain}/${label}`])
        const disabled = parseDisabled(
            this.#exec("launchctl", ["print-disabled", this.#domain]).stdout,
        ).includes(label)

        if (print.code !== 0) {
            // Not loaded. The plist may still exist on disk — a stopped service is exactly that —
            // so "installed" is a question for the caller, which can see the file.
            return { installed: false, disabled }
        }
        const facts = parseLaunchctlPrint(print.stdout)
        return {
            installed: true,
            disabled,
            print: facts,
            ...(facts.pid === undefined ? {} : { pid: facts.pid }),
        }
    }

    labels(prefix: string): readonly string[] {
        return parseLaunchctlList(this.#exec("launchctl", ["list"]).stdout)
            .map((entry) => entry.label)
            .filter((label) => label.startsWith(prefix))
    }

    #launchctl(args: readonly string[], options: { tolerate?: boolean } = {}): ExecResult {
        const result = this.#exec("launchctl", args)
        if (result.code === 0 || options.tolerate === true) return result
        // launchctl's own stderr, verbatim. Its messages are terse — "Bootstrap failed: 5:
        // Input/output error" — and paraphrasing loses the code, which is the only searchable part.
        throw new HarnessError({
            code: "daemon_launchctl_failed",
            message: `launchctl ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || "no output"}`,
            hint: `Code 5 usually means the service is already loaded — try \`daemon restart\`. Code 37 means an operation is still in progress; wait a moment. Code 125 or 112 means the ${this.#domain} domain is unavailable, which happens over SSH with no GUI session: a LaunchAgent needs a logged-in desktop session, and the exit timeout is ${EXIT_TIMEOUT_SECONDS}s.`,
        })
    }
}
