/**
 * Nearest-match suggestion, for error messages that name the fix.
 *
 * A suggestion has to be plausible or it makes the message worse: "unknown tool `gmial` — did you
 * mean `calendar_list`?" sends someone off to read the wrong docs. So the distance is capped
 * relative to the word's own length, and a poor best match yields nothing at all.
 */

function distance(a: string, b: string): number {
    // Two rows rather than a full matrix. The inputs here are identifiers, not documents.
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i]
        for (let j = 1; j <= b.length; j += 1) {
            const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
            const insertion = (current[j - 1] ?? 0) + 1
            const deletion = (previous[j] ?? 0) + 1
            current.push(Math.min(substitution, insertion, deletion))
        }
        previous = current
    }
    return previous[b.length] ?? Math.max(a.length, b.length)
}

/** The closest candidate, or `undefined` when nothing is close enough to be worth printing. */
export function nearest(word: string, candidates: readonly string[]): string | undefined {
    let best: string | undefined
    let bestScore = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
        const score = distance(word, candidate)
        if (score < bestScore) {
            bestScore = score
            best = candidate
        }
    }
    return best !== undefined && bestScore <= Math.max(2, Math.floor(word.length / 3))
        ? best
        : undefined
}
