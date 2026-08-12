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
    readonly role: "system" | "user" | "assistant"
    readonly content: string
    /** Pinned blocks are never dropped or summarised by compaction. */
    readonly pinned: boolean
    readonly tokens: number
    /** Human-facing label for `GET /v1/agents/:id/context`. */
    readonly label: string
}
