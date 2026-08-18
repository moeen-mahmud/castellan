/**
 * The window over a buffer taller than itself.
 *
 * Worth its own file because every interesting property here is a property of *appending* — a window
 * that follows and a window that stays put look identical in a single frame and behave differently the
 * moment a row arrives.
 */

import { describe, expect, test } from "bun:test"
import { MIN_BODY_ROWS } from "#lib/const"
import { bodyRows, FOLLOWING, scroll, scrollHint, slice, topRow } from "#lib/scroll"

describe("following the newest row", () => {
    test("a fresh window sits at the bottom", () => {
        expect(topRow(FOLLOWING, 100, 10)).toBe(90)
    })

    test("appending moves the window with no state change", () => {
        // The property that makes streaming free: nothing about the scroll state changes as rows arrive,
        // so no re-render is caused by the scroll layer.
        expect(topRow(FOLLOWING, 100, 10)).toBe(90)
        expect(topRow(FOLLOWING, 140, 10)).toBe(130)
    })

    test("a buffer shorter than the window starts at zero", () => {
        expect(topRow(FOLLOWING, 4, 10)).toBe(0)
        expect(slice(FOLLOWING, 4, 10)).toEqual({ from: 0, to: 4, above: 0, below: 0 })
    })
})

describe("parking", () => {
    test("a page up leaves the tail and says how much is below", () => {
        const parked = scroll(FOLLOWING, "pageUp", 100, 10)
        expect(parked.pinned).toBe(false)
        const view = slice(parked, 100, 10)
        expect(view.from).toBe(81)
        expect(view.below).toBe(9)
    })

    test("a parked window does not move when rows are appended", () => {
        // The whole reason `pinned` is a flag rather than a comparison against the bottom. Derived, the
        // first appended row would make a deliberately parked window look like it was at the tail.
        const parked = scroll(FOLLOWING, "up", 100, 10)
        expect(topRow(parked, 100, 10)).toBe(89)
        expect(topRow(parked, 160, 10)).toBe(89)
    })

    test("scrolling back down to the bottom resumes following", () => {
        // Parking at the bottom would look identical and then quietly stop updating, which is the worst
        // available outcome: a session that appears live and is not.
        const parked = scroll(FOLLOWING, "up", 100, 10)
        expect(scroll(parked, "down", 100, 10)).toEqual(FOLLOWING)
    })

    test("overshooting the bottom re-pins rather than clamping past it", () => {
        const parked = scroll(FOLLOWING, "up", 100, 10)
        expect(scroll(parked, "pageDown", 100, 10)).toEqual(FOLLOWING)
    })

    test("it clamps at the top", () => {
        let view = FOLLOWING
        for (let at = 0; at < 50; at += 1) view = scroll(view, "pageUp", 100, 10)
        expect(topRow(view, 100, 10)).toBe(0)
        expect(slice(view, 100, 10).above).toBe(0)
    })

    test("top and bottom are one move each", () => {
        expect(topRow(scroll(FOLLOWING, "top", 100, 10), 100, 10)).toBe(0)
        expect(scroll({ offset: 0, pinned: false }, "bottom", 100, 10)).toEqual(FOLLOWING)
    })

    test("nothing to scroll means every move stays following", () => {
        for (const move of ["up", "down", "pageUp", "pageDown", "top"] as const) {
            expect(scroll(FOLLOWING, move, 5, 10)).toEqual(FOLLOWING)
        }
    })
})

describe("the counter line", () => {
    test("it is empty when the whole buffer fits", () => {
        expect(scrollHint(slice(FOLLOWING, 5, 10))).toBe("")
    })

    test("it names only what is hidden", () => {
        expect(scrollHint(slice(FOLLOWING, 100, 10))).toBe("  ↑ 90 rows above")
        const parked = scroll(FOLLOWING, "up", 100, 10)
        expect(scrollHint(slice(parked, 100, 10))).toContain("↓ 1 row below")
        expect(scrollHint(slice(parked, 100, 10))).toContain("esc returns")
    })

    test("it says row rather than rows for one", () => {
        expect(scrollHint(slice(FOLLOWING, 11, 10))).toBe("  ↑ 1 row above")
    })
})

describe("the body's share of the terminal", () => {
    test("a row is spent as a margin, in the direction that cannot be seen", () => {
        // One row short leaves a blank line; one row over makes the frame taller than the screen, which on
        // the alternate buffer scrolls the whole layout.
        expect(bodyRows(24, 10)).toBe(13)
    })

    test("it never returns nothing, however little is left", () => {
        expect(bodyRows(8, 20)).toBe(MIN_BODY_ROWS)
        expect(bodyRows(1, 0)).toBe(MIN_BODY_ROWS)
    })
})
