/**
 * `remove <agent>` — the mirror of `init`.
 *
 * `init` creates a sandbox agent: a directory, a manifest, a workspace, an `.env`. Everything after
 * that scatters — sessions and memory into one shared `store.db` keyed by manifest id, logs into
 * `logs/<id>.*.log`, a LaunchAgent under `<slug>.agent.<id>`, a lease row while it runs. Nothing put
 * those back together, so deleting an agent meant `rm -rf` plus knowledge nobody has, and the rows
 * left behind were unreachable: `LeaseStore.orphans` sees ids with *running* turns and no lease, which
 * cannot see an agent whose directory was deleted while it was idle.
 *
 * ## Only the sandbox
 *
 * A ref, never a path. `run` accepts `./somewhere/agent.yaml` because running a manifest in place is a
 * real thing to want; deleting one is not — a directory somebody pointed at is theirs to remove, and a
 * command that recursively deletes an arbitrary argument is one bad tab-completion from being the worst
 * thing in this repository. A path is refused, by name, with `rm -rf` named as the honest alternative.
 *
 * ## Show, then require the name typed back
 *
 * `--dry-run` and the confirmation print the *same* listing from the same function, so what a dry run
 * shows is what a real run does. The bar is the agent's name typed back rather than a keypress: `y`
 * against the wrong listing is one keystroke from deleting conversations that cannot be recovered, and
 * the listing exists on the assumption somebody reads it. Not a TTY means no, so a piped run without
 * `--yes` deletes nothing and says so.
 *
 * ## The order is the safety
 *
 * Stop, then unload the service, then rows, then logs, then the directory — see `removalSteps` for why
 * each of those is where it is. The short version: every step but the last is recoverable, and the
 * directory is the only part that is not.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRAND, HarnessError, processAlive, readManifestHeader, SqliteStore } from "@dispach/core"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { labelFor } from "#lib/launchd"
import {
    type FileFacts,
    type Orphan,
    type RemovalFacts,
    removalFindings,
    removalSteps,
    renderOrphans,
    renderRemoval,
} from "#lib/remove-plan"
import { bullet, keyValue, type Row, section } from "#lib/render"
import { agentsDir, listAgents, logPaths, sandboxRoot, storePath } from "#lib/sandbox"
import { type Exec, resolveServiceManager, type ServiceManager } from "#lib/service"
import { stopCommand } from "#stop"

/**
 * The facts plus the manifest path the executor needs.
 *
 * `manifestPath` is deliberately **not** on `RemovalFacts`: the plan module never reads it, and a pure
 * module carrying a field nothing in it uses is a field that can quietly go wrong. It is `stop`'s
 * argument, so it belongs to the half of this that does the work.
 */
type Removal = RemovalFacts & { readonly manifestPath: string }

export interface RemoveOptions {
    /** The sandbox directory name. Absent only with `--prune` or `--all`. */
    readonly ref?: string
    readonly dryRun?: boolean
    /** Delete the directory only; leave the store, the logs and the service alone. */
    readonly filesOnly?: boolean
    /** Rows and logs no sandbox directory claims. */
    readonly prune?: boolean
    readonly all?: boolean
    readonly yes?: boolean
    readonly json?: boolean
    readonly store?: string
    /** Test seams. Nothing in `src/` outside this file passes them. */
    readonly exec?: Exec
    readonly platform?: string
    /** Injected so the prompt is testable, and so `--yes` can bypass it without a fake TTY. */
    readonly confirm?: (question: string, expected: string) => Promise<boolean>
}

export async function removeCommand(options: RemoveOptions): Promise<number> {
    const store = await SqliteStore.open({ path: options.store ?? storePath() })
    try {
        if (options.prune === true) return await pruneAction(options, store)
        if (options.all === true) return await allAction(options, store)
        if (options.ref === undefined) {
            throw new HarnessError({
                code: "cli_remove_needs_agent",
                message: "remove needs an agent.",
                hint: `\`${BRAND.slug} remove <name>\` takes a sandbox agent's name — the ones \`${BRAND.slug} run\` lists. \`--prune\` clears data no agent claims; \`--all\` removes every agent.`,
            })
        }
        return await removeOne(options.ref, options, store)
    } finally {
        await store.close()
    }
}

// ─── one agent ──────────────────────────────────────────────────────────────────────────

