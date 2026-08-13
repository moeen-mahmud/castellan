import { createChatCompletionsProvider } from "../src/model/chat-completions.ts"
import type { ChatChunk, ChatRequest } from "../src/model/provider.ts"
import { describe, expect, sleep, test } from "./_harness.ts"

/**
 * The HTTP transport, driven by an injected `fetch`. Injection rather than a live endpoint
 * because these are the cases that matter and cannot be summoned on demand: a 429 followed by a
 * success, a proxy that ignores `stream: true`, an error page injected mid-stream, a key that
 * rotates between requests.
 */

function sseResponse(frames: string[], init: ResponseInit = {}): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
        },
    })
    return new Response(stream, {
        ...init,
        headers: { "content-type": "text/event-stream", ...(init.headers ?? {}) },
    })
}

function delta(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
    const chunks: ChatChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
}

function textOf(chunks: ChatChunk[]): string {
    return chunks
        .filter((c): c is Extract<ChatChunk, { type: "text" }> => c.type === "text")
        .map((c) => c.delta)
        .join("")
}

const REQUEST: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] }

describe("request shape", () => {
    test("the endpoint path is appended to baseUrl", async () => {
        let seen = ""
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1",
            fetch: async (url) => {
                seen = String(url)
                return sseResponse([delta("ok"), "data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toBe("https://api.example.com/v1/chat/completions")
    })

    test("a trailing slash on baseUrl does not double up", async () => {
        let seen = ""
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1/",
            fetch: async (url) => {
                seen = String(url)
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toBe("https://api.example.com/v1/chat/completions")
    })

    test("a query string on baseUrl is preserved, with the path inserted before it", async () => {
        // Azure OpenAI requires ?api-version=. Naive concatenation yields `/v1?x=1/chat/completions`
        // and a 404 that looks like a wrong base URL rather than a wrong join.
        let seen = ""
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x.openai.azure.com/openai/deployments/gpt4?api-version=2024-02-01",
            fetch: async (url) => {
                seen = String(url)
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toBe(
            "https://x.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01",
        )
    })

    test("stream_options is omitted by default, because compat endpoints 400 on unknown fields", async () => {
        let body: Record<string, unknown> = {}
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(body.stream).toBe(true)
        expect(body.stream_options).toBeUndefined()
    })

    test("optional sampling parameters are omitted rather than sent as null", async () => {
        let body: Record<string, unknown> = {}
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect("temperature" in body).toBe(false)
        expect("max_tokens" in body).toBe(false)
    })
})

describe("api key handling", () => {
    test("the key is read on every request, so rotation needs no restart", async () => {
        const env: Record<string, string | undefined> = { KEY: "first" }
        const seen: string[] = []
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            apiKeyEnv: "KEY",
            env,
            fetch: async (_url, init) => {
                const headers = new Headers(init?.headers)
                seen.push(headers.get("authorization") ?? "")
                return sseResponse(["data: [DONE]\n\n"])
            },
        })

        await drain(provider.chat(REQUEST, new AbortController().signal))
        env.KEY = "rotated"
        await drain(provider.chat(REQUEST, new AbortController().signal))

        expect(seen).toEqual(["Bearer first", "Bearer rotated"])
    })

    test("no authorization header is sent when no key is configured", async () => {
        let hasAuth = true
        const provider = createChatCompletionsProvider({
            baseUrl: "http://localhost:11434/v1",
            fetch: async (_url, init) => {
                hasAuth = new Headers(init?.headers).has("authorization")
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(hasAuth).toBe(false)
    })

    test("a configured key that is unset names the variable", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            apiKeyEnv: "ABSENT_KEY",
            env: {},
            fetch: async () => sseResponse([]),
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            "ABSENT_KEY",
        )
    })
})

describe("streaming", () => {
    test("deltas accumulate in order", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([delta("Hel"), delta("lo "), delta("world"), "data: [DONE]\n\n"]),
        })
        expect(textOf(await drain(provider.chat(REQUEST, new AbortController().signal)))).toBe(
            "Hello world",
        )
    })

    test("[DONE] ends the stream and is not emitted as text", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => sseResponse([delta("a"), "data: [DONE]\n\n", delta("never")]),
        })
        expect(textOf(await drain(provider.chat(REQUEST, new AbortController().signal)))).toBe("a")
    })

    test("usage and finish_reason surface as their own chunks", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([
                    delta("a"),
                    `data: ${JSON.stringify({
                        choices: [{ delta: {}, finish_reason: "stop" }],
                        usage: { prompt_tokens: 12, completion_tokens: 3 },
                    })}\n\n`,
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(chunks).toContainEqual({ type: "usage", promptTokens: 12, completionTokens: 3 })
        expect(chunks).toContainEqual({ type: "finish", reason: "stop" })
    })

    test("reasoning content is kept separate from the reply", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                sseResponse([
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n`,
                    delta("answer"),
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(chunks).toContainEqual({ type: "reasoning", delta: "thinking" })
        expect(textOf(chunks)).toBe("answer")
    })

    test("a DeepSeek reasoner stream keeps reasoning_content out of the reply", async () => {
        // The failure this guards against is reasoning text arriving in `text` and being delivered
        // to the user as the answer — which is what happens if `reasoning_content` is treated as
        // just another content field.
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.deepseek.com/v1",
            fetch: async () =>
                sseResponse([
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me think. " } }] })}\n\n`,
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Both weigh 1kg." } }] })}\n\n`,
                    delta("They weigh the same."),
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))

        expect(textOf(chunks)).toBe("They weigh the same.")
        expect(
            chunks
                .filter(
                    (c): c is Extract<ChatChunk, { type: "reasoning" }> => c.type === "reasoning",
                )
                .map((c) => c.delta)
                .join(""),
        ).toBe("Let me think. Both weigh 1kg.")
    })

    test("a server that ignores stream:true is still understood", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        choices: [{ message: { content: "whole answer" }, finish_reason: "stop" }],
                        usage: { prompt_tokens: 5, completion_tokens: 2 },
                    }),
                    { headers: { "content-type": "application/json" } },
                ),
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(textOf(chunks)).toBe("whole answer")
        expect(chunks).toContainEqual({ type: "finish", reason: "stop" })
    })

    test("an error page injected into a stream is a named failure", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => sseResponse([delta("a"), "data: <html>502 Bad Gateway</html>\n\n"]),
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /not JSON/,
        )
    })
})

