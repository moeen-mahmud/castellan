/**
 * Where a window sits in a buffer taller than itself. Pure, so scrolling is testable as arithmetic.
 *
 * ## Why the transcript needs this at all
 *
 * Until Phase 5.5 the finished conversation lived in Ink's `<Static>`, which writes a node to the
 * terminal once and never touches it again — so scrolling was the *terminal's* scrollback and cost
 * this code nothing. The alternate screen removes that: the buffer it swaps in is discarded on the
 * way out and its scrollbar reaches nothing, so a screen that owns the terminal has to own scrolling
 * too. `<Static>` and the alternate screen are not two options; they are incompatible.
 *
 * ## `pinned` is a flag, not a comparison
 *
 * The property that matters is "new output follows the tail only when the reader is already at the
 * tail". Deriving that by comparing the offset to the bottom looks equivalent and is not: the moment
 * a row is appended the old offset *is* one short of the bottom, so a reader who had deliberately
 * scrolled up one row would be yanked back down. Holding the intent explicitly makes the two states
 * different things — following, or parked — and a parked window stays parked however much arrives.
 *
 * While pinned the offset is *derived* rather than stored, which is what makes appending free: no
 * state changes when a row arrives, so nothing re-renders because of the scroll layer.
 */

import { MIN_BODY_ROWS } from "#lib/const"
import type { ScrollMove } from "#lib/types"

export interface ScrollState {
    /** First visible row while parked. Ignored while `pinned`, and kept so unpinning is reversible. */
    readonly offset: number
    /** Following the newest row. The state a session starts and returns to. */
    readonly pinned: boolean
}

/** Where a conversation starts, and where `bottom` puts it back. */
export const FOLLOWING: ScrollState = { offset: 0, pinned: true }

/** The furthest down a window may start: the last full screen of the buffer. */
function floorOf(total: number, window: number): number {
    return Math.max(0, total - window)
}

/** The first visible row, resolved. One derivation, so no caller repeats the pinned case. */
export function topRow(state: ScrollState, total: number, window: number): number {
    const bottom = floorOf(total, window)
    return state.pinned ? bottom : Math.max(0, Math.min(state.offset, bottom))
}

export function scroll(
    state: ScrollState,
    move: ScrollMove,
    total: number,
    window: number,
): ScrollState {
    if (move === "bottom") return FOLLOWING
    const bottom = floorOf(total, window)
    // A buffer shorter than the window has nowhere to go, so every move is already at the bottom.
    // Returning `FOLLOWING` rather than `{offset: 0, pinned: false}` matters: parked-at-zero would
    // stop following as soon as the conversation grew past one screen, with nothing having asked it to.
    if (bottom === 0) return FOLLOWING
    if (move === "top") return { offset: 0, pinned: false }

    const step = move === "pageUp" || move === "pageDown" ? Math.max(1, window - 1) : 1
    const delta = move === "down" || move === "pageDown" ? step : -step
    const next = topRow(state, total, window) + delta
    // Reaching the bottom re-pins rather than parking there, so scrolling back down to the newest row
    // resumes following. Parking at the bottom would look identical and then quietly stop updating.
    if (next >= bottom) return FOLLOWING
    return { offset: Math.max(0, next), pinned: false }
}

export interface Slice {
    readonly from: number
    readonly to: number
    readonly above: number
    readonly below: number
}

/** Which rows to draw, and how many are out of sight on each side. */
export function slice(state: ScrollState, total: number, window: number): Slice {
    if (window <= 0) return { from: 0, to: 0, above: total, below: 0 }
    const from = topRow(state, total, window)
    const to = Math.min(total, from + window)
    return { from, to, above: from, below: total - to }
}

/**
 * Rows a body may use, given the terminal's height and what the chrome around it takes.
 *
 * Biased low on purpose: one row short of the terminal leaves a blank line, and one row over makes the
 * frame taller than the screen — which on the alternate buffer scrolls the whole layout and leaves the
 * status line halfway up the display. An underestimate is invisible and an overestimate is corruption,
 * so the safety row is spent in the direction that cannot be seen.
 */
export function bodyRows(terminalRows: number, chrome: number): number {
    return Math.max(MIN_BODY_ROWS, terminalRows - chrome - 1)
}

/**
 * One line saying what is out of sight, or the empty string when nothing is.
 *
 * **Always rendered, blank included.** A counter that appears only when it has something to say takes a
 * row from the window on the frame it appears, which pushes the last row of the conversation under the
 * composer at exactly the moment somebody scrolls — so the fix for a jumping layout would be triggered
 * by scrolling, which is when it is least welcome. One row, reserved, forever: an empty line costs
 * nothing to look at and the geometry never moves.
 *
 * Both directions on one line for the same reason. Two conditional rows is two things that can move.
 */
export function scrollHint(view: Slice): string {
    const parts: string[] = []
    if (view.above > 0) parts.push(`\u2191 ${view.above} row${view.above === 1 ? "" : "s"} above`)
    if (view.below > 0) {
        parts.push(`\u2193 ${view.below} row${view.below === 1 ? "" : "s"} below`, "esc returns")
    }
    return parts.length === 0 ? "" : `  ${parts.join(" \u00b7 ")}`
}
