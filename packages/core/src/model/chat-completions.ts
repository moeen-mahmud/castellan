/**
 * The one transport: OpenAI-compatible `/chat/completions` over hand-rolled `fetch`.
 *
 * No SDK. The `openai` package is heavy and leans toward the Responses API, which most compat
 * proxies do not implement; the Vercel AI SDK routes through a gateway when handed a model
 * string, which is a hidden network dependency in a runtime that advertises none.
 *
 * Three behaviours worth knowing about:
 *
 * - **The API key is read from the environment on every request**, never captured at
 *   construction. Rotating a key therefore needs no restart, which is a bug class deleted
 *   rather than a feature added.
 * - **Retries happen only before the first byte.** Once tokens are flowing, a retry would
 *   silently duplicate output. A mid-stream failure is surfaced, not papered over.
 * - **A server that ignores `stream: true` still works.** If the response is JSON rather than
 *   an event stream, it is read as a single completion. Compat proxies do this often enough
 *   that treating it as a hard error would cost real endpoints.
 */

import { apiKeyMissing, modelHttpError, modelStreamMalformed, modelUnreachable } from "../errors.ts"
import type { EnvSource } from "../manifest/env.ts"
import type { ChatChunk, ChatRequest, FetchLike, ModelProvider } from "./provider.ts"
import { parseSSE } from "./sse.ts"

export interface RetryPolicy {
    /** Total attempts, including the first. `1` disables retrying. */
    readonly attempts: number
    readonly baseDelayMs: number
    readonly maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 400, maxDelayMs: 8000 }

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export interface ChatCompletionsConfig {
    /** Provider id, for events. Defaults to `chat-completions`. */
    readonly id?: string
    /** Must end at the version segment; `/chat/completions` is appended. */
    readonly baseUrl: string
    /** Name of the env var holding the key. Omit for endpoints that need none. */
    readonly apiKeyEnv?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly retry?: RetryPolicy
    /**
     * Ask for usage in the streamed response. Off by default: `stream_options` is an OpenAI
     * extension and some compat endpoints reject unknown body fields with a 400, which would
     * cost portability for an accounting nicety. Phase 7 revisits this when the budget needs a
     * `prompt_tokens` anchor.
     */
    readonly streamUsage?: boolean
    /** Injectable for tests. Defaults to global `fetch`. */
    readonly fetch?: FetchLike
    /** Injectable for tests. Defaults to `process.env`, read per request. */
    readonly env?: EnvSource
    /** Called before a retry sleeps, so the runtime can emit `model.retry`. */
    readonly onRetry?: (info: { status: number; attempt: number; delayMs: number }) => void
    /** Field path for error reporting, e.g. `model.main`. */
    readonly field?: string
}

interface DeltaShape {
    choices?: {
        delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
        message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
        finish_reason?: unknown
    }[]
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
}

/**
 * Append `/chat/completions` to the base URL, keeping any query string intact.
 *
 * Naive string concatenation puts the path *after* the query — `…/v1?x=1/chat/completions` —
 * which 404s. Azure OpenAI carries a mandatory `?api-version=`, so this is a real endpoint
 * shape rather than a hypothetical one.
 */
function endpointUrl(baseUrl: string): string {
    try {
        const url = new URL(baseUrl)
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`
        return url.toString()
    } catch {
        // Not absolute. `validateManifest` rejects this at load; if a caller constructs a
        // provider directly, fall back rather than throwing from a URL parse.
        return `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number | undefined {
    if (header === null) return undefined
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
    return undefined
}

function backoffMs(policy: RetryPolicy, attempt: number): number {
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1)
    const capped = Math.min(exponential, policy.maxDelayMs)
    // Full jitter. Synchronised retries from several agents are their own outage.
    return Math.round(capped * (0.5 + Math.random() / 2))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve()
            return
        }
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            resolve()
        }
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

