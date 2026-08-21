/**
 * What a person actually saw of an assistant message.
 *
 * A tool-calling step is stored raw, on purpose: `renderCall` keeps the model's own output so the next
 * model call sees the call it made rather than a cleaned-up version that no longer explains the
 * observation underneath it. Under NLT that means one `origin: "call"` row holds the narration and the
 * `ACTION` block together, in one string, with nothing separating them.
 *
 * A live session shows only the narration — the stream filter strips the block as it arrives — so a
 * reader scrolling back through a running conversation and a reader resuming it were seeing two
 * different transcripts of the same turn. This is the recovery, and it happens at *read* time rather
 * than by storing a second copy: the block is delimited, `parseNlt` already separates it, and a new
 * field on `ChatMessage` is the one shape that has cost this repo six debugging rounds — a conditional
 * spread is not excess-property-checked, so a layer that forgets to forward it fails silently.
 *
 * Read time also means it applies to rows already in the store, which no migration could.
 */

import type { ChatMessage } from "../../model/provider.ts"
import type { DialectId } from "./dialect.ts"
import { parseNlt } from "./nlt.ts"

/**
 * The prose in `message`, with any invocation the dialect embeds in the text removed.
 *
 * Only NLT embeds one. Native puts the call in `toolCalls`, so its `content` is already exactly what
 * the person saw — stated here rather than parsed anyway, because a parse that cannot change the
 * answer is a line somebody later reads as necessary.
 *
 * Safe on any message: a non-assistant role carries no invocation, and NLT's parser handed ordinary
 * prose returns it unchanged. Callers wanting the text as stored should read `content` directly.
 */
export function proseOf(message: ChatMessage, dialect: DialectId): string {
    if (message.role !== "assistant" || dialect === "native") return message.content.trim()
    return parseNlt(message.content).text.trim()
}
