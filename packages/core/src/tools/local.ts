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

import type { Tool, ToolContext, ToolProvider } from "./types.ts"

export const LOCAL_PROVIDER_ID = "local"

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
 * A deliberate stand-in.
 *
 * Memory is files plus FTS5 and arrives with its own phase; this exists so that a mutating tool can
 * be exercised end to end before then. Its observation says plainly that nothing was written,
 * because a stub that reports success teaches the agent to tell the person their note was saved —
 * which is the one outcome worse than not having the tool at all.
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
    handler(args) {
        const text = typeof args.text === "string" ? args.text : ""
        return [
            "NOT SAVED. This build has no memory store, so the note was discarded.",
            `The note was: ${text}`,
            "Do not call this tool again for the same note, and do not tell the person it was saved.",
        ].join("\n")
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
        signal: overrides.signal ?? new AbortController().signal,
        now: overrides.now ?? (() => new Date()),
    }
}