function* chunksFromPayload(payload: DeltaShape): Generator<ChatChunk> {
    const choice = payload.choices?.[0]

    const delta = choice?.delta ?? choice?.message
    const reasoning = asString(delta?.reasoning_content) ?? asString(delta?.reasoning)
    if (reasoning !== undefined) yield { type: "reasoning", delta: reasoning }

    const text = asString(delta?.content)
    if (text !== undefined) yield { type: "text", delta: text }

    const usage = payload.usage
    if (usage !== undefined) {
        yield {
            type: "usage",
            promptTokens: asNumber(usage.prompt_tokens) ?? 0,
            completionTokens: asNumber(usage.completion_tokens) ?? 0,
        }
    }

    const finish = asString(choice?.finish_reason)
    if (finish !== undefined) yield { type: "finish", reason: finish }
}

async function* iterateBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = body.getReader()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) return
            if (value !== undefined) yield value
        }
    } finally {
        // Releasing the lock lets an aborted fetch tear the socket down promptly, which is what
        // makes cancellation land inside a hundred milliseconds rather than at end of stream.
        reader.releaseLock()
    }
}

export function createChatCompletionsProvider(config: ChatCompletionsConfig): ModelProvider {
    const url = endpointUrl(config.baseUrl)
    const policy = config.retry ?? DEFAULT_RETRY
    const doFetch = config.fetch ?? globalThis.fetch
    const field = config.field ?? "model.main"

    function authHeaders(): Record<string, string> {
        if (config.apiKeyEnv === undefined) return {}
        const env = config.env ?? process.env
        const key = env[config.apiKeyEnv]
        if (key === undefined || key === "")
            throw apiKeyMissing(config.apiKeyEnv, `${field}.apiKeyEnv`)
        return { authorization: `Bearer ${key}` }
    }

    async function* chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
        const body = JSON.stringify({
            model: request.model,
            messages: request.messages,
            stream: true,
            ...(config.streamUsage === true ? { stream_options: { include_usage: true } } : {}),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.topP === undefined ? {} : { top_p: request.topP }),
            ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        })

        // Read the key *before* the retry loop. Inside it, a missing-key ConfigError would be
        // caught by the network-failure branch, retried twice, and finally reported as "cannot reach
        // the endpoint" — a config mistake wearing a connectivity error's clothes. Reading here is
        // still per-request, so rotation continues to work without a restart.
        const auth = authHeaders()

        let response: Response | undefined

        for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
            if (signal.aborted) return

            let candidate: Response
            try {
                candidate = await doFetch(url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        accept: "text/event-stream",
                        ...auth,
                        ...(config.headers ?? {}),
                    },
                    body,
                    signal,
                })
            } catch (cause) {
                if (signal.aborted) return
                if (attempt >= policy.attempts) throw modelUnreachable(url, cause)
                const delayMs = backoffMs(policy, attempt)
                config.onRetry?.({ status: 0, attempt, delayMs })
                await sleep(delayMs, signal)
                continue
            }

            if (candidate.ok) {
                response = candidate
                break
            }

            const retryable = RETRYABLE_STATUS.has(candidate.status)
            if (!retryable || attempt >= policy.attempts) {
                const text = await candidate.text().catch(() => "")
                throw modelHttpError(candidate.status, text, url)
            }

            // Drain so the connection can be reused rather than left half-read.
            await candidate.text().catch(() => "")
            const delayMs =
                retryAfterMs(candidate.headers.get("retry-after")) ?? backoffMs(policy, attempt)
            config.onRetry?.({ status: candidate.status, attempt, delayMs })
            await sleep(delayMs, signal)
        }

        if (response === undefined) return
        if (signal.aborted) return

        const contentType = response.headers.get("content-type") ?? ""

        // A server that ignored `stream: true` and answered with one JSON document.
        if (!contentType.includes("text/event-stream")) {
            const text = await response.text()
            let payload: DeltaShape
            try {
                payload = JSON.parse(text) as DeltaShape
            } catch (cause) {
                throw modelStreamMalformed(text, cause)
            }
            yield* chunksFromPayload(payload)
            return
        }

        if (response.body === null) return

        for await (const event of parseSSE(iterateBody(response.body))) {
            if (signal.aborted) return

            const data = event.data.trim()
            if (data === "") continue
            if (data === "[DONE]") return

            let payload: DeltaShape
            try {
                payload = JSON.parse(data) as DeltaShape
            } catch (cause) {
                throw modelStreamMalformed(data, cause)
            }

            yield* chunksFromPayload(payload)
        }
    }

    return { id: config.id ?? "chat-completions", chat }
}
