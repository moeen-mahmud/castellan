/**
 * Chunking, the outbox store, and the delivery engine.
 *
 * Runs under both runners via `./_harness.ts`. The exactly-once claims below are the reason this
 * file exists: a queue's interesting behaviour is entirely in the states you cannot reach by using
 * it normally — a claimed row whose process died, a re-enqueue of something already sent, a chunk
 * abandoned because its predecessor gave up. None of those are reachable by hand.
 */

import type {
    ChannelLimits,
    ChannelTransport,
    OutboundMessage,
    RawInbound,
    SendResult,
} from "../src/channels/channel.ts"
import { Inbox } from "../src/channels/inbox.ts"
import { deliveryGroup, deliveryKey, Outbox } from "../src/channels/outbox.ts"
import { splitMessage } from "../src/channels/split.ts"
import { EventBus } from "../src/events/bus.ts"
import type { AnyEvent } from "../src/events/types.ts"
import { openMemoryStore, type SqliteStore } from "../src/store/sqlite/store.ts"
import { describe, expect, test } from "./_harness.ts"

const AGENT = "assistant"
const SESSION = "tg:12345"
const TURN = "t_0001"

// ─── A transport that records instead of connecting ──────────────────────────────────────

interface Recorded {
    readonly text: string
    readonly idempotencyKey: string
    readonly chunkIndex: number
}

class FakeTransport implements ChannelTransport {
    readonly id: string
    readonly type = "fake"
    limits: ChannelLimits
    readonly sent: Recorded[] = []
    /** Consumed one per send. When empty, every send succeeds. */
    responses: SendResult[] = []
    /** Set to make `send` reject rather than return, exercising the throwing-transport path. */
    throwOnce = false

    constructor(id = "tg", limits?: Partial<ChannelLimits>) {
        this.id = id
        this.limits = { maxMessageChars: 4096, idempotentSend: false, ...limits }
    }

    async start(): Promise<void> {}
    async stop(): Promise<void> {}

    async send(message: OutboundMessage): Promise<SendResult> {
        if (this.throwOnce) {
            this.throwOnce = false
            throw new Error("socket hang up")
        }
        this.sent.push({
            text: message.text,
            idempotencyKey: message.idempotencyKey,
            chunkIndex: message.chunkIndex,
        })
        const next = this.responses.shift()
        return next ?? { ok: true, providerMessageId: `p_${this.sent.length}` }
    }
}

function harness(transport: FakeTransport, options: { maxAttempts?: number } = {}) {
    const bus = new EventBus({ runtimeId: "r_test", onHandlerError: () => {} })
    const events: AnyEvent[] = []
    bus.on("*", (event) => events.push(event))
    let clock = Date.parse("2026-08-16T12:00:00.000Z")

    return {
        bus,
        events,
        typesOf: (prefix: string) =>
            events.filter((e) => e.type.startsWith(prefix)).map((e) => e.type),
        dataOf: <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.data as T),
        /**
         * The engine's clock as an ISO string.
         *
         * Tests that reach past the engine into the store must ask with *this*, not `new Date()`.
         * Mixing the two is what made an earlier version of this file pass or fail depending on
         * whether the suite ran before or after noon UTC.
         */
        nowIso: () => new Date(clock).toISOString(),
        advance: (ms: number) => {
            clock += ms
        },
        outbox: (store: SqliteStore) =>
            new Outbox({
                store: store.outbox,
                bus,
                channels: new Map([[transport.id, transport]]),
                backoffMs: [1_000, 5_000],
                ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
                now: () => clock,
            }),
    }
}

function reply(text: string, over: Partial<{ turnId: string; recipient: string }> = {}) {
    return {
        agentId: AGENT,
        sessionKey: SESSION,
        channelId: "tg",
        recipient: "12345",
        turnId: TURN,
        text,
        ...over,
    }
}

// ─── Splitting ───────────────────────────────────────────────────────────────────────────

