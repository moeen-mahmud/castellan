/**
 * Where an installed skill came from, recorded beside the skills rather than inside them.
 *
 * ## Why not in the skill's own frontmatter
 *
 * `metadata` is the spec's extension point and would accept it, and writing there would still be the
 * wrong move: decision 6.1's compliance claim is checked by vendoring a skill from `anthropics/skills`
 * **unmodified**, and a copy this tool has edited is no longer that. Provenance is a fact about the
 * copy, not about the skill.
 *
 * ## Why not in the agent's state directory
 *
 * `<agentDir>/<stateDir>/` is a cache — `skills.idx.json` lives there and is safe to delete. This is
 * not cache: it is the answer to "where did this folder of somebody else's code come from", which is
 * worth committing alongside the skills it describes. So it sits at `<skills dir>/.origins.json`, one
 * file for the whole directory rather than one per skill, and the loader never sees it because
 * `loadSkills` scans `<dir>/*​/SKILL.md` and a file is not a directory.
 *
 * Hidden by a leading dot to keep it out of the way, and surfaced by `skills list` so it is not hidden
 * *information* — a distinction this codebase has already had to make once, for boot warnings emitted
 * into an empty room.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const ORIGINS_FILE = ".origins.json"

export interface Origin {
    /** The source's nickname at the time of installing. */
    readonly source: string
    readonly url: string
    /** Path inside the repository — what to read to see the upstream copy. */
    readonly repoPath: string
    /** Short commit the copy was taken from. What makes "has upstream changed?" answerable. */
    readonly commit: string
    readonly ref?: string
    readonly installedAt: string
}

interface OriginsFile {
    readonly version?: number
    readonly origins?: Readonly<Record<string, Origin>>
}

const VERSION = 1

export function originsPath(skillsDir: string): string {
    return join(skillsDir, ORIGINS_FILE)
}

export function readOrigins(skillsDir: string): Readonly<Record<string, Origin>> {
    const path = originsPath(skillsDir)
    if (!existsSync(path)) return {}
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as OriginsFile
        return parsed.origins ?? {}
    } catch {
        // A record of where things came from is not worth failing a listing over, and the next install
        // rewrites it. Silent here and only here: nothing downstream depends on it being present.
        return {}
    }
}

export function recordOrigins(skillsDir: string, added: Readonly<Record<string, Origin>>): void {
    const merged = { ...readOrigins(skillsDir), ...added }
    writeFileSync(
        originsPath(skillsDir),
        `${JSON.stringify({ version: VERSION, origins: merged }, null, 4)}\n`,
    )
}

/** Called by `remove`, so a deleted skill does not leave a claim about a directory that is gone. */
export function forgetOrigin(skillsDir: string, name: string): void {
    const origins = readOrigins(skillsDir)
    if (origins[name] === undefined) return
    const kept = Object.fromEntries(Object.entries(origins).filter(([skill]) => skill !== name))
    writeFileSync(
        originsPath(skillsDir),
        `${JSON.stringify({ version: VERSION, origins: kept }, null, 4)}\n`,
    )
}