describe("retries", () => {
    test("a 429 is retried and then succeeds", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => {
                calls += 1
                if (calls === 1) {
                    return new Response("rate limited", {
                        status: 429,
                        headers: { "retry-after": "0" },
                    })
                }
                return sseResponse([delta("ok"), "data: [DONE]\n\n"])
            },
        })
        expect(textOf(await drain(provider.chat(REQUEST, new AbortController().signal)))).toBe("ok")
        expect(calls).toBe(2)
    })

    test("a 500 is retried", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => {
                calls += 1
                if (calls === 1) return new Response("boom", { status: 500 })
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(calls).toBe(2)
    })

    test("a 401 is not retried, and the hint points at the key", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => {
                calls += 1
                return new Response("no", { status: 401 })
            },
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /401/,
        )
        expect(calls).toBe(1)
    })

    test("a 404 hint names the version-segment mistake", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => new Response("nope", { status: 404 }),
        })
        try {
            await drain(provider.chat(REQUEST, new AbortController().signal))
            throw new Error("expected a failure")
        } catch (error) {
            expect((error as { hint: string }).hint).toContain("version segment")
        }
    })

    test("retries are reported, so the runtime can emit an event", async () => {
        const seen: number[] = []
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
            onRetry: (info) => seen.push(info.status),
            fetch: async () => {
                calls += 1
                if (calls < 3) return new Response("later", { status: 503 })
                return sseResponse(["data: [DONE]\n\n"])
            },
        })
        await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(seen).toEqual([503, 503])
    })

    test("exhausting the attempts surfaces the last status", async () => {
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => new Response("still down", { status: 503 }),
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /503/,
        )
    })

    test("a network failure is retried, then reported as unreachable", async () => {
        let calls = 0
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
            fetch: async () => {
                calls += 1
                throw new TypeError("connection refused")
            },
        })
        await expect(drain(provider.chat(REQUEST, new AbortController().signal))).rejects.toThrow(
            /Cannot reach/,
        )
        expect(calls).toBe(2)
    })
})