describe("splitMessage", () => {
    test("returns the whole text when it fits", () => {
        expect(splitMessage("short", { maxChars: 4096 })).toEqual(["short"])
    })

    test("empty input is one empty chunk, never zero chunks", () => {
        // Zero chunks would make "this reply has N chunks" answer 0, which is indistinguishable
        // from a delivery that never happened.
        expect(splitMessage("", { maxChars: 10 })).toEqual([""])
    })

    test("every chunk is within the limit", () => {
        const text = "lorem ipsum dolor sit amet ".repeat(400)
        const chunks = splitMessage(text, { maxChars: 4096 })
        expect(chunks.length).toBeGreaterThan(1)
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096)
    })

    test("prefers a paragraph boundary", () => {
        const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}`
        const chunks = splitMessage(text, { maxChars: 100 })
        expect(chunks[0]).toBe("a".repeat(60))
        expect(chunks[1]).toBe("b".repeat(60))
    })

    test("falls back to a word boundary rather than cutting a word", () => {
        const text = `${"word ".repeat(30)}tail`
        const chunks = splitMessage(text, { maxChars: 40 })
        for (const chunk of chunks) expect(chunk.endsWith(" ")).toBe(false)
        expect(chunks.join(" ")).toBe(text.trim())
    })

    test("never splits a surrogate pair", () => {
        // 🙂 is one astral code point — two UTF-16 units. A naive slice at an odd offset produces
        // a lone surrogate, which a provider either rejects or renders as a replacement character.
        const text = "🙂".repeat(50)
        const chunks = splitMessage(text, { maxChars: 15 })
        for (const chunk of chunks) {
            expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk)).toBe(false)
            expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk)).toBe(false)
        }
        expect(chunks.join("")).toBe(text)
    })

    test("keeps a code fence balanced across a boundary", () => {
        const code = "x = 1\n".repeat(40)
        const text = `intro\n\n\`\`\`python\n${code}\`\`\`\n\nafter`
        const chunks = splitMessage(text, { maxChars: 120, fenceAware: true })
        expect(chunks.length).toBeGreaterThan(1)
        for (const chunk of chunks) {
            const fences = chunk.split("\n").filter((line) => /^ {0,3}`{3,}/.test(line)).length
            expect(fences % 2).toBe(0)
        }
    })

    test("leaves fences alone when the channel does not render markdown", () => {
        const text = `\`\`\`\n${"y = 2\n".repeat(40)}\`\`\``
        const chunks = splitMessage(text, { maxChars: 100 })
        // No synthetic backticks anywhere: joining recovers the original bytes.
        expect(chunks.join("\n")).toContain("y = 2")
        expect(chunks.join("").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""))
    })
})

// ─── Inbound ─────────────────────────────────────────────────────────────────────────────

function inbound(over: Partial<RawInbound> = {}): RawInbound {
    return {
        peerId: "12345",
        text: "hi",
        receivedAt: "2026-08-16T12:00:00.000Z",
        ...over,
    }
}

