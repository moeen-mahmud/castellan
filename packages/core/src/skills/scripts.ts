/**
 * Which interpreter runs a skill's script — decided here, executed somewhere else.
 *
 * Everything in this file is a pure function over a directory listing. **Core spawns nothing**, and the
 * split is not tidiness: `exec` lives in `packages/tools-system` because core is what an embedder runs
 * *other people's* agents on, and a package that starts processes there is one every provisioned agent
 * gets with no way to decline it. That package also already owns every rule about child processes that
 * was expensive to learn — process groups, so `kill(-pid)` reaches all of `sh -c "a | b | c"` instead of
 * orphaning two stages; a file descriptor rather than a pipe, so backgrounding is possible at all; a
 * concurrency cap; and `ToolProvider.stop()` as the only reaper. A second spawn path in core would have
 * to rediscover all of it, and the last time something here leaked children it put 33 orphaned shells on
 * a machine, a load average of 351, and a 132-second `runtime.ready`.
 *
 * So core decides *what to run* and `ScriptRunner` carries it across the boundary.
 *
 * The ladder is the one `01-ARCHITECTURE.md` publishes, with one clarification it left open: the Python
 * metadata rule applies to Python scripts only. A skill shipping both a `pyproject.toml` and a
 * `report.ts` must not have `uv run report.ts` attempted on it.
 */

/** Files that mark a skill as carrying its own Python environment. */
const PYTHON_METADATA: readonly string[] = ["pyproject.toml", "requirements.txt"]

export interface ScriptPlan {
    /** `skill.<skill>.<script>` — the slug the model calls and `tools.policy` can name. */
    readonly slug: string
    /** Basename inside `scripts/`. */
    readonly file: string
    /**
     * The interpreter, or **absent** when the script's own shebang decides.
     *
     * Absent rather than a sentinel like `"self"` because the two cases take different argument lists,
     * and the caller — which is the only layer holding an absolute path — has to branch anyway. A
     * sentinel would let that branch be forgotten and produce a literal `self` on a command line.
     */
    readonly interpreter?: string
    /** Interpreter arguments, before the script path. Empty for a direct execution. */
    readonly args: readonly string[]
    /**
     * The runtime that must be present on the machine, when one must.
     *
     * Absent for a directly executable script, which needs nothing but its own shebang — and a missing
     * shebang interpreter is a failure the kernel reports at exec time, not something this can predict.
     */
    readonly requires?: string
}

export type ScriptResolution =
    | { readonly kind: "runnable"; readonly plan: ScriptPlan }
    /**
     * Present in `scripts/` and not executable by any rule here.
     *
     * Reported rather than dropped, because `scripts/deploy.sh` with no executable bit looks installed
     * and never runs — the silently-unreachable shape this codebase refuses everywhere. `skills validate`
     * turns these into warnings; a `README.md` in `scripts/` produces one too, which is noise worth
     * accepting to catch the case that matters.
     */
    | { readonly kind: "ignored"; readonly file: string; readonly reason: string }

export interface InterpreterInput {
    /** The skill's name, for the slug. */
    readonly skill: string
    /** Basename inside `scripts/`. */
    readonly file: string
    /** Basenames at the skill root, for Python metadata detection. */
    readonly root: readonly string[]
    /** Whether the file carries an executable bit. */
    readonly executable: boolean
    /** Which runtime is hosting, for `.ts` and `.js`. */
    readonly host: "bun" | "node"
}

export function scriptSlug(skill: string, file: string): string {
    return `skill.${skill}.${file.replace(/\.[^.]+$/, "")}`
}

export function interpreterFor(input: InterpreterInput): ScriptResolution {
    const slug = scriptSlug(input.skill, input.file)
    const extension = /\.([^.]+)$/.exec(input.file)?.[1]?.toLowerCase()

    if (extension === "py") {
        const managed = input.root.some((name) => PYTHON_METADATA.includes(name))
        return managed
            ? {
                  kind: "runnable",
                  plan: {
                      slug,
                      file: input.file,
                      interpreter: "uv",
                      args: ["run"],
                      requires: "uv",
                  },
              }
            : {
                  kind: "runnable",
                  plan: {
                      slug,
                      file: input.file,
                      interpreter: "python3",
                      args: [],
                      requires: "python3",
                  },
              }
    }

    if (extension === "ts" || extension === "js") {
        // The host, not a hardcoded runtime. A skill's `.ts` script under Bun runs without a build step
        // and under Node needs 22's type stripping, and either way the interpreter already running this
        // process is the one known to exist.
        return {
            kind: "runnable",
            plan: {
                slug,
                file: input.file,
                interpreter: input.host,
                args: [],
                requires: input.host,
            },
        }
    }

    if (input.executable) {
        // `./script`, with the shebang deciding. `requires` is deliberately absent: the interpreter is
        // named inside the file, and guessing at it here would produce a load-time refusal for a script
        // that runs perfectly.
        return { kind: "runnable", plan: { slug, file: input.file, args: [] } }
    }

    return {
        kind: "ignored",
        file: input.file,
        reason:
            extension === undefined
                ? "it has no extension and no executable bit"
                : `nothing here runs a .${extension} file, and it has no executable bit`,
    }
}
