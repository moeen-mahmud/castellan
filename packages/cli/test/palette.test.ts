/**
 * The palette, the argument rule, and the `inSession` declaration.
 *
 * The point of these is the *generation*: the palette is built from the same `COMMANDS` table `--help`
 * renders from, so a flag added to the CLI reaches the TUI with nothing to remember. What has to be
 * asserted is that the link holds and that hiding is declared rather than achieved by omission.
 */

import { describe, expect, test } from "bun:test"
import { COMMANDS } from "#lib/commands"
import { paletteEntries, paletteFor, paletteSelection } from "#lib/palette"
import { resolveSessionCommand, SESSION_COMMANDS } from "#lib/session-commands"
import { paneRefusal, subcommandArgv } from "#lib/subcommand"

describe("every command declares how it appears in a session", () => {
    test("no command is left undeclared", () => {
        // Required on the type, and asserted here as well: the whole reason the field is mandatory is
        // that a new command must not be able to go missing from the TUI by being forgotten.
        for (const spec of COMMANDS) {
            expect(["view", "output", "hidden"]).toContain(spec.inSession)
        }
    })

    test("the ones that would end or replace the session are hidden", () => {
        const hidden = COMMANDS.filter((spec) => spec.inSession === "hidden").map((s) => s.name)
        // `stop` would stop the session it was typed into; `run` is the session; `serve` is a server;
        // `init` builds a different agent; `terminal-setup` asks a question on stdin.
        expect(hidden).toContain("stop")
        expect(hidden).toContain("run")
        expect(hidden).toContain("serve")
        expect(hidden).toContain("init")
    })

    test("the reporting commands are offered", () => {
        const offered = COMMANDS.filter((spec) => spec.inSession !== "hidden").map((s) => s.name)
        for (const name of ["validate", "workspace", "agents", "tools", "sessions", "daemon"]) {
            expect(offered).toContain(name)
        }
    })
})

/** The palette for a value, or a failure that names the value rather than the property access. */
function must(value: string) {
    const palette = paletteFor(value)
    if (palette === undefined) throw new Error(`no palette for ${value}`)
    return palette
}

describe("the palette", () => {
    test("session verbs lead, then the CLI", () => {
        // "What can I do here" before "what commands exist": /help and /exit have no shell equivalent.
        const entries = paletteEntries()
        expect(entries[0]?.word).toBe(SESSION_COMMANDS[0]?.word)
        expect(entries.some((entry) => entry.word === "/validate")).toBe(true)
    })

    test("a hidden command never appears", () => {
        expect(paletteEntries().some((entry) => entry.word === "/stop")).toBe(false)
    })

    test("a session verb wins a name collision with a CLI command", () => {
        // `/tools` in a session means the running agent's catalogue, not a fresh load from disk.
        const tools = paletteEntries().filter((entry) => entry.word === "/tools")
        expect(tools).toHaveLength(1)
        expect(tools[0]?.kind).toBe("session")
    })

    test("it opens on a bare slash and narrows as the word is typed", () => {
        expect(paletteFor("/")?.matches.length).toBeGreaterThan(5)
        const narrowed = paletteFor("/sk")
        expect(narrowed?.query).toBe("sk")
        expect(narrowed?.matches.map((entry) => entry.word)).toEqual(["/skills"])
    })

    test("it is closed for anything that is not a slash word being typed", () => {
        // A message that merely mentions a path must never open it.
        expect(paletteFor("/etc/passwd is world-readable")).toBeUndefined()
        expect(paletteFor("and/or")).toBeUndefined()
        expect(paletteFor("what tools do you have")).toBeUndefined()
        // And it closes once arguments are being typed: there is nothing left to complete, and a list
        // over the line would hide what is being written.
        expect(paletteFor("/logs 200")).toBeUndefined()
    })

    test("no match is a fact, not an empty list to scroll", () => {
        const palette = must("/zzz")
        expect(palette.matches).toEqual([])
        expect(paletteSelection(palette, 0)).toBeUndefined()
    })

    test("the selection clamps rather than falling off the end", () => {
        expect(paletteSelection(must("/sk"), 99)?.word).toBe("/skills")
    })
})