describe("inbox", () => {
    test("an omitted allowFrom permits nobody, and says what to add", () => {
        const box = new Inbox({ channelId: "tg", channelType: "telegram" })
        const decision = box.accept(inbound({ senderHandle: "@moeen" }))
        expect(decision.kind).toBe("denied")
        // The refusal carries the sender that was just refused, so the fix is a copy and paste.
        if (decision.kind === "denied") expect(decision.reason).toContain('allowFrom: ["@moeen"]')
    })

    test('["*"] permits anyone', () => {
        const box = new Inbox({ channelId: "tg", channelType: "telegram", allowFrom: ["*"] })
        expect(box.accept(inbound({ senderHandle: "@stranger" })).kind).toBe("accept")
    })

    test("matching folds case and an optional @", () => {
        const box = new Inbox({ channelId: "tg", channelType: "telegram", allowFrom: ["@moeen"] })
        for (const handle of ["@moeen", "@Moeen", "moeen", "  @MOEEN  "]) {
            expect(box.accept(inbound({ senderHandle: handle })).kind).toBe("accept")
        }
        expect(box.accept(inbound({ senderHandle: "@moeen2" })).kind).toBe("denied")
    })

    test("a sender with no handle is matched on peer id", () => {
        // Plenty of Telegram users have no username. Handle-only matching would make them
        // impossible to allowlist at all.
        const box = new Inbox({ channelId: "tg", channelType: "telegram", allowFrom: ["12345"] })
        expect(box.accept(inbound()).kind).toBe("accept")
        expect(box.accept(inbound({ peerId: "99" })).kind).toBe("denied")
    })

    test("an accepted message carries a well-formed session key", () => {
        const box = new Inbox({ channelId: "tg", channelType: "telegram", allowFrom: ["*"] })
        const plain = box.accept(inbound())
        const threaded = box.accept(inbound({ providerMessageId: "m2", thread: "topic7" }))
        if (plain.kind === "accept") expect(plain.message.sessionKey).toBe("tg:12345")
        if (threaded.kind === "accept") {
            // A forum topic gets its own session rather than sharing the group's.
            expect(threaded.message.sessionKey).toBe("tg:12345:topic7")
        }
    })

    test("a replayed provider message id is a duplicate, not a second turn", () => {
        const box = new Inbox({ channelId: "tg", channelType: "telegram", allowFrom: ["*"] })
        expect(box.accept(inbound({ providerMessageId: "m1" })).kind).toBe("accept")
        expect(box.accept(inbound({ providerMessageId: "m1" })).kind).toBe("duplicate")
    })

    test("the dedupe window evicts oldest-first and stays bounded", () => {
        const box = new Inbox({
            channelId: "tg",
            channelType: "telegram",
            allowFrom: ["*"],
            dedupeWindow: 2,
        })
        for (const id of ["m1", "m2", "m3"]) box.accept(inbound({ providerMessageId: id }))
        // m1 fell out of the window; m3 is still remembered.
        expect(box.accept(inbound({ providerMessageId: "m1" })).kind).toBe("accept")
        expect(box.accept(inbound({ providerMessageId: "m3" })).kind).toBe("duplicate")
    })

    test("a message with no provider id is never treated as a duplicate", () => {
        // Synthesising an id that looks stable and is not would drop real messages.
        const box = new Inbox({ channelId: "tg", channelType: "telegram", allowFrom: ["*"] })
        expect(box.accept(inbound()).kind).toBe("accept")
        expect(box.accept(inbound()).kind).toBe("accept")
    })
})

// ─── Key derivation ──────────────────────────────────────────────────────────────────────

describe("delivery keys", () => {
    test("the same logical delivery derives the same key", () => {
        const parts = { sessionKey: SESSION, channelId: "tg", recipient: "12345", turnId: TURN }
        expect(deliveryKey(deliveryGroup(parts), 0)).toBe(deliveryKey(deliveryGroup(parts), 0))
    })

    test("a different recipient is a different delivery", () => {
        const base = { sessionKey: SESSION, channelId: "tg", turnId: TURN }
        // Without the recipient in the key, a reply fanned out to two targets would collide and
        // the second target would silently receive nothing.
        const differs =
            deliveryGroup({ ...base, recipient: "1" }) !==
            deliveryGroup({ ...base, recipient: "2" })
        expect(differs).toBe(true)
    })

    test("a key is printable ASCII with no NUL", () => {
        // Regression guard with teeth. A NUL separator here is stored whole by `bun:sqlite` and
        // truncated at the NUL by `node:sqlite`, so the key round-trips differently per runtime
        // and every lookup keyed on it silently misses on one of them. See `sqlite/driver.ts`.
        const key = deliveryKey(
            deliveryGroup({
                sessionKey: "tg:12345:topic 7",
                channelId: "tg",
                recipient: "+880 171|2",
                turnId: TURN,
            }),
            0,
        )
        expect(/^[\x21-\x7e|]+$/.test(key)).toBe(true)
    })

    test("a delimiter inside a recipient cannot forge another group", () => {
        // `recipient` is provider-supplied. Without encoding, a recipient containing the
        // separator could compose a key belonging to a different conversation.
        const base = { sessionKey: SESSION, channelId: "tg", turnId: TURN }
        const differs =
            deliveryGroup({ ...base, recipient: "a|b" }) !==
            `${deliveryGroup({ ...base, recipient: "a" })}|b`
        expect(differs).toBe(true)
    })

    test("a turn key and an explicit key cannot collide", () => {
        const base = { sessionKey: SESSION, channelId: "tg", recipient: "12345" }
        const differs =
            deliveryGroup({ ...base, turnId: "x" }) !== deliveryGroup({ ...base, key: "x" })
        expect(differs).toBe(true)
    })
})