async function removeOne(ref: string, options: RemoveOptions, store: SqliteStore): Promise<number> {
    const facts = await gather(ref, options, store)
    const findings = removalFindings(facts)
    if (findings.length > 0) {
        const first = findings[0] as { code: string; message: string; hint: string }
        throw new HarnessError({ code: first.code, message: first.message, hint: first.hint })
    }

    const steps = removalSteps(facts)
    const listing = `${section(`removing ${ref} will:`, true)}\n${renderRemoval(facts)}\n\n${steps
        .map((step) => bullet(step.detail))
        .join("\n")}\n`

    if (options.dryRun === true) {
        process.stdout.write(
            options.json === true
                ? `${JSON.stringify({ ref, agentId: facts.agentId, steps, footprint: facts.footprint }, null, 2)}\n`
                : `${listing}\nNothing was deleted — this was --dry-run.\n`,
        )
        return EXIT_OK
    }

    process.stdout.write(listing)
    if (!(await agreed(options, ref, `type the agent's name to confirm:`))) {
        process.stdout.write("\nNothing was deleted.\n")
        return EXIT_OK
    }

    return await execute(facts, options, store)
}

/**
 * Perform the steps, in order, reporting each.
 *
 * A failure to stop **aborts** rather than continuing: deleting the directory out from under a live
 * process leaves it serving from a manifest that no longer exists, with the backgrounded children only
 * a graceful stop would have reaped.
 */
async function execute(
    facts: Removal,
    options: RemoveOptions,
    store: SqliteStore,
): Promise<number> {
    const done: Row[] = []

    if (facts.running !== undefined || (!facts.filesOnly && facts.service !== undefined)) {
        // Delegated to `stop` rather than reimplemented: it consults both sources, sends SIGTERM before
        // SIGKILL, and disables as well as unloading. Its output is the same words the stop command
        // prints, which is the point — this is not a second, subtly different way to stop an agent.
        const code = await stopCommand({
            manifestPath: facts.manifestPath,
            ...(options.exec === undefined ? {} : { exec: options.exec }),
            ...(options.platform === undefined ? {} : { platform: options.platform }),
        })
        if (code !== EXIT_OK) {
            process.stderr.write(
                `\nStopping ${facts.ref} did not succeed, so nothing was deleted. Its directory and data are untouched.\n  hint: check what is still running with \`${BRAND.slug} stop --dry-run\`, then run remove again.\n`,
            )
            return EXIT_FAILURE
        }
        done.push({ label: "stopped", value: facts.ref })
    }

    if (!facts.filesOnly && facts.service !== undefined) {
        // `stop` disabled and unloaded it; this deletes the definition. Both are needed — a plist left
        // on disk is a job that reappears the moment somebody runs `daemon start`.
        const manager = serviceManager(options)
        try {
            manager?.uninstall(facts.service)
            done.push({ label: "service", value: `${facts.service} removed` })
        } catch (error) {
            // Not fatal: the agent is still going, and a plist for a deleted agent fails loudly at the
            // next login rather than silently. Named so it can be cleaned up by hand.
            done.push({
                label: "service",
                value: `${facts.service} could NOT be removed`,
                note: error instanceof Error ? error.message : String(error),
            })
        }
    }

    if (!facts.filesOnly) {
        const went = await store.purgeAgent(facts.agentId)
        done.push({
            label: "store",
            value: `${went.sessions} conversation(s), ${went.messages} message(s), ${went.passages} passage(s)`,
        })
        for (const log of facts.logs) rmSync(log.path, { force: true })
        if (facts.logs.length > 0) {
            done.push({ label: "logs", value: `${facts.logs.length} file(s)` })
        }
    }

    // Last, for the reason `removalSteps` documents: it is the only irreplaceable part.
    rmSync(facts.dir, { recursive: true, force: true })
    done.push({ label: "directory", value: facts.dir })

    if (options.json === true) {
        process.stdout.write(
            `${JSON.stringify({ removed: facts.ref, agentId: facts.agentId, filesOnly: facts.filesOnly }, null, 2)}\n`,
        )
        return EXIT_OK
    }
    process.stdout.write(`\n${facts.ref} removed.\n${keyValue(done)}\n`)
    if (facts.filesOnly) {
        process.stdout.write(
            `\nIts sessions and memory are still in the store under the id "${facts.agentId}", which another agent shares.\n`,
        )
    }
    return EXIT_OK
}

// ─── every agent, and the leftovers ─────────────────────────────────────────────────────

