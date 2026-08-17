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
import { skillOverBudget, skillsDirMissing } from "../errors.ts"
import { DEFAULT_PROMPT_STYLE, type PromptStyle, renderPromptStyle } from "../model/prompt-style.ts"
import { parseSkillFile, type SkillFrontmatter } from "./frontmatter.ts"

/** Bumped when the cached shape changes, so an old file is ignored rather than misread. */
const CACHE_VERSION = 1
const CACHE_FILE = "skills.idx.json"
const SKILL_FILE = "SKILL.md"

export interface Skill {
    /** Spec-validated and equal to the directory's basename, so it is safe in a tool slug. */
    readonly name: string
    /** Absolute, and the root every relative path inside the skill resolves against. */
    readonly dir: string
    readonly frontmatter: SkillFrontmatter
    /** What the rendered body will cost. Measured on a cold scan, then carried in the cache. */
    readonly tokens: number
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
}

export function cachePath(agentDir: string): string {
    return join(agentDir, BRAND.stateDir, CACHE_FILE)
}

interface CachedSkill {
    readonly mtimeMs: number
    readonly size: number
    readonly tokens: number
    readonly frontmatter: SkillFrontmatter
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

        const hit = cache?.skills[name]
        if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
            fresh[name] = hit
            skills.push({ name, dir, frontmatter: hit.frontmatter, tokens: hit.tokens })
            continue
        }

        allCached = false
        const parsed = parseSkillFile(name, readFileSync(path, "utf8"))
        const tokens = estimateTokens(renderPromptStyle(parsed.body, style))
        fresh[name] = { ...stat, tokens, frontmatter: parsed.frontmatter }
        skills.push({ name, dir, frontmatter: parsed.frontmatter, tokens })
    }

    // Checked after the scan rather than inside it so one oversized skill is reported against the
    // budget it broke, with every skill's size already known.
    for (const skill of skills) {
        if (skill.tokens > options.budget) {
            throw skillOverBudget(skill.name, skill.tokens, options.budget)
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
        typeof entry.frontmatter.description === "string"
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
