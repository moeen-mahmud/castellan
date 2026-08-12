#!/usr/bin/env bun
/**
 * A deliberately awkward OpenAI-compatible endpoint, for verifying the transport end to end
 * without a key or a network.
 *
 *   bun scripts/mock-endpoint.ts [--port 8787]
 *
 * It streams in a way real gateways do and unit tests cannot cover, because the point is to
 * exercise the *actual* fetch + ReadableStream + TextDecoder path:
 *
 * - frames split mid-JSON across TCP writes
 * - `\r\n` line endings
 * - a heartbeat comment partway through
 * - a terminating `data: [DONE]` with no trailing blank line
 *
 * Query parameters drive the failure modes:
 *   ?fail=429&failTimes=2   fail the first N requests with that status, then succeed
 *   ?delay=50               milliseconds between chunks, for testing cancellation
 *   ?plain=1                answer with one JSON document, ignoring `stream: true`
 *   ?reason=1               emit `reasoning_content` deltas first, as DeepSeek's reasoner does
 */

const args = process.argv.slice(2)
const portFlag = args.indexOf("--port")
const port = portFlag === -1 ? 8787 : Number(args[portFlag + 1] ?? 8787)

let failuresServed = 0

function sseFrame(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\r\n\r\n`
}

function deltaPayload(content: string): unknown {
    return {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }
}

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url)

        if (url.pathname === "/healthz") return new Response("ok")

        if (!url.pathname.endsWith("/chat/completions")) {
            return new Response(
                JSON.stringify({ error: { message: `no route for ${url.pathname}` } }),
                {
                    status: 404,
                    headers: { "content-type": "application/json" },
                },
            )
        }

        const body = (await request.json().catch(() => ({}))) as {
            messages?: { role: string; content: string }[]
        }
        const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")

        const failStatus = Number(url.searchParams.get("fail") ?? 0)
        const failTimes = Number(url.searchParams.get("failTimes") ?? 1)
        if (failStatus > 0 && failuresServed < failTimes) {
            failuresServed += 1
            return new Response(JSON.stringify({ error: { message: "mock failure" } }), {
                status: failStatus,
                headers: { "content-type": "application/json", "retry-after": "0" },
            })
        }
        failuresServed = 0

        const reply = `You said: ${lastUser?.content ?? "(nothing)"}`

        if (url.searchParams.get("plain") === "1") {
            return new Response(
                JSON.stringify({
                    choices: [{ index: 0, message: { content: reply }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 11, completion_tokens: 7 },
                }),
                { headers: { "content-type": "application/json" } },
            )
        }

        const delay = Number(url.searchParams.get("delay") ?? 0)
        const words = reply.split(" ").map((word, index) => (index === 0 ? word : ` ${word}`))
        const wantsReasoning = url.searchParams.get("reason") === "1"

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                const encoder = new TextEncoder()
                const write = (text: string) => controller.enqueue(encoder.encode(text))

                // DeepSeek's reasoner sends its chain of thought as `reasoning_content` deltas
                // before any reply content. A client that treats the field as ordinary content
                // delivers the model's scratchpad to the user as the answer.
                if (wantsReasoning) {
                    for (const thought of ["Let me think. ", "The user said something. "]) {
                        write(
                            sseFrame({
                                choices: [
                                    {
                                        index: 0,
                                        delta: { reasoning_content: thought },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        )
                        if (delay > 0) await Bun.sleep(delay)
                    }
                }

                for (const [index, word] of words.entries()) {
                    const frame = sseFrame(deltaPayload(word))

                    if (index === 1) {
                        // Split one frame mid-JSON across two writes. A parser that assumes a chunk is a
                        // frame drops a token here and nobody notices until a user reports a typo.
                        const cut = Math.floor(frame.length / 2)
                        write(frame.slice(0, cut))
                        await Bun.sleep(5)
                        write(frame.slice(cut))
                    } else {
                        write(frame)
                    }

                    // Proxy keepalive.
                    if (index === 2) write(": heartbeat\r\n\r\n")
                    if (delay > 0) await Bun.sleep(delay)
                }

                write(
                    sseFrame({
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                        usage: { prompt_tokens: 11, completion_tokens: words.length },
                    }),
                )
                // No trailing blank line after [DONE], exactly as several real gateways behave.
                write("data: [DONE]")
                controller.close()
            },
        })

        return new Response(stream, {
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            },
        })
    },
})

console.log(`mock-endpoint listening on http://localhost:${server.port}/v1`)
