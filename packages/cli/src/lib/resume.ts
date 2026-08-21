/**
 * The conversation a resumed session paints, out of the messages the store kept.
 *
 * Pure, and extracted from `run` for one reason: it was four chained lambdas inside a function that
 * needs a live runtime to call, so the only way to check it was to resume a real session and look. The
 * shape it decides has already been wrong twice — first painting nothing at all under a banner that
 * said `17 message(s)`, then painting every turn except the ones that called a tool — and both times
 * the layers around it were individually correct.
 *
 * What counts as part of the conversation:
 *
 * - No `origin` — a person's message, or a reply the model wrote as its final answer.
 * - `origin: "call"` — a tool-calling step. Its prose is narration the live session *did* show as it
 *   streamed, so excluding the row made a resumed transcript differ from the one that had been on
 *   screen. Under NLT the row also holds the ACTION block, which `proseOf` removes.
 *
 * What does not, and why each is deliberate rather than unhandled:
 *
 * - `origin: "observation"` — text a stranger wrote. It reaches the model inside a fence; painting it
 *   as part of the conversation would present it as something the agent or the person said.
 * - `origin: "repair"` and `origin: "digest"` — the runtime talking to itself about a malformed call
 *   or a compacted history. True of the prompt, not of anything anybody said.
 * - `role: "system"` and `role: "tool"` — the assembled prefix and native tool results, neither of
 *   which was ever on screen.
 */

import type { ChatMessage, DialectId } from "@dispach/core"
import { proseOf } from "@dispach/core"
import type { PriorMessage } from "#transcript"

/**
 * `history` in order, reduced to what a reader saw. Empty prose is dropped, not painted blank.
 *
 * A step that called a tool without narrating it produces no text at all, and a blank message row in a
 * resumed transcript reads as content that failed to load.
 */
export function priorMessages(
    history: readonly ChatMessage[],
    dialect: DialectId,
): readonly PriorMessage[] {
    const shown: PriorMessage[] = []
    for (const message of history) {
        if (message.origin !== undefined && message.origin !== "call") continue
        if (message.role !== "user" && message.role !== "assistant") continue
        const text = proseOf(message, dialect)
        if (text === "") continue
        shown.push({ role: message.role, text })
    }
    return shown
}