// ─── The store ───────────────────────────────────────────────────────────────────────────

describe("outbox store", () => {
    test("re-enqueueing the same key inserts nothing", async () => {
        const store = await openMemoryStore()
        const row = {
            agentId: AGENT,
            dedupeKey: "k1",
            groupKey: "g1",
            sessionKey: SESSION,
            channelId: "tg",
            recipient: "12345",
            chunkIndex: 0,
            chunkTotal: 1,
            body: "hello",
        }
        const first = await store.outbox.enqueue([row])
        const second = await store.outbox.enqueue([{ ...row, body: "different" }])

        expect(first[0]?.inserted).toBe(true)
        expect(second[0]?.inserted).toBe(false)
        // The original body survives: a conflicting re-enqueue is a no-op, not an update.
        expect(second[0]?.record.body).toBe("hello")
        expect(second[0]?.record.id).toBe(first[0]?.record.id)
        await store.close()
    })

    test("due withholds a chunk whose predecessor is unsent", async () => {
        const store = await openMemoryStore()
        const base = {
            agentId: AGENT,
            groupKey: "g1",
            sessionKey: SESSION,
            channelId: "tg",
            recipient: "12345",
            chunkTotal: 2,
        }
        await store.outbox.enqueue([
            { ...base, dedupeKey: "g1 0", chunkIndex: 0, body: "one" },
            { ...base, dedupeKey: "g1 1", chunkIndex: 1, body: "two" },
        ])

        const now = new Date().toISOString()
        const first = await store.outbox.due(AGENT, now)
        expect(first.length).toBe(1)
        expect(first[0]?.chunkIndex).toBe(0)

        await store.outbox.markSent(first[0]?.id ?? 0, "p_1")
        const second = await store.outbox.due(AGENT, now)
        expect(second.length).toBe(1)
        expect(second[0]?.chunkIndex).toBe(1)
        await store.close()
    })

    test("claim is atomic — a second claimant gets undefined", async () => {
        const store = await openMemoryStore()
        const enqueued = await store.outbox.enqueue([
            {
                agentId: AGENT,
                dedupeKey: "k1",
                groupKey: "g1",
                sessionKey: SESSION,
                channelId: "tg",
                recipient: "12345",
                chunkIndex: 0,
                chunkTotal: 1,
                body: "hello",
            },
        ])
        const id = enqueued[0]?.record.id ?? 0

        expect((await store.outbox.claim(id))?.status).toBe("inflight")
        expect(await store.outbox.claim(id)).toBeUndefined()
        await store.close()
    })

    test("recoverInflight re-queues and marks uncertain", async () => {
        const store = await openMemoryStore()
        const [first] = await store.outbox.enqueue([
            {
                agentId: AGENT,
                dedupeKey: "k1",
                groupKey: "g1",
                sessionKey: SESSION,
                channelId: "tg",
                recipient: "12345",
                chunkIndex: 0,
                chunkTotal: 1,
                body: "hello",
            },
        ])
        const id = first?.record.id ?? 0
        await store.outbox.claim(id)

        const recovered = await store.outbox.recoverInflight()
        expect(recovered.length).toBe(1)
        expect(recovered[0]?.uncertain).toBe(true)
        expect(recovered[0]?.status).toBe("pending")

        const reread = await store.outbox.get(id)
        expect(reread?.status).toBe("pending")
        expect(reread?.uncertain).toBe(true)
        await store.close()
    })

    test("clearing a session does not discard undelivered replies", async () => {
        // `messages` and `turns` cascade on session delete; the outbox deliberately does not.
        // Losing a queued reply because someone cleared the conversation is a silent data loss.
        const store = await openMemoryStore()
        await store.sessions.ensure(AGENT, SESSION)
        await store.outbox.enqueue([
            {
                agentId: AGENT,
                dedupeKey: "k1",
                groupKey: "g1",
                sessionKey: SESSION,
                channelId: "tg",
                recipient: "12345",
                chunkIndex: 0,
                chunkTotal: 1,
                body: "hello",
            },
        ])
        await store.sessions.clear(AGENT, SESSION)
        await store.sessions.delete(AGENT, SESSION)
        expect((await store.outbox.list(AGENT)).length).toBe(1)
        await store.close()
    })
})

