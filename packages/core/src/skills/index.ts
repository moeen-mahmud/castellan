/**
 * The skill catalogue: one scan of `<skills.dir>/*​/SKILL.md`, frontmatter retained and bodies not.
 *
 * ## What "frontmatter only" actually buys
 *
 * The architecture doc says bodies are never read at boot, and the literal version of that is not
 * achievable — the frontmatter is at the top of the same file, so the bytes come off the disk either
 * way. What is achievable, and what the phrase is really about, is that **no body is retained, rendered
 * or tokenised twice**: a cold scan measures each body once and keeps the number, and a warm scan does
 * not open the files at all. Fifty skills of prose held in memory and re-tokenised every boot is the
 * cost being avoided, not fifty `read()` calls.
 *
 * Measuring at index time is what makes `skillOverBudget` possible. A skill whose body exceeds the whole
 * activation budget can never be selected, and this codebase refuses that shape at load everywhere it
 * appears rather than leaving something silently unreachable — which means the size has to be known
 * before anything is selected, so it is measured here and cached.
 *
 * ## The cache
 *
 * `<agentDir>/<stateDir>/skills.idx.json`, shaped like `tools-composio`'s resolution cache: a version
 * integer so an old file is ignored rather than misread, atomic temp-then-rename so a reader never sees
 * half of one, and every failure path treated as "no cache" because at boot that is the correct
 * response to absent, unreadable, truncated and stale alike.
 *
 * It is keyed per skill on mtime and size, so touching one file re-reads one file. It also carries the
 * `PromptStyle` the token counts were measured under and is discarded wholesale when that changes:
 * `delimiters: xml` and `delimiters: markdown` render the same body to different lengths, so a cache
 * moved between two models would report a budget figure for a rendering nobody is using.
 *
 * Synchronous and filesystem-only, called inside boot where hard rule 4 puts the network out of reach.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BRAND } from "../brand.ts"
import { estimateTokens } from "../context/tokens.ts"
import { skillOverBudget, skillRuntimeMissing, skillsDirMissing } from "../errors.ts"
import { DEFAULT_PROMPT_STYLE, type PromptStyle, renderPromptStyle } from "../model/prompt-style.ts"
import type { ScriptRunner } from "../tools/types.ts"
import { parseSkillFile, type SkillFrontmatter } from "./frontmatter.ts"
import { interpreterFor, type ScriptPlan } from "./scripts.ts"

/** Bumped when the cached shape changes, so an old file is ignored rather than misread. */
const CACHE_VERSION = 1
const CACHE_FILE = "skills.idx.json"
const SKILL_FILE = "SKILL.md"
const SCRIPTS_DIR = "scripts"

export interface Skill {
    /** Spec-validated and equal to the directory's basename, so it is safe in a tool slug. */
    readonly name: string
    /** Absolute, and the root every relative path inside the skill resolves against. */
    readonly dir: string
    readonly frontmatter: SkillFrontmatter
    /** What the rendered body will cost. Measured on a cold scan, then carried in the cache. */
    readonly tokens: number
    /**
     * Runnable entries in `scripts/`, exposed as tools only while this skill is active.
     *
     * Empty when the skill ships none, or when no `ScriptRunner` was supplied — an embedder without one
     * gets skills without scripts, which is coherent: a skill carrying only prose is a valid skill.
     */
    readonly scripts: readonly ScriptPlan[]
    /**
     * Files in `scripts/` that nothing here can run, with the reason.
     *
     * Carried so `skills validate` can warn. `scripts/deploy.sh` with no executable bit looks installed
     * and never runs, which is the shape that has to be said out loud rather than dropped.
     */
    readonly ignoredScripts: readonly { readonly file: string; readonly reason: string }[]
}

export interface SkillCatalogue {
    /** Sorted by name, so ranking ties break the same way on every machine. */
    readonly skills: readonly Skill[]
    readonly maxActive: number
    readonly budget: number
    readonly threshold: number
    /** True when every entry came from the cache — reported by `skills list`, and what the boot
     * criterion measures. */
    readonly cached: boolean
}

export interface LoadSkillsOptions {
    /** Absolute. The caller resolves it against the manifest directory. */
    readonly dir: string
    readonly maxActive: number
    readonly budget: number
    readonly threshold: number
    /** The same style the workspace rendered with, so the two cannot drift. */
    readonly style?: PromptStyle
    /**
     * The agent's own directory, under which the cache is written. Omitted means no caching — which
     * is what a test wants, and what a read-only workspace gets.
     */
    readonly agentDir?: string
    /**
     * How a script gets run, and how an interpreter gets probed. Omitted means scripts are not
     * discovered at all rather than discovered and unrunnable.
     */
    readonly runner?: ScriptRunner
    /** Which runtime hosts a `.ts` or `.js` script. Defaults to whichever is executing.  */
    readonly host?: "bun" | "node"
}

