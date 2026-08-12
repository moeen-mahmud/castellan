/**
 * Structural guards.
 *
 * These assert facts about the source tree rather than about behaviour, because the facts are
 * expensive to check by hand and silent when broken. The lazy-Ink boundary in particular fails
 * invisibly: adding `import { Text } from "ink"` to a command module keeps every test passing and
 * every output identical, while quietly adding ~200 ms to every invocation of every command.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { BRAND } from "@castellan/core"
import { COMMANDS } from "#lib/commands"

const SRC = resolve(import.meta.dirname, "..", "src")

function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
        else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full)
    }
    return out
}

const FILES = sourceFiles(SRC).map((path) => ({
    path: relative(SRC, path),
    text: readFileSync(path, "utf8"),
}))

/** `import … from "x"` and `export … from "x"`, but not `await import("x")`. */
function staticImportsOf(text: string, pkg: string): boolean {
    return new RegExp(
        `(?:^|\\n)\\s*(?:import|export)[^\\n]*from\\s*["']${pkg}(?:/[^"']*)?["']`,
    ).test(text)
}

describe("the rich renderer stays lazy", () => {
    const RICH_ONLY = ["ink", "react"]

    test("at least one file does import it, or this test proves nothing", () => {
        const importers = FILES.filter((file) =>
            RICH_ONLY.some((pkg) => staticImportsOf(file.text, pkg)),
        )
        expect(importers.length).toBeGreaterThan(0)
    })

    test("only components and hooks import Ink or React statically", () => {
        const offenders = FILES.filter(
            (file) =>
                !file.path.startsWith("components/") &&
                !file.path.startsWith("hooks/") &&
                RICH_ONLY.some((pkg) => staticImportsOf(file.text, pkg)),
        ).map((file) => file.path)

        // Measured: react + ink cost ~65 ms to import under Bun and ~170-210 ms under Node, against
        // a ~90 ms total runtime for `validate --json`. Any static import on a shared path is paid by
        // every command.
        expect(offenders).toEqual([])
    })

    test("the entry point reaches the app only through a dynamic import", () => {
        const entry = FILES.find((file) => file.path === "index.ts")
        expect(entry).toBeDefined()
        expect(staticImportsOf(entry?.text ?? "", "#components/App")).toBe(false)
    })

    test("run.ts loads the renderer dynamically", () => {
        const run = FILES.find((file) => file.path === "run.ts")
        expect(run?.text).toContain('import("ink")')
        expect(staticImportsOf(run?.text ?? "", "ink")).toBe(false)
    })
})

describe("the pure modules stay pure", () => {
    // These four are the ones worth unit-testing, and each would become untestable the moment it
    // reached for a terminal, a clock, or a renderer.
    const PURE = ["transcript.ts", "keymap.ts", "editor.ts", "lib/wrap.ts", "lib/args.ts"]

    test("they import no renderer and no node built-ins", () => {
        for (const name of PURE) {
            const file = FILES.find((candidate) => candidate.path === name)
            expect(file).toBeDefined()
            const text = file?.text ?? ""
            expect(staticImportsOf(text, "ink")).toBe(false)
            expect(staticImportsOf(text, "react")).toBe(false)
            expect(staticImportsOf(text, "node:.*")).toBe(false)
        }
    })

    test("they do not read process state", () => {
        for (const name of PURE) {
            const text = FILES.find((candidate) => candidate.path === name)?.text ?? ""
            // `resolveMode` takes its inputs as arguments precisely so that the interesting logic is
            // a pure function; the same rule applies to the reducers.
            expect(text).not.toContain("process.env")
            expect(text).not.toContain("process.stdout")
        }
    })
})

describe("hard rule 3 — the brand lives in one file", () => {
    test("no source file spells the product name", () => {
        // `rename-brand.ts` rewrites `brand.ts` and package manifests. A literal anywhere else,
        // including in a comment, goes stale on the first rename.
        // Reads the real brand rather than a copy of it. The import scope legitimately contains
        // the slug, so it is stripped before looking.
        const offenders = FILES.filter((file) =>
            file.text.replaceAll(BRAND.packageScope, "").toLowerCase().includes(BRAND.slug),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })
})

test("every command in the table is wired to an implementation", () => {
    // The entry point throws for an unwired command, but only when someone runs it. This catches it
    // at test time instead.
    const entry = FILES.find((file) => file.path === "index.ts")?.text ?? ""
    expect(COMMANDS.length).toBeGreaterThan(0)
    for (const command of COMMANDS) {
        expect(entry).toContain(`case "${command.name}"`)
    }
})