async function allAction(options: RemoveOptions, store: SqliteStore): Promise<number> {
    const agents = listAgents()
    if (agents.length === 0) {
        process.stdout.write("The sandbox is empty — there is nothing to remove.\n")
        return EXIT_OK
    }

    process.stdout.write(
        `${section(`removing every agent in ${agentsDir()}:`, true)}\n${agents
            .map((agent) =>
                bullet(
                    `${agent.ref}${agent.id === undefined || agent.id === agent.ref ? "" : ` (id ${agent.id})`}`,
                ),
            )
            .join("\n")}\n`,
    )
    if (options.dryRun === true) {
        process.stdout.write("\nNothing was deleted — this was --dry-run.\n")
        return EXIT_OK
    }
    // A different word from a ref, so a half-remembered `--all` cannot be confirmed by typing the name
    // of the one agent somebody had in mind.
    if (!(await agreed(options, "all", `type \`all\` to remove all ${agents.length}:`))) {
        process.stdout.write("\nNothing was deleted.\n")
        return EXIT_OK
    }

    let worst = EXIT_OK
    for (const agent of agents) {
        const facts = await gather(agent.ref, options, store)
        // Every agent is going, so a shared id is no longer a reason to refuse: nothing is left behind
        // to be surprised by the deletion. Ordering still matters per agent.
        const code = await execute({ ...facts, sharesIdWith: [] }, options, store)
        if (code !== EXIT_OK) worst = code
    }
    return worst
}

/**
 * Rows and logs belonging to no sandbox directory.
 *
 * The gap `LeaseStore.orphans`'s own docstring admits to and pointed at a `sessions --reap-orphans`
 * that was never built. Two sources, because an orphan can appear in either: `store.agentIds()` for
 * rows, and the logs directory for files a service wrote before its agent was deleted.
 */
async function pruneAction(options: RemoveOptions, store: SqliteStore): Promise<number> {
    const claimed = new Set(
        listAgents()
            .map((agent) => agent.id ?? agent.ref)
            .filter((id) => id !== ""),
    )
    const ids = new Set<string>((await store.agentIds()).filter((id) => !claimed.has(id)))
    for (const id of logAgentIds()) if (!claimed.has(id)) ids.add(id)

    const orphans: Orphan[] = []
    for (const agentId of [...ids].sort()) {
        orphans.push({
            agentId,
            footprint: await store.agentFootprint(agentId),
            logs: logsFor(agentId),
        })
    }

    if (orphans.length === 0) {
        process.stdout.write(
            options.json === true
                ? `${JSON.stringify({ pruned: [] })}\n`
                : `Nothing to prune — every agent id in the store and the log directory belongs to an agent in ${agentsDir()}.\n`,
        )
        return EXIT_OK
    }

    process.stdout.write(
        `${section("no sandbox directory claims these:", true)}\n${renderOrphans(orphans)}\n`,
    )
    if (options.dryRun === true) {
        process.stdout.write("\nNothing was deleted — this was --dry-run.\n")
        return EXIT_OK
    }
    if (!(await agreed(options, "prune", "type `prune` to delete them:"))) {
        process.stdout.write("\nNothing was deleted.\n")
        return EXIT_OK
    }

    const rows: Row[] = []
    for (const orphan of orphans) {
        const went = await store.purgeAgent(orphan.agentId)
        for (const log of orphan.logs) rmSync(log.path, { force: true })
        rows.push({
            label: orphan.agentId,
            value: `${went.sessions} conversation(s), ${went.passages} passage(s), ${orphan.logs.length} log file(s)`,
        })
    }
    process.stdout.write(
        options.json === true
            ? `${JSON.stringify({ pruned: orphans.map((o) => o.agentId) }, null, 2)}\n`
            : `\npruned ${orphans.length} agent id(s).\n${keyValue(rows)}\n`,
    )
    return EXIT_OK
}

// ─── facts ──────────────────────────────────────────────────────────────────────────────

