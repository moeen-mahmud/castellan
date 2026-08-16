/**
 * Splitting a reply into provider-sized chunks.
 *
 * In core rather than in each channel because chunk boundaries are half of delivery ordering: the
 * outbox keys a row on `chunk_index`, and two channels that disagreed about how many chunks a reply
 * has would disagree about what "already delivered" means. Each channel contributes exactly one
 * number, `ChannelLimits.maxMessageChars`.
 *
 * Three things this must not do, each of which has a visible failure mode:
 *
 * - **Cut mid-grapheme.** `String.prototype.length` counts UTF-16 code units, so a naive slice at
 *   4096 can land between the halves of an emoji's surrogate pair, or between a base character and
 *   its combining mark. The provider receives a lone surrogate and either rejects the message or
 *   renders `�`. `Intl.Segmenter` decides where a character actually ends.
 * - **Cut mid-word when a nearby boundary exists.** A break at a paragraph reads as a pause; a break
 *   inside a word reads as a bug.
 * - **Leave a code fence open.** A chunk ending inside a ``` block renders the rest of that chunk as
 *   prose and the *next* chunk as code, so the split corrupts formatting in both directions. The
 *   fence is closed and reopened.
 *
 * That last one inserts text the author did not write, which is worth being explicit about next to
 * decision 4.19 (*the renderer never rewrites a sentence*). The distinction is the same one that
 * licenses `VOLATILE_HEADER`: this changes delimiters and structure so the authored bytes survive
 * transport intact. Not one character of prose is altered, added, or reordered.
 */

/**
 * How far back a boundary search may reach before giving up and cutting hard.
 *
 * Without a floor, a 4096-char chunk containing one very long unbroken token would scan all the way
 * to the start and emit a 40-character chunk followed by a full one — technically well-broken and
 * visibly wrong. 60% keeps chunks recognisably full.
 */
const MIN_FILL = 0.6

/** Only the tail of a candidate chunk needs grapheme analysis, and segmenting 4096 chars would not. */
const GRAPHEME_WINDOW = 32

/** ```lang on its own line. Indented up to three spaces, per CommonMark. */
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/

/** Closing and reopening costs "\n```" and "```\n". Reserved so a fenced chunk still fits. */
const FENCE_RESERVE = 8

export interface SplitOptions {
    /** Hard cap per chunk, in UTF-16 code units — the unit providers count in. */
    readonly maxChars: number
    /**
     * Whether to keep code fences balanced across a boundary.
     *
     * Off for a channel that does not render markdown, where the extra backticks would be literal
     * text a reader sees. The channel knows; core does not guess.
     */
    readonly fenceAware?: boolean
}

/**
 * Split `text` into chunks of at most `maxChars`, preferring natural boundaries.
 *
 * Returns `[""]`, not `[]`, for empty input. A caller with nothing to say should not reach here at
 * all — but an empty array would make "how many chunks does this reply have" answer zero, and a
 * delivery of zero chunks is indistinguishable from a delivery that never happened.
 */
export function splitMessage(text: string, options: SplitOptions): readonly string[] {
    const max = Math.max(1, Math.floor(options.maxChars))
    if (text.length <= max) return [text]

    const fenceAware = options.fenceAware ?? false
    const budget = fenceAware ? Math.max(1, max - FENCE_RESERVE) : max

    const chunks: string[] = []
    let cursor = 0
    let openFence: boolean = false

    while (cursor < text.length) {
        const prefix = openFence ? "```\n" : ""
        const room = budget - prefix.length
        const remaining = text.length - cursor

        if (remaining <= room) {
            const rest = text.slice(cursor)
            // Recomputed over the tail rather than reusing `openFence`, which is the state at the
            // *start* of this chunk. A tail carrying the author's own closing fence needs no
            // synthetic one, and adding a second opened a fence around everything after it.
            const stillOpen = fenceAware && togglesFence(rest, openFence)
            const tail = prefix + rest
            chunks.push(stillOpen ? closeFence(tail) : tail)
            break
        }

        const cut = breakPoint(text, cursor, cursor + room)
        const body = text.slice(cursor, cut)
        cursor = cut

        // Whether the *content* leaves a fence open is a property of the authored text, so it is
        // computed before the synthetic reopen is added and after any synthetic close is not.
        const nowOpen: boolean = fenceAware ? togglesFence(body, openFence) : false
        const piece = prefix + body
        chunks.push(nowOpen ? closeFence(piece) : piece)
        openFence = nowOpen

        // A boundary search that landed on whitespace leaves it at the head of the next chunk,
        // where it would render as a leading blank line.
        while (cursor < text.length && isBreakable(text.charCodeAt(cursor))) cursor += 1
    }

    return chunks
}