describe("arguments, without breaking prose", () => {
    const OFFERED = ["validate", "daemon", "skills"]

    test("a known first token takes arguments", () => {
        expect(resolveSessionCommand("/daemon status", OFFERED)).toEqual({
            kind: "command",
            name: "daemon",
            rest: "status",
        })
        expect(resolveSessionCommand("/skills validate --strict", OFFERED)).toMatchObject({
            kind: "command",
            rest: "validate --strict",
        })
    })

    test("prose with a slash in it is still prose", () => {
        // The cases the narrow rule was written for, and the reason the loosening is keyed on a known
        // first token rather than on shape.
        expect(resolveSessionCommand("/etc/passwd is world-readable", OFFERED)).toBeUndefined()
        expect(resolveSessionCommand("and/or", OFFERED)).toBeUndefined()
        expect(resolveSessionCommand("/usr/local/bin is on my PATH", OFFERED)).toBeUndefined()
    })

    test("a mistyped command with arguments is prose, not a refusal", () => {
        // The one thing this loosening costs, and the cheaper of the two errors.
        expect(resolveSessionCommand("/skils validate", OFFERED)).toBeUndefined()
    })

    test("a mistyped lone command is still refused, and suggests the nearest", () => {
        expect(resolveSessionCommand("/skils", OFFERED)).toMatchObject({
            kind: "unknown",
            nearest: "/skills",
        })
    })

    test("a session verb still resolves with and without arguments", () => {
        expect(resolveSessionCommand("/help", OFFERED)).toEqual({ kind: "help" })
        expect(resolveSessionCommand("/help keys", OFFERED)).toEqual({ kind: "help", rest: "keys" })
    })

    test("an offered CLI command resolves with no arguments too", () => {
        expect(resolveSessionCommand("/validate", OFFERED)).toEqual({
            kind: "command",
            name: "validate",
            rest: "",
        })
    })
})

describe("the argv a pane runs", () => {
    const BASE = { manifestPath: "/agents/milo/agent.yaml" }

    test("a manifest-taking command gets the session's agent", () => {
        // Without it the child resolves whichever agent the cwd suggests — a different agent than the one
        // being talked to, and it would not look wrong in the output.
        expect(subcommandArgv({ ...BASE, name: "validate", rest: "" })).toEqual([
            "validate",
            "/agents/milo/agent.yaml",
            "--plain",
        ])
    })

    test("a command that takes an action first is left in its own order", () => {
        expect(subcommandArgv({ ...BASE, name: "daemon", rest: "status" })).toEqual([
            "daemon",
            "status",
            "--plain",
        ])
    })

    test("`--plain` is always last, so it cannot be read as a value", () => {
        const argv = subcommandArgv({ ...BASE, name: "sessions", rest: "--limit 5" })
        expect(argv.at(-1)).toBe("--plain")
    })

    test("machine-level commands are not handed an agent", () => {
        expect(subcommandArgv({ ...BASE, name: "sources", rest: "list" })).toEqual([
            "sources",
            "list",
            "--plain",
        ])
    })
})

describe("what a pane refuses to run", () => {
    const BASE = { manifestPath: "/agents/milo/agent.yaml" }

    test("a following command is refused, and told where it does work", () => {
        // A pane captures a child to completion, so `--follow` would spin until the timeout and then
        // report being killed — thirty seconds of a frozen surface for a flag that works fine at a shell.
        const refusal = paneRefusal({ ...BASE, name: "daemon", rest: "logs milo --follow" })
        expect(refusal).toContain("nothing to interrupt it with")
        expect(refusal).toContain("daemon logs milo --follow")
    })

    test("the short form too, read off the spec rather than a second list", () => {
        expect(paneRefusal({ ...BASE, name: "daemon", rest: "logs milo -f" })).toBeDefined()
    })

    test("the same command without the flag is fine", () => {
        expect(paneRefusal({ ...BASE, name: "daemon", rest: "logs milo" })).toBeUndefined()
        expect(paneRefusal({ ...BASE, name: "daemon", rest: "status" })).toBeUndefined()
    })

    test("a command with no follow flag is never refused for one", () => {
        // `-f` is not reserved globally: it is refused only where the spec declares it.
        expect(paneRefusal({ ...BASE, name: "validate", rest: "-f" })).toBeUndefined()
    })
})
