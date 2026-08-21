/**
 * `config` — a person changing an agent's settings without hand-editing YAML.
 *
 * ## Why this exists
 *
 * `config_read`/`config_set` shipped in Phase 3.6 and are the *agent's*. There was no equivalent for a
 * person, so the routes were editing `agent.yaml` by hand, re-running `init` into a fresh directory, or
 * asking the agent (which needs `config_set` pinned, a matching allow rule, and a restart).
 *
 * The inversion is the argument for the command. Decision 11.29 reserves `allowFrom`, `server.host`,
 * `server.tokenEnv` and `writeRoots` **for the person**, floored so the agent cannot widen its own
 * reach — and that is right. But the only editor ever built was the agent's, so the fields designated
 * as the person's had the worst ergonomics in the system: unvalidated YAML that fails at the next boot.
 * It compounds with `.env` being protected *precisely* so the agent cannot supply its own secrets,
 * which left the one actor who can fill in `MODEL_API_KEY` with no tool for doing it.
 *
 * ## What this does not own
 *
 * The write. `editManifest` places, validates against the real schema, checks that the providers still
 * resolve, and only then writes — one writer for every surface, because the three that existed made
 * the guarantee depend on which caller you happened to be.
 *
 * ## Why nothing here is floored
 *
 * The agent's floor exists because an agent that could widen its own inbound gate could be *talked
 * into* it by the message it is reading. A person at a terminal is not that threat. Two edits are
 * confirmed rather than refused — `tools.policy.deny` and `onMutate: allow` — and `lib/config-view.ts`
 * decides which, so "what needs a confirmation" is assertable without performing one.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
    editManifest,
    HarnessError,
    manifestDocument,
    manifestValueAt,
    nearest,
    parseSettingValue,
    processAlive,
    readManifestHeader,
    SETTINGS,
    type Setting,
    SqliteStore,
    settingByPath,
} from "@dispach/core"
import { ambientEnv } from "#lib/ambient"
import {
    confirmationFor,
    envNeeds,
    renderChange,
    renderOne,
    renderSettings,
    type SettingValue,
    settablePaths,
    showValue,
    unmet,
} from "#lib/config-view"
import { askSecret, askYesNo } from "#lib/confirm"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { upsertEnv } from "#lib/dotenv-edit"
import { telegramHandle } from "#lib/init-flow"
import { bullet, keyValue } from "#lib/render"
import { resolveAgentRef, storePath } from "#lib/sandbox"

export interface ConfigCommandOptions {
    /** `list` | `get` | `set` | `env` | `allow`. */
    readonly action?: string
    /** A path or a sandbox agent name. */
    readonly ref?: string
    /** A setting path, an env variable name, or a handle, depending on the action. */
    readonly name?: string
    readonly value?: string
    readonly channel?: string
    readonly remove?: boolean
    readonly yes?: boolean
    readonly store?: string
    /** Injected by tests. */
    readonly confirm?: (question: string) => Promise<boolean>
    readonly secret?: (question: string) => Promise<string | undefined>
    /**
     * The `<ENVPREFIX>HOME` override that relocates the whole sandbox. **Not** the manifest
     * environment: that one is `ambientEnv`, computed from the resolved path, and answers "is this
     * variable set". Two env concepts in one options object want two names — conflating them has
     * already cost a round, where `skills install` consulted a different registry from `init`.
     */
    readonly sandboxEnv?: Readonly<Record<string, string | undefined>>
    readonly out?: (text: string) => void
}

const ACTIONS = ["list", "get", "set", "env", "allow"] as const