// ─── The engine ──────────────────────────────────────────────────────────────────────────

describe("outbox engine", () => {
    test("a reply is chunked, enqueued, and sent in order", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport("tg", { maxMessageChars: 40 })
        const h = harness(transport)
        const outbox = h.outbox(store)

        const text = "sentence one. ".repeat(20)
        const rows = await outbox.enqueue(reply(text))
        expect(rows.length).toBeGreaterThan(1)

        const report = await outbox.drain(AGENT)
        expect(report.sent).toBe(rows.length)
        expect(transport.sent.map((s) => s.chunkIndex)).toEqual(rows.map((_, i) => i))
        await store.close()
    })

    test("enqueueing the same turn twice sends once", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        const h = harness(transport)
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        await outbox.drain(AGENT)
        // The replay: same turn, same recipient, same text. A generated id would send again.
        await outbox.enqueue(reply("hello"))
        await outbox.drain(AGENT)

        expect(transport.sent.length).toBe(1)
        await store.close()
    })

    test("a crash after claim resends exactly once and reports the doubt", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        const h = harness(transport)
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        // Simulate the process dying between claim and acknowledgement.
        const due = await store.outbox.due(AGENT, h.nowIso())
        expect(due.length).toBe(1)
        await store.outbox.claim(due[0]?.id ?? 0)

        const recovered = await outbox.recover()
        expect(recovered.length).toBe(1)
        expect(h.typesOf("delivery.uncertain")).toEqual(["delivery.uncertain"])

        await outbox.drain(AGENT)
        expect(transport.sent.length).toBe(1)
        // The flag rides along to the success event, so a duplicate stays explicable afterwards.
        expect(h.dataOf<{ uncertain: boolean }>("delivery.sent")[0]?.uncertain).toBe(true)
        await store.close()
    })

    test("a crash after markSent never resends", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        const h = harness(transport)
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        await outbox.drain(AGENT)
        // A fresh process: recovery finds nothing, and the row is terminal.
        expect((await outbox.recover()).length).toBe(0)
        await outbox.drain(AGENT)
        expect(transport.sent.length).toBe(1)
        await store.close()
    })

    test("a retryable failure backs off and succeeds on the next pass", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        transport.responses = [
            {
                ok: false,
                retryable: true,
                error: { code: "rate_limited", message: "429", hint: "wait" },
            },
        ]
        const h = harness(transport)
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        expect((await outbox.drain(AGENT)).retried).toBe(1)
        // Still inside the first backoff window: nothing is due.
        expect((await outbox.drain(AGENT)).sent).toBe(0)

        h.advance(1_500)
        expect((await outbox.drain(AGENT)).sent).toBe(1)
        expect(h.dataOf<{ attempts: number }>("delivery.sent")[0]?.attempts).toBe(2)
        await store.close()
    })

    test("a provider-supplied retryAfterMs beats the backoff table", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        transport.responses = [
            {
                ok: false,
                retryable: true,
                retryAfterMs: 30_000,
                error: { code: "rate_limited", message: "429", hint: "wait" },
            },
        ]
        const h = harness(transport)
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        await outbox.drain(AGENT)
        expect(h.dataOf<{ delayMs: number }>("delivery.retry")[0]?.delayMs).toBe(30_000)

        // The table's first delay is 1s; honouring it here would walk into a second 429.
        h.advance(2_000)
        expect((await outbox.drain(AGENT)).sent).toBe(0)
        h.advance(30_000)
        expect((await outbox.drain(AGENT)).sent).toBe(1)
        await store.close()
    })

    test("a permanent failure is not retried", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        transport.responses = [
            {
                ok: false,
                retryable: false,
                error: { code: "chat_not_found", message: "no such chat", hint: "check the id" },
            },
        ]
        const h = harness(transport)
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        expect((await outbox.drain(AGENT)).failed).toBe(1)
        h.advance(60_000)
        expect((await outbox.drain(AGENT)).sent).toBe(0)
        expect(transport.sent.length).toBe(1)
        expect(h.dataOf<{ exhausted: boolean }>("delivery.failed")[0]?.exhausted).toBe(false)
        await store.close()
    })

    test("attempts are capped and the last failure says it was exhausted", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        const rateLimited: SendResult = {
            ok: false,
            retryable: true,
            error: { code: "rate_limited", message: "429", hint: "wait" },
        }
        transport.responses = [rateLimited, rateLimited, rateLimited]
        const h = harness(transport, { maxAttempts: 3 })
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        await outbox.drain(AGENT)
        h.advance(2_000)
        await outbox.drain(AGENT)
        h.advance(10_000)
        await outbox.drain(AGENT)

        expect(transport.sent.length).toBe(3)
        expect(h.dataOf<{ exhausted: boolean }>("delivery.failed")[0]?.exhausted).toBe(true)
        await store.close()
    })

    test("a failed chunk abandons the rest of the message", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport("tg", { maxMessageChars: 30 })
        transport.responses = [
            { ok: true, providerMessageId: "p_1" },
            {
                ok: false,
                retryable: false,
                error: { code: "blocked", message: "bot was blocked", hint: "unblock" },
            },
        ]
        const h = harness(transport)
        const outbox = h.outbox(store)

        const rows = await outbox.enqueue(
            reply("alpha bravo charlie delta echo foxtrot golf hotel"),
        )
        expect(rows.length).toBeGreaterThan(2)
        await outbox.drain(AGENT)

        // Half a message is worse than none: chunk 2 onwards never goes out.
        expect(transport.sent.length).toBe(2)
        const failed = h.dataOf<{ abandoned: number }>("delivery.failed")
        expect(failed.length).toBe(1)
        expect(failed[0]?.abandoned).toBe(rows.length - 2)
        await store.close()
    })

    test("a transport that throws is retried, not abandoned", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        transport.throwOnce = true
        const h = harness(transport)
        const outbox = h.outbox(store)

        await outbox.enqueue(reply("hello"))
        expect((await outbox.drain(AGENT)).retried).toBe(1)
        h.advance(2_000)
        expect((await outbox.drain(AGENT)).sent).toBe(1)
        await store.close()
    })

    test("an unknown channel fails permanently and names what is configured", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        const h = harness(transport)
        const outbox = h.outbox(store)

        await store.outbox.enqueue([
            {
                agentId: AGENT,
                dedupeKey: "k1",
                groupKey: "g1",
                sessionKey: SESSION,
                channelId: "gone",
                recipient: "12345",
                chunkIndex: 0,
                chunkTotal: 1,
                body: "hello",
                nextAttemptAt: h.nowIso(),
            },
        ])
        expect((await outbox.drain(AGENT)).failed).toBe(1)
        expect(h.dataOf<{ error: { code: string } }>("delivery.failed")[0]?.error.code).toBe(
            "delivery_channel_unknown",
        )
        await store.close()
    })

    test("enqueue refuses a delivery with no turn and no key", async () => {
        const store = await openMemoryStore()
        const h = harness(new FakeTransport())
        const outbox = h.outbox(store)
        // Without either there is nothing for a replayed enqueue to collide with.
        await expect(
            outbox.enqueue({
                agentId: AGENT,
                sessionKey: SESSION,
                channelId: "tg",
                recipient: "12345",
                text: "hello",
            }),
        ).rejects.toThrow(/turnId or an explicit key/)
        await store.close()
    })

    test("the idempotency key reaches the transport", async () => {
        const store = await openMemoryStore()
        const transport = new FakeTransport()
        const h = harness(transport)
        const outbox = h.outbox(store)

        const rows = await outbox.enqueue(reply("hello"))
        await outbox.drain(AGENT)
        // Handed over whether or not the channel can use it, so enabling provider-side dedupe
        // later is a change inside the channel package rather than a new field on the interface.
        expect(transport.sent[0]?.idempotencyKey).toBe(rows[0]?.dedupeKey)
        await store.close()
    })
})