describe("cancellation", () => {
    test("an already-aborted signal yields nothing and does not throw", async () => {
        const controller = new AbortController()
        controller.abort()
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => sseResponse([delta("a")]),
        })
        expect(await drain(provider.chat(REQUEST, controller.signal))).toEqual([])
    })

    test("aborting mid-stream stops yielding without rejecting", async () => {
        const controller = new AbortController()
        const provider = createChatCompletionsProvider({
            baseUrl: "https://x/v1",
            fetch: async () => {
                const stream = new ReadableStream<Uint8Array>({
                    async pull(streamController) {
                        await sleep(5)
                        streamController.enqueue(new TextEncoder().encode(delta("tick")))
                    },
                })
                return new Response(stream, { headers: { "content-type": "text/event-stream" } })
            },
        })

        const chunks: ChatChunk[] = []
        for await (const chunk of provider.chat(REQUEST, controller.signal)) {
            chunks.push(chunk)
            if (chunks.length === 2) controller.abort()
        }

        expect(chunks.length).toBe(2)
    })
})

// ─── native tool calling on the wire ─────────────────────────────────────────────────────

/**
 * Two things here are worth more than the rest of this file put together, because both fail
 * *silently*: the message mapping, and the fragment reassembly.
 *
 * The body used to be built with `messages: request.messages`, correct only for as long as a message
 * was exactly `{role, content}`. A camelCase `toolCalls` on the wire is a field the API has never
 * heard of — the request succeeds, the model simply never sees the call it made, and the symptom is
 * an agent that repeats itself with no error anywhere.
 */

