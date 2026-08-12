import { parseSSE } from "../src/model/sse.ts"
import { describe, expect, test } from "./_harness.ts"

/**
 * Streaming bugs are only findable with fabricated input. Every case here is something a real
 * gateway does that a naive "one chunk is one frame" parser gets wrong.
 */

async function* chunks(...values: (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
    for (const value of values) yield value
}

async function collect(source: AsyncIterable<string | Uint8Array>): Promise<string[]> {
    const out: string[] = []
    for await (const event of parseSSE(source)) out.push(event.data)
    return out
}

describe("frame splitting", () => {
    test("one frame in one chunk", async () => {
        expect(await collect(chunks("data: a\n\n"))).toEqual(["a"])
    })

    test("several frames in one chunk", async () => {
        expect(await collect(chunks("data: a\n\ndata: b\n\ndata: c\n\n"))).toEqual(["a", "b", "c"])
    })

    test("one frame split across two chunks", async () => {
        expect(await collect(chunks("data: he", "llo\n\n"))).toEqual(["hello"])
    })

    test("a frame split inside its terminator", async () => {
        expect(await collect(chunks("data: a\n", "\ndata: b\n\n"))).toEqual(["a", "b"])
    })

    test("a frame split mid-JSON, byte by byte", async () => {
        const frame = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        const bytes = [...frame].map((char) => char)
        expect(await collect(chunks(...bytes))).toEqual([
            '{"choices":[{"delta":{"content":"hi"}}]}',
        ])
    })

    test("CRLF line endings", async () => {
        expect(await collect(chunks("data: a\r\n\r\ndata: b\r\n\r\n"))).toEqual(["a", "b"])
    })

    test("bare CR line endings", async () => {
        expect(await collect(chunks("data: a\r\rdata: b\r\r"))).toEqual(["a", "b"])
    })

    test("mixed line endings in one stream", async () => {
        expect(await collect(chunks("data: a\n\ndata: b\r\n\r\n"))).toEqual(["a", "b"])
    })
})

describe("fields", () => {
    test("multi-line data joins with newlines, per the spec", async () => {
        expect(await collect(chunks("data: one\ndata: two\n\n"))).toEqual(["one\ntwo"])
    })

    test("exactly one leading space is stripped", async () => {
        expect(await collect(chunks("data:  padded\n\n"))).toEqual([" padded"])
    })

    test("a data field with no space still parses", async () => {
        expect(await collect(chunks("data:tight\n\n"))).toEqual(["tight"])
    })

    test("an empty data field yields an empty string, not nothing", async () => {
        expect(await collect(chunks("data:\n\n"))).toEqual([""])
    })

    test("event, id and retry are captured", async () => {
        const events = []
        for await (const event of parseSSE(
            chunks("event: tool.call\nid: 7\nretry: 250\ndata: x\n\n"),
        )) {
            events.push(event)
        }
        expect(events).toEqual([{ event: "tool.call", id: "7", retry: 250, data: "x" }])
    })

    test("unknown fields are ignored", async () => {
        expect(await collect(chunks("banana: yes\ndata: a\n\n"))).toEqual(["a"])
    })

    test("a non-numeric retry is dropped rather than yielding NaN", async () => {
        const events = []
        for await (const event of parseSSE(chunks("retry: soon\ndata: a\n\n"))) events.push(event)
        expect(events[0]?.retry).toBeUndefined()
    })
})

describe("comments and keepalives", () => {
    test("a heartbeat comment is not an event", async () => {
        expect(await collect(chunks(": heartbeat\n\ndata: a\n\n"))).toEqual(["a"])
    })

    test("a comment inside a frame does not disturb it", async () => {
        expect(await collect(chunks(": note\ndata: a\n\n"))).toEqual(["a"])
    })

    test("a frame with only a comment yields nothing", async () => {
        expect(await collect(chunks(": one\n\n: two\n\n"))).toEqual([])
    })
})

describe("termination", () => {
    test("[DONE] arrives as data, for the caller to act on", async () => {
        expect(await collect(chunks("data: a\n\ndata: [DONE]\n\n"))).toEqual(["a", "[DONE]"])
    })

    test("a final frame with no trailing blank line is still emitted", async () => {
        // Several real gateways close the socket straight after [DONE]. Discarding the tail here
        // would silently drop the last token of every reply.
        expect(await collect(chunks("data: a\n\ndata: [DONE]"))).toEqual(["a", "[DONE]"])
    })

    test("trailing whitespace alone is not an event", async () => {
        expect(await collect(chunks("data: a\n\n\n\n"))).toEqual(["a"])
    })

    test("an empty stream yields nothing", async () => {
        expect(await collect(chunks())).toEqual([])
    })
})

describe("bytes", () => {
    test("Uint8Array chunks decode", async () => {
        const encoder = new TextEncoder()
        expect(await collect(chunks(encoder.encode("data: a\n\n")))).toEqual(["a"])
    })

    test("a multi-byte character split across chunks survives", async () => {
        // "→" is three bytes. Splitting it mid-character breaks any parser that decodes each chunk
        // independently — hence the streaming TextDecoder.
        const bytes = new TextEncoder().encode("data: →\n\n")
        expect(await collect(chunks(bytes.slice(0, 7), bytes.slice(7)))).toEqual(["→"])
    })
})
