/**
 * Where skills come from: a named list of repositories, machine-level and the person's.
 *
 * ## Why this is not in `agent.yaml`
 *
 * A source is a place *you* trust, not a property of one agent. Put it in the manifest and you add a
 * repository once per agent, and — worse — you put a fetchable URL inside the document the runtime
 * loads at boot, which is an invitation to resolve it there. Hard rule 4 exists because the runtime
 * this replaces spent four minutes on network calls during initialisation. Nothing here is reachable
 * from `Runtime.create`: this module lives in the CLI, every fetch is an explicit command a person
 * typed, and the runtime's only relationship with a source is that a directory was copied before it
 * ever started.
 *
 * `skills.sources` was a manifest field reserved for this and is deliberately gone (decision 11.46).
 * A field only a CLI reads is a field the runtime will eventually be asked to read.
 *
 * ## Built-ins are compiled in, never written to the file
 *
 * `DEFAULT_SOURCES` ships in the binary. If it were seeded into `sources.json` on first run, a repo
 * that moves would stay broken until every user hand-edited a file, and an upgrade could not fix it.
 * A user entry with a built-in's name overrides it; `sources remove <builtin>` records the name in
 * `disabled` instead, because a default is an endorsement and refusing to let someone drop one would
 * make the endorsement mandatory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HarnessError } from "@castellan/core"
import { sandboxRoot } from "#lib/sandbox"

/** A repository to look for skills in. */
export interface SourceSpec {
    /**
     * The nickname you install by — `install <agent> <name>/<skill>`.
     *
     * One path segment, so it can be a directory name in the cache and cannot be confused with the
     * `owner/repo` shorthand a URL uses.
     */
    readonly name: string
    /** Anything `git clone` accepts. */
    readonly url: string
    /**
     * Subdirectory holding the skill folders, if the repo does not keep them at the root.
     *
     * Load-bearing for more than tidiness: it is what `git sparse-checkout` narrows to, and narrowing
     * took `github/awesome-copilot` from 100 MB to 22 MB (measured). With no path the whole repository
     * is checked out, so a source without one is a source that costs its full size.
     */
    readonly path?: string
    /** Branch or tag. Omitted means whatever the remote's HEAD points at. */
    readonly ref?: string
    /** Shipped rather than added. Never written to the registry file. */
    readonly builtin?: boolean
}

/**
 * The two sources every install starts with.
 *
 * Both verified to exist, to use `skills/<name>/SKILL.md`, and to be readable without credentials on
 * 2026-08-17: `anthropics/skills` carries 18 skills, `github/awesome-copilot` 425. Deliberately short
 * — a default is an endorsement of somebody else's executable code, so the list holds the spec's own
 * authors and one large community catalogue, and everything else is `sources add`.
 */
export const DEFAULT_SOURCES: readonly SourceSpec[] = [
    {
        name: "anthropic",
        url: "https://github.com/anthropics/skills",
        path: "skills",
        builtin: true,
    },
    {
        name: "github",
        url: "https://github.com/github/awesome-copilot",
        path: "skills",
        builtin: true,
    },
]

/** One path segment, no dots, so it is safe as a cache directory and as a ref prefix. */
const SOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSourceName(name: string): boolean {
    return name.length > 0 && name.length <= 64 && SOURCE_NAME.test(name)
}

interface RegistryFile {
    readonly version?: number
    readonly sources?: readonly SourceSpec[]
    readonly disabled?: readonly string[]
}

const VERSION = 1

export function registryPath(env?: Readonly<Record<string, string | undefined>>): string {
    return join(sandboxRoot(env), "sources.json")
}

/** Where a source's working copy is cached. One directory per source name. */
export function cacheRoot(env?: Readonly<Record<string, string | undefined>>): string {
    return join(sandboxRoot(env), "sources")
}

export function cacheDir(name: string, env?: Readonly<Record<string, string | undefined>>): string {
    return join(cacheRoot(env), name)
}

function readRegistry(env?: Readonly<Record<string, string | undefined>>): RegistryFile {
    const path = registryPath(env)
    if (!existsSync(path)) return {}
    let parsed: unknown
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
        throw new HarnessError({
            code: "skill_sources_unreadable",
            message: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            hint: "Fix the file, or delete it — the built-in sources work with no file at all.",
        })
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new HarnessError({
            code: "skill_sources_unreadable",
            message: `${path} does not hold a JSON object`,
            hint: `Expected {"version": ${VERSION}, "sources": [...]}. Delete the file to start from the built-in sources.`,
        })
    }
    return parsed as RegistryFile
}

/**
 * Every source `search` and `install` will look in: built-ins minus disabled, then user entries.
 *
 * Order is the resolution order for a bare skill name, so built-ins are first and a user's own
 * additions are tried after — which is also why an overriding entry keeps the built-in's position
 * rather than moving to the end.
 */
