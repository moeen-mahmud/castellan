/**
 * The five stages, as pure transforms over history.
 *
 * Decision 5.1: compaction is progressive from v1, because binary emergency compaction at 95% is the
 * known-bad design — late activation, severe loss, and errors that compound across successive
 * compactions. Each stage here is strictly more destructive than the one before it, and the ladder
 * (`ladder.ts`) is what decides which ones run.
 *
 * | stage | what it does | model |
 * | --- | --- | --- |
 * | `trim` | drops the oldest whole turns | no |
 * | `snip` | cuts oversized observations to head + tail | no |
 * | `micro` | replaces an observation body with a pointer | no |
 * | `collapse` | digests all but the newest turns | yes, with a fallback |
 * | `reset` | digests everything; only pinned blocks survive | yes, with a fallback |
 *
 * ## Three properties that are load-bearing
 *
 * **Nothing is destroyed, only displaced.** `snip` and `micro` return the full original content as a
 * `Displaced` entry for the caller to persist, and leave a pointer the agent can follow. The id is
 * derived from the content, not generated, so a message that is snipped and then micro'd on a later
 * turn produces the *same* id both times — escalation converges on one artifact instead of
 * accumulating one per stage. Same reasoning as the outbox's dedupe key: the duplicate that actually
 * happens is the same work running twice, and only a derived identity collides. `StageOutcome.displaced`
 * is a map keyed by message index for this reason — see its comment; deriving the id afresh in `micro`
 * would hash the text `snip` had already cut.
 *
 * **The protected tail is untouchable.** `turn.ts` appends calls and observations to `history` *during*
 * the turn, so a stage firing at step three could replace the observation the model is about to reason
 * over — the compaction would break the turn it was rescuing. The count comes from the caller because
 * no pure function can know where the current turn's trace begins.
 *
 * **A stage that changes nothing says so.** `changed: false` is not a failure, it is the signal the
 * ladder uses to escalate. A stage reporting success for a no-op would stall the ladder one rung below
 * where it needed to be, and the prompt would then be cut by `assembleContext`'s blunt oldest-first
 * trim with nothing explaining why.
 */

import { derivedId } from "../../ids.ts"
import type { ChatMessage } from "../../model/provider.ts"
import { estimateMessageTokens, estimateTokens } from "../tokens.ts"

export const STAGE_ORDER = ["trim", "snip", "micro", "collapse", "reset"] as const

export type StageName = (typeof STAGE_ORDER)[number]

/** Content a stage removed from history, for the caller to persist and the agent to re-read. */
export interface Displaced {
    /** Derived from the content. Printable ASCII: it is used as a store key. */
    readonly id: string
    /** The tool that produced it, where the message says. */
    readonly slug?: string
    readonly content: string
    readonly tokens: number
}

export interface StageOutcome {
    readonly messages: readonly ChatMessage[]
    /**
     * Everything displaced so far in this pass, keyed by message index. Supersedes the input map.
     *
     * A map rather than a list, and that is what makes the convergence property true rather than
     * merely claimed: `micro` following `snip` over the same message finds the entry `snip` recorded
     * and reuses its id and its **original** content. Deriving the id afresh would hash the cut text,
     * so the pointer would resolve to a truncation of the thing it promises in full.
     *
     * Indices are stable from `snip` onward because the ladder runs the stages in the validated order
     * and `trim` — the only stage that reindexes — is strictly before both.
     */
    readonly displaced: ReadonlyMap<number, Displaced>
    /** Estimated cost of `messages`, from the same function the budget uses. */
    readonly tokens: number
    /** False when the stage had nothing left to do. The ladder escalates on this. */
    readonly changed: boolean
}

export interface StageInput {
    /** Oldest first, as `assembleContext` expects. */
    readonly history: readonly ChatMessage[]
    /** Tokens the history must fit into after this stage. */
    readonly target: number
    /** Newest messages that must not be altered — the current turn's trace. */
    readonly protectedTail: number
    /** What earlier stages in this same pass have already displaced, by index. */
    readonly displaced?: ReadonlyMap<number, Displaced>
}

const NO_DISPLACEMENTS: ReadonlyMap<number, Displaced> = new Map()

/** `obs_<len>_<hash>`. Length is in the id so two hash collisions still have to agree on size. */
export function displacedId(content: string): string {
    return derivedId("obs", content)
}

