/**
 * Local token estimation.
 *
 * Deliberately approximate and deliberately cheap. The real number comes from the API's
 * `prompt_tokens` on the previous call, which Phase 7 uses as a calibration anchor; this
 * estimator only has to be good enough between calls, and it must never be so slow that
 * assembling context costs more than sending it.
 *
 * Biased slightly high. Over-estimating wastes a little budget; under-estimating overflows the
 * window, and an overflow is a hard failure while waste is a rounding error.
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
