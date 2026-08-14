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
    /**
     * system: the workspace's `static` tier. Pinned, cache breakpoint A.
     *
     * The slot keeps the name `identity` while the tier is called `static`, and the two names are
     * doing different jobs: the tier says where the text came from, the slot says what it is for.
     * A manifest still using the deprecated `context.files` lands here by the same path.
     */
    identity: 0,
    /** Tool dialect preamble and catalogue. Pinned, cache breakpoint A. Phase 3. */
    tools: 1,
    /**
     * Workspace example blocks as a user message, under `examplesIn: user`. Pinned. Phase 3.5.
     *
     * *Before* `volatile`, and the ordering is the point: extracted examples are byte-stable for
     * the lifetime of the agent, and OpenAI-compatible prompt caching is contiguous-prefix-based.
     * Placed after the volatile tier they would fall out of the cacheable region on every memory
     * write despite never changing. Empty under `examplesIn: system`, where the blocks stay
     * embedded in the static tier exactly as authored.
     */
    examples: 2,
    /**
     * Workspace `volatile` tier — the user model and working memory. Pinned. Phase 3.5.
     *
     * *After* breakpoint A, and that is the entire reason the tier exists: this content changes when
     * the agent writes to memory, and content ahead of the breakpoint that changes invalidates the
     * cached prefix on every write. The cost rises and nothing anywhere reports it.
     */
    volatile: 3,
    /** Active skill body. Cache breakpoint B. Phase 5. */
    skill: 4,
    /**
     * Activated knowledge entries. **Not pinned** — Tier 3 is retrieved, never carried, so
     * compaction may drop it where it must never drop a workspace tier. Phase 3.5.
     */
    knowledge: 5,
    /** Retrieved memory passages. Phase 6. */
    memory: 6,
    /** Rolling digest, the output of compaction. Phase 7. */
    digest: 7,
    /** Recent message window. */
    history: 8,
    /**
     * Workspace `reminder` tier — one or two re-asserted rules. Pinned. Phase 3.5.
     *
     * Positioned after the history rather than with the other pinned instruction slots, because that
     * is what it is for: rule adherence decays across a conversation, attention is stronger at both
     * ends of the context than in the middle, and a rule stated once at the top of a thirty-turn
     * session is effectively in the middle.
     */
    reminder: 9,
    /** Current input and current task line. Pinned. */
    input: 10,
    /** Last error, if any. Pinned. */
    error: 11,
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
