/**
 * Ordered, budgeted context assembly.
 *
 * Phase 1 fills slots 0 (identity), 5 (recent history), and 6 (current input). Slot 1 arrives
 * with tools, 2 with skills, 3 with memory, 4 with compaction. The slot order is already fixed
 * so that adding them later cannot disturb the cache-stable prefix.
 *
 * History is trimmed from the oldest end when the budget is tight. That is a window, not
 * compaction — dropping the oldest turn outright is what Phase 7's ladder replaces with
 * something that summarises before it forgets.
 */

import type { ChatMessage } from "../model/provider.ts"
import { type ContextBlock, SLOT } from "./blocks.ts"
import { estimateMessageTokens, estimateTokens } from "./tokens.ts"

export interface AssembleInput {
    /** Concatenated `context.files`, read once at agent load. Must be byte-stable per turn. */
    readonly identity: string
    /**
     * Slot 1: the dialect preamble and tool catalogue, rendered once at agent load.
     *
     * Rendered at load rather than here, and for the same reason identity is read at load: slots 0
     * and 1 are the cache-stable prefix, and a catalogue that varies per turn — re-sorted, or with a
     * timestamp in it — silently stops prompt caching working, with no error and no symptom beyond
     * the bill.
     */
    readonly toolBlocks?: readonly ContextBlock[]
    /** Oldest first. */
    readonly history: readonly ChatMessage[]
    readonly input: string
    /** Surfaced in the pinned error slot so a failure survives compaction. */
    readonly lastError?: string
    /** Total window, after capability resolution. */
    readonly window: number
    /** Held back for the response. */
    readonly reserveOutput: number
}

export interface AssembledContext {
    readonly blocks: readonly ContextBlock[]
    readonly messages: readonly ChatMessage[]
    readonly totalTokens: number
    /** Budget available to the prompt: `window - reserveOutput`. */
    readonly promptBudget: number
    /** History messages dropped to fit. Reported, never silent. */
    readonly droppedMessages: number
}

function block(
    slot: ContextBlock["slot"],
    role: ContextBlock["role"],
    content: string,
    pinned: boolean,
    label: string,
): ContextBlock {
    return { slot, role, content, pinned, tokens: estimateMessageTokens(content), label }
}

/**
 * What one history message costs.
 *
 * `content` is not the whole message under the `native` dialect: an assistant turn carries the
 * argument documents of the calls it made, and those are billed like any other tokens. Counting only
 * the content undercounts a tool-heavy history — the same invisible-cost mistake `wireTokens` exists
 * to correct for the catalogue, arriving here by a different route.
 */
function messageCost(message: ChatMessage): number {
    const calls = message.toolCalls
    if (calls === undefined || calls.length === 0) return estimateMessageTokens(message.content)
    return estimateMessageTokens(message.content) + estimateTokens(JSON.stringify(calls))
}

export function assembleContext(input: AssembleInput): AssembledContext {
    const promptBudget = Math.max(1, input.window - input.reserveOutput)

    const pinned: ContextBlock[] = []

    if (input.identity.trim() !== "") {
        pinned.push(block(SLOT.identity, "system", input.identity, true, "identity"))
    }
    for (const toolBlock of input.toolBlocks ?? []) pinned.push(toolBlock)
    const inputBlock = block(SLOT.input, "user", input.input, true, "input")
    pinned.push(inputBlock)
    if (input.lastError !== undefined && input.lastError !== "") {
        pinned.push(
            block(SLOT.error, "system", `Last error: ${input.lastError}`, true, "last-error"),
        )
    }

    const pinnedTokens = pinned.reduce((sum, b) => sum + b.tokens, 0)

    // Whatever the pinned blocks leave over goes to history, newest first.
    let remaining = promptBudget - pinnedTokens
    const kept: ChatMessage[] = []
    let dropped = 0

    for (let i = input.history.length - 1; i >= 0; i -= 1) {
        const message = input.history[i]
        if (message === undefined) continue
        const cost = messageCost(message)
        if (cost > remaining) {
            dropped = i + 1
            break
        }
        remaining -= cost
        kept.unshift(message)
    }

    // Carrying the message itself, not just its role and content. A `tool` observation names the call
    // it answers and an assistant turn carries the calls it made; a block describes neither, so
    // rebuilding messages from blocks alone would quietly strip both back out on the next step.
    const historyBlocks = kept.map((message) => ({
        ...block(SLOT.history, message.role, message.content, false, "history"),
        // `tokens` from the same function the trimming loop used, so the reported total and the budget
        // that produced it cannot disagree about what a message costs.
        tokens: messageCost(message),
        message,
    }))

    // Slot order, not insertion order: 0 and 1 lead so the cached prefix is the same bytes every
    // turn, and the pinned tail follows the history it applies to.
    const blocks = [
        ...pinned.filter((b) => b.slot === SLOT.identity),
        ...pinned.filter((b) => b.slot === SLOT.tools),
        ...historyBlocks,
        ...pinned.filter((b) => b.slot === SLOT.input || b.slot === SLOT.error),
    ]

    return {
        blocks,
        messages: blocks.map((b) => b.message ?? { role: b.role, content: b.content }),
        totalTokens: blocks.reduce((sum, b) => sum + b.tokens, 0),
        promptBudget,
        droppedMessages: dropped,
    }
}

/** Slot-level report for `GET /v1/agents/:id/context` and the `context.assembled` event. */
export function slotReport(
    blocks: readonly ContextBlock[],
): { slot: number; tokens: number; pinned: boolean }[] {
    const bySlot = new Map<number, { slot: number; tokens: number; pinned: boolean }>()
    for (const b of blocks) {
        const existing = bySlot.get(b.slot)
        if (existing === undefined) {
            bySlot.set(b.slot, { slot: b.slot, tokens: b.tokens, pinned: b.pinned })
        } else {
            existing.tokens += b.tokens
        }
    }
    return [...bySlot.values()].sort((a, b) => a.slot - b.slot)
}

export { estimateTokens }