/** What a message costs, matching `assembleContext`'s accounting including tool-call arguments. */
function cost(message: ChatMessage): number {
    const calls = message.toolCalls
    if (calls === undefined || calls.length === 0) return estimateMessageTokens(message.content)
    return estimateMessageTokens(message.content) + estimateTokens(JSON.stringify(calls))
}

export function historyTokens(history: readonly ChatMessage[]): number {
    return history.reduce((sum, message) => sum + cost(message), 0)
}

/**
 * Is this message tool output?
 *
 * `origin` is the answer where it is present. `role === "tool"` covers the native dialect, where the
 * wire role really does carry the meaning, and also covers a history loaded from a store written
 * before `origin` existed.
 */
function isObservation(message: ChatMessage): boolean {
    return message.origin === "observation" || message.role === "tool"
}

/** The tool named in an NLT observation header, so a pointer can say what it replaced. */
function slugOf(message: ChatMessage): string | undefined {
    const match = /^OBSERVATION ([^\s—]+)/.exec(message.content)
    return match?.[1]
}

function unchanged(input: StageInput): StageOutcome {
    return {
        messages: input.history,
        displaced: input.displaced ?? NO_DISPLACEMENTS,
        tokens: historyTokens(input.history),
        changed: false,
    }
}

/**
 * The displacement for a message: whatever an earlier stage recorded, or a new entry from its content.
 *
 * This is the single place the original text is preserved across an escalation.
 */
function displacementFor(
    known: ReadonlyMap<number, Displaced>,
    index: number,
    message: ChatMessage,
    tokens: number,
): Displaced {
    const existing = known.get(index)
    if (existing !== undefined) return existing
    const slug = slugOf(message)
    return {
        id: displacedId(message.content),
        ...(slug === undefined ? {} : { slug }),
        content: message.content,
        tokens,
    }
}

/**
 * Where the protected tail starts. Everything from here on is off limits.
 *
 * Clamped rather than trusted: a caller that reports a longer tail than the history it passed would
 * otherwise produce a negative index and a silently reversed slice.
 */
function tailStart(input: StageInput): number {
    return Math.max(0, input.history.length - Math.max(0, input.protectedTail))
}

/**
 * A turn boundary is a `user` message that is not tool output.
 *
 * Under NLT an observation is also a `user` message, which is why this asks `isObservation` rather
 * than looking at the role alone — dropping "everything before the third user message" would
 * otherwise cut a history in the middle of a tool exchange and leave an assistant turn answering a
 * call whose result is gone.
 */
function isTurnStart(message: ChatMessage): boolean {
    return message.role === "user" && !isObservation(message)
}

/**
 * S1 — drop the oldest whole turns.
 *
 * This is what `assembleContext` already does when the budget is tight, with one difference that is
 * the entire point: it drops at *turn* granularity, so history never begins with an assistant message
 * answering a call whose observation was dropped, or with an observation whose call is gone. The blunt
 * version leaves both shapes, and a model reading them re-answers work it has already done.
 */
export function trim(input: StageInput): StageOutcome {
    const limit = tailStart(input)
    const boundaries: number[] = []
    for (let i = 0; i < limit; i += 1) {
        const message = input.history[i]
        if (message !== undefined && isTurnStart(message)) boundaries.push(i)
    }

    // The first boundary is the start of the oldest turn; dropping to it removes nothing. Candidates
    // are the boundaries after it, each of which drops one more complete turn.
    for (const boundary of boundaries.slice(1)) {
        const kept = input.history.slice(boundary)
        const tokens = historyTokens(kept)
        if (tokens <= input.target) {
            return { messages: kept, displaced: NO_DISPLACEMENTS, tokens, changed: true }
        }
    }

    // Nothing on its own gets under target. Drop every turn we may — the ladder escalates from here,
    // and a stage that refuses to help because it cannot finish the job is a stage that wasted a rung.
    const last = boundaries[boundaries.length - 1]
    if (last === undefined || last === 0) return unchanged(input)
    const kept = input.history.slice(last)
    return {
        messages: kept,
        // Deliberately empty rather than carried: `trim` reindexes, so any map keyed by the old
        // indices is now wrong. It runs before `snip`, so there is never one to lose.
        displaced: NO_DISPLACEMENTS,
        tokens: historyTokens(kept),
        changed: true,
    }
}

