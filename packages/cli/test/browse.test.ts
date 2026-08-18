/**
 * The browse list and the multi-select, both pure: rows in, rows out, no Ink and no network.
 *
 * The component is a thin renderer over these — `SkillBrowser` holds one `useInput` and no rules — so
 * asserting here covers the behaviour that would otherwise need a mounted terminal. What is deliberately
 * *not* covered is the rendering itself, which is why `--plain` reads the same `browseRows` the component
 * does rather than formatting its own list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "@castellan/core"
import { browseRows, chosenEntries, curatedEntries, selectableOf, summarise } from "#lib/browse"
import { CURATED_COMMUNITY, CURATED_COMMUNITY_SKILLS, curatedGroupOf } from "#lib/curated"
import { firstSelectable, reduceMultiSelect, startMultiSelect } from "#lib/multiselect"
import { columnsFor, compactTokens, layoutRow, metaOf } from "#lib/rows"
import type { CatalogueEntry } from "#lib/source-cache"
import type { SourceSpec } from "#lib/sources"
import { type InstallOutcome, skillsCommand } from "#skills"

function entry(source: string, skill: string, over: Partial<CatalogueEntry> = {}): CatalogueEntry {
    return {
        source,
        skill,
        dir: `/cache/${source}/skills/${skill}`,
        repoPath: `skills/${skill}`,
        description: `Does ${skill} things. Use when asked.`,
        tokens: 500,
        scripts: [],
        ...over,
    }
}

const dirs: string[] = []
let written = ""
let restore: (() => void) | undefined

beforeEach(() => {
    written = ""
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
        written += String(chunk)
        return true
    }) as typeof process.stdout.write
    restore = () => {
        process.stdout.write = original
    }
})

afterEach(() => {
    restore?.()
    restore = undefined
    while (dirs.length > 0) {
        const dir = dirs.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

const ANTHROPIC: SourceSpec = { name: "anthropic", url: "u", path: "skills" }
const GITHUB: SourceSpec = { name: "github", url: "u", path: "skills", curated: ["prd", "napkin"] }

describe("curation filters browsing and nothing else", () => {
    test("a source with no allowlist shows everything", () => {
        const entries = [entry("anthropic", "pdf"), entry("anthropic", "docx")]
        expect(curatedEntries(ANTHROPIC, entries).length).toBe(2)
    })

    test("an allowlist keeps only what it names", () => {
        const entries = [entry("github", "prd"), entry("github", "azure-role-selector")]
        expect(curatedEntries(GITHUB, entries).map((e) => e.skill)).toEqual(["prd"])
    })

    test("a skill that will not load is never offered", () => {
        // It is listed by `sources search` with its problem, because that answers "is this here". A browse
        // list is a list of things to install, and an unloadable folder is not one.
        const entries = [
            entry("anthropic", "pdf"),
            entry("anthropic", "broken", { problem: "bad" }),
        ]
        expect(curatedEntries(ANTHROPIC, entries).map((e) => e.skill)).toEqual(["pdf"])
    })
})

describe("the rows", () => {
    const inputs = [
        { spec: ANTHROPIC, entries: [entry("anthropic", "pdf"), entry("anthropic", "docx")] },
        { spec: GITHUB, entries: [entry("github", "prd"), entry("github", "napkin")] },
    ]

    test("each source gets a heading with its count", () => {
        const rows = browseRows(inputs)
        expect(rows[0]?.kind).toBe("source")
        expect(rows[0]?.label).toBe("anthropic  2 skills")
    })

    test("a curated source is grouped and an uncurated one is flat", () => {
        const rows = browseRows(inputs)
        const headings = rows.filter((row) => row.kind !== "item").map((row) => row.label.trim())
        // `prd` and `napkin` sit in different curated groups; anthropic gets no invented categories.
        expect(headings).toEqual([
            "anthropic  2 skills",
            "github  2 skills",
            "Specs and planning",
            "Diagrams",
        ])
    })

    test("headings are not selectable and the cursor starts past the first one", () => {
        const rows = browseRows(inputs)
        const selectable = selectableOf(rows)
        expect(selectable[0]).toBe(false)
        expect(firstSelectable(selectable)).toBe(1)
    })

    test("a row says what it costs and whether it ships code", () => {
        const rows = browseRows([
            {
                spec: ANTHROPIC,
                entries: [entry("anthropic", "pdf", { tokens: 2284, scripts: ["a.py", "b.py"] })],
            },
        ])
        // Its own column, not appended to the label: a concatenated hint is what wrapped.
        expect(rows[1]?.meta).toBe("2.3k · 2 scripts")
    })

    test("an already-installed skill is marked, not hidden", () => {
        // A list whose contents change with the agent you picked is one nobody can learn.
        const rows = browseRows([
            { spec: ANTHROPIC, entries: [entry("anthropic", "pdf")], installed: ["pdf"] },
        ])
        expect(rows[1]?.meta).toBe("installed")
    })

    test("a source whose catalogue is empty contributes no heading", () => {
        expect(browseRows([{ spec: ANTHROPIC, entries: [] }])).toEqual([])
    })

    test("chosen indices map back to skills in screen order", () => {
        const rows = browseRows(inputs)
        const items = rows.flatMap((row, index) => (row.entry === undefined ? [] : [index]))
        const picked = chosenEntries(
            rows,
            [items[1] as number, items[0] as number].sort((a, b) => a - b),
        )
        expect(picked.map((e) => e.skill)).toEqual(["pdf", "docx"])
    })
})

describe("a description becomes one line", () => {
    test("the first sentence survives, the rest does not", () => {
        expect(summarise("Does a thing. Then more detail nobody needs on a row.")).toBe(
            "Does a thing.",
        )
    })

    test("newlines collapse, so a folded YAML description stays one row", () => {
        expect(summarise("Does\n  a\n  thing. More.")).toBe("Does a thing.")
    })

    test("it does not cap the length — the column does", () => {
        // Capping in both places truncated twice: once at 96 characters and again at whatever the terminal
        // had left, which shows a short description with an ellipsis and empty space after it.
        const long = `${"word ".repeat(40)}end.`
        expect(summarise(long).length).toBeGreaterThan(150)
    })
})

describe("the row layout, which is what stops a row wrapping", () => {
    test("every cell is exactly its column width, so the checkboxes line up", () => {
        const columns = columnsFor(100, 20)
        const cells = layoutRow(
            { name: "pdf", meta: "2.3k · 8 scripts", description: "A ".repeat(200) },
            columns,
        )
        expect(cells.name.length).toBe(columns.name)
        expect(cells.meta.length).toBe(columns.meta)
        expect(cells.description.length).toBe(columns.description)
    })

    test("the whole row fits the terminal", () => {
        // The property the first version broke: a row longer than the width wraps, and a wrapped row
        // destroys the one thing a list has — that a row is a row.
        for (const width of [40, 60, 80, 100, 140]) {
            const columns = columnsFor(width, 34)
            const cells = layoutRow(
                {
                    name: "create-architectural-decision-record",
                    meta: "12.3k · 15 scripts",
                    description: "x".repeat(400),
                },
                columns,
            )
            // Mirrors the component, which omits the trailing gap when there is no description.
            const tail = cells.description === "" ? "" : `  ${cells.description}`
            const rendered = `  ◯ ${cells.name}  ${cells.meta}${tail}`
            expect(rendered.length).toBeLessThanOrEqual(width)
        }
    })

    test("a wider name column shrinks the description rather than the row", () => {
        // The plain path prints `<source>/<skill>`, so it asks for a wider name — and asking for it
        // *outside* this function is what pushed every piped row twelve characters over its width.
        const wide = columnsFor(100, 46, { nameMax: 46 })
        expect(wide.name).toBe(46)
        const cells = layoutRow(
            { name: "a".repeat(60), meta: "2.3k", description: "x".repeat(400) },
            wide,
        )
        expect(`    ${cells.name}  ${cells.meta}  ${cells.description}`.length).toBeLessThanOrEqual(
            100,
        )
    })

    test("a narrow terminal drops the description rather than showing three characters of it", () => {
        expect(columnsFor(50, 20).description).toBe(0)
        expect(columnsFor(100, 20).description).toBeGreaterThan(20)
    })

    test("tokens are compact, because five digits cost a column", () => {
        expect(compactTokens(343)).toBe("343")
        expect(compactTokens(2284)).toBe("2.3k")
        expect(compactTokens(79_079)).toBe("79k")
    })

    test("an installed skill says so instead of its size", () => {
        expect(metaOf(2284, 8, true)).toBe("installed")
        expect(metaOf(2284, 0, false)).toBe("2.3k")
        expect(metaOf(2284, 1, false)).toBe("2.3k · 1 script")
    })
})

describe("the multi-select reducer", () => {
    // Heading, item, item, heading, item — the shape every grouped list has.
    const selectable = [false, true, true, false, true]

    test("space toggles the row under the cursor and toggles it back", () => {
        let state = { cursor: { index: 1, count: 5 }, chosen: [] as readonly number[] }
        state = reduceMultiSelect(state, { kind: "toggle" }, selectable)
        expect(state.chosen).toEqual([1])
        state = reduceMultiSelect(state, { kind: "toggle" }, selectable)
        expect(state.chosen).toEqual([])
    })

    test("chosen stays sorted, so install order is screen order", () => {
        let state = { cursor: { index: 4, count: 5 }, chosen: [] as readonly number[] }
        state = reduceMultiSelect(state, { kind: "toggle" }, selectable)
        state = { ...state, cursor: { index: 1, count: 5 } }
        state = reduceMultiSelect(state, { kind: "toggle" }, selectable)
        expect(state.chosen).toEqual([1, 4])
    })

    test("the cursor skips headings going down", () => {
        let state = { cursor: { index: 2, count: 5 }, chosen: [] as readonly number[] }
        state = reduceMultiSelect(state, { kind: "move", move: { kind: "down" } }, selectable)
        // 3 is a heading; landing there would make enter do nothing, which reads as a broken keyboard.
        expect(state.cursor.index).toBe(4)
    })

    test("the cursor skips headings going up", () => {
        let state = { cursor: { index: 4, count: 5 }, chosen: [] as readonly number[] }
        state = reduceMultiSelect(state, { kind: "move", move: { kind: "up" } }, selectable)
        expect(state.cursor.index).toBe(2)
    })

    test("a heading cannot be ticked even if the cursor is somehow on one", () => {
        const state = reduceMultiSelect(
            { cursor: { index: 0, count: 5 }, chosen: [] },
            { kind: "toggle" },
            selectable,
        )
        expect(state.chosen).toEqual([])
    })

    test("all ticks every item and no heading; none clears", () => {
        let state = startMultiSelect(5)
        state = reduceMultiSelect(state, { kind: "all" }, selectable)
        expect(state.chosen).toEqual([1, 2, 4])
        state = reduceMultiSelect(state, { kind: "none" }, selectable)
        expect(state.chosen).toEqual([])
    })

    test("a list with nothing selectable does not loop forever", () => {
        // The bound on the skip walk, asserted rather than trusted: without it this hangs the process.
        const state = reduceMultiSelect(
            { cursor: { index: 0, count: 2 }, chosen: [] },
            { kind: "move", move: { kind: "down" } },
            [false, false],
        )
        expect(state.cursor.index).toBe(0)
    })

    test("up from the first item stays on it rather than parking on the heading above", () => {
        // The bug a frame test found: the walk ran out of list going up, and the fallback returned the
        // already-moved cursor — which was sitting on row 0, a heading. A heading draws no cursor, so
        // the pointer disappeared from the list entirely and space and enter both did nothing.
        const state = reduceMultiSelect(
            { cursor: { index: 1, count: 5 }, chosen: [] },
            { kind: "move", move: { kind: "up" } },
            selectable,
        )
        expect(state.cursor.index).toBe(1)
        expect(selectable[state.cursor.index]).toBe(true)
    })

    test("down from the last item stays on it", () => {
        const state = reduceMultiSelect(
            { cursor: { index: 4, count: 5 }, chosen: [] },
            { kind: "move", move: { kind: "down" } },
            selectable,
        )
        expect(state.cursor.index).toBe(4)
    })

    test("`g` reaches the first item, not row zero", () => {
        // `first` travels backwards to row 0 and then has to search *forwards*, which is why the
        // direction is read off the indices rather than the kind of move.
        const state = reduceMultiSelect(
            { cursor: { index: 4, count: 5 }, chosen: [] },
            { kind: "move", move: { kind: "first" } },
            selectable,
        )
        expect(state.cursor.index).toBe(1)
    })

    test("`G` reaches the last item even when a heading trails the list", () => {
        const trailing = [false, true, true, false]
        const state = reduceMultiSelect(
            { cursor: { index: 1, count: 4 }, chosen: [] },
            { kind: "move", move: { kind: "last" } },
            trailing,
        )
        expect(state.cursor.index).toBe(2)
    })

    test("a digit jump onto a heading lands on a real row", () => {
        const state = reduceMultiSelect(
            { cursor: { index: 1, count: 5 }, chosen: [] },
            { kind: "move", move: { kind: "jump", index: 3 } },
            selectable,
        )
        expect(selectable[state.cursor.index]).toBe(true)
    })

    test("every move kind leaves the cursor on a selectable row", () => {
        // The invariant, over the whole move vocabulary and every starting position — which is the
        // claim the individual cases above are examples of.
        const moves = [
            { kind: "up" as const },
            { kind: "down" as const },
            { kind: "first" as const },
            { kind: "last" as const },
            { kind: "jump" as const, index: 0 },
            { kind: "jump" as const, index: 3 },
        ]
        for (let start = 0; start < selectable.length; start += 1) {
            for (const move of moves) {
                const state = reduceMultiSelect(
                    { cursor: { index: start, count: selectable.length }, chosen: [] },
                    { kind: "move", move },
                    selectable,
                )
                expect(selectable[state.cursor.index]).toBe(true)
            }
        }
    })
})

describe("the curated list", () => {
    test("no duplicates across groups", () => {
        expect(new Set(CURATED_COMMUNITY_SKILLS).size).toBe(CURATED_COMMUNITY_SKILLS.length)
    })

    test("every entry belongs to exactly one group", () => {
        for (const skill of CURATED_COMMUNITY_SKILLS) {
            expect(curatedGroupOf(skill)).toBeDefined()
        }
        expect(curatedGroupOf("not-curated")).toBe(undefined)
    })

    test("every group has a title and at least one skill", () => {
        // Shape only. Asserting against the remote would make this test fail when upstream renames
        // something, which is a fact about GitHub and not about this code.
        for (const group of CURATED_COMMUNITY) {
            expect(group.title.length).toBeGreaterThan(0)
            expect(group.skills.length).toBeGreaterThan(0)
        }
    })
})

describe("the batch install reports once", () => {
    /**
     * Eleven ticked skills produced **eleven** `from / installed / this installed code / next` blocks —
     * a screenful of repeated narrative for one action, and the thing "the TUI should be everything" was
     * objecting to. `quiet` plus `collect` is how the per-skill report stays right for `skills install <one>`
     * and stops being wrong at eleven.
     */
    test("quiet install collects outcomes and prints nothing itself", () => {
        const dir = mkdtempSync(join(tmpdir(), "cli-batch-"))
        dirs.push(dir)
        mkdirSync(join(dir, "skills"), { recursive: true })
        writeFileSync(join(dir, "IDENTITY.md"), "A probe.")
        writeFileSync(
            join(dir, "agent.yaml"),
            [
                `apiVersion: ${BRAND.apiVersion}`,
                "id: probe",
                "name: Probe",
                "model:",
                "  main:",
                "    id: gpt-4o-mini",
                "    baseUrl: https://api.example.test/v1",
                "context:",
                "  files:",
                "    - IDENTITY.md",
                "skills:",
                "  dir: ./skills",
                "  maxActive: 1",
                "",
            ].join("\n"),
        )
        const from = mkdtempSync(join(tmpdir(), "cli-batch-src-"))
        dirs.push(from)
        for (const name of ["one", "two"]) {
            mkdirSync(join(from, name), { recursive: true })
            writeFileSync(
                join(from, name, "SKILL.md"),
                `---\nname: ${name}\ndescription: Does ${name}. Use when asked for ${name}.\n---\n\nSteps.\n`,
            )
        }

        const outcomes: InstallOutcome[] = []
        written = ""
        for (const name of ["one", "two"]) {
            skillsCommand({
                manifestPath: join(dir, "agent.yaml"),
                action: "install",
                name: join(from, name),
                quiet: true,
                collect: outcomes,
            })
        }
        // Nothing printed: the caller writes one summary from `outcomes`.
        expect(written).toBe("")
        expect(outcomes.map((outcome) => outcome.name)).toEqual(["one", "two"])
        expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
    })
})
