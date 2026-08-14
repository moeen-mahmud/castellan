/**
 * Built-in tools. No network, no provider, no configuration.
 *
 * They exist because a tool layer with nothing in it cannot be exercised, and because the two
 * things every agent asks for first are "what is the date" and "remember this". Everything else is
 * a provider's job.
 *
 * They are opt-in via `tools.local`, never registered implicitly. A tool nobody asked for still
 * costs catalogue tokens and still widens the space the model routes over, which is the one thing
 * that reliably degrades a small model.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { workspaceNotEditable } from "../errors.ts"
import type { Tool, ToolContext, ToolProvider } from "./types.ts"

export const LOCAL_PROVIDER_ID = "local"

/**
 * Where a note goes, relative to the agent's directory.
 *
 * Matches `memory.dir`'s default so that the memory subsystem, when it arrives, indexes what is
 * already here rather than a second location nobody looks at.
 */
export const MEMORY_DIR = "memory"
export const MEMORY_FILE = "notes.md"

const now: Tool = {
    spec: {
        slug: "now",
        provider: LOCAL_PROVIDER_ID,
        summary: "Reports the current date and time.",
        whenToUse:
            "you need today's date or the current time — including to work out what 'tomorrow' or 'in three hours' means",
        whenNotToUse:
            "the person already told you the date or time; use theirs rather than replacing it with the clock",
        mutating: false,
        tags: ["read", "time"],
        parameters: {
            type: "object",
            properties: {
                timezone: {
                    type: "string",
                    description: "IANA name such as Europe/London. Defaults to UTC.",
                },
                format: {
                    type: "string",
                    description: "iso for a machine-readable timestamp, human for a readable one",
                    enum: ["iso", "human"],
                    default: "iso",
                },
            },
        },
    },
    handler(args, context) {
        const at = context.now()
        const zone =
            typeof args.timezone === "string" && args.timezone !== "" ? args.timezone : "UTC"

        if (args.format === "human") {
            // A bad IANA name throws here rather than silently falling back to UTC: a reply that
            // states the time in the wrong zone with no hint of it is worse than a failed call.
            const formatted = new Intl.DateTimeFormat("en-GB", {
                dateStyle: "full",
                timeStyle: "short",
                timeZone: zone,
            }).format(at)
            return `${formatted} (${zone})`
        }

        if (zone === "UTC") return at.toISOString()
        return `${isoInZone(at, zone)} (${zone})`
    },
}

/**
 * ISO-shaped, in a named zone. `toISOString` is UTC-only and `Intl` will not emit ISO, so the
 * parts are assembled by hand — offset included, because a local timestamp without one is
 * ambiguous exactly when it matters.
 */
function isoInZone(at: Date, zone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZoneName: "longOffset",
    }).formatToParts(at)

    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
    const offset = get("timeZoneName").replace("GMT", "")
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset === "" ? "Z" : offset}`
}

/**
 * Writes a note to a file, and nothing more.
 *
 * The first version of this returned "NOT SAVED — this build has no memory store", which was
 * truthful and a trap: asked to save something, a real model retried until the step budget ran out.
 * Measured against DeepSeek — three attempts, no reply, an honest `max_steps` failure. A mutating
 * tool that can never succeed is not a mutating tool, it is a loop.
 *
 * So it appends to a markdown file under the agent's own directory, which is exactly where the
 * memory subsystem will look: files are canonical for memory, and the retriever indexes this
 * directory when it lands. Write-only until then. That is a missing half, not a lie — the note is
 * genuinely on disk, and the observation says where.
 */
const memoryWrite: Tool = {
    spec: {
        slug: "memory_write",
        provider: LOCAL_PROVIDER_ID,
        summary: "Saves a short note for later recall.",
        whenToUse:
            "the person tells you something durable about themselves or their work that later conversations should know",
        whenNotToUse:
            "for anything already in this conversation, for secrets or credentials, or to store your own reasoning",
        mutating: true,
        tags: ["write", "memory"],
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "The note, in one or two sentences." },
                tags: { type: "array", items: { type: "string" }, description: "Optional labels." },
            },
            required: ["text"],
        },
    },
    async handler(args, context) {
        const text = typeof args.text === "string" ? args.text.trim() : ""
        const tags = Array.isArray(args.tags) ? args.tags.map((tag) => String(tag)) : []
        const stamped = context.now().toISOString()
        const labels = tags.length === 0 ? "" : ` _(${tags.join(", ")})_`
        const line = `\n- **${stamped}**${labels} ${text}\n`

        const target = context.writeTarget

        // A workspace that declares a memory file and makes it read-only is refused out loud. The
        // tempting alternative — quietly falling back to the default file — would put the note
        // somewhere the agent's own context never reads from, so the model would be told it saved
        // something it will never see again. `editable` is enforced, not advisory.
        if (target?.mode === "refused") {
            throw workspaceNotEditable(target.name, target.reason ?? "none")
        }

        if (target?.path !== undefined) {
            await appendFile(target.path, line, "utf8")
            // Named rather than described, because the model sees this file's contents in slot 3 on
            // the next turn and the two should be recognisably the same thing.
            return `Saved to ${target.name}.`
        }

        // No workspace declared anywhere to write. The agent's own directory it is — the same place
        // the memory subsystem will index when it lands.
        const dir = join(context.dir, MEMORY_DIR)
        await mkdir(dir, { recursive: true })
        await appendFile(join(dir, MEMORY_FILE), line, "utf8")

        return `Saved to ${MEMORY_DIR}/${MEMORY_FILE}.`
    },
}

const LOCAL_TOOLS: readonly Tool[] = [now, memoryWrite]

/** Slugs a manifest may name in `tools.local`. */
export const LOCAL_TOOL_SLUGS: readonly string[] = LOCAL_TOOLS.map((tool) => tool.spec.slug)

export function localProvider(): ToolProvider {
    return {
        id: LOCAL_PROVIDER_ID,
        resolve(slugs) {
            const wanted = new Set(slugs.map((slug) => slug.toLowerCase().replace(/[\s_.-]+/g, "")))
            return Promise.resolve(
                LOCAL_TOOLS.filter((tool) =>
                    wanted.has(tool.spec.slug.toLowerCase().replace(/[\s_.-]+/g, "")),
                ),
            )
        },
        list() {
            return Promise.resolve(LOCAL_TOOL_SLUGS)
        },
    }
}

/** For tests and for tools that need a context without a turn behind them. */
export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        agentId: overrides.agentId ?? "agent",
        sessionKey: overrides.sessionKey ?? "local:default",
        turnId: overrides.turnId ?? "t_none",
        dir: overrides.dir ?? process.cwd(),
        signal: overrides.signal ?? new AbortController().signal,
        deadlineMs: overrides.deadlineMs ?? 120_000,
        now: overrides.now ?? (() => new Date()),
        ...(overrides.writeTarget === undefined ? {} : { writeTarget: overrides.writeTarget }),
    }
}
