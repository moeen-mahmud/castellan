/**
 * Local token estimation.
 *
 * Deliberately approximate and deliberately cheap. The real number comes from the API's
 * `prompt_tokens` on the previous call, which Phase 7 uses as a calibration anchor; this
 * estimator only has to be good enough between calls, and it must never be so slow that
 * assembling context costs more than sending it.
 *
 * ## The bias is not what this file claimed, and the direction matters
 *
 * This said "biased slightly high" for five phases, on the reasoning that over-estimating wastes a
 * little budget while under-estimating overflows the window. The intent is right; the fact was
 * unmeasured and is wrong for the prompts that actually get large.
 *
 * Measured (`evals/budget/results.json`, deepseek-v4-pro, 31 turns): on a prose-only opening the
 * estimate is close, and on an observation-heavy prompt it runs **16–20% low** — 14,057 estimated
 * against 16,835 charged. Tool observations are JSON documents and shell output, where braces,
 * quotes, colons and identifiers all split into more tokens per character than the 3.8 below assumes,
 * and a session under compaction pressure is mostly observations by definition. So the error is in
 * the overflow direction precisely when the window is tight.
 *
 * The divisor is deliberately **not** retuned to fix that. A single constant cannot be right for both
 * prose and JSON, and moving it would trade one silent bias for another while changing assembly
 * behaviour everywhere. The fix is `context/budget.ts`, which learns the real ratio from the
 * endpoint's own `prompt_tokens` and corrects it — measured at 14.21% mean error uncorrected against
 * 2.88% corrected. What remains exposed is the first call of a session, before any observation exists
 * to learn from; `assembleContext` still trims oldest-first there, and that is the honest floor.
 */

/** Average characters per token for English prose in Byte-Pair Encoding (BPE) vocabularies. */
const CHARS_PER_TOKEN = 3.8

export function estimateTokens(text: string): number {
    if (text === "") return 0

    // Newlines and punctuation runs tokenise worse than prose, so they are counted separately
    // rather than being averaged away by the character ratio.
    let newlines = 0
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) newlines += 1
    }

    return Math.ceil(text.length / CHARS_PER_TOKEN) + newlines
}

/** Per-message overhead the chat wire format adds: role, separators, framing. */
const MESSAGE_OVERHEAD_TOKENS = 4

export function estimateMessageTokens(content: string): number {
    return estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS
}
