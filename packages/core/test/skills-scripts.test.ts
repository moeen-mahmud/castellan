import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_PROMPT_STYLE } from "../src/model/prompt-style.ts"
import type { Skill } from "../src/skills/index.ts"
import { loadSkills } from "../src/skills/index.ts"
import { interpreterFor, scriptSlug } from "../src/skills/scripts.ts"
import { renderScripts, skillScriptTools } from "../src/skills/tools.ts"
import type { ScriptRunner, ScriptRunRequest, ScriptRunResult } from "../src/tools/types.ts"
import { afterEach, describe, expect, test } from "./_harness.ts"

const roots: string[] = []

function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "skill-scripts-"))
    roots.push(dir)
    return dir
}

afterEach(() => {
    while (roots.length > 0) {
        const dir = roots.pop()
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
})

// ─── the pure ladder ─────────────────────────────────────────────────────────────────────

describe("interpreterFor", () => {
    function resolve(file: string, root: readonly string[] = [], executable = false) {
        return interpreterFor({ skill: "demo", file, root, executable, host: "bun" })
    }

    test("a .py with no Python metadata runs under python3", () => {
        const found = resolve("extract.py")
        expect(found.kind).toBe("runnable")
        if (found.kind !== "runnable") return
        expect(found.plan.interpreter).toBe("python3")
        expect(found.plan.args).toEqual([])
        expect(found.plan.requires).toBe("python3")
    })

    test("a .py beside pyproject.toml runs under uv", () => {
        const found = resolve("extract.py", ["SKILL.md", "pyproject.toml"])
        if (found.kind !== "runnable") throw new Error("expected runnable")
        expect(found.plan.interpreter).toBe("uv")
        expect(found.plan.args).toEqual(["run"])
        expect(found.plan.requires).toBe("uv")
    })

    test("requirements.txt counts too", () => {
        const found = resolve("extract.py", ["requirements.txt"])
        if (found.kind !== "runnable") throw new Error("expected runnable")
        expect(found.plan.interpreter).toBe("uv")
    })

    test("Python metadata does not reach a .ts script", () => {
        // The clarification the architecture doc left open. `uv run report.ts` is not a thing, and a
        // skill is allowed to ship both kinds.
        const found = resolve("report.ts", ["pyproject.toml"])
        if (found.kind !== "runnable") throw new Error("expected runnable")
        expect(found.plan.interpreter).toBe("bun")
    })

    test("a .ts or .js runs under the host, whichever is hosting", () => {
        for (const file of ["report.ts", "report.js"]) {
            const node = interpreterFor({
                skill: "demo",
                file,
                root: [],
                executable: false,
                host: "node",
            })
            if (node.kind !== "runnable") throw new Error("expected runnable")
            expect(node.plan.interpreter).toBe("node")
        }
    })

    test("an executable file with no known extension runs itself, and requires nothing", () => {
        const found = resolve("deploy.sh", [], true)
        if (found.kind !== "runnable") throw new Error("expected runnable")
        // Absent, not a sentinel: the caller has to branch anyway, since only it holds a path.
        expect(found.plan.interpreter).toBeUndefined()
        // Deliberately absent. The shebang names the interpreter, and guessing here would refuse a
        // script at load that runs perfectly.
        expect(found.plan.requires).toBeUndefined()
    })

    test("a .sh with no executable bit is ignored, with the reason said out loud", () => {
        // The case this branch exists for. Dropped silently, `scripts/deploy.sh` looks installed and
        // never runs — which is the shape refused everywhere else in this codebase.
        const found = resolve("deploy.sh")
        expect(found.kind).toBe("ignored")
        if (found.kind !== "ignored") return
        expect(found.reason).toContain("executable bit")
        expect(found.file).toBe("deploy.sh")
    })

    test("a README in scripts/ is ignored rather than treated as a script", () => {
        expect(resolve("README.md").kind).toBe("ignored")
    })

    test("the slug is skill.<skill>.<script>, extension dropped", () => {
        expect(scriptSlug("pdf-processing", "extract.py")).toBe("skill.pdf-processing.extract")
        expect(scriptSlug("demo", "run")).toBe("skill.demo.run")
    })
})

// ─── discovery ───────────────────────────────────────────────────────────────────────────

const RUNNER: ScriptRunner = {
    has: () => true,
    run: () => Promise.resolve({ ok: true, output: "ran", code: 0, timedOut: false }),
}

function writeSkill(
    dir: string,
    name: string,
    scripts: Readonly<Record<string, string>> = {},
    extraRoot: readonly string[] = [],
): void {
    const skillDir = join(dir, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Handles ${name} work for the team.\n---\n\nStep one.\n`,
    )
    for (const file of extraRoot) writeFileSync(join(skillDir, file), "")
    const names = Object.keys(scripts)
    if (names.length === 0) return
    mkdirSync(join(skillDir, "scripts"), { recursive: true })
    for (const [file, body] of Object.entries(scripts)) {
        writeFileSync(join(skillDir, "scripts", file), body)
    }
}

function load(dir: string, runner: ScriptRunner = RUNNER) {
    return loadSkills({
        dir,
        maxActive: 1,
        threshold: 0.35,
        style: DEFAULT_PROMPT_STYLE,
        host: "bun",
        runner,
    })
}

/**
 * Separate from `load` rather than `load(dir, undefined)`.
 *
 * A default parameter fires on an explicitly passed `undefined` too, so `load(dir, undefined)` used
 * `RUNNER` and this test passed for the wrong reason until it didn't. Worth keeping as two functions: the
 * omission is the thing under test, and it should not be expressible as an argument.
 */
function loadWithoutRunner(dir: string) {
    return loadSkills({
        dir,
        maxActive: 1,
        threshold: 0.35,
        style: DEFAULT_PROMPT_STYLE,
        host: "bun",
    })
}

describe("discovery at scan time", () => {
    test("scripts are found, sorted, and slugged", () => {
        const dir = root()
        writeSkill(dir, "demo", { "b.py": "print(1)", "a.py": "print(1)" })
        const skill = load(dir).skills[0]
        expect(skill?.scripts.map((plan) => plan.slug)).toEqual(["skill.demo.a", "skill.demo.b"])
    })

    test("an unrunnable file lands in ignoredScripts, not in scripts", () => {
        const dir = root()
        writeSkill(dir, "demo", { "notes.md": "# hi" })
        const skill = load(dir).skills[0]
        expect(skill?.scripts).toEqual([])
        expect(skill?.ignoredScripts.map((entry) => entry.file)).toEqual(["notes.md"])
    })

    test("no runner means scripts are never discovered rather than discovered and unrunnable", () => {
        const dir = root()
        writeSkill(dir, "demo", { "a.py": "print(1)" })
        const skill = loadWithoutRunner(dir).skills[0]
        expect(skill?.scripts).toEqual([])
    })

    test("a skill with no scripts directory is fine", () => {
        const dir = root()
        writeSkill(dir, "demo")
        expect(load(dir).skills[0]?.scripts).toEqual([])
    })
})

describe("the runtime probe happens at load", () => {
    test("a missing interpreter fails the load, naming the skill, the file and the command", () => {
        const dir = root()
        writeSkill(dir, "demo", { "a.py": "print(1)" })
        const absent: ScriptRunner = { ...RUNNER, has: () => false }
        try {
            load(dir, absent)
            throw new Error("expected a throw")
        } catch (error) {
            const failure = error as { code?: string; message?: string; hint?: string }
            expect(failure.code).toBe("skill_runtime_missing")
            expect(failure.message).toContain("demo")
            expect(failure.message).toContain("a.py")
            expect(failure.message).toContain("python3")
            expect((failure.hint ?? "").length).toBeGreaterThan(0)
        }
    })

    test("a directly executable script needs no probe, so a bare machine still loads it", () => {
        const dir = root()
        writeSkill(dir, "demo", { "deploy.sh": "#!/bin/sh\necho hi\n" })
        // No executable bit was set, so this is the ignored path rather than the runnable one — which is
        // the point: nothing was probed, and nothing failed.
        const absent: ScriptRunner = { ...RUNNER, has: () => false }
        expect(load(dir, absent).skills[0]?.ignoredScripts.length).toBe(1)
    })

    test("each interpreter is probed once, however many skills need it", () => {
        const dir = root()
        writeSkill(dir, "one", { "a.py": "" })
        writeSkill(dir, "two", { "b.py": "" })
        writeSkill(dir, "three", { "c.py": "" })
        const asked: string[] = []
        load(dir, {
            ...RUNNER,
            has: (command) => {
                asked.push(command)
                return true
            },
        })
        expect(asked).toEqual(["python3"])
    })
})

// ─── the tools ───────────────────────────────────────────────────────────────────────────

describe("script tools", () => {
    function skillWith(scripts: Readonly<Record<string, string>>, extraRoot: string[] = []): Skill {
        const dir = root()
        writeSkill(dir, "demo", scripts, extraRoot)
        const skill = load(dir).skills[0]
        if (skill === undefined) throw new Error("no skill")
        return skill
    }

    test("the spec is untrusted and mutating, which are both the safe direction", () => {
        const [tool] = skillScriptTools({ skill: skillWith({ "a.py": "" }), runner: RUNNER })
        expect(tool?.spec.trust).toBe("untrusted")
        // Nothing here can know whether a script writes, and a write mislabelled as a read runs in
        // parallel *and* is retried — so the side effect happens twice.
        expect(tool?.spec.mutating).toBe(true)
        expect(tool?.spec.provider).toBe("skill")
    })

    test("it carries negative guidance, which both dialects render", () => {
        const [tool] = skillScriptTools({ skill: skillWith({ "a.py": "" }), runner: RUNNER })
        expect((tool?.spec.whenNotToUse ?? "").length).toBeGreaterThan(0)
    })

    test("the handler passes the interpreter, its args, the script path, then the model's args", () => {
        const seen: ScriptRunRequest[] = []
        const recorder: ScriptRunner = {
            has: () => true,
            run: (request) => {
                seen.push(request)
                return Promise.resolve({ ok: true, output: "done", code: 0, timedOut: false })
            },
        }
        const skill = skillWith({ "extract.py": "" }, ["pyproject.toml"])
        const [tool] = skillScriptTools({ skill, runner: recorder })
        return Promise.resolve(
            tool?.handler({ args: ["--in", "a.pdf"] }, toolContext(skill.dir)),
        ).then(() => {
            expect(seen[0]?.command).toBe("uv")
            expect(seen[0]?.args).toEqual(["run", "scripts/extract.py", "--in", "a.pdf"])
            expect(seen[0]?.cwd).toBe(skill.dir)
        })
    })

    test("a directly executable script is the command itself, relative to the skill", () => {
        const dir = root()
        writeSkill(dir, "demo", {})
        mkdirSync(join(dir, "demo", "scripts"), { recursive: true })
        writeFileSync(join(dir, "demo", "scripts", "deploy.sh"), "#!/bin/sh\n", { mode: 0o755 })
        const skill = load(dir).skills[0]
        if (skill === undefined) throw new Error("no skill")

        const seen: ScriptRunRequest[] = []
        const [tool] = skillScriptTools({
            skill,
            runner: {
                has: () => true,
                run: (request) => {
                    seen.push(request)
                    return Promise.resolve({ ok: true, output: "", code: 0, timedOut: false })
                },
            },
        })
        return Promise.resolve(tool?.handler({}, toolContext(skill.dir))).then(() => {
            expect(seen[0]?.command).toBe("./scripts/deploy.sh")
            expect(seen[0]?.args).toEqual([])
        })
    })

    test("the deadline is clamped under the harness's, so the child dies before the handler is abandoned", () => {
        // Without the margin the two race, and the loser is a process still running with nothing
        // referencing it — which is how the orphan count reached 33.
        const seen: ScriptRunRequest[] = []
        const [tool] = skillScriptTools({
            skill: skillWith({ "a.py": "" }),
            runner: {
                has: () => true,
                run: (request) => {
                    seen.push(request)
                    return Promise.resolve({ ok: true, output: "", code: 0, timedOut: false })
                },
            },
        })
        return Promise.resolve(tool?.handler({}, toolContext("/tmp", 120_000))).then(() => {
            expect(seen[0]?.timeoutMs).toBeLessThan(120_000)
            expect(seen[0]?.timeoutMs).toBe(115_000)
        })
    })

    test("a failing script throws with its own output, so the model can act on it", () => {
        const failing: ScriptRunner = {
            has: () => true,
            run: () =>
                Promise.resolve({
                    ok: false,
                    output: "Traceback: no such file 'a.pdf'",
                    code: 1,
                    timedOut: false,
                } satisfies ScriptRunResult),
        }
        const [tool] = skillScriptTools({ skill: skillWith({ "a.py": "" }), runner: failing })
        return Promise.resolve(tool?.handler({}, toolContext("/tmp")))
            .then(() => {
                throw new Error("expected a throw")
            })
            .catch((error: unknown) => {
                const failure = error as { code?: string; message?: string }
                expect(failure.code).toBe("skill_script_failed")
                expect(failure.message).toContain("no such file")
            })
    })

    test("a non-string argument is stringified rather than refused", () => {
        const seen: ScriptRunRequest[] = []
        const [tool] = skillScriptTools({
            skill: skillWith({ "a.py": "" }),
            runner: {
                has: () => true,
                run: (request) => {
                    seen.push(request)
                    return Promise.resolve({ ok: true, output: "", code: 0, timedOut: false })
                },
            },
        })
        return Promise.resolve(tool?.handler({ args: [3, true] }, toolContext("/tmp"))).then(() => {
            expect(seen[0]?.args).toContain("3")
            expect(seen[0]?.args).toContain("true")
        })
    })
})

// ─── rendering ───────────────────────────────────────────────────────────────────────────

describe("renderScripts", () => {
    function skillWith(scripts: Readonly<Record<string, string>>): Skill {
        const dir = root()
        writeSkill(dir, "demo", scripts)
        const skill = load(dir).skills[0]
        if (skill === undefined) throw new Error("no skill")
        return skill
    }

    test("a prose-only skill renders nothing, so it costs nothing", () => {
        expect(renderScripts(skillWith({}), true)).toBe("")
    })

    test("with a runner, every slug is named as callable now", () => {
        const text = renderScripts(skillWith({ "extract.py": "" }), true)
        expect(text).toContain("skill.demo.extract")
        expect(text).toContain("this turn only")
    })

    test("without a runner, it says the scripts exist and cannot run", () => {
        // The model is told what it was *not* given, which is decision 4.53's rule. Omitting them makes
        // an agent invent a workaround for a capability it cannot see it lacks.
        const text = renderScripts(skillWith({ "extract.py": "" }), false)
        expect(text).toContain("extract.py")
        expect(text).toContain("cannot run")
    })
})

function toolContext(dir: string, deadlineMs = 30_000) {
    return {
        agentId: "a",
        sessionKey: "s",
        turnId: "t",
        dir,
        signal: new AbortController().signal,
        deadlineMs,
        now: () => new Date(0),
    }
}