export async function configCommand(options: ConfigCommandOptions): Promise<number> {
    const out = options.out ?? ((text: string) => process.stdout.write(text))
    const action = options.action ?? ""
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
        const suggestion = nearest(action, [...ACTIONS])
        throw new HarnessError({
            code: "cli_config_action_unknown",
            message: `"${action}" is not something config does.`,
            hint: `One of: ${ACTIONS.join(", ")}.${
                suggestion === undefined ? "" : ` Did you mean ${suggestion}?`
            }`,
        })
    }

    const manifestPath = resolveAgentRef(options.ref ?? "", options.sandboxEnv)

    switch (action) {
        case "list": {
            out(`${renderSettings(currentValues(manifestPath), manifestPath)}\n`)
            // What is currently missing belongs here rather than on every `set`: this is the command
            // whose job is the overview, and a note repeated on unrelated edits is one nobody reads.
            const missing = unmet(
                envNeeds(manifestDocument(readFileSync(manifestPath, "utf8"))),
                ambientEnv([manifestPath]),
            )
            for (const need of missing) {
                out(`\n${bullet(`${need.name} is not set — ${need.why}`)}\n`)
                out(`${bullet(`\`config env <agent> ${need.name}\` fills it in`)}\n`)
            }
            return EXIT_OK
        }
        case "get":
            return get(manifestPath, options, out)
        case "set":
            return await set(manifestPath, options, out)
        case "env":
            return await env(manifestPath, options, out)
        default:
            return await allow(manifestPath, options, out)
    }
}

/**
 * Every setting with whatever the file currently holds.
 *
 * Two rows do not have a readable dotted path — `allowFrom` lives inside a list entry and `writeRoots`
 * inside a provider — so they are gathered by walking the block instead. Shown rather than omitted: a
 * field missing from a listing reads as "no such concept", which is the same reasoning that puts a
 * `none` row in slot 2 instead of leaving the line out.
 */
function currentValues(manifestPath: string): readonly SettingValue[] {
    const source = readFileSync(manifestPath, "utf8")
    return SETTINGS.map((setting) => {
        if (setting.path === "channels[].allowFrom") {
            const channels = manifestValueAt(source, ["channels"])
            if (!Array.isArray(channels)) return { setting, value: undefined }
            const byId: Record<string, unknown> = {}
            for (const entry of channels) {
                if (typeof entry !== "object" || entry === null) continue
                const row = entry as { id?: unknown; allowFrom?: unknown }
                if (typeof row.id !== "string") continue
                byId[row.id] = row.allowFrom ?? []
            }
            return { setting, value: Object.keys(byId).length === 0 ? undefined : byId }
        }
        if (setting.path === "tools.providers.<id>.writeRoots") {
            const providers = manifestValueAt(source, ["tools", "providers"])
            if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
                return { setting, value: undefined }
            }
            const roots: Record<string, unknown> = {}
            for (const [id, config] of Object.entries(providers as Record<string, unknown>)) {
                if (typeof config !== "object" || config === null) continue
                const found = (config as { writeRoots?: unknown }).writeRoots
                if (found !== undefined) roots[id] = found
            }
            return { setting, value: Object.keys(roots).length === 0 ? undefined : roots }
        }
        return { setting, value: manifestValueAt(source, setting.path.split(".")) }
    })
}

function get(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): number {
    const path = (options.name ?? "").trim()
    const setting = requireSetting(path)
    const row = currentValues(manifestPath).find((entry) => entry.setting.path === setting.path)
    out(`${renderOne(setting, row?.value)}\n`)
    return EXIT_OK
}

function requireSetting(path: string): Setting {
    const found = settingByPath(path)
    if (found !== undefined) return found
    const suggestion = nearest(path, [...settablePaths()])
    throw new HarnessError({
        code: "cli_config_path_unknown",
        message: `"${path}" is not a setting.`,
        hint: `\`config list <agent>\` shows every one with its current value.${
            suggestion === undefined ? "" : ` Did you mean ${suggestion}?`
        }`,
        field: "path",
    })
}

