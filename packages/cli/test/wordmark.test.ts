/**
 * The product name, drawn large, from a glyph grid.
 *
 * The reason it is a grid rather than a string is hard rule 3: an ASCII wordmark is a brand string, and a
 * literal one would be the largest violation in the tree. So the property that matters most here is that
 * *any* name renders — a rename has to stay one commit.
 */

import { drawable, wordmark } from "#lib/wordmark"
import { describe, expect, test } from "bun:test"

const ROOMY = { columns: 140, rows: 20 }

function widest(lines: readonly string[]): number {
    return lines.reduce((most, line) => Math.max(most, [...line].length), 0)
}

describe("the glyph table", () => {
    test("every letter, digit and the punctuation a name might carry is drawable", () => {
        expect(drawable("abcdefghijklmnopqrstuvwxyz")).toBe(true)
        expect(drawable("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe(true)
        expect(drawable("0123456789")).toBe(true)
        expect(drawable("a-b.c d")).toBe(true)
    })

    test("a name with a character it cannot draw falls back rather than dropping it", () => {
        // Silently rendering a blank where a letter was would misspell the product.
        expect(drawable("naïve")).toBe(false)
        expect(wordmark("naïve", ROOMY).tier).toBe("plain")
        expect(wordmark("naïve", ROOMY).lines[0]).toContain("Ï")
    })

    test("every glyph is five rows and five columns", () => {
        // The floor for a legible Latin glyph without anti-aliasing, and the assumption the packing and
        // the tracking both rest on.
        for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
            const mark = wordmark(char, ROOMY)
            expect(mark.tier).toBe("wide")
            expect(mark.lines.length).toBe(5)
            expect(widest(mark.lines)).toBeLessThanOrEqual(10)
        }
    })

    test("no two letters are drawn identically", () => {
        // A pixel font at this size is easy to author with a collision, and two letters that render the
        // same misspell the name in a way nobody reads as a bug.
        const drawn = new Map<string, string>()
        for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
            const key = wordmark(char, ROOMY).lines.join("|")
            expect(drawn.has(key)).toBe(false)
            drawn.set(key, char)
        }
    })
})

describe("the tiers", () => {
    const NAME = "Castle"

    test("the biggest one that fits is chosen, by measuring", () => {
        expect(wordmark(NAME, { columns: 140, rows: 20 }).tier).toBe("wide")
        expect(wordmark(NAME, { columns: 50, rows: 20 }).tier).toBe("block")
        expect(wordmark(NAME, { columns: 50, rows: 4 }).tier).toBe("half")
        expect(wordmark(NAME, { columns: 20, rows: 20 }).tier).toBe("plain")
    })

    test("it degrades on height as well as width", () => {
        // A splash is constrained by both: an eight-row terminal has no room for five rows of anything.
        expect(wordmark(NAME, { columns: 140, rows: 4 }).tier).toBe("half")
        expect(wordmark(NAME, { columns: 140, rows: 2 }).tier).toBe("plain")
    })

    test("nothing ever exceeds the space it was given", () => {
        for (const columns of [20, 40, 53, 60, 80, 100, 140]) {
            for (const rows of [1, 3, 5, 20]) {
                const mark = wordmark("dispach", { columns, rows })
                expect(mark.lines.length).toBeLessThanOrEqual(rows)
                expect(widest(mark.lines)).toBeLessThanOrEqual(columns)
                expect(mark.width).toBe(widest(mark.lines))
            }
        }
    })

    test("the compact tier is bottom-heavy, because caps are", () => {
        // Five pixel rows is odd, so one pairs with nothing and which end gets the blank decides the
        // weight. Padding the bottom leaves every baseline a thin `▀`; padding the top makes it a full `█`.
        const mark = wordmark("L", { columns: 50, rows: 3 })
        expect(mark.tier).toBe("half")
        expect(mark.lines.at(-1)).toContain("█")
        expect(mark.lines[0]).toContain("▄")
    })

    test("trailing space is trimmed, so centring on the width centres the ink", () => {
        const mark = wordmark("dispach", ROOMY)
        for (const line of mark.lines) expect(line).toBe(line.replace(/\s+$/, ""))
    })

    test("an empty name draws nothing rather than throwing", () => {
        expect(wordmark("   ", ROOMY)).toEqual({ lines: [""], tier: "plain", width: 0 })
    })

    test("a rename is one commit — any name renders", () => {
        for (const name of ["Kit", "Hermes", "Warden", "A", "dispach", "some-agent.2"]) {
            const mark = wordmark(name, ROOMY)
            expect(mark.lines.length).toBeGreaterThan(0)
            expect(mark.width).toBeGreaterThan(0)
        }
    })
})