function closeFence(piece: string): string {
    return piece.endsWith("\n") ? `${piece}\`\`\`` : `${piece}\n\`\`\``
}

/**
 * Whether `body` leaves a fence open, given whether one was already open.
 *
 * Counts fence *lines* rather than occurrences of three backticks: an inline `` ```code``` `` span
 * is not a fence, and counting it as one inverts the state for the rest of the message.
 */
function togglesFence(body: string, wasOpen: boolean): boolean {
    let open = wasOpen
    for (const line of body.split("\n")) {
        if (FENCE_LINE.test(line)) open = !open
    }
    return open
}

/**
 * The best cut position in `[start, limit)`, searching backwards from `limit`.
 *
 * Preference order is paragraph, then line, then any whitespace, then a grapheme boundary. The
 * first three are about readability; the fourth is about not emitting invalid UTF-16.
 */
function breakPoint(text: string, start: number, limit: number): number {
    const floor = start + Math.floor((limit - start) * MIN_FILL)

    const paragraph = text.lastIndexOf("\n\n", limit - 1)
    if (paragraph >= floor) return paragraph

    const line = text.lastIndexOf("\n", limit - 1)
    if (line >= floor) return line

    for (let i = limit - 1; i >= floor; i -= 1) {
        if (isBreakable(text.charCodeAt(i))) return i
    }

    return graphemeFloor(text, start, limit)
}

/** Space, tab, and the Unicode separators a provider will happily collapse. */
function isBreakable(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x00a0
}

/**
 * The largest position `<= limit` that does not fall inside a grapheme cluster.
 *
 * Only the last few code units can possibly be affected, so a short tail is segmented rather than
 * the whole chunk. Falls back to a surrogate-pair check where `Intl.Segmenter` is unavailable —
 * both shipped runtimes have it, but a fallback that emits valid UTF-16 costs three lines and
 * removes an assumption about the host.
 */
function graphemeFloor(text: string, start: number, limit: number): number {
    const windowStart = Math.max(start, limit - GRAPHEME_WINDOW)
    const segmenter = graphemeSegmenter()

    if (segmenter === undefined) {
        const previous = text.charCodeAt(limit - 1)
        const next = text.charCodeAt(limit)
        const splitsPair =
            previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
        return splitsPair ? limit - 1 : limit
    }

    let best = windowStart
    for (const segment of segmenter.segment(text.slice(windowStart, limit + GRAPHEME_WINDOW))) {
        const position = windowStart + segment.index
        if (position > limit) break
        best = position
    }

    // A single grapheme longer than the search window — a long ZWJ emoji sequence against a tiny
    // `maxChars`. Cutting inside it is wrong and refusing to advance would loop forever, so the
    // hard limit wins and the caller gets a chunk that is at least well-formed at the code-unit level.
    return best <= windowStart ? limit : best
}

let cachedSegmenter: Intl.Segmenter | undefined | null = null

function graphemeSegmenter(): Intl.Segmenter | undefined {
    if (cachedSegmenter !== null) return cachedSegmenter
    cachedSegmenter =
        typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
            ? new Intl.Segmenter("en", { granularity: "grapheme" })
            : undefined
    return cachedSegmenter
}