async function set(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): Promise<number> {
    const path = (options.name ?? "").trim()
    const setting = requireSetting(path)

    if (setting.via !== undefined) {
        throw new HarnessError({
            code: "cli_config_needs_action",
            message: `${setting.path} is not set by a dotted path.`,
            hint: `Use \`${setting.via}\` — it lives inside a list entry, and it gets its value checked against the service that issues it rather than written verbatim.`,
            field: "path",
        })
    }
    if (options.value === undefined) {
        throw new HarnessError({
            code: "cli_config_value_missing",
            message: `No value given for ${path}.`,
            hint: `A bare word, a number, a list as ["a", "b"], or a map as {k: v}. \`config get <agent> ${path}\` shows what it is now.`,
            field: "value",
        })
    }

    const value = parseSettingValue(options.value)

    // The confirmation, before anything is read or written. It is not a floor — these edits are the
    // person's to make — but both of them stop a check from running, and an edit whose whole effect is
    // invisible until something exploits it is worth one sentence and a keypress.
    const warning = confirmationFor(setting, value)
    if (warning !== undefined && options.yes !== true) {
        out(`${bullet(warning)}\n`)
        const ask = options.confirm ?? askYesNo
        if (!(await ask(`Change ${setting.path} anyway?`))) {
            out(`${keyValue([{ label: "unchanged", value: setting.path }])}\n`)
            return EXIT_OK
        }
    }

    const ambient = ambientEnv([manifestPath])
    const before = unmet(
        envNeeds(manifestDocument(readFileSync(manifestPath, "utf8"))),
        ambient,
    ).map((need) => need.name)

    const result = await editManifest({ file: manifestPath, path: path.split("."), value })

    // Newly required only. Computed either side of the edit rather than guessed from the value, so
    // `server.enabled true` reports the token it has just made load-bearing and `limits.maxSteps 9`
    // reports nothing — which a live run got wrong in the other direction, warning that an agent with
    // a disabled server "will refuse to start".
    const pending = unmet(
        envNeeds(manifestDocument(readFileSync(manifestPath, "utf8"))),
        ambient,
    ).filter((need) => !before.includes(need.name))

    const held = await running(manifestPath, options)
    out(
        `${renderChange({
            path,
            before: result.before,
            after: value,
            file: manifestPath,
            reflowed: result.reflowed,
            ...(held === undefined ? {} : { running: held }),
            pending,
            restartHint: restartHint(held?.mode),
        })}\n`,
    )
    return EXIT_OK
}

/**
 * How this agent comes back, phrased for how it is currently held.
 *
 * All three `RuntimeMode` values, because the generic sentence is useless for two of them. `embedded` is
 * the case that matters most and is easiest to miss: it is *this* session, so the answer is one word the
 * person can type — and a live run reported `pid 90050, embedded` under "it is started again", which is
 * true and gives them nothing.
 */
function restartHint(mode: string | undefined): string {
    if (mode === "daemon") return "`daemon restart <agent>`"
    if (mode === "embedded") return "`/restart` in this session"
    if (mode === "terminal") return "that process being started again"
    return "it is started again"
}

/**
 * A live process holding this agent, or `undefined`.
 *
 * Never a refusal, only a note. Fixing a misconfiguration *while it is running and broken* is the main
 * thing this command is for, so refusing in that state would block the case it exists to serve.
 *
 * Liveness is re-checked rather than trusted: a lease row is a claim, and a boot that failed after
 * claiming leaves a row seconds old with no process under it — which once blocked every retry for
 * ninety seconds while naming a pid that no longer existed.
 */
async function running(
    manifestPath: string,
    options: ConfigCommandOptions,
): Promise<{ readonly pid: number; readonly mode: string } | undefined> {
    let agentId: string | undefined
    try {
        agentId = readManifestHeader(manifestPath).id
    } catch {
        return undefined
    }
    if (agentId === undefined) return undefined

    try {
        const store = await SqliteStore.open({
            path: options.store ?? storePath(options.sandboxEnv),
        })
        try {
            for (const lease of await store.leases.all()) {
                if (lease.agentId !== agentId) continue
                if (!processAlive(lease.pid)) continue
                return { pid: lease.pid, mode: lease.mode }
            }
        } finally {
            await store.close()
        }
    } catch {
        // A missing or unreadable store is not a reason to refuse a manifest edit. The note is a
        // courtesy; the write is the command.
        return undefined
    }
    return undefined
}