export function cachePath(agentDir: string): string {
    return join(agentDir, BRAND.stateDir, CACHE_FILE)
}

interface CachedSkill {
    readonly mtimeMs: number
    readonly size: number
    readonly tokens: number
    readonly frontmatter: SkillFrontmatter
    /**
     * The `scripts/` directory's own mtime, or 0 when there is none.
     *
     * Separate from `SKILL.md`'s because adding `scripts/new.py` does not touch `SKILL.md`, so keying the
     * entry on that alone would leave a new script undiscovered until something unrelated changed. The
     * gap that remains is a `chmod +x` on an existing file, which changes neither mtime — documented
     * rather than solved, because the fix is stat-ing every script on every warm boot to catch a case
     * that a restart already handles.
     */
    readonly scriptsMtimeMs: number
    readonly scripts: readonly ScriptPlan[]
    readonly ignoredScripts: readonly { readonly file: string; readonly reason: string }[]
}

interface CacheFile {
    readonly version: number
    /** The rendering the token counts were measured under. A change discards the whole file. */
    readonly style: string
    readonly skills: Readonly<Record<string, CachedSkill>>
}

function styleKey(style: PromptStyle): string {
    return `${style.delimiters}/${style.intensity}/${style.examplesIn}/${style.skillsIn}`
}