function toolCallFrame(entries: unknown[]): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: entries } }] })}\n\n`
}

function callsOf(chunks: ChatChunk[]) {
    return chunks
        .filter((c): c is Extract<ChatChunk, { type: "tool_call" }> => c.type === "tool_call")
        .map((c) => c.call)
}

async function capture(
    frames: string[],
    request = REQUEST,
): Promise<{ body: Record<string, unknown>; chunks: ChatChunk[] }> {
    let body: Record<string, unknown> = {}
    const provider = createChatCompletionsProvider({
        baseUrl: "https://api.example.com/v1",
        fetch: async (_url, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>
            return sseResponse(frames)
        },
    })
    const chunks = await drain(provider.chat(request, new AbortController().signal))
    return { body, chunks }
}

describe("the tools request parameter", () => {
    test("absent entirely when no tools are given — a text-dialect body is unchanged", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"])
        expect("tools" in body).toBe(false)
    })

    test("wrapped in the function envelope the API expects", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            ...REQUEST,
            tools: [{ name: "now", description: "the time", parameters: { type: "object" } }],
        })
        expect(body.tools).toEqual([
            {
                type: "function",
                function: { name: "now", description: "the time", parameters: { type: "object" } },
            },
        ])
    })
})

describe("messages on the wire use wire names", () => {
    test("an assistant message's calls are sent as tool_calls, not toolCalls", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            model: "m",
            messages: [
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: "c1", name: "now", arguments: "{}" }],
                },
            ],
        })
        const [message] = body.messages as Record<string, unknown>[]
        expect(message?.tool_calls).toEqual([
            { id: "c1", type: "function", function: { name: "now", arguments: "{}" } },
        ])
        expect("toolCalls" in (message ?? {})).toBe(false)
    })

    test("content is null beside a call, since some endpoints reject an empty string there", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            model: "m",
            messages: [
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: "c1", name: "now", arguments: "{}" }],
                },
            ],
        })
        expect((body.messages as Record<string, unknown>[])[0]?.content).toBe(null)
    })

    test("a tool message names the call it answers", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"], {
            model: "m",
            messages: [{ role: "tool", content: "09:00", toolCallId: "c1" }],
        })
        const [message] = body.messages as Record<string, unknown>[]
        expect(message?.role).toBe("tool")
        expect(message?.tool_call_id).toBe("c1")
    })

    test("an ordinary message is exactly what it always was", async () => {
        const { body } = await capture([delta("hi"), "data: [DONE]\n\n"])
        expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    })
})

describe("reassembling streamed tool_calls", () => {
    test("arguments arrive in fragments and are joined in order", async () => {
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, id: "call_1", function: { name: "now", arguments: "" } }]),
            toolCallFrame([{ index: 0, function: { arguments: '{"time' } }]),
            toolCallFrame([{ index: 0, function: { arguments: 'zone":"UTC"}' } }]),
            "data: [DONE]\n\n",
        ])
        expect(callsOf(chunks)).toEqual([
            { id: "call_1", name: "now", arguments: '{"timezone":"UTC"}' },
        ])
    })

    test("two interleaved calls stay separate, and come back in index order", async () => {
        // Keyed by index rather than arrival, which is the whole reason a buffer exists.
        const { chunks } = await capture([
            toolCallFrame([
                { index: 0, id: "a", function: { name: "now", arguments: "{}" } },
                { index: 1, id: "b", function: { name: "send", arguments: "" } },
            ]),
            toolCallFrame([{ index: 1, function: { arguments: '{"to":"x"}' } }]),
            "data: [DONE]\n\n",
        ])
        expect(callsOf(chunks)).toEqual([
            { id: "a", name: "now", arguments: "{}" },
            { id: "b", name: "send", arguments: '{"to":"x"}' },
        ])
    })

    test("a call is emitted once complete, never as fragments", async () => {
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, id: "a", function: { name: "now", arguments: "{" } }]),
            toolCallFrame([{ index: 0, function: { arguments: "}" } }]),
            "data: [DONE]\n\n",
        ])
        // Three frames, one chunk. Half a JSON document is of no use to any consumer.
        expect(callsOf(chunks).length).toBe(1)
    })

    test("a stream that just ends still yields its calls", async () => {
        // No `[DONE]`. Some endpoints simply close the body, and a flush that only ran on the
        // sentinel would drop the call and report the turn as a plain reply.
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, id: "a", function: { name: "now", arguments: "{}" } }]),
        ])
        expect(callsOf(chunks).length).toBe(1)
    })

    test("a non-streaming JSON reply carries complete calls, with no index", async () => {
        let body: Record<string, unknown> = {}
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1",
            fetch: async (_url, init) => {
                body = JSON.parse(String(init?.body)) as Record<string, unknown>
                return new Response(
                    JSON.stringify({
                        choices: [
                            {
                                message: {
                                    content: "",
                                    tool_calls: [
                                        {
                                            id: "a",
                                            function: { name: "now", arguments: "{}" },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                    { headers: { "content-type": "application/json" } },
                )
            },
        })
        const chunks = await drain(provider.chat(REQUEST, new AbortController().signal))
        expect(body.model).toBe("m")
        expect(callsOf(chunks)).toEqual([{ id: "a", name: "now", arguments: "{}" }])
    })

    test("an endpoint that omits the id gets a synthesised one rather than losing the call", async () => {
        const { chunks } = await capture([
            toolCallFrame([{ index: 0, function: { name: "now", arguments: "{}" } }]),
            "data: [DONE]\n\n",
        ])
        expect(callsOf(chunks)[0]?.id).toBe("call_0")
    })

    test("a cancelled stream drops a half-arrived call rather than executing half a document", async () => {
        const controller = new AbortController()
        const provider = createChatCompletionsProvider({
            baseUrl: "https://api.example.com/v1",
            fetch: async () =>
                sseResponse([
                    toolCallFrame([
                        { index: 0, id: "a", function: { name: "now", arguments: '{"t' } },
                    ]),
                    delta("x"),
                    "data: [DONE]\n\n",
                ]),
        })
        const chunks: ChatChunk[] = []
        for await (const chunk of provider.chat(REQUEST, controller.signal)) {
            chunks.push(chunk)
            controller.abort()
        }
        expect(callsOf(chunks)).toEqual([])
    })
})
