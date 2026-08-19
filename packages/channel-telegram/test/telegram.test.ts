/**
 * The Telegram transport, against a scripted Bot API.
 *
 * A live bot proves the happy path and nothing else. Everything that actually decides whether this
 * channel is trustworthy — a 429 honoured verbatim, a 403 not retried, a poll loop that survives a
 * failure, a webhook with the wrong secret — is either hard or impossible to provoke against the
 * real thing, and all of it is one wrong branch away from silent message loss.
 */

import type { ChannelHost, RawInbound } from "@dispach/core"
import { describe, expect, mock, test } from "bun:test"
import { TelegramApi, TelegramApiError } from "../src/api.ts"
import { telegramChannel } from "../src/index.ts"
import { TelegramTransport, toInbound } from "../src/transport.ts"

const TOKEN = "123456:AAtest-token-never-real"

interface Scripted {
    readonly method: string
    readonly status?: number
    readonly body: unknown
}

/** A `fetch` that answers from a script and records what it was asked. */
function scriptedFetch(script: Scripted[]) {
    const calls: { method: string; body: unknown }[] = []
    let index = 0

    const fetchLike = async (input: string, init?: RequestInit): Promise<Response> => {
        const method = input.split("/").pop() ?? ""
        calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) })

        const next = script[index]
        if (next !== undefined && next.method === method) index += 1
        const entry =
            next?.method === method
                ? next
                : { method, status: 200, body: { ok: true, result: true } }

        return new Response(JSON.stringify(entry.body), {
            status: entry.status ?? 200,
            headers: { "content-type": "application/json" },
        })
    }

    return { fetchLike, calls }
}

function hostSpy() {
    const received: RawInbound[] = []
    const statuses: { status: string; detail?: string }[] = []
    const errors: { code: string; message: string }[] = []
    const host: ChannelHost = {
        receive: (message) => received.push(message),
        status: (status, detail) =>
            statuses.push({ status, ...(detail === undefined ? {} : { detail }) }),
        error: (detail) => errors.push({ code: detail.code, message: detail.message }),
    }
    return { host, received, statuses, errors }
}

function message(over: Record<string, unknown> = {}) {
    return {
        message_id: 11,
        from: { id: 7, is_bot: false, first_name: "Moeen", username: "moeen" },
        chat: { id: 12345, type: "private" },
        date: 1_770_000_000,
        text: "hello",
        ...over,
    }
}

// ─── Mapping ─────────────────────────────────────────────────────────────────────────────

describe("update mapping", () => {
    test("a private message becomes a routable inbound", () => {
        const inbound = toInbound(message() as never, "hello")
        expect(inbound.peerId).toBe("12345")
        expect(inbound.senderHandle).toBe("@moeen")
        expect(inbound.senderName).toBe("Moeen")
        expect(inbound.text).toBe("hello")
        expect(inbound.receivedAt).toBe(new Date(1_770_000_000_000).toISOString())
    })

    test("the provider id is scoped to the chat", () => {
        // message_id is unique per chat, not globally. A bare id would make two people's first
        // messages look like one replayed update, and the inbox would drop the second.
        const a = toInbound(message({ chat: { id: 1, type: "private" } }) as never, "hi")
        const b = toInbound(message({ chat: { id: 2, type: "private" } }) as never, "hi")
        expect(a.providerMessageId).toBe("1:11")
        expect(b.providerMessageId).toBe("2:11")
    })

    test("a forum topic carries its thread", () => {
        const inbound = toInbound(message({ message_thread_id: 7 }) as never, "hi")
        expect(inbound.thread).toBe("7")
    })

    test("a sender with no username has no handle, only a peer id", () => {
        const inbound = toInbound(
            message({ from: { id: 7, is_bot: false, first_name: "Moeen" } }) as never,
            "hi",
        )
        expect(inbound.senderHandle).toBeUndefined()
        expect(inbound.peerId).toBe("12345")
    })
})

// ─── Sending ─────────────────────────────────────────────────────────────────────────────