/**
 * How much of an oversized observation `snip` keeps, and in what proportion.
 *
 * Head-heavy on purpose. A tool result states what happened in its first lines — `ok`, an error, a
 * count, the first rows — and trails off into repetition; the tail is kept at all because the *end*
 * of a shell run carries the exit status. Two-thirds head, one-third tail is the split that keeps both
 * without keeping the middle, which is where a 200-row listing spends its bytes.
 */
const SNIP_KEEP_TOKENS = 400
const SNIP_HEAD_SHARE = 2 / 3

/** Below this an observation is left alone: cutting it would cost a marker and save nothing. */
const SNIP_FLOOR_TOKENS = 200

/**
 * Head, tail, and a marker naming the id — the id is not optional and its absence was a live bug.
 *
 * The first real run of this stage against an endpoint produced a marker reading "the whole
 * observation is still readable with artifact_read" with no id in it. Asked to follow it, the model
 * correctly reported that there was no id to pass and then answered from the visible fragment. An
 * invitation the runtime cannot honour is worse than no invitation: it spends a step and teaches the
 * model that the mechanism does not work.
 */
function cutMiddle(content: string, id: string): string {
    const lines = content.split("\n")
    const headLines: string[] = []
    const tailLines: string[] = []
    let headTokens = 0
    let tailTokens = 0
    const headBudget = Math.floor(SNIP_KEEP_TOKENS * SNIP_HEAD_SHARE)
    const tailBudget = SNIP_KEEP_TOKENS - headBudget

    let head = 0
    let tail = lines.length - 1
    while (head <= tail) {
        const line = lines[head]
        if (line === undefined) break
        const lineTokens = estimateTokens(line)
        if (headTokens + lineTokens > headBudget) break
        headLines.push(line)
        headTokens += lineTokens
        head += 1
    }
    while (tail >= head) {
        const line = lines[tail]
        if (line === undefined) break
        const lineTokens = estimateTokens(line)
        if (tailTokens + lineTokens > tailBudget) break
        tailLines.unshift(line)
        tailTokens += lineTokens
        tail -= 1
    }

    const removed = lines.length - headLines.length - tailLines.length
    if (removed <= 0) return content
    return [
        ...headLines,
        `… ${removed} line${removed === 1 ? "" : "s"} cut by compaction — the whole observation is still readable with artifact_read("${id}") …`,
        ...tailLines,
    ].join("\n")
}

/**
 * S2 — cut oversized observations to head and tail.
 *
 * Oldest first, and it stops as soon as the target is met: an observation from three turns ago is
 * worth less than the one from the last turn, and cutting more than necessary spends fidelity the
 * ladder has not yet asked for.
 */
export function snip(input: StageInput): StageOutcome {
    const limit = tailStart(input)
    const messages = [...input.history]
    const displaced = new Map(input.displaced ?? NO_DISPLACEMENTS)
    let tokens = historyTokens(input.history)
    let changed = false

    for (let i = 0; i < limit && tokens > input.target; i += 1) {
        const message = messages[i]
        if (message === undefined || !isObservation(message)) continue
        const before = cost(message)
        if (before <= SNIP_FLOOR_TOKENS) continue

        // The displacement is resolved *before* the cut, because the marker has to name its id and
        // the id is derived from the uncut text — which after this line is no longer what the message
        // holds. Same ordering constraint `micro` relies on, one stage earlier.
        const entry = displacementFor(displaced, i, message, before)
        const cut = cutMiddle(message.content, entry.id)
        if (cut === message.content) continue

        displaced.set(i, entry)
        messages[i] = { ...message, content: cut }
        tokens -= before - cost(messages[i] as ChatMessage)
        changed = true
    }

    if (!changed) return unchanged(input)
    return { messages, displaced, tokens, changed }
}

/**
 * S3 — replace an observation body with a pointer.
 *
 * The pointer names the tool, the size, and the id, in that order, because those are the three facts
 * that let a model decide whether following it is worth a step. It is generated text and not an
 * authored sentence, so writing it is not the rewriting decision 4.19 forbids.
 */
function pointer(displaced: Displaced): string {
    const what = displaced.slug === undefined ? "observation" : `${displaced.slug} observation`
    return `[compacted ${what}, ${displaced.tokens} tokens — read it in full with artifact_read("${displaced.id}")]`
}

