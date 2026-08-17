/**
 * `skills list|show|validate` against real files on disk.
 *
 * Written against the command function rather than the binary: the interesting behaviour is what it
 * reports and what it exits with, and both are cheap to assert directly. The one thing a spawn would add
 * is proof that the dispatch wires the positionals correctly, and `boundaries.test.ts` covers that from
 * the other side by pinning the action list against the help.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BRAND } from "@castellan/core"
import { skillsCommand } from "#skills"

const dirs: string[] = []
let written = ""
let restore: (() => void) | undefined

beforeEach(() => {
    written = ""
    const original = process.stdout.write.bind(process.stdout)
    // Captured rather than silenced: every assertion below is about what a person sees, and a test that
    // only checks the exit code would pass on an empty report.
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

function agent(options: { readonly skills?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "cli-skills-"))
    dirs.push(dir)
    writeFileSync(
        join(dir, "agent.yaml"),
        `apiVersion: ${BRAND.apiVersion}
id: probe
name: Probe
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: PROBE_KEY
context:
  files:
    - IDENTITY.md
${options.skills === false ? "" : "skills:\n  dir: ./skills\n  maxActive: 1\n"}`,
    )
    writeFileSync(join(dir, "IDENTITY.md"), "A probe.")
    if (options.skills === false) return join(dir, "agent.yaml")

    write(dir, "pdf-tables", {
        description:
            "Extract tables from PDF files into CSV. Use when someone has a PDF report and wants the numbers out of it.",
        whenNotToUse: "Not for scanned images without a text layer.",
        body: "Run the extractor.",
    })
    write(dir, "thin", { description: "Handles invoices.", body: "Do it." })
    write(dir, "shellish", {
        description:
            "Deploy the application to a staging or production cluster. Use when shipping a build.",
        whenNotToUse: "Not for local runs.",
        body: "Run the script.",
        // One runnable and one not. The runnable one is executable with a shebang rather than a `.py`,
        // so it needs no interpreter probe and the test holds on a machine without Python.
        executable: { "deploy.sh": "#!/bin/sh\necho hi\n" },
        scripts: { "notes.md": "# not a script\n" },
    })
    return join(dir, "agent.yaml")
}

function write(
    root: string,
    name: string,
    options: {
        description: string
        whenNotToUse?: string
        body: string
        scripts?: Readonly<Record<string, string>>
        executable?: Readonly<Record<string, string>>
    },
): void {
    const dir = join(root, "skills", name)
    mkdirSync(dir, { recursive: true })
    const meta =
        options.whenNotToUse === undefined
            ? ""
            : `metadata:\n  ${BRAND.slug}-when-not-to-use: ${JSON.stringify(options.whenNotToUse)}\n`
    writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${JSON.stringify(options.description)}\n${meta}---\n\n${options.body}\n`,
    )
    if (options.scripts === undefined && options.executable === undefined) return
    mkdirSync(join(dir, "scripts"), { recursive: true })
    for (const [file, body] of Object.entries(options.scripts ?? {})) {
        writeFileSync(join(dir, "scripts", file), body)
    }
    for (const [file, body] of Object.entries(options.executable ?? {})) {
        writeFileSync(join(dir, "scripts", file), body, { mode: 0o755 })
    }
}

const ENV_KEY = "PROBE_KEY"

function run(options: Parameters<typeof skillsCommand>[0]): number {
    process.env[ENV_KEY] = "x"
    try {
        return skillsCommand(options)
    } finally {
        delete process.env[ENV_KEY]
    }
}

describe("list", () => {
    test("names every skill with its size, and flags a missing when-not-to-use", () => {
        const code = run({ manifestPath: agent(), action: "list" })
        expect(code).toBe(0)
        expect(written).toContain("pdf-tables")
        expect(written).toContain("shellish")
        // The one gap worth surfacing even in an inventory: cheap to fix, invisible until something
        // routes wrongly.
        expect(written).toContain("no when-not-to-use")
        expect(written).toContain("1 script(s)")
    })

    test("--json carries the machine-readable shape", () => {
        run({ manifestPath: agent(), action: "list", json: true })
        const parsed = JSON.parse(written) as {
            ok: boolean
            configured: boolean
            skills: { name: string; hasWhenNotToUse: boolean; scripts: string[] }[]
        }
        expect(parsed.ok).toBe(true)
        expect(parsed.configured).toBe(true)
        expect(parsed.skills.map((skill) => skill.name).sort()).toEqual([
            "pdf-tables",
            "shellish",
            "thin",
        ])
        expect(parsed.skills.find((skill) => skill.name === "thin")?.hasWhenNotToUse).toBe(false)
    })

    test("an agent with no skills block says what to add rather than nothing", () => {
        // Decision 4.53's shape: someone who typed this was looking for something, and "none" with no
        // way forward is the answer that sends them to the source.
        const code = run({ manifestPath: agent({ skills: false }), action: "list" })
        expect(code).toBe(0)
        expect(written).toContain("no skills configured")
        expect(written).toContain("skills:")
    })
})

describe("show", () => {
    test("prints the description and the negative guidance", () => {
        const code = run({ manifestPath: agent(), action: "show", name: "pdf-tables" })
        expect(code).toBe(0)
        expect(written).toContain("Extract tables from PDF")
        expect(written).toContain("scanned images")
    })

    test("a skill without negative guidance is told how to add it, by key name", () => {
        run({ manifestPath: agent(), action: "show", name: "thin" })
        expect(written).toContain(`metadata.${BRAND.slug}-when-not-to-use`)
    })

    test("an unrunnable script is shown as such rather than omitted", () => {
        run({ manifestPath: agent(), action: "show", name: "shellish" })
        expect(written).toContain("not runnable")
        expect(written).toContain("notes.md")
        // And the runnable one is listed as callable, by slug.
        expect(written).toContain("skill.shellish.deploy")
    })

    test("an unknown name lists the known ones and exits non-zero", () => {
        const code = run({ manifestPath: agent(), action: "show", name: "nope" })
        expect(code).toBe(1)
        expect(written).toContain("pdf-tables")
    })

    test("no name at all is a usage failure, not an empty report", () => {
        expect(run({ manifestPath: agent(), action: "show" })).toBe(1)
    })
})

describe("new", () => {
    test("scaffolds a skill and turns skills on for an agent that has none", () => {
        // The case someone actually hits: they skipped skills at `init` and want them later. Both halves
        // or neither — `skills.dir` naming a directory that does not exist is a load failure.
        const manifest = agent({ skills: false })
        expect(run({ manifestPath: manifest, action: "new", name: "triage-inbox" })).toBe(0)
        const yaml = readFileSync(manifest, "utf8")
        expect(yaml).toContain("skills:")
        expect(yaml).toContain("dir: ./skills")
        expect(existsSync(join(dirname(manifest), "skills", "triage-inbox", "SKILL.md"))).toBe(true)
    })

    test("the scaffold carries the name it was given, not the template's", () => {
        const manifest = agent({ skills: false })
        run({ manifestPath: manifest, action: "new", name: "triage-inbox" })
        const body = readFileSync(
            join(dirname(manifest), "skills", "triage-inbox", "SKILL.md"),
            "utf8",
        )
        expect(body).toContain("name: triage-inbox")
        // And the brand-derived metadata key is substituted, not left as a placeholder.
        expect(body).toContain(`${BRAND.slug}-when-not-to-use`)
        expect(body.includes("{{")).toBe(false)
    })

    test("it refuses a name the loader would refuse, rather than writing a broken scaffold", () => {
        const manifest = agent()
        expect(run({ manifestPath: manifest, action: "new", name: "Triage_Inbox" })).toBe(1)
    })

    test("it never overwrites an existing skill", () => {
        const manifest = agent()
        expect(run({ manifestPath: manifest, action: "new", name: "pdf-tables" })).toBe(1)
        expect(written).toContain("already exists")
    })

    test("it needs a name", () => {
        expect(run({ manifestPath: agent(), action: "new" })).toBe(1)
    })
})

describe("install", () => {
    function source(entries: Readonly<Record<string, string>>): string {
        const dir = mkdtempSync(join(tmpdir(), "cli-skills-src-"))
        dirs.push(dir)
        for (const [name, description] of Object.entries(entries)) {
            mkdirSync(join(dir, name), { recursive: true })
            writeFileSync(
                join(dir, name, "SKILL.md"),
                `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nSteps.\n`,
            )
        }
        return dir
    }

    test("a directory of skills installs all of them", () => {
        const manifest = agent({ skills: false })
        const from = source({
            alpha: "Does the alpha thing. Use when someone asks for alpha work.",
            beta: "Does the beta thing. Use when someone asks for beta work.",
        })
        expect(run({ manifestPath: manifest, action: "install", name: from })).toBe(0)
        expect(written).toContain("alpha")
        expect(written).toContain("beta")
    })

    test("a single skill directory installs just that one", () => {
        const manifest = agent({ skills: false })
        const from = source({
            alpha: "Does the alpha thing. Use when someone asks for alpha work.",
        })
        expect(run({ manifestPath: manifest, action: "install", name: join(from, "alpha") })).toBe(
            0,
        )
        expect(existsSync(join(dirname(manifest), "skills", "alpha", "SKILL.md"))).toBe(true)
    })

    test("an already-installed skill is skipped by name, not overwritten", () => {
        const manifest = agent({ skills: false })
        const from = source({
            alpha: "Does the alpha thing. Use when someone asks for alpha work.",
        })
        run({ manifestPath: manifest, action: "install", name: from })
        written = ""
        run({ manifestPath: manifest, action: "install", name: from })
        expect(written).toContain("already installed")
    })

    test("a body over skills.budget is refused before anything is copied", () => {
        // The dead end this prevents: a body over the budget **fails the load**, so installing one would
        // break `list`, `validate` and every turn — to add a skill that could never have activated.
        // `skill-creator` from anthropics/skills is 9,065 tokens and is exactly this case.
        const manifest = agent({ skills: false })
        const dir = mkdtempSync(join(tmpdir(), "cli-skills-big-"))
        dirs.push(dir)
        mkdirSync(join(dir, "huge"), { recursive: true })
        writeFileSync(
            join(dir, "huge", "SKILL.md"),
            `---\nname: huge\ndescription: A very large skill. Use when nothing else fits.\n---\n\n${"word ".repeat(6000)}\n`,
        )
        expect(run({ manifestPath: manifest, action: "install", name: dir })).toBe(1)
        expect(written).toContain("would stop this agent loading")
        expect(existsSync(join(dirname(manifest), "skills", "huge"))).toBe(false)
    })

    test("a path with no SKILL.md anywhere says so", () => {
        const empty = mkdtempSync(join(tmpdir(), "cli-skills-empty-"))
        dirs.push(empty)
        expect(
            run({ manifestPath: agent({ skills: false }), action: "install", name: empty }),
        ).toBe(1)
    })

    test("a path that does not exist says so", () => {
        expect(run({ manifestPath: agent(), action: "install", name: "/nope/not/here" })).toBe(1)
    })
})

describe("remove", () => {
    test("it deletes the directory and reports the file count", () => {
        const manifest = agent()
        expect(run({ manifestPath: manifest, action: "remove", name: "pdf-tables" })).toBe(0)
        expect(written).toContain("removed")
        expect(existsSync(join(dirname(manifest), "skills", "pdf-tables"))).toBe(false)
    })

    test("it works when the catalogue cannot load at all", () => {
        // The ordering that fixes the dead end: with `remove` behind `loadSkills`, a skill over the budget
        // made the one command that could undo it the one that could not run.
        const manifest = agent()
        mkdirSync(join(dirname(manifest), "skills", "huge"), { recursive: true })
        writeFileSync(
            join(dirname(manifest), "skills", "huge", "SKILL.md"),
            `---\nname: huge\ndescription: A very large skill. Use when nothing else fits.\n---\n\n${"word ".repeat(6000)}\n`,
        )
        // `list` is expected to fail here — that is the load contract doing its job.
        expect(() => run({ manifestPath: manifest, action: "list" })).toThrow()
        expect(run({ manifestPath: manifest, action: "remove", name: "huge" })).toBe(0)
    })

    test("an unknown name lists the known ones", () => {
        expect(run({ manifestPath: agent(), action: "remove", name: "nope" })).toBe(1)
        expect(written).toContain("pdf-tables")
    })
})

describe("validate", () => {
    test("names every skill, so a clean one is visibly checked", () => {
        run({ manifestPath: agent(), action: "validate" })
        expect(written).toContain("pdf-tables")
        expect(written).toContain("ok")
    })

    test("it warns and exits 0 — findings here are judgements, not failures", () => {
        const code = run({ manifestPath: agent(), action: "validate" })
        expect(code).toBe(0)
        expect(written).toContain("warnings, not failures")
    })

    test("--strict exits non-zero, which is what CI needs", () => {
        // Without it, "warnings somebody decided to live with" and "warnings nobody read" are the same
        // output.
        expect(run({ manifestPath: agent(), action: "validate", strict: true })).toBe(1)
    })

    test("a clean workspace reports no findings and --strict still passes", () => {
        const dir = mkdtempSync(join(tmpdir(), "cli-skills-clean-"))
        dirs.push(dir)
        writeFileSync(
            join(dir, "agent.yaml"),
            `apiVersion: ${BRAND.apiVersion}\nid: probe\nmodel:\n  main:\n    id: gpt-4o-mini\n    baseUrl: https://api.example.com/v1\n    apiKeyEnv: ${ENV_KEY}\nskills:\n  dir: ./skills\n`,
        )
        mkdirSync(join(dir, "skills"), { recursive: true })
        const code = run({
            manifestPath: join(dir, "agent.yaml"),
            action: "validate",
            strict: true,
        })
        expect(code).toBe(0)
        expect(written).toContain("no findings")
    })

    test("--json reports ok false with the findings attached", () => {
        run({ manifestPath: agent(), action: "validate", json: true })
        const parsed = JSON.parse(written) as {
            ok: boolean
            findings: { code: string; hint: string }[]
        }
        expect(parsed.ok).toBe(false)
        expect(parsed.findings.length).toBeGreaterThan(0)
        // Hard rule 7, as a test: every finding names a fix.
        for (const finding of parsed.findings) {
            expect(finding.code).toBe("skill_authoring")
            expect(finding.hint.length).toBeGreaterThan(20)
        }
    })
})
