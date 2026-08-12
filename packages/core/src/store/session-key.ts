/**
 * Session keys: `{channel}:{peerId}[:{thread}]`.
 *
 * The shape is required, not merely conventional. Phase 4 routes outbound delivery by reading
 * the channel and peer back out of the key, and Phase 8 gives scheduled runs their own
 * sessions — both need the key to be structured rather than opaque. So an explicit key still
 * carries a channel segment: `schedule:nightly`, `local:default`, `api:moeen`.
 *
 * A key with no colon is refused. It would otherwise be stored happily and then fail much
 * later, at delivery, as an unroutable session — which is the "chat not found" class of
 * failure the architecture notes warn about.
 */

import { ConfigError } from "../errors.ts"

export interface SessionParts {
    readonly channel: string
    readonly peerId: string
    /** Thread, topic, or forum sub-id. Absent for a plain one-to-one conversation. */
    readonly thread?: string
}

/** Channel segments are slugs, so a key never needs quoting in a URL path or a log line. */
const CHANNEL_PATTERN = /^[a-z][a-z0-9_-]*$/

export function formatSessionKey(parts: SessionParts): string {
    const base = `${parts.channel}:${parts.peerId}`
    return parts.thread === undefined || parts.thread === "" ? base : `${base}:${parts.thread}`
}

/**
 * Split a key into its parts.
 *
 * The thread segment takes everything after the second colon, so a thread id containing a
 * colon round-trips through `formatSessionKey` unchanged.
 */
export function parseSessionKey(key: string): SessionParts {
    const first = key.indexOf(":")
    if (first === -1) {
        throw new ConfigError({
            code: "session_key_malformed",
            message: `Session key "${key}" has no channel segment.`,
            hint: "Keys are {channel}:{peerId}[:{thread}] — for example telegram:12345, api:moeen, or local:default. An explicit key still needs a channel, because outbound delivery reads it back out of the key.",
        })
    }

    const channel = key.slice(0, first)
    if (!CHANNEL_PATTERN.test(channel)) {
        throw new ConfigError({
            code: "session_key_malformed",
            message: `Session key "${key}" has an invalid channel segment "${channel}".`,
            hint: "The channel segment is a lowercase slug starting with a letter: telegram, whatsapp, api, schedule, local.",
        })
    }

    const rest = key.slice(first + 1)
    const second = rest.indexOf(":")
    if (second === -1) {
        if (rest === "") {
            throw new ConfigError({
                code: "session_key_malformed",
                message: `Session key "${key}" has an empty peer segment.`,
                hint: "The peer segment identifies who the conversation is with: telegram:12345, api:moeen.",
            })
        }
        return { channel, peerId: rest }
    }

    const peerId = rest.slice(0, second)
    const thread = rest.slice(second + 1)
    if (peerId === "") {
        throw new ConfigError({
            code: "session_key_malformed",
            message: `Session key "${key}" has an empty peer segment.`,
            hint: "The peer segment identifies who the conversation is with: telegram:12345, api:moeen.",
        })
    }

    return thread === "" ? { channel, peerId } : { channel, peerId, thread }
}

/** True when `key` is a well-formed session key. For validating input without a try/catch. */
export function isSessionKey(key: string): boolean {
    try {
        parseSessionKey(key)
        return true
    } catch {
        return false
    }
}
