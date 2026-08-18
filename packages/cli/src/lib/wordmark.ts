/**
 * The product name, drawn large, from a glyph grid.
 *
 * ## Why a grid and not a string
 *
 * Hard rule 3: no brand strings outside `brand.ts`, so that a rename is one commit. An ASCII wordmark is
 * a brand string — a literal one would be the single largest violation in the tree. So this renders
 * whatever `BRAND.name` happens to say, from a table of letters, and a rename changes nothing here.
 *
 * ## The research, and what it settled
 *
 * Three findings shaped this. **5×5 pixels is the floor** for a legible Latin glyph without
 * anti-aliasing, so that is the grid. **A width-aware fallback is mandatory rather than polish** — the
 * big figlet faces (`big`, `ansi-shadow`) pass 120 columns on a nine-letter word, and this CLI's floor is
 * 40. And **half-blocks are the density trick**: one character cell per pixel renders a 5×5 glyph tall and
 * thin, because a cell is roughly 1:2, while packing two pixel rows into one cell with `▀▄█` brings it
 * back to nearly square.
 *
 * A third-party font was the obvious shortcut and is not taken: embedding `.flf` data or another
 * project's bitmap into an Apache-2.0 repo buys a licence question, and 26 letters are verifiable by
 * rendering them.
 *
 * ## One table, four renderings
 *
 * The tiers are parameter changes over the same grid — how many columns a pixel occupies, and whether
 * rows are packed — not four codepaths:
 *
 * | tier | pixel | rows | nine letters |
 * | --- | --- | --- | --- |
 * | `wide`  | 2 columns | 5 | 106 columns |
 * | `block` | 1 column  | 5 |  53 columns |
 * | `half`  | 1 column  | 3 |  53 columns |
 * | `plain` | — | 1 | as wide as the name |
 *
 * `plain` is the floor and always fits, because it is the name with spaces in it and gets clipped like
 * any other line. A screen too small for that is a screen with no wordmark, which is a real answer.
 *
 * Pure: text and a size in, lines out. Colour is the component's business.
 */

import { clip } from "#lib/rows"

/** On and off, as authored. `#` reads as ink in the source, which is the only place these are edited. */
const ON = "#"

/**
 * A 5×5 grid per glyph, authored by hand and verified by rendering.
 *
 * Uppercase only: the input is upper-cased before lookup, because a display face has no lowercase at this
 * size, and inventing one is how a name and its shout become two different-looking products. Digits are
 * here for a version, and `.`/`-`/space for what a name might contain.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
    A: [".###.", "#...#", "#####", "#...#", "#...#"],
    B: ["####.", "#...#", "####.", "#...#", "####."],
    C: [".####", "#....", "#....", "#....", ".####"],
    D: ["####.", "#...#", "#...#", "#...#", "####."],
    E: ["#####", "#....", "####.", "#....", "#####"],
    F: ["#####", "#....", "####.", "#....", "#...."],
    G: [".####", "#....", "#..##", "#...#", ".###."],
    H: ["#...#", "#...#", "#####", "#...#", "#...#"],
    I: ["#####", "..#..", "..#..", "..#..", "#####"],
    J: ["..###", "....#", "....#", "#...#", ".###."],
    K: ["#...#", "#..#.", "###..", "#..#.", "#...#"],
    L: ["#....", "#....", "#....", "#....", "#####"],
    M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
    N: ["#...#", "##..#", "#.#.#", "#..##", "#...#"],
    O: [".###.", "#...#", "#...#", "#...#", ".###."],
    P: ["####.", "#...#", "####.", "#....", "#...."],
    Q: [".###.", "#...#", "#.#.#", "#..#.", ".##.#"],
    R: ["####.", "#...#", "####.", "#..#.", "#...#"],
    S: [".####", "#....", ".###.", "....#", "####."],
    T: ["#####", "..#..", "..#..", "..#..", "..#.."],
    U: ["#...#", "#...#", "#...#", "#...#", ".###."],
    V: ["#...#", "#...#", "#...#", ".#.#.", "..#.."],
    W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
    X: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
    Y: ["#...#", ".#.#.", "..#..", "..#..", "..#.."],
    Z: ["#####", "...#.", "..#..", ".#...", "#####"],
    "0": [".###.", "#..##", "#.#.#", "##..#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "..##.", ".#...", "#####"],
    "3": ["####.", "....#", ".###.", "....#", "####."],
    "4": ["#..#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "####."],
    "6": [".###.", "#....", "####.", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#..."],
    "8": [".###.", "#...#", ".###.", "#...#", ".###."],
    "9": [".###.", "#...#", ".####", "....#", ".###."],
    ".": [".....", ".....", ".....", ".....", "..#.."],
    "-": [".....", ".....", ".###.", ".....", "....."],
    " ": [".....", ".....", ".....", ".....", "....."],
}

const GLYPH_ROWS = 5
/** Blank pixel columns between letters. One is enough at this weight; two reads as word spacing. */
const TRACKING = 1