function envPathOf(manifestPath: string): string {
    return join(manifestPath.replace(/\/agent\.yaml$/, ""), ".env")
}

/**
 * Put a secret in the `.env` beside the manifest.
 *
 * The value is prompted and never taken from an argument: an argument lands in shell history and in
 * `ps`, readable by every local process for the lifetime of the call. Not a TTY refuses rather than
 * reading a pipe, so a CI run is told nothing was written instead of a secret arriving from a source
 * the caller did not audit.
 *
 * Written 0600 whichever way the file arrived. Under a service manager this file is the *only* path
 * credentials take — launchd hands a job almost no environment and a plist carries none on purpose —
 * so tightening it is right even when this command did not create it.
 */
async function env(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): Promise<number> {
    const name = (options.name ?? "").trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new HarnessError({
            code: "cli_config_env_name_invalid",
            message: `"${name}" is not an environment variable name.`,
            hint: "Letters, digits and underscores, not starting with a digit — MODEL_API_KEY, TELEGRAM_BOT_TOKEN. `config list <agent>` shows which ones this agent names.",
            field: "name",
        })
    }

    // Statically imported, not `await import`. A module reached both ways makes `bun build
    // --splitting` emit its exports twice and the binary refuses to parse — and `bun test` sails
    // through it, because tests import source and the failure is in the bundle. `confirm.ts` pulls in
    // only `node:readline`, so there is nothing to defer.
    const ask = options.secret ?? askSecret
    const value = await ask(`value for ${name} (not echoed):`)
    if (value === undefined) {
        throw new HarnessError({
            code: "cli_config_env_no_value",
            message: `Nothing was written for ${name}.`,
            hint: "A secret is read from a prompt, never from an argument or a pipe — an argument is visible in `ps` and in shell history. Run this at a terminal, or edit the .env beside the manifest yourself.",
        })
    }
    if (value === "") {
        throw new HarnessError({
            code: "cli_config_env_empty",
            message: `An empty value for ${name} would not start the agent.`,
            hint: "A variable set to nothing fails the load exactly as a missing one does. Nothing was written.",
        })
    }

    const path = envPathOf(manifestPath)
    const before = existsSync(path) ? readFileSync(path, "utf8") : ""
    const upsert = upsertEnv(before, name, value)
    writeFileSync(path, upsert.text, { encoding: "utf8", mode: 0o600 })
    // `writeFileSync`'s mode applies only when it creates the file, so an existing 0644 stays 0644.
    const loose = (statSync(path).mode & 0o077) !== 0
    if (loose) chmodSync(path, 0o600)

    out(
        `${keyValue([
            { label: upsert.replaced ? "replaced" : "wrote", value: name },
            { label: "file", value: path },
        ])}\n`,
    )
    if (loose)
        out(`${bullet("tightened this file to 0600 — it holds every secret this agent has")}\n`)
    out(`${bullet("takes effect the next time the agent starts")}\n`)
    return EXIT_OK
}

/**
 * Add or remove a handle on a channel's `allowFrom`.
 *
 * Its own action rather than a `config set` path for two reasons. The source editor matches `key:` at
 * an indent and cannot index a sequence, so the field is not addressable — and rewriting the whole
 * `channels` list to change one handle is the dead end this command exists to remove. The second is
 * better: a handle can be *checked against the service that issues it*, and an impossible one is
 * otherwise a bot that is connected, healthy and silently refusing the one person it was set up for.
 */