async function gather(ref: string, options: RemoveOptions, store: SqliteStore): Promise<Removal> {
    if (ref.includes("/") || ref.endsWith(".yaml") || ref.endsWith(".yml")) {
        throw new HarnessError({
            code: "cli_remove_takes_a_name",
            message: `remove takes a sandbox agent's name, and "${ref}" is a path.`,
            hint: `An agent outside ${agentsDir()} is a directory you created and yours to delete — \`rm -rf\` it. This command only removes agents \`${BRAND.slug} init\` made, because it also has to clear their sessions, memory, logs and service.`,
        })
    }

    const agents = listAgents()
    const agent = agents.find((candidate) => candidate.ref === ref)
    if (agent === undefined) {
        const known = agents.map((candidate) => candidate.ref)
        throw new HarnessError({
            code: "cli_agent_unknown",
            message: `No agent named "${ref}" in the sandbox${known.length === 0 ? ", which is empty" : ""}.`,
            hint:
                known.length === 0
                    ? `Nothing to remove. \`${BRAND.slug} init\` creates one.`
                    : `Known agents: ${known.join(", ")}. \`--prune\` clears data left by an agent whose directory is already gone.`,
        })
    }

    // The header, not `loadManifest`: loading checks that key env vars are set, and refusing to delete
    // a broken agent because its API key is missing would refuse exactly the agent most worth deleting.
    let agentId = agent.id
    if (agentId === undefined) {
        try {
            agentId = readManifestHeader(agent.manifestPath).id
        } catch {
            // Unreadable manifest. The directory can still go; there is just no id to key data by, so
            // this degrades to files-only rather than guessing that the ref is the id.
        }
    }

    const filesOnly = options.filesOnly === true || agentId === undefined
    const id = agentId ?? ref
    const footprint = await store.agentFootprint(id)
    const lease = footprint.lease ? await store.leases.get(id) : undefined
    const service = serviceManager(options)
    const label = labelFor(BRAND.slug, id)

    return {
        ref,
        agentId: id,
        manifestPath: agent.manifestPath,
        dir: agent.dir,
        files: treeSize(agent.dir),
        footprint,
        logs: logsFor(id),
        sharesIdWith: agents
            .filter((other) => other.ref !== ref && (other.id ?? "") === id)
            .map((other) => other.ref),
        // A lease row is a claim, not a fact: a boot that failed after claiming leaves a row seconds old
        // with no process under it, and reporting that as running would block a removal on a pid that
        // does not exist.
        ...(lease !== undefined && processAlive(lease.pid)
            ? { running: { pid: lease.pid, mode: lease.mode } }
            : {}),
        ...(service?.state(label).installed === true ? { service: label } : {}),
        filesOnly,
    }
}

function serviceManager(options: RemoveOptions): ServiceManager | undefined {
    const platform = options.platform ?? process.platform
    if (platform !== "darwin") return undefined
    return resolveServiceManager(platform, {
        home: homedir(),
        uid: process.getuid?.() ?? 0,
        envPrefix: BRAND.envPrefix,
        ...(options.exec === undefined ? {} : { exec: options.exec }),
    })
}

/** Files and bytes under a directory. A directory that cannot be read counts as empty rather than throwing. */
function treeSize(dir: string): { readonly count: number; readonly bytes: number } {
    let count = 0
    let total = 0
    const walk = (at: string): void => {
        let entries: string[]
        try {
            entries = readdirSync(at)
        } catch {
            return
        }
        for (const entry of entries) {
            const path = join(at, entry)
            try {
                const stats = statSync(path)
                if (stats.isDirectory()) {
                    walk(path)
                    continue
                }
                count += 1
                total += stats.size
            } catch {
                // Raced away mid-walk. The listing is a summary, not an inventory.
            }
        }
    }
    walk(dir)
    return { count, bytes: total }
}

function logsFor(agentId: string): readonly FileFacts[] {
    const paths = logPaths(agentId)
    const out: FileFacts[] = []
    for (const path of [paths.out, paths.err]) {
        try {
            if (!existsSync(path)) continue
            out.push({ path, bytes: statSync(path).size })
        } catch {
            // Unreadable. Not listed, and not deleted either.
        }
    }
    return out
}

/**
 * Agent ids implied by the log directory.
 *
 * A service can have written logs for an agent that never reached the store — a manifest that failed to
 * load restarts, writes to stderr and persists nothing — so the log directory names ids `agentIds()`
 * cannot. `dot.err.log` on the author's machine was exactly that.
 */
function logAgentIds(): readonly string[] {
    let entries: string[]
    try {
        entries = readdirSync(join(sandboxRoot(), "logs"))
    } catch {
        return []
    }
    const ids = new Set<string>()
    for (const entry of entries) {
        for (const suffix of [".out.log", ".err.log"]) {
            if (entry.endsWith(suffix)) ids.add(entry.slice(0, -suffix.length))
        }
    }
    return [...ids]
}

async function agreed(
    options: RemoveOptions,
    expected: string,
    question: string,
): Promise<boolean> {
    if (options.yes === true) return true
    const ask = options.confirm
    if (ask === undefined) return false
    return await ask(question, expected)
}