export function micro(input: StageInput): StageOutcome {
    const limit = tailStart(input)
    const messages = [...input.history]
    const displaced = new Map(input.displaced ?? NO_DISPLACEMENTS)
    let tokens = historyTokens(input.history)
    let changed = false

    for (let i = 0; i < limit && tokens > input.target; i += 1) {
        const message = messages[i]
        if (message === undefined || !isObservation(message)) continue
        const before = cost(message)

        // `displacementFor` is what preserves the original across an escalation: after a `snip` this
        // returns the entry that stage recorded, carrying the id derived from the *uncut* text. So
        // the pointer written below resolves to the whole observation, not to the truncation.
        const entry = displacementFor(displaced, i, message, before)
        const replaced = pointer(entry)
        if (estimateMessageTokens(replaced) >= before) continue

        displaced.set(i, entry)
        messages[i] = { ...message, content: replaced }
        tokens -= before - cost(messages[i] as ChatMessage)
        changed = true
    }

    if (!changed) return unchanged(input)
    return { messages, displaced, tokens, changed }
}

/** Turns kept verbatim by `collapse`. Two, so the current exchange and the one it answers survive. */
const COLLAPSE_KEEP_TURNS = 2

/**
 * A digest built without a model.
 *
 * Used when no `compactor` role is configured and whenever the model call fails, which is the case
 * that matters: a compaction that throws has failed the turn it existed to rescue. Deliberately
 * factual rather than interpretive — roles, counts, and the tools that ran. It is a worse digest than
 * a model writes and it is never a *wrong* one, which is the right trade for a fallback.
 */
export function mechanicalDigest(messages: readonly ChatMessage[]): string {
    const people = messages.filter((message) => isTurnStart(message)).length
    const observations = messages.filter(isObservation)
    const slugs = [...new Set(observations.map(slugOf).filter((slug) => slug !== undefined))]
    const lines = [
        `Earlier in this conversation: ${people} message${people === 1 ? "" : "s"} from the person and ${observations.length} tool result${observations.length === 1 ? "" : "s"}.`,
    ]
    if (slugs.length > 0) lines.push(`Tools used: ${slugs.join(", ")}.`)
    const firstAsk = messages.find(isTurnStart)
    if (firstAsk !== undefined) {
        lines.push(`It opened with: ${firstAsk.content.slice(0, 200).replace(/\s+/g, " ")}`)
    }
    lines.push(
        "That detail was dropped to stay inside the context window. Ask the person rather than guessing at anything it covered.",
    )
    return lines.join("\n")
}

function digestMessage(text: string): ChatMessage {
    return { role: "user", content: text, origin: "digest" }
}

/**
 * S4 — digest everything but the newest turns.
 *
 * `digest` is supplied by the caller because producing it may be a model call, and a pure function
 * cannot make one. The caller is also where the fallback is chosen, so this stage never has to know
 * whether the text it was handed came from a model.
 */
export function collapse(input: StageInput & { readonly digest: string }): StageOutcome {
    const limit = tailStart(input)
    const boundaries: number[] = []
    for (let i = 0; i < limit; i += 1) {
        const message = input.history[i]
        if (message !== undefined && isTurnStart(message)) boundaries.push(i)
    }
    if (boundaries.length <= COLLAPSE_KEEP_TURNS) return unchanged(input)

    const from = boundaries[boundaries.length - COLLAPSE_KEEP_TURNS] as number
    const messages = [digestMessage(input.digest), ...input.history.slice(from)]
    const tokens = historyTokens(messages)
    // A digest longer than what it replaced is not a compaction. It happens on a short history of
    // terse turns, and accepting it would grow the prompt at the moment the ladder was asked to
    // shrink it.
    if (tokens >= historyTokens(input.history)) return unchanged(input)
    // Empty for the same reason `trim`'s is: a digest replaces a span of messages, so every index
    // after it has moved and a map keyed by the old ones would point at the wrong messages.
    return { messages, displaced: NO_DISPLACEMENTS, tokens, changed: true }
}

/**
 * S5 — everything becomes the digest, except the protected tail.
 *
 * The last rung. Pinned blocks are not history and survive untouched, which is why anything that must
 * always hold lives in slots 0–2 and never here. Firing this twice in one session is a
 * misconfiguration rather than a busy session, and the ladder says so.
 */
export function reset(input: StageInput & { readonly digest: string }): StageOutcome {
    const limit = tailStart(input)
    if (limit === 0) return unchanged(input)
    const messages = [digestMessage(input.digest), ...input.history.slice(limit)]
    const tokens = historyTokens(messages)
    if (tokens >= historyTokens(input.history)) return unchanged(input)
    return { messages, displaced: NO_DISPLACEMENTS, tokens, changed: true }
}