async function allow(
    manifestPath: string,
    options: ConfigCommandOptions,
    out: (text: string) => void,
): Promise<number> {
    const channels = manifestValueAt(readFileSync(manifestPath, "utf8"), ["channels"])
    if (!Array.isArray(channels) || channels.length === 0) {
        throw new HarnessError({
            code: "cli_config_no_channels",
            message: "This agent has no channels, so there is nobody to allow.",
            hint: "`config set <agent> channels '[{type: telegram, id: tg, tokenEnv: TELEGRAM_BOT_TOKEN, mode: longpoll}]'` declares one first.",
        })
    }

    const entries = channels.filter(
        (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    const ids = entries.map((entry) => String(entry.id ?? "")).filter((id) => id !== "")
    const wanted = options.channel?.trim()
    if (wanted === undefined && entries.length > 1) {
        throw new HarnessError({
            code: "cli_config_channel_ambiguous",
            message: `This agent has ${entries.length} channels, so --channel says which.`,
            hint: `One of: ${ids.join(", ")}.`,
            field: "channel",
        })
    }
    const at =
        wanted === undefined ? 0 : entries.findIndex((entry) => String(entry.id ?? "") === wanted)
    if (at === -1) {
        throw new HarnessError({
            code: "cli_config_channel_unknown",
            message: `No channel with id "${wanted}".`,
            hint: `Declared: ${ids.join(", ")}.${
                nearest(wanted ?? "", ids) === undefined
                    ? ""
                    : ` Did you mean ${nearest(wanted ?? "", ids)}?`
            }`,
            field: "channel",
        })
    }

    const target = entries[at] as Record<string, unknown>
    const handle = checkedHandle(options.name ?? "", String(target.type ?? ""))
    const current = Array.isArray(target.allowFrom) ? target.allowFrom.map(String) : []

    const next =
        options.remove === true
            ? current.filter((entry) => entry !== handle)
            : current.includes(handle)
              ? current
              : [...current, handle]

    if (next.length === current.length && options.remove === true) {
        out(
            `${keyValue([
                { label: "unchanged", value: `${handle} was not on ${String(target.id)}` },
            ])}\n`,
        )
        return EXIT_OK
    }
    if (next.length === current.length) {
        // Idempotent on purpose: running it twice is what somebody does when they are not sure it
        // took, and reporting a second write they did not make would be a small lie.
        out(
            `${keyValue([{ label: "already allowed", value: `${handle} on ${String(target.id)}` }])}\n`,
        )
        return EXIT_OK
    }

    // The whole list is rewritten because one entry's key is not addressable. That re-renders the
    // block, which is why `allowFrom` is worth its own command rather than being a documented recipe.
    const rewritten = entries.map((entry, index) =>
        index === at ? { ...entry, allowFrom: next } : entry,
    )
    const result = await editManifest({
        file: manifestPath,
        path: ["channels"],
        value: rewritten,
    })
    const held = await running(manifestPath, options)

    out(
        `${keyValue([
            { label: options.remove === true ? "removed" : "allowed", value: handle },
            { label: "channel", value: String(target.id) },
            { label: "now", value: showValue(next) },
            { label: "file", value: manifestPath },
        ])}\n`,
    )
    if (result.reflowed) {
        out(`${bullet("the file was re-serialised — it is valid, and comments may have moved")}\n`)
    }
    if (held !== undefined) {
        out(
            `${bullet(
                `this agent is running (pid ${held.pid}, ${held.mode}) and holds its settings for its lifetime — the change applies after ${restartHint(held.mode)}`,
            )}\n`,
        )
    }
    return EXIT_OK
}

/**
 * A handle, validated against the service that issues it.
 *
 * Telegram's rule is shared with `init` rather than restated, because a check only one surface performs
 * is a check the two disagree about. An unknown channel type passes through: guessing at another
 * service's identifier format would refuse handles that are perfectly valid.
 */
function checkedHandle(raw: string, type: string): string {
    const given = raw.trim()
    if (given === "") {
        throw new HarnessError({
            code: "cli_config_handle_missing",
            message: "No handle given.",
            hint: "`config allow <agent> @handle`. On Telegram that is the username, not the display name.",
            field: "handle",
        })
    }
    if (type !== "telegram") return given
    const checked = telegramHandle(given)
    if (!checked.ok) {
        throw new HarnessError({
            code: "cli_config_handle_invalid",
            message: `"${given}" ${checked.reason}`,
            hint: "A handle that cannot exist matches nobody, and the only symptom is the bot silently refusing every message from the person it was set up for.",
            field: "handle",
        })
    }
    return checked.value
}

export const CONFIG_EXIT_FAILURE = EXIT_FAILURE
