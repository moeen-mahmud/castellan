/**
 * The daemon's decisions, as pure functions: what would stop an install, and what a service's
 * state actually means.
 *
 * Facts in, verdicts out. Gathering the facts needs the filesystem, `launchctl` and a manifest
 * loader; *judging* them needs none of that, and separating the two is what makes the interesting
 * cases — a restart loop, a stale heartbeat, a binary inside a git checkout — testable as a table
 * rather than by breaking a real machine in nine different ways.
 *
 * No `node:*`, no `process`. This module is on the boundaries test's `PURE` list.
 */

import { bytes, duration, keyValue, type Row } from "#lib/render"

export type Severity = "block" | "warn"

export interface Finding {
    readonly code: string
    readonly severity: Severity
    readonly message: string
    /** Never optional. Hard rule 7, and a test asserts it over every finding this can produce. */
    readonly hint: string
}

export interface BinaryFacts {
    /** `realpath(process.execPath)` — the interpreter, absolute. */
    readonly execPath: string
    /** `realpath(process.argv[1])` — the script, absolute. */
    readonly scriptPath: string
    /** Nearest ancestor of `scriptPath` holding a `.git`, if any. */
    readonly gitRoot?: string
}

export interface PreflightFacts {
    readonly platform: string
    readonly agentId: string
    readonly manifestPath: string
    readonly agentDir: string
    readonly binary: BinaryFacts
    /** `undefined` when there is no `.env` beside the manifest. */
    readonly envFileMode?: number
    readonly enabledChannels: readonly string[]
    readonly serverEnabled: boolean
    readonly serverHost: string
    readonly serverTokenPresent: boolean
    /** A plist already at this label, and the manifest it names. */
    readonly installedManifest?: string
    /** A live runtime lease, if one is held. */
    readonly servedBy?: { readonly pid: number; readonly mode: string; readonly startedAt: string }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"])

export function isLoopbackHost(host: string): boolean {
    return LOOPBACK.has(host.toLowerCase())
}

/**
 * Everything that would stop, or should worry, an install — in one ordered list.
 *
 * Blocking findings are collected rather than thrown one at a time: a command line with two
 * mistakes should report both, because fixing them one round trip at a time is the experience this
 * whole phase is a reaction to.
 *
 * Preflight is a **convenience**, not the safety mechanism. It runs once, at install, and cannot
 * know about the key that gets rotated three weeks later. What actually keeps a broken service from
 * looping is the exit-code contract plus `KeepAlive: {Crashed: true}` — see `launchd.ts`.
 */
export function preflightFindings(facts: PreflightFacts): readonly Finding[] {
    const out: Finding[] = []

    if (facts.enabledChannels.length === 0 && !facts.serverEnabled) {
        out.push({
            code: "daemon_nothing_to_serve",
            severity: "block",
            message: `Agent "${facts.agentId}" has no enabled channel and its HTTP server is off, so a background service would answer nothing.`,
            hint: "A service exists to keep something listening. Add a channel, or set server.enabled: true — the agent can write either itself with config_set, if it has that tool. Until then `run` is the way to talk to it.",
        })
    }

    if (!isLoopbackHost(facts.serverHost) && facts.serverEnabled && !facts.serverTokenPresent) {
        out.push({
            code: "server_public_without_token",
            severity: "block",
            message: `The server is set to bind ${facts.serverHost}, which is not loopback, and no API token is set.`,
            hint: "The same refusal `serve` makes at bind time, made here instead — a service that fails at every start is worse than a command that fails once. Set the token in the .env beside the manifest, or bind 127.0.0.1.",
        })
    }

    if (facts.servedBy !== undefined) {
        out.push({
            code: "daemon_already_serving",
            severity: "block",
            message: `Agent "${facts.agentId}" is already being served by pid ${facts.servedBy.pid} (${facts.servedBy.mode}, since ${facts.servedBy.startedAt}).`,
            hint: "Two processes serving one agent is a silent failure, not a loud one: a messaging channel allows a single listener per token, so a second one produces conflicts indistinguishable from the provider being down. Stop that one first.",
        })
    }

    if (facts.installedManifest !== undefined && facts.installedManifest !== facts.manifestPath) {
        out.push({
            code: "daemon_label_taken",
            severity: "block",
            message: `A service for "${facts.agentId}" already exists and points at a different manifest: ${facts.installedManifest}`,
            hint: `Two agents sharing an id would share this service, and one would silently replace the other. Uninstall the existing one first, or give this agent a different id. The manifest here is ${facts.manifestPath}.`,
        })
    }

    // ── warnings ────────────────────────────────────────────────────────────────────────

    if (facts.envFileMode !== undefined && (facts.envFileMode & 0o077) !== 0) {
        out.push({
            code: "daemon_env_world_readable",
            severity: "warn",
            message: `The .env beside the manifest is mode ${(facts.envFileMode & 0o777).toString(8)} and holds this agent's only secrets.`,
            hint: `Under a service manager that file is the *only* path credentials arrive by — launchd hands a job almost no environment, and the service definition carries none on purpose. \`chmod 600 ${facts.agentDir}/.env\`.`,
        })
    }

    if (facts.binary.gitRoot !== undefined) {
        out.push({
            code: "daemon_binary_in_checkout",
            severity: "warn",
            message: `The binary resolves to ${facts.binary.scriptPath}, inside a git checkout at ${facts.binary.gitRoot}.`,
            hint: "A rebuild, a branch switch or a `git clean` changes or breaks what the service runs, and the failure arrives with no obvious connection to the change. Fine for testing; install a released build for a service you intend to leave running.",
        })
    }

    if (/[/.](nvm|fnm|volta|asdf)\//.test(facts.binary.execPath)) {
        out.push({
            code: "daemon_versioned_runtime",
            severity: "warn",
            message: `The interpreter is a version-managed install: ${facts.binary.execPath}`,
            hint: "The absolute path is baked into the service definition, so removing that runtime version later kills the service with a message only the log file sees. A system or Homebrew install is more durable.",
        })
    }

    return out
}

// ─── status ─────────────────────────────────────────────────────────────────────────────

/**
 * What a service is doing, in four states rather than two.
 *
 * `running` and `absent` are the easy ones. The pair that matters is `stopped` versus
 * `installed-idle`: a disabled job is simply *not listed* by `launchctl list`, so without the
 * disable registry those two are the same observation — and one of them means "you asked for
 * this" while the other means "it died and launchd gave up".
 */
export type Verdict =
    | "running"
    | "failed"
    | "restart-loop"
    | "stopped"
    | "installed-idle"
    | "absent"

export interface ServiceFacts {
    readonly installed: boolean
    readonly disabled: boolean
    readonly pid?: number
    readonly runs?: number
    readonly lastExitCode?: number
    readonly stderrPath?: string
    readonly stderrBytes?: number
    /** From the runtime lease — true even when launchd knows nothing, e.g. a terminal `serve`. */
    readonly leasePid?: number
    readonly leaseMode?: string
    readonly leaseStartedAt?: string
    readonly uptimeMs?: number
}

/**
 * Things a *running* service is saying that a person needs to see.
 *
 * `status` reporting "running" was true and useless: the bot was up, connected, and refusing every
 * message from the one person it had been set up for, because a handle in `allowFrom` was mistyped.
 * The refusal names the sender and the exact line to paste — and writes it to a log file, which is
 * the failure mode this whole phase is a reaction to, reached from a new direction.
 *
 * Health is not the only question. "Is it running" and "is it working" are different, and only the
 * second one is why anybody typed the command.
 */
export interface Attention {
    readonly code: string
    readonly summary: string
    readonly fix: string
}

/**
 * Only the current run.
 *
 * launchd *appends* to a service's log, so a denial from before you fixed the allowlist would
 * otherwise be reported forever — a warning that outlives its cause is one people learn to scroll
 * past, which is how you end up with a screen full of things that are all fine. Each start writes
 * the serving banner, so everything after the last one is this process and nothing else.
 */
export function currentRun(log: string, marker = "serving on"): string {
    const at = log.lastIndexOf(marker)
    return at === -1 ? log : log.slice(at)
}

/** Lines a running service wrote that mean it is up and not doing its job. */
export function attentionFrom(rawLog: string): readonly Attention[] {
    const log = currentRun(rawLog)
    const out: Attention[] = []

    // Every distinct sender it has turned away. Deduplicated, because a person who messages three
    // times produces three identical lines and a status screen should say it once.
    const denied = new Set<string>()
    for (const match of log.matchAll(/denied — Sender "([^"]+)" is not in channel "([^"]+)"/g)) {
        if (match[1] !== undefined) denied.add(`${match[1]}|${match[2] ?? ""}`)
    }
    for (const entry of denied) {
        const [sender, channel] = entry.split("|")
        out.push({
            code: "inbound_denied",
            summary: `messages from ${sender} are being refused — they are not on channel "${channel}"'s allowFrom list`,
            fix: `add ${sender} to allowFrom in agent.yaml, then restart. An allowlist that is empty, or that has a typo in it, refuses silently from the sender's side: they see nothing at all.`,
        })
    }

    if (/channel_telegram_unauthorized|telegram_token_missing/.test(log)) {
        out.push({
            code: "channel_unauthorized",
            summary: "the channel rejected its token",
            fix: "check the token in the .env beside the manifest, then restart.",
        })
    }

    return out
}

export interface StatusReport {
    readonly verdict: Verdict
    readonly healthy: boolean
    readonly headline: string
    readonly rows: readonly Row[]
    /** Print the tail of stderr. True whenever the thing is not simply running. */
    readonly wantsStderrTail: boolean
}

/** Three restarts is where "it recovered" stops being the likelier reading. */
const LOOP_RUNS = 3

export function summariseStatus(agentId: string, facts: ServiceFacts): StatusReport {
    const verdict = decide(facts)
    const rows: Row[] = []

    if (facts.pid !== undefined) {
        rows.push({
            label: "state",
            value: `running · pid ${facts.pid}`,
            ...(facts.uptimeMs === undefined ? {} : { note: `up ${duration(facts.uptimeMs)}` }),
        })
    } else if (facts.leasePid !== undefined) {
        // launchd knows nothing, but something holds the lease — a `serve` in a terminal. Worth
        // saying plainly: "not installed" alone would read as "nothing is running", which is the
        // opposite of the truth and is exactly the confusion slot 2 was fixed for.
        rows.push({
            label: "state",
            value: `running in a terminal · pid ${facts.leasePid}`,
            note: "not installed as a service",
        })
    }
    // No `else`. With nothing running the headline already carries the state, and repeating it as
    // a row two lines below is noise that makes the rows underneath — the ones with the actual
    // evidence — harder to find.

    if (facts.runs !== undefined && facts.runs > 1) {
        rows.push({
            label: "starts",
            value: String(facts.runs),
            ...(verdict === "restart-loop"
                ? { note: `launchd has restarted this ${facts.runs} times` }
                : { note: "since the service was installed" }),
        })
    }
    // Only when nothing is running. On a healthy service this is history — the failure you already
    // fixed — and printing a red-looking "last exit code 1" beside "running" invites a person to go
    // and debug something that is working.
    if (verdict !== "running" && facts.lastExitCode !== undefined && facts.lastExitCode !== 0) {
        rows.push({ label: "last exit", value: `code ${facts.lastExitCode}` })
    }
    if (facts.stderrPath !== undefined) {
        rows.push({
            label: "logs",
            value: facts.stderrPath,
            ...(facts.stderrBytes === undefined ? {} : { note: `(${bytes(facts.stderrBytes)})` }),
        })
    }

    return {
        verdict,
        healthy: verdict === "running",
        headline:
            verdict === "restart-loop"
                ? `${agentId} — RESTART LOOP`
                : `${agentId} — ${stateWord(verdict)}`,
        rows,
        wantsStderrTail:
            verdict === "restart-loop" || verdict === "failed" || verdict === "installed-idle",
    }
}

function decide(facts: ServiceFacts): Verdict {
    if (!facts.installed) return facts.leasePid === undefined ? "absent" : "running"
    // **A pid means running, with no qualification.** An earlier version also demanded the start
    // count be low and the uptime long, and that was wrong in a way only the real thing showed:
    // launchd's `runs` is cumulative for the life of the loaded job and never resets, so every
    // deliberate restart of a service that had *ever* failed came back seconds old with a high
    // count and was announced as a RESTART LOOP while working perfectly. A status command that
    // cries wolf on a healthy service is worse than one that says nothing.
    if (facts.pid !== undefined) return "running"
    if (facts.disabled) return "stopped"
    if ((facts.runs ?? 0) >= LOOP_RUNS && (facts.lastExitCode ?? 0) !== 0) return "restart-loop"
    // A single non-zero exit, which under `KeepAlive: {Crashed: true}` is the *designed* end state
    // for a misconfiguration: it stopped once instead of looping. Reporting that as "installed, not
    // running" would understate it into invisibility — the same understatement that let a job
    // restart 2,463 times with a perfectly good error message in a file nobody opened.
    if ((facts.lastExitCode ?? 0) !== 0) return "failed"
    return "installed-idle"
}

function stateWord(verdict: Verdict): string {
    switch (verdict) {
        case "running":
            return "running"
        case "failed":
            return "STOPPED AFTER A FAILURE"
        case "restart-loop":
            return "exited · nothing is running"
        case "stopped":
            return "stopped by you"
        case "installed-idle":
            return "installed · not running"
        case "absent":
            return "not installed"
    }
}

/** The body of a `status` block, minus the log tail the caller reads from disk. */
export function renderStatus(report: StatusReport): string {
    return `${report.headline}\n${keyValue(report.rows)}`
}
