/**
 * Wheel scrolling on the alternate screen. Pure, so a mouse report is arithmetic rather than a guess.
 *
 * ## Why this needs a guard rather than only a parser
 *
 * Ink does not know about mouse reports. Measured against a real pty with tracking on: a wheel notch
 * arrived as the literal text `ESC[<64;10;5M`, fell through the keymap to the insert branch, and was typed
 * into the message — twice, because two notches are two reports. So recognising a report is not an
 * optimisation here; every report a terminal can send has to be claimed, wheel and click alike, or the
 * feature's cost is garbage in somebody's message.
 *
 * A chunk can carry several reports. A fast scroll sends one per notch and the runtime coalesces them, so
 * the count matters: honouring one report per chunk makes a flick of the wheel move a single row and reads
 * as the wheel not working.
 *
 * ## The trade this makes, stated
 *
 * Tracking is what stops the terminal handling the mouse itself, so **drag-selecting text with the mouse
 * stops working while a session is mounted**. Every terminal worth naming lets you hold shift to bypass
 * tracking and select natively, which is why the key list says so rather than leaving it to be discovered.
 *
 * Two encodings are recognised. SGR (`ESC [ < b ; x ; y M`) is what we ask for and what any terminal from
 * the last decade replies with; X10 (`ESC [ M` and three raw bytes) is the fallback a terminal that ignored
 * the SGR request will use, and its bytes are frequently above 127 — so leaving it unclaimed would put
 * unprintable characters into a message on exactly the terminals least able to say why.
 */

/** Button-press tracking plus SGR encoding. 1000 is the least that reports the wheel at all. */
export const ENABLE_MOUSE = "\u001B[?1000h\u001B[?1006h"
/** Reversed on the way out, so a terminal is left handling its own mouse again. */
export const DISABLE_MOUSE = "\u001B[?1006l\u001B[?1000l"

/**
 * Rows one notch of the wheel moves.
 *
 * Three, which is the line-scroll every desktop uses. One row per notch is technically a scroll and feels
 * like the wheel is broken; a whole page per notch overshoots what somebody is looking for.
 */
export const WHEEL_ROWS = 3

/** Wheel-up and wheel-down in SGR's button numbering. 64 is the wheel bit plus button 0. */
const WHEEL_UP = 64
const WHEEL_DOWN = 65

/**
 * The escape prefix is **optional**, and that is not laxness.
 *
 * Ink strips one leading `ESC` from the chunk before a handler sees it (`use-input.js:97`), so the first
 * report in a chunk arrives bare and every one after it keeps its escape. Requiring the prefix therefore
 * matched none of them, which is exactly how the first version of this let a wheel notch through: measured
 * against a real pty, the composer read `abc[<64;10;5M[<64;10;5M`.
 *
 * Anchored rather than left floating: a bare report is only recognised at the very start of the chunk,
 * which is the one position Ink's stripping can produce. A message that happens to contain the same text
 * in the middle of a sentence is still a message.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the thing being matched
const SGR = /(?:^|\u001B)\[<(\d+);\d+;\d+[Mm]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the thing being matched
const X10 = /(?:^|\u001B)\[M[\s\S]{3}/g

export interface MouseInput {
    /**
     * Rows to move: negative up, positive down, zero for a report that is not the wheel.
     *
     * Zero is *not* "no report" — a click is a report with no scroll in it, and it still has to be
     * swallowed. The `undefined` return is what means "no report".
     */
    readonly rows: number
}

/**
 * What a chunk of input means to the mouse, or `undefined` if it holds no mouse report at all.
 *
 * Returning `undefined` rather than a zero is what keeps a keystroke a keystroke: every other branch of
 * the keymap runs only when this says nothing.
 */
export function mouseInput(input: string): MouseInput | undefined {
    // Cheap prefilter. Every report contains one of these two, and almost no keystroke does.
    if (!input.includes("[<") && !input.includes("[M")) return undefined
    let rows = 0
    let seen = false
    for (const match of input.matchAll(SGR)) {
        seen = true
        const button = Number(match[1])
        if (button === WHEEL_UP) rows -= WHEEL_ROWS
        else if (button === WHEEL_DOWN) rows += WHEEL_ROWS
    }
    for (const match of input.matchAll(X10)) {
        seen = true
        // X10 offsets every field by 32, so the wheel's 64 and 65 arrive as 96 and 97.
        // Three fields follow `[M`, and the escape before it is optional — so the button is found
        // from the end of the match rather than at a fixed offset.
        const button = (match[0].codePointAt(match[0].length - 3) ?? 32) - 32
        if (button === WHEEL_UP) rows -= WHEEL_ROWS
        else if (button === WHEEL_DOWN) rows += WHEEL_ROWS
    }
    return seen ? { rows } : undefined
}