export type WordmarkTier = "wide" | "block" | "half" | "plain"

export interface Wordmark {
    readonly lines: readonly string[]
    readonly tier: WordmarkTier
    /** Code points in the widest line, so a caller can centre it without measuring. */
    readonly width: number
}

/** Letters this module can draw. A name containing anything else falls back to `plain`. */
export function drawable(text: string): boolean {
    return [...text.toUpperCase()].every((char) => GLYPHS[char] !== undefined)
}

/** The pixel grid for a whole word: rows of `#` and `.`, tracking included. */
function pixels(text: string): readonly string[] {
    const glyphs = [...text.toUpperCase()].map((char) => GLYPHS[char] ?? GLYPHS[" "])
    const gap = ".".repeat(TRACKING)
    return Array.from({ length: GLYPH_ROWS }, (_, row) =>
        glyphs.map((glyph) => glyph?.[row] ?? "").join(gap),
    )
}

/** Every pixel as `columns` cells of the fill character, or of space. */
function solid(grid: readonly string[], fill: string, columns: number): readonly string[] {
    const on = fill.repeat(columns)
    const off = " ".repeat(columns)
    return grid.map((row) => [...row].map((cell) => (cell === ON ? on : off)).join(""))
}

/**
 * Two pixel rows to a text row, using the half blocks.
 *
 * This is what makes the compact tier look like type rather than a stretched grid: five pixel rows become
 * three text rows, so a 5-wide glyph is 5×3 cells — near enough square once a cell's own 1:2 ratio is
 * accounted for.
 *
 * Five rows is odd, so one of them pairs with nothing, and **which end gets the blank decides the
 * weight**. Padding the bottom leaves every baseline as a thin `▀`, so the letters sit on a hairline and
 * read light. Padding the *top* puts the blank against the cap line instead: the top stroke becomes `▄`
 * and the baseline becomes a full `█`. Compared side by side that is not a close call — caps want to be
 * bottom-heavy — which is why the blank row is prepended rather than appended.
 */
function packed(grid: readonly string[]): readonly string[] {
    const padded = [".".repeat([...(grid[0] ?? "")].length), ...grid]
    const lines: string[] = []
    for (let row = 0; row < padded.length; row += 2) {
        const top = [...(padded[row] ?? "")]
        const bottom = [...(padded[row + 1] ?? "")]
        const cells: string[] = []
        for (let at = 0; at < Math.max(top.length, bottom.length); at += 1) {
            const up = top[at] === ON
            const down = bottom[at] === ON
            cells.push(up && down ? "█" : up ? "▀" : down ? "▄" : " ")
        }
        lines.push(cells.join(""))
    }
    return lines
}

/** The name with a space between every letter — the floor, and it always fits because it is clipped. */
function spaced(text: string, columns: number): readonly string[] {
    return [clip([...text.toUpperCase()].join(" "), columns)]
}

function widthOf(lines: readonly string[]): number {
    return lines.reduce((widest, line) => Math.max(widest, [...line].length), 0)
}

/**
 * The largest wordmark that fits, and how it was drawn.
 *
 * Degrades on both axes, because a splash is constrained by both: a 40-column terminal has no room for the
 * grid at any packing, and an 8-row one has no room for five rows of anything. Trailing blank space is
 * trimmed from each line so a caller centring on `width` centres the ink rather than the padding.
 */
export function wordmark(
    text: string,
    space: { readonly columns: number; readonly rows: number },
): Wordmark {
    const trimmed = text.trim()
    if (trimmed === "" || !drawable(trimmed)) {
        const lines = spaced(trimmed, space.columns)
        return { lines, tier: "plain", width: widthOf(lines) }
    }

    const grid = pixels(trimmed)
    const candidates: readonly { tier: WordmarkTier; lines: readonly string[] }[] = [
        { tier: "wide", lines: solid(grid, "█", 2) },
        { tier: "block", lines: solid(grid, "█", 1) },
        { tier: "half", lines: packed(grid) },
    ]

    for (const candidate of candidates) {
        const lines = candidate.lines.map((line) => line.replace(/\s+$/, ""))
        const width = widthOf(lines)
        if (width <= space.columns && lines.length <= space.rows) {
            return { lines, tier: candidate.tier, width }
        }
    }

    const lines = spaced(trimmed, space.columns)
    return { lines, tier: "plain", width: widthOf(lines) }
}
