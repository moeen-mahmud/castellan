/**
 * A synthetic session that changes composition as it grows.
 *
 * The question this fixture exists to answer is not "how wrong is the estimator" — that is a fact
 * about a tokeniser and varies per endpoint — but **how fast its error drifts within one
 * conversation**, because that is what sets the smoothing weight in `context/budget.ts`.
 *
 * So the shape matters more than the words. A real session does not stay prose: it opens
 * conversationally and fills up with tool observations — JSON documents, shell output, file
 * listings — which tokenise far worse than the 3.8 characters-per-token constant assumes. Punctuation
 * runs, braces, quotes and identifiers all split into more tokens per character than English does. If
 * the estimator's bias drifts over a session, this is the mechanism, and these turns reproduce it:
 * prose early, observation-heavy later, in the proportion a working agent actually produces.
 *
 * **Sized for the regime that matters.** The first run of this eval was small — prompts of 50 to 120
 * tokens — and at that size the endpoint's fixed overhead (chat template, per-message framing) is
 * about +60 tokens and swamps everything else: the ratio reads 2.37 where the same offset at 5,000
 * tokens reads 1.01. A weight tuned there would be tuned on an artefact. The observations are
 * therefore large enough that the session reaches thousands of tokens, which is where a compaction
 * threshold is crossed and where the multiplicative part of the error is the part that matters.
 *
 * The content is deliberately mundane and self-contained. Nothing here is a prompt under test — the
 * model's reply is discarded and only `prompt_tokens` is read — so nothing depends on the model
 * understanding any of it.
 */

export interface SessionTurn {
    /**
     * The *kind* of turn, not a wire role. An observation reaches the endpoint as a `user` message,
     * because that is what `nlt.ts:738` sends — under a text dialect a tool result is simply text
     * arriving in the conversation. Recording it as `tool` here would both misdescribe the prompt and
     * be rejected outright, since an OpenAI-compatible `tool` message must answer a preceding
     * `tool_calls`.
     */
    readonly kind: "user" | "assistant" | "observation"
    readonly content: string
}

/** A JSON observation of the kind a provider-resolved tool returns. */
function jsonObservation(index: number): string {
    return JSON.stringify(
        {
            ok: true,
            requestId: `req_${index}0f4c8a2b`,
            items: Array.from({ length: 14 }, (_, i) => ({
                id: `itm_${index}${i}`,
                subject: `Re: quarterly numbers (${i + 1})`,
                from: { name: "A. Reviewer", address: `reviewer${i}@example.com` },
                receivedAt: `2026-02-1${i}T09:${index}0:00Z`,
                labels: ["inbox", "important"],
                unread: i % 2 === 0,
            })),
            nextCursor: `cur_${index}zzq`,
        },
        null,
        2,
    )
}

/** Shell output, the other common observation shape: dense, aligned, punctuation-heavy. */
function shellObservation(index: number): string {
    const rows = Array.from(
        { length: 40 },
        (_, i) =>
            `-rw-r--r--  1 user  staff   ${1000 + index * 97 + i * 13}  2 Feb 09:${10 + i}  packages/core/src/module-${index}-${i}.ts`,
    )
    return `$ ls -l packages/core/src\n${rows.join("\n")}\nexit 0`
}

/**
 * Oldest first, the order `assembleContext` expects.
 *
 * Built rather than written out: twenty-four turns of hand-authored filler would be the same content
 * with more places to be inconsistent, and the *proportions* are the fixture — six prose exchanges,
 * then observation-heavy work, which is the arc of a session that starts with a question and ends in
 * a task.
 */
export const SESSION_TURNS: readonly SessionTurn[] = [
    { kind: "user", content: "Morning — can you give me a hand with the release notes today?" },
    {
        kind: "assistant",
        content:
            "Of course. I can draft them from the commit range once you tell me which two tags to compare, and I will keep each entry to one line with the change first and the reason second.",
    },
    { kind: "user", content: "Compare v0.4.2 with v0.5.0. Keep it short." },
    {
        kind: "assistant",
        content:
            "That range has thirty-one commits. Before I summarise them, are you expecting the notes to name contributors, or just the changes?",
    },
    { kind: "user", content: "Just the changes. Contributors go in the footer." },
    {
        kind: "assistant",
        content:
            "Understood. I will group them under Added, Changed and Fixed, and put a single footer line pointing at the contributor list rather than naming anyone inline.",
    },
    ...Array.from({ length: 12 }, (_, index) => [
        {
            kind: "assistant" as const,
            content: `Fetching the ${index % 2 === 0 ? "message batch" : "directory listing"} for section ${index + 1}.`,
        },
        {
            kind: "observation" as const,
            content: index % 2 === 0 ? jsonObservation(index) : shellObservation(index),
        },
    ]).flat(),
    { kind: "user", content: "Good. Now write the Fixed section and stop there." },
]
