/**
 * Context slots, in fixed order.
 *
 * The order is load-bearing. Slots 0 and 1 form the cache-stable prefix, and prompt caching
 * only works if that prefix is byte-identical across turns — reordering them, or letting their
 * content vary per turn, silently stops the cache working and the bill goes up with no error
 * anywhere. Nothing warns you. That is why the identity text is read once at agent load and
 * never re-read per turn.
 *
 * Pinned blocks survive every compaction stage, including the most aggressive. Anything that
 * must always hold — identity, guardrails, the tool catalogue, the current task — lives in a
 * pinned slot and never in history, because compaction reliably eats initial instructions and
 * the fix is structural placement rather than a stronger prompt.
 */

import type { ChatMessage } from "../model/provider.ts"

export const SLOT = {
    /** system: identity, from `context.files`. Pinned, cache breakpoint A. */
    identity: 0,
    /** Tool dialect preamble and catalogue. Pinned, cache breakpoint A. Phase 3. */
    tools: 1,
    /** Active skill body. Cache breakpoint B. Phase 5. */
    skill: 2,
    /** Retrieved memory passages. Phase 6. */
    memory: 3,
    /** Rolling digest, the output of compaction. Phase 7. */
    digest: 4,
    /** Recent message window. */
    history: 5,
    /** Current input and current task line. Pinned. */
    input: 6,
    /** Last error, if any. Pinned. */
    error: 7,
} as const

export type SlotName = keyof typeof SLOT
export type SlotNumber = (typeof SLOT)[SlotName]

export interface ContextBlock {
    readonly slot: SlotNumber
    readonly role: ChatMessage["role"]
    readonly content: string
    /** Pinned blocks are never dropped or summarised by compaction. */
    readonly pinned: boolean
    readonly tokens: number
    /** Human-facing label for `GET /v1/agents/:id/context`. */
    readonly label: string
    /**
     * The verbatim message, when this block *is* one — history blocks, and nothing else.
     *
     * Present because `{role, content}` is a lossy description of a message and stopped being a
     * complete one when native tool calling arrived. A `tool` observation carries the id of the call
     * it answers, and an assistant turn carries the calls it made; rebuilding a message from a block's
     * two fields drops both. The endpoint's reply to that is a rejected turn at best, and at worst a
     * model that never sees the call it just made and repeats itself.
     *
     * Blocks the harness composes — identity, catalogue, the input line — have no message of their
     * own and leave this unset. The projection falls back to `{role, content}` for them.
     */
    readonly message?: ChatMessage
}
