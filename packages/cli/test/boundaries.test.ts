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
import { DAEMON_ACTIONS } from "#daemon"
import { COMMANDS } from "#lib/commands"
import { helpText } from "#lib/help"
import { SKILLS_ACTIONS } from "#skills"

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

    test("init.ts loads the renderer dynamically too", () => {
        // The wizard is the second Ink surface; the same laziness contract applies — a
        // flag-driven `init --yes` must never pay for a renderer it does not mount.
        const init = FILES.find((file) => file.path === "init.ts")
        expect(init?.text).toContain('import("ink")')
        expect(staticImportsOf(init?.text ?? "", "ink")).toBe(false)
    })

    test("the entry point reaches no screen root statically", () => {
        const entry = FILES.find((file) => file.path === "index.ts")?.text ?? ""
        for (const root of ["#components/App", "#components/WizardApp", "#components/Picker"]) {
            expect(staticImportsOf(entry, root)).toBe(false)
        }
    })
})

describe("the pure modules stay pure", () => {
    // These four are the ones worth unit-testing, and each would become untestable the moment it
    // reached for a terminal, a clock, or a renderer.
    const PURE = [
        "transcript.ts",
        "keymap.ts",
        "editor.ts",
        "lib/wrap.ts",
        "lib/args.ts",
        "lib/init-flow.ts",
        "lib/templates.ts",
        "lib/theme.ts",
        "lib/select.ts",
        "lib/wizard.ts",
        // The daemon's three. `launchd.ts` renders a plist and parses `launchctl` output;
        // `daemon-plan.ts` decides what would stop an install and what a service's state means;
        // `render.ts` is the plain path's shared vocabulary. Keeping all three pure is what lets
        // every plist key, every wait-status decode and every verdict be asserted without
        // installing a service on the machine running the tests.
        "lib/launchd.ts",
        "lib/daemon-plan.ts",
        "lib/render.ts",
    ]

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

describe("exactly one module may spawn a subprocess", () => {
    /**
     * The CLI spawned nothing at all until the daemon needed `launchctl`, and that is worth
     * keeping true of everything except the one seam built for it. A second call site is a second
     * place tests would have to intercept, and the first one that forgets reaches the real
     * `~/Library/LaunchAgents` on somebody's machine.
     *
     * The seam moved out of `lib/service.ts` when `git` became the second thing worth running, and it
     * moved rather than becoming a two-entry allowlist: an allowlist is what this rule turns into if a
     * new caller is ever the answer, and it would grow once per phase. `lib/service.ts` and
     * `lib/source-cache.ts` both call `spawnCapture`, and neither knows how a process is started.
     */
    const SPAWNER = "lib/spawn.ts"

    test("only the shared spawn seam imports node:child_process", () => {
        const offenders = FILES.filter(
            (file) => file.path !== SPAWNER && staticImportsOf(file.text, "node:child_process"),
        ).map((file) => file.path)
        expect(offenders).toEqual([])
    })

    test("and it really does — otherwise this test proves nothing", () => {
        const seam = FILES.find((file) => file.path === SPAWNER)?.text ?? ""
        expect(staticImportsOf(seam, "node:child_process")).toBe(true)
    })
})

describe("help lists everything a command accepts", () => {
    /**
     * The flag half of this has been pinned since Phase 2.5. The *action* half had no check at
     * all: `soul`'s single verb lived inside a prose help string, invisible to anything, and
     * `daemon` arriving with seven of them turned that from an oddity into a class of drift. So
     * actions are structured data now, and the guarantee is the same one flags already have.
     */
    test("every action-taking command enumerates its actions", () => {
        for (const command of COMMANDS) {
            const action = command.args.find((arg) => arg.name === "action")
            if (action === undefined) continue
            expect(action.choices ?? []).not.toEqual([])
            const help = helpText(command)
            for (const choice of action.choices ?? []) {
                expect(help).toContain(choice.value)
                expect(help).toContain(choice.help)
            }
        }
    })

    test("the skills command's actions in help are exactly the ones it accepts", () => {
        const spec = COMMANDS.find((command) => command.name === "skills")
        const listed = (spec?.args.find((arg) => arg.name === "action")?.choices ?? []).map(
            (choice) => choice.value,
        )
        expect(listed).toEqual([...SKILLS_ACTIONS])
    })

    test("the daemon's actions in help are exactly the ones it accepts", () => {
        const spec = COMMANDS.find((command) => command.name === "daemon")
        const listed = (spec?.args.find((arg) => arg.name === "action")?.choices ?? []).map(
            (choice) => choice.value,
        )
        // Compared against the command's own runtime list, so adding a verb in one place and not
        // the other fails here rather than at the moment somebody types it.
        expect(listed).toEqual([...DAEMON_ACTIONS])
    })
})

describe("only the rich path moves a cursor", () => {
    test("the interactive readline is pinned out of terminal mode", () => {
        // Found by running `--plain` under a pty: Node's readline decides terminal mode from
        // `output.isTTY` rather than from the mode this CLI already resolved, so a plain run at a
        // terminal repainted its prompt with ESC[1G / ESC[0J / ESC[3G that the same command piped
        // never emitted — breaking the one property plain mode exists for.
        const run = FILES.find((file) => file.path === "run.ts")?.text ?? ""
        expect(run).toContain("createInterface({")
        expect(run).toContain("terminal: false")
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

test("an event a person must see is handled on BOTH output paths", () => {
    // The two paths subscribe differently, and that asymmetry is a real trap. The rich path uses
    // `bus.on("*")`, so a new event type reaches the reducer for free — and falls into its
    // `default` case, silently doing nothing. The plain path uses named subscriptions, so the same
    // event is simply absent. Either way the failure is invisible, which is the worst shape for a
    // blocked write. Pinned rather than left to vigilance.
    const transcript = FILES.find((file) => file.path === "transcript.ts")?.text ?? ""
    const plain = FILES.find((file) => file.path === "run.ts")?.text ?? ""

    for (const type of ["tool.gated"]) {
        expect(transcript).toContain(`case "${type}"`)
        expect(plain).toContain(`runtime.bus.on("${type}"`)
    }
})

test("a blocked write is reported even when tool rows are suppressed", () => {
    // `showRows` hides tool chatter in one-shot and --quiet runs, because something is parsing the
    // output. A gate refusal is the exception: it means the run did less than it was asked to.
    const plain = FILES.find((file) => file.path === "run.ts")?.text ?? ""
    const handler = plain.slice(plain.indexOf('runtime.bus.on("tool.gated"'))
    const body = handler.slice(0, handler.indexOf("}),"))
    expect(body.includes("showRows")).toBe(false)
})