export function loadSources(
    env?: Readonly<Record<string, string | undefined>>,
): readonly SourceSpec[] {
    const file = readRegistry(env)
    const added = (file.sources ?? []).filter((entry) => isSourceName(entry.name))
    const disabled = new Set(file.disabled ?? [])
    const overridden = new Map(added.map((entry) => [entry.name, entry]))

    const resolved: SourceSpec[] = []
    for (const builtin of DEFAULT_SOURCES) {
        if (disabled.has(builtin.name)) continue
        const override = overridden.get(builtin.name)
        resolved.push(override === undefined ? builtin : { ...override, builtin: false })
    }
    for (const entry of added) {
        if (DEFAULT_SOURCES.some((builtin) => builtin.name === entry.name)) continue
        resolved.push({ ...entry, builtin: false })
    }
    return resolved
}

function writeRegistry(
    file: RegistryFile,
    env?: Readonly<Record<string, string | undefined>>,
): void {
    const path = registryPath(env)
    mkdirSync(sandboxRoot(env), { recursive: true })
    const body: RegistryFile = {
        version: VERSION,
        sources: file.sources ?? [],
        ...(file.disabled === undefined || file.disabled.length === 0
            ? {}
            : { disabled: file.disabled }),
    }
    writeFileSync(path, `${JSON.stringify(body, null, 4)}\n`)
}

export function addSource(
    spec: SourceSpec,
    env?: Readonly<Record<string, string | undefined>>,
): void {
    const file = readRegistry(env)
    const kept = (file.sources ?? []).filter((entry) => entry.name !== spec.name)
    // Adding back a disabled built-in re-enables it; anything else would make `add` silently do
    // nothing for the one name most likely to be re-added.
    const disabled = (file.disabled ?? []).filter((name) => name !== spec.name)
    writeRegistry({ ...file, sources: [...kept, spec], disabled }, env)
}

/** Returns false when there was nothing by that name to remove. */
export function removeSource(
    name: string,
    env?: Readonly<Record<string, string | undefined>>,
): boolean {
    const file = readRegistry(env)
    const kept = (file.sources ?? []).filter((entry) => entry.name !== name)
    const wasAdded = kept.length !== (file.sources ?? []).length
    const builtin = DEFAULT_SOURCES.some((entry) => entry.name === name)
    const already = (file.disabled ?? []).includes(name)
    if (!wasAdded && !builtin) return false
    if (builtin && already && !wasAdded) return false
    const disabled = builtin && !already ? [...(file.disabled ?? []), name] : (file.disabled ?? [])
    writeRegistry({ ...file, sources: kept, disabled }, env)
    return true
}

/**
 * What a person types for a repository, turned into a clone URL and — where the URL says so — a ref
 * and a path.
 *
 * The browser URL case is the one that has to work: someone finding a skill collection pastes
 * `https://github.com/anthropics/skills/tree/main/skills`, which is not a clone URL and carries two
 * fields inside its path. Refusing it would mean the documented way to add a source is to hand-edit
 * what GitHub put in the address bar.
 */
export function parseSourceUrl(input: string): {
    readonly url: string
    readonly ref?: string
    readonly path?: string
} {
    const trimmed = input.trim()
    if (trimmed.length === 0) throw badUrl(input)

    // `owner/repo` — the shorthand every git front end accepts. Two segments exactly, so it cannot
    // swallow a path that was meant as one.
    if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
        return { url: `https://github.com/${trimmed.replace(/\.git$/, "")}` }
    }

    if (trimmed.startsWith("git@") || trimmed.startsWith("ssh://")) return { url: trimmed }

    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        throw badUrl(input)
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badUrl(input)

    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0)
    const cut = segments.findIndex((segment) => segment === "tree" || segment === "blob")
    if (cut < 2) {
        return { url: `${parsed.origin}/${segments.join("/")}`.replace(/\.git$/, "") }
    }
    const repo = segments.slice(0, cut).join("/")
    const ref = segments[cut + 1]
    const path = segments.slice(cut + 2).join("/")
    return {
        url: `${parsed.origin}/${repo}`.replace(/\.git$/, ""),
        ...(ref === undefined ? {} : { ref }),
        ...(path.length === 0 ? {} : { path }),
    }
}

function badUrl(input: string): HarnessError {
    return new HarnessError({
        code: "skill_source_url_invalid",
        message: `${JSON.stringify(input)} is not a repository`,
        hint: "Accepted: owner/repo, an https:// clone URL, a git@ SSH URL, or the page URL you were reading — .../tree/<branch>/<subdir> is understood.",
    })
}

/** A skill reference as typed: `pdf`, or `anthropic/pdf`. */
export interface SkillRef {
    readonly source?: string
    readonly skill: string
}

export function parseSkillRef(input: string): SkillRef {
    const parts = input.split("/").filter((part) => part.length > 0)
    if (parts.length === 1) return { skill: parts[0] as string }
    if (parts.length === 2) return { source: parts[0] as string, skill: parts[1] as string }
    throw new HarnessError({
        code: "skill_ref_invalid",
        message: `${JSON.stringify(input)} is neither a skill name nor <source>/<skill>`,
        hint: "Use `pdf` to search every source, or `anthropic/pdf` to name one. A path is taken as a path only if it exists on disk.",
    })
}
