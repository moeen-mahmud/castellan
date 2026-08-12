/**
 * The model transport contract.
 *
 * One shape, one implementation (`chat-completions.ts`). Implement this only for a genuinely
 * different wire protocol — a native Messages-API adapter, an in-process local runner. Not for
 * a different vendor: a different vendor is a different base URL.
 */

/**
 * The slice of `fetch` this runtime uses. Narrower than `typeof globalThis.fetch` on purpose:
 * the platform type carries extras (Bun adds `preconnect`) that make an injected test double
 * fail to typecheck, and the injection seam is worth more than the extra members.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ChatMessage {
    readonly role: "system" | "user" | "assistant"
    readonly content: string
}

export interface ChatRequest {
    readonly model: string
    readonly messages: readonly ChatMessage[]
    readonly temperature?: number
    readonly topP?: number
    readonly maxTokens?: number
}

/** Streamed output. `text` accumulates into the reply; `reasoning` is kept separate. */
export type ChatChunk =
    | { readonly type: "text"; readonly delta: string }
    | { readonly type: "reasoning"; readonly delta: string }
    | {
          readonly type: "usage"
          readonly promptTokens: number
          readonly completionTokens: number
      }
    | { readonly type: "finish"; readonly reason: string }

export interface ModelProvider {
    readonly id: string
    /**
     * Stream a completion. Must return promptly and yield as bytes arrive.
     *
     * On abort the generator returns rather than throwing: cancellation is a state, not an
     * exception, and a rejected promise here becomes an unhandled rejection somewhere else.
     */
    chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>
}
