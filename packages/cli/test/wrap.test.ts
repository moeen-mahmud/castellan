import { describe, expect, test } from "bun:test"
import { tailRows, totalRows, visualRows } from "#lib/wrap"

describe("visualRows", () => {
    test("a short line is one row", () => {
        expect(visualRows("hello", 80)).toBe(1)
    })

    test("an empty line still occupies a row", () => {
        expect(visualRows("", 80)).toBe(1)
    })

    test("a line exactly the terminal width is one row", () => {
        expect(visualRows("x".repeat(80), 80)).toBe(1)
    })

    test("one character over wraps to two", () => {
        expect(visualRows("x".repeat(81), 80)).toBe(2)
    })

    test("a long paragraph is counted in rows, not as one line", () => {
        // The whole reason this module exists: 400 characters is five rows at 80 columns, and
        // treating it as one row lets the live pane grow without limit.
        expect(visualRows("x".repeat(400), 80)).toBe(5)
    })

    test("a zero-width terminal does not divide by zero", () => {
        // Measured: a pty under `script -q` reports columns === 0.
        expect(visualRows("anything", 0)).toBe(1)
    })

    test("tabs cost more than one column", () => {
        expect(visualRows("\t\t", 8)).toBe(2)
    })
})

describe("totalRows", () => {
    test("sums the rows of every line", () => {
        expect(totalRows("one\ntwo\nthree", 80)).toBe(3)
    })

    test("counts wrapping within lines", () => {
        expect(totalRows(`short\n${"x".repeat(160)}`, 80)).toBe(3)
    })

    test("trailing newlines are real rows", () => {
        expect(totalRows("a\n\n", 80)).toBe(3)
    })
})

describe("tailRows", () => {
    test("text that already fits comes back unchanged", () => {
        expect(tailRows("a\nb", 80, 10)).toBe("a\nb")
    })

    test("keeps the newest rows", () => {
        expect(tailRows("1\n2\n3\n4\n5", 80, 2)).toBe("4\n5")
    })

    test("cuts at line boundaries, never mid-line", () => {
        // A half-line at the top of the pane reads as corruption; a missing line reads as
        // scrolling, which is what it is.
        const text = `${"a".repeat(160)}\nshort`
        expect(tailRows(text, 80, 2)).toBe("short")
    })

    test("a single line longer than the whole budget shows its tail", () => {
        // Otherwise the pane would be empty during exactly the reply that is filling it, which
        // looks like a hang.
        const result = tailRows(`${"x".repeat(500)}END`, 80, 2)
        expect(result.endsWith("END")).toBe(true)
        expect(result.length).toBeLessThan(500)
    })

    test("a zero budget yields nothing rather than throwing", () => {
        expect(tailRows("anything", 80, 0)).toBe("")
    })

    test("an empty string is unchanged", () => {
        expect(tailRows("", 80, 5)).toBe("")
    })
})
