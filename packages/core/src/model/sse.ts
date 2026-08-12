/**
 * Server-sent event parsing, per the WHATWG event-stream grammar and tolerant of what real
 * gateways actually send.
 *
 * Kept as a pure generator over byte chunks, separately from the HTTP client, because this is
 * where streaming bugs live and they are only findable with fabricated input: a frame split
 * mid-JSON, a heartbeat comment, `\r\n` line endings from a proxy, a final frame with no
 * trailing blank line. None of that is reproducible against a live endpoint on demand.
 */

export interface SSEEvent {
    /** The `event:` field, when the server sends one. */
    readonly event?: string
    /** Concatenated `data:` lines, joined with newlines, as the spec requires. */
    readonly data: string
    readonly id?: string
    readonly retry?: number
}

/** Frame separator: a blank line, in any of the three line-ending conventions. */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/

function parseFrame(frame: string): SSEEvent | undefined {
    const dataLines: string[] = []
    let event: string | undefined
    let id: string | undefined
    let retry: number | undefined

    for (const rawLine of frame.split(/\r\n|\n|\r/)) {
        // A line beginning with a colon is a comment. Heartbeats arrive as bare `:` lines, and
        // dropping them here is why a 15-second keepalive does not look like a malformed frame.
        if (rawLine === "" || rawLine.startsWith(":")) continue

        const colon = rawLine.indexOf(":")
        const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
        // Exactly one leading space is stripped from the value, per the spec.
        let value = colon === -1 ? "" : rawLine.slice(colon + 1)
        if (value.startsWith(" ")) value = value.slice(1)

        switch (field) {
            case "data":
                dataLines.push(value)
                break
            case "event":
                event = value
                break
            case "id":
                id = value
                break
            case "retry": {
                const parsed = Number.parseInt(value, 10)
                if (Number.isFinite(parsed)) retry = parsed
                break
            }
            default:
                // Unknown fields are ignored, per the spec.
                break
        }
    }

    if (dataLines.length === 0 && event === undefined) return undefined

    return {
        ...(event === undefined ? {} : { event }),
        data: dataLines.join("\n"),
        ...(id === undefined ? {} : { id }),
        ...(retry === undefined ? {} : { retry }),
    }
}

/**
 * Decode and split a byte stream into events.
 *
 * Accepts strings as well as bytes so tests can hand it exact frame boundaries. A trailing
 * frame with no terminating blank line is emitted at end of stream — servers that close
 * immediately after `data: [DONE]` are common enough that discarding it would drop real data.
 */
export async function* parseSSE(
    source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SSEEvent> {
    const decoder = new TextDecoder()
    let buffer = ""

    for await (const chunk of source) {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })

        while (true) {
            const match = FRAME_SEPARATOR.exec(buffer)
            if (match === null) break
            const frame = buffer.slice(0, match.index)
            buffer = buffer.slice(match.index + match[0].length)
            const event = parseFrame(frame)
            if (event !== undefined) yield event
        }
    }

    buffer += decoder.decode()
    if (buffer.trim() !== "") {
        const event = parseFrame(buffer)
        if (event !== undefined) yield event
    }
}