export function loadSkills(options: LoadSkillsOptions): SkillCatalogue {
    const style = options.style ?? DEFAULT_PROMPT_STYLE

    let names: string[]
    try {
        if (!statSync(options.dir).isDirectory()) throw new Error("not a directory")
        names = readdirSync(options.dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
    } catch {
        throw skillsDirMissing(options.dir, options.dir)
    }

    const cache =
        options.agentDir === undefined ? undefined : readCache(options.agentDir, styleKey(style))
    const fresh: Record<string, CachedSkill> = {}
    const skills: Skill[] = []
    let allCached = true

    for (const name of names.sort()) {
        const dir = join(options.dir, name)
        const path = join(dir, SKILL_FILE)

        // A directory without a SKILL.md is not a skill and not an error: `assets/` or a stray folder
        // beside the skills is ordinary, and refusing the load over one would make the directory
        // unusable for anything else.
        let stat: { mtimeMs: number; size: number }
        try {
            const found = statSync(path)
            if (!found.isFile()) continue
            stat = { mtimeMs: found.mtimeMs, size: found.size }
        } catch {
            continue
        }

        const scriptsMtimeMs = directoryMtime(join(dir, SCRIPTS_DIR))
        const hit = cache?.skills[name]
        if (
            hit !== undefined &&
            hit.mtimeMs === stat.mtimeMs &&
            hit.size === stat.size &&
            hit.scriptsMtimeMs === scriptsMtimeMs
        ) {
            fresh[name] = hit
            skills.push({
                name,
                dir,
                frontmatter: hit.frontmatter,
                tokens: hit.tokens,
                scripts: hit.scripts,
                ignoredScripts: hit.ignoredScripts,
            })
            continue
        }

        allCached = false
        const parsed = parseSkillFile(name, readFileSync(path, "utf8"))
        const tokens = estimateTokens(renderPromptStyle(parsed.body, style))
        const found =
            options.runner === undefined
                ? { scripts: [], ignoredScripts: [] }
                : discoverScripts(name, dir, options.host ?? hostRuntime())
        fresh[name] = { ...stat, scriptsMtimeMs, tokens, frontmatter: parsed.frontmatter, ...found }
        skills.push({ name, dir, frontmatter: parsed.frontmatter, tokens, ...found })
    }

    // Checked after the scan rather than inside it so one oversized skill is reported against the
    // budget it broke, with every skill's size already known.
    for (const skill of skills) {
        if (skill.tokens > options.budget) {
            throw skillOverBudget(skill.name, skill.tokens, options.budget)
        }
    }

    // Probed on every load, warm cache included: a machine can gain or lose an interpreter between
    // boots, and a cached "python3 was here last week" is exactly the kind of stale fact that turns into
    // a failure at the moment the model finally reaches for the script.
    const runner = options.runner
    if (runner !== undefined) {
        const seen = new Set<string>()
        for (const skill of skills) {
            for (const script of skill.scripts) {
                const required = script.requires
                if (required === undefined) continue
                if (!seen.has(required)) {
                    seen.add(required)
                    if (!runner.has(required)) {
                        throw skillRuntimeMissing(skill.name, script.file, required)
                    }
                }
            }
        }
    }

    if (options.agentDir !== undefined && !allCached) {
        writeCache(options.agentDir, {
            version: CACHE_VERSION,
            style: styleKey(style),
            skills: fresh,
        })
    }

    return {
        skills,
        maxActive: options.maxActive,
        budget: options.budget,
        threshold: options.threshold,
        cached: allCached && skills.length > 0,
    }
}

/** The host runtime, for a `.ts` or `.js` script. The one interpreter guaranteed to exist. */
function hostRuntime(): "bun" | "node" {
    return typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"
}

/** 0 for an absent directory, so "no scripts" and "scripts unchanged" are the same comparison. */
function directoryMtime(path: string): number {
    try {
        const found = statSync(path)
        return found.isDirectory() ? found.mtimeMs : 0
    } catch {
        return 0
    }
}

/**
 * Resolve every file in `scripts/` to an interpreter, or to a stated reason it has none.
 *
 * Sorted, so two machines with the same skill expose its scripts in the same order — the catalogue a
 * model reads should not depend on directory iteration order.
 */
function discoverScripts(
    name: string,
    dir: string,
    host: "bun" | "node",
): {
    scripts: readonly ScriptPlan[]
    ignoredScripts: readonly { readonly file: string; readonly reason: string }[]
} {
    let entries: string[]
    let root: string[]
    try {
        entries = readdirSync(join(dir, SCRIPTS_DIR), { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort()
        root = readdirSync(dir)
    } catch {
        return { scripts: [], ignoredScripts: [] }
    }

    const scripts: ScriptPlan[] = []
    const ignoredScripts: { file: string; reason: string }[] = []
    for (const file of entries) {
        const resolution = interpreterFor({
            skill: name,
            file,
            root,
            executable: isExecutable(join(dir, SCRIPTS_DIR, file)),
            host,
        })
        if (resolution.kind === "runnable") scripts.push(resolution.plan)
        else ignoredScripts.push({ file: resolution.file, reason: resolution.reason })
    }
    return { scripts, ignoredScripts }
}

/** Any execute bit — owner, group or other. `access(X_OK)` would answer for *this* process only. */
function isExecutable(path: string): boolean {
    try {
        return (statSync(path).mode & 0o111) !== 0
    } catch {
        return false
    }
}

function isCachedSkill(value: unknown): value is CachedSkill {
    if (typeof value !== "object" || value === null) return false
    const entry = value as Partial<CachedSkill>
    return (
        typeof entry.mtimeMs === "number" &&
        typeof entry.size === "number" &&
        typeof entry.tokens === "number" &&
        typeof entry.frontmatter === "object" &&
        entry.frontmatter !== null &&
        typeof entry.frontmatter.name === "string" &&
        typeof entry.frontmatter.description === "string" &&
        typeof entry.scriptsMtimeMs === "number" &&
        Array.isArray(entry.scripts) &&
        Array.isArray(entry.ignoredScripts)
    )
}

/**
 * Read the cache, or nothing.
 *
 * Never throws. Absent, unreadable, truncated, written by an older version, or measured under a
 * different rendering all have the same correct answer at boot: scan cold.
 */
function readCache(agentDir: string, style: string): CacheFile | undefined {
    let raw: string
    try {
        raw = readFileSync(cachePath(agentDir), "utf8")
    } catch {
        return undefined
    }
    try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== "object" || parsed === null) return undefined
        const file = parsed as Partial<CacheFile>
        if (file.version !== CACHE_VERSION) return undefined
        if (file.style !== style) return undefined
        const skills: Record<string, CachedSkill> = {}
        for (const [name, entry] of Object.entries(file.skills ?? {})) {
            if (isCachedSkill(entry)) skills[name] = entry
        }
        return { version: CACHE_VERSION, style, skills }
    } catch {
        return undefined
    }
}

/**
 * Write the cache, and never fail the boot over it.
 *
 * A workspace mounted read-only is a real deployment — an embedder shipping an image of agents —
 * and a cache is an optimisation. Losing it costs one cold scan per boot and nothing else, which is
 * not worth refusing to start over.
 */
function writeCache(agentDir: string, file: CacheFile): void {
    const path = cachePath(agentDir)
    try {
        mkdirSync(dirname(path), { recursive: true })
        const temp = `${path}.${process.pid}.tmp`
        writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
        renameSync(temp, path)
    } catch {
        // Deliberately silent here and reported by `skills list`, which can say "uncached" next to
        // the reason. A warning on every turn of a read-only deployment is a warning nobody reads.
    }
}