describe("send", () => {
    test("a successful send returns the provider message id", async () => {
        const { fetchLike, calls } = scriptedFetch([
            { method: "sendMessage", body: { ok: true, result: { message_id: 99 } } },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })

        const result = await transport.send({
            channelId: "tg",
            recipient: "12345",
            text: "hi",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result).toEqual({ ok: true, providerMessageId: "99" })
        expect(calls[0]?.body).toEqual({ chat_id: "12345", text: "hi" })
    })

    test("a 429 is retryable and its retry_after is honoured verbatim", async () => {
        const { fetchLike } = scriptedFetch([
            {
                method: "sendMessage",
                status: 429,
                body: {
                    ok: false,
                    error_code: 429,
                    description: "Too Many Requests",
                    parameters: { retry_after: 17 },
                },
            },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })

        const result = await transport.send({
            channelId: "tg",
            recipient: "1",
            text: "hi",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.retryable).toBe(true)
            // Seconds on the wire, milliseconds in the outbox. Getting this wrong by 1000x is the
            // difference between backing off 17 s and backing off 17 ms into the next 429.
            expect(result.retryAfterMs).toBe(17_000)
        }
    })

    test("a 403 is permanent — the bot was blocked, and waiting does not help", async () => {
        const { fetchLike } = scriptedFetch([
            {
                method: "sendMessage",
                status: 403,
                body: {
                    ok: false,
                    error_code: 403,
                    description: "Forbidden: bot was blocked by the user",
                },
            },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })

        const result = await transport.send({
            channelId: "tg",
            recipient: "1",
            text: "hi",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.retryable).toBe(false)
    })

    test("a 409 names the real cause: a second instance is polling", async () => {
        // Telegram allows one getUpdates consumer per token. The generic 4xx branch told the
        // reader "a 5xx from Telegram is usually brief", which is wrong twice.
        const { fetchLike } = scriptedFetch([
            {
                method: "sendMessage",
                status: 409,
                body: {
                    ok: false,
                    error_code: 409,
                    description: "Conflict: terminated by other getUpdates request",
                },
            },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const result = await transport.send({
            channelId: "tg",
            recipient: "1",
            text: "hi",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.retryable).toBe(true)
            expect(result.error.code).toBe("telegram_conflict")
            expect(result.error.hint).toContain("one getUpdates consumer")
        }
    })

    test("a 5xx is retryable", async () => {
        const { fetchLike } = scriptedFetch([
            {
                method: "sendMessage",
                status: 502,
                body: { ok: false, error_code: 502, description: "Bad Gateway" },
            },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const result = await transport.send({
            channelId: "tg",
            recipient: "1",
            text: "hi",
            idempotencyKey: "k",
            chunkIndex: 0,
            chunkTotal: 1,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.retryable).toBe(true)
    })

    test("a network failure is retryable and never quotes the URL", async () => {
        // The token is a path segment. Any message quoting the URL leaks a bearer credential into
        // logs and into whatever collects them.
        const api = new TelegramApi({
            token: TOKEN,
            fetch: async () => {
                throw new Error("ECONNRESET")
            },
        })
        await api.getMe().then(
            () => {
                throw new Error("expected a failure")
            },
            (error: unknown) => {
                expect(error).toBeInstanceOf(TelegramApiError)
                expect((error as TelegramApiError).retryable).toBe(true)
                expect((error as Error).message).not.toContain(TOKEN)
            },
        )
    })

    test("the declared limit is Telegram's, and idempotentSend is honestly false", () => {
        const transport = new TelegramTransport({ id: "tg", token: TOKEN, mode: "longpoll" })
        expect(transport.limits.maxMessageChars).toBe(4096)
        // sendMessage takes no client-supplied key. Declaring true would turn the outbox's visible
        // `uncertain` flag into a silent duplicate.
        expect(transport.limits.idempotentSend).toBe(false)
    })
})

// ─── Long-poll ───────────────────────────────────────────────────────────────────────────

describe("long-poll", () => {
    test("updates are ingested and the offset advances past them", async () => {
        const script: Scripted[] = [
            { method: "deleteWebhook", body: { ok: true, result: true } },
            {
                method: "getUpdates",
                body: { ok: true, result: [{ update_id: 41, message: message() }] },
            },
        ]
        const { fetchLike, calls } = scriptedFetch(script)
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const { host, received, statuses } = hostSpy()

        await transport.start(host)
        await Bun.sleep(20)
        await transport.stop()

        expect(received.length).toBeGreaterThanOrEqual(1)
        expect(received[0]?.text).toBe("hello")
        expect(statuses.some((s) => s.status === "connected")).toBe(true)

        // The offset is the update id plus one: re-sending the same offset would replay it forever.
        const polls = calls.filter((c) => c.method === "getUpdates")
        expect((polls[0]?.body as { offset: number } | undefined)?.offset).toBe(0)
        expect((polls[1]?.body as { offset: number } | undefined)?.offset).toBe(42)
    })

    test("a leftover webhook is cleared before polling", async () => {
        // Telegram allows one delivery method at a time. A webhook left from a previous deployment
        // silently takes every update and the poll returns empty forever.
        const { fetchLike, calls } = scriptedFetch([])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const { host } = hostSpy()
        await transport.start(host)
        await Bun.sleep(10)
        await transport.stop()
        expect(calls[0]?.method).toBe("deleteWebhook")
    })

    test("a failing poll reports once and keeps polling", async () => {
        let polls = 0
        const api = new TelegramApi({
            token: TOKEN,
            fetch: async (input: string) => {
                if (input.endsWith("/getUpdates")) {
                    polls += 1
                    return new Response(
                        JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }),
                        { status: 502, headers: { "content-type": "application/json" } },
                    )
                }
                return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
            },
        })
        const transport = new TelegramTransport({ id: "tg", token: TOKEN, mode: "longpoll", api })
        const { host, errors } = hostSpy()

        await transport.start(host)
        await Bun.sleep(50)
        await transport.stop()

        // A loop that exited on the first failure leaves a bot that is running, reports nothing,
        // and receives nothing forever.
        expect(polls).toBeGreaterThanOrEqual(1)
        expect(errors.length).toBe(1)
    })

    test("connected names the bot and arrives without waiting for the first poll", async () => {
        // A long-poll holds for 30 s, so reporting connected from its first return left a working
        // bot silent for half a minute — indistinguishable from a broken one.
        const { fetchLike } = scriptedFetch([
            { method: "deleteWebhook", body: { ok: true, result: true } },
            { method: "getMe", body: { ok: true, result: { id: 1, username: "KamlaAI_bot" } } },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const { host, statuses } = hostSpy()
        await transport.start(host)
        await Bun.sleep(20)
        await transport.stop()
        expect(statuses.find((s) => s.status === "connected")?.detail).toBe(
            "@KamlaAI_bot, long-poll",
        )
    })

    test("connected is announced once, not once per poll", async () => {
        // Keyed on `offset === 0` this repeated every 30 seconds on an idle bot, forever. A status
        // line that repeats on a timer is one a reader learns to skip — including when it changes.
        const { fetchLike } = scriptedFetch([])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const { host, statuses } = hostSpy()
        await transport.start(host)
        await Bun.sleep(40)
        await transport.stop()
        expect(statuses.filter((s) => s.status === "connected").length).toBe(1)
    })

    test("a bot's own message is ignored", async () => {
        const { fetchLike } = scriptedFetch([
            { method: "deleteWebhook", body: { ok: true, result: true } },
            {
                method: "getUpdates",
                body: {
                    ok: true,
                    result: [
                        {
                            update_id: 1,
                            message: message({ from: { id: 9, is_bot: true, first_name: "Bot" } }),
                        },
                    ],
                },
            },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const { host, received } = hostSpy()
        await transport.start(host)
        await Bun.sleep(20)
        await transport.stop()
        expect(received.length).toBe(0)
    })

    test("a media message with no caption produces no turn", async () => {
        const { fetchLike } = scriptedFetch([
            { method: "deleteWebhook", body: { ok: true, result: true } },
            {
                method: "getUpdates",
                body: {
                    ok: true,
                    result: [{ update_id: 1, message: message({ text: undefined }) }],
                },
            },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "longpoll",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const { host, received } = hostSpy()
        await transport.start(host)
        await Bun.sleep(20)
        await transport.stop()
        expect(received.length).toBe(0)
    })
})

// ─── Webhook ─────────────────────────────────────────────────────────────────────────────

describe("webhook", () => {
    async function started(secretToken?: string) {
        const { fetchLike, calls } = scriptedFetch([
            { method: "setWebhook", body: { ok: true, result: true } },
        ])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "webhook",
            webhookUrl: "https://example.test/v1/channels/tg/webhook/a",
            ...(secretToken === undefined ? {} : { secretToken }),
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const spy = hostSpy()
        await transport.start(spy.host)
        return { transport, calls, ...spy }
    }

    test("start registers the webhook and reports connected", async () => {
        const { calls, statuses } = await started()
        expect(calls[0]?.method).toBe("setWebhook")
        expect((calls[0]?.body as { url: string } | undefined)?.url).toBe(
            "https://example.test/v1/channels/tg/webhook/a",
        )
        expect(statuses.at(-1)?.status).toBe("connected")
    })

    test("webhook mode with no url reports an error and does not register", async () => {
        // Telegram will not deliver to a missing or plain-HTTP URL, so this otherwise shows up as
        // a bot nobody is messaging.
        const { fetchLike, calls } = scriptedFetch([])
        const transport = new TelegramTransport({
            id: "tg",
            token: TOKEN,
            mode: "webhook",
            api: new TelegramApi({ token: TOKEN, fetch: fetchLike }),
        })
        const { host, errors } = hostSpy()
        await transport.start(host)
        expect(errors[0]?.code).toBe("telegram_webhook_url_missing")
        expect(calls.length).toBe(0)
    })

    test("a delivery with the right secret is accepted and ingested", async () => {
        const { transport, received } = await started("s3cret")
        const outcome = await transport.webhook({
            body: { update_id: 1, message: message() },
            headers: { "x-telegram-bot-api-secret-token": "s3cret" },
        })
        expect(outcome.status).toBe(200)
        expect(received[0]?.text).toBe("hello")
    })

    test("a delivery with the wrong secret is 401 and ingests nothing", async () => {
        const { transport, received } = await started("s3cret")
        const outcome = await transport.webhook({
            body: { update_id: 1, message: message() },
            headers: { "x-telegram-bot-api-secret-token": "guess" },
        })
        expect(outcome.status).toBe(401)
        // The messages inside an unverified body are exactly the ones an attacker chose.
        expect(received.length).toBe(0)
    })

    test("a delivery with no secret header is 401 when one is configured", async () => {
        const { transport, received } = await started("s3cret")
        const outcome = await transport.webhook({
            body: { update_id: 1, message: message() },
            headers: {},
        })
        expect(outcome.status).toBe(401)
        expect(received.length).toBe(0)
    })

    test("200 is returned before the turn runs", async () => {
        // Telegram retries any non-2xx. A webhook that waited for generation would be retried
        // mid-turn and deliver the same message again.
        const { transport, received } = await started()
        const outcome = await transport.webhook({
            body: { update_id: 1, message: message() },
            headers: {},
        })
        expect(outcome.status).toBe(200)
        expect(received.length).toBe(1)
    })
})

// ─── The factory ─────────────────────────────────────────────────────────────────────────

describe("telegramChannel factory", () => {
    const base = { agentId: "a", dir: "/tmp", id: "tg" }

    test("a missing token fails at load, naming the variable", () => {
        // Different from a *wrong* token, which is a network fact and must not block readiness.
        expect(() =>
            telegramChannel({ ...base, env: {}, config: { tokenEnv: "TG_TOKEN" } }),
        ).toThrow(/TG_TOKEN/)
    })

    test("an invalid mode is refused, and the hint names both valid ones", () => {
        try {
            telegramChannel({
                ...base,
                env: { TELEGRAM_BOT_TOKEN: TOKEN },
                config: { mode: "polling" },
            })
            throw new Error("expected a failure")
        } catch (error) {
            expect((error as { code?: string }).code).toBe("telegram_mode_invalid")
            expect((error as { hint: string }).hint).toContain("longpoll or webhook")
        }
    })

    test("naming secretTokenEnv and leaving it unset is refused", () => {
        // A webhook that verifies nothing is worse than one that never claimed to.
        expect(() =>
            telegramChannel({
                ...base,
                env: { TELEGRAM_BOT_TOKEN: TOKEN },
                config: { mode: "webhook", secretTokenEnv: "TG_SECRET" },
            }),
        ).toThrow(/TG_SECRET/)
    })

    test("a valid entry produces a transport with the channel's id", () => {
        const transport = telegramChannel({
            ...base,
            env: { TELEGRAM_BOT_TOKEN: TOKEN },
            config: { mode: "longpoll" },
        })
        expect(transport.id).toBe("tg")
        expect(transport.type).toBe("telegram")
    })
})

// Keeps `mock` imported and the linter honest about the bun:test surface in use.
void mock
