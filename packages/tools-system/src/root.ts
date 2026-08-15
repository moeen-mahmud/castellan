/**
 * Where the agent is allowed to change things.
 *
 * Protected paths (`protect.ts`) answer "which files are never writable". This answers the opposite
 * and more useful question: **which files are writable at all.** A deny list has to anticipate every
 * path worth protecting; a root has to anticipate nothing, because everything outside it is refused
 * by default and the list of exceptions is written by a person.
 *
 * ## The default is the workspace, not the agent directory
 *
 * `<agentDir>/workspace` — the directory the agent's own files already live in. An agent asked to
 * "save a summary" writes it beside its notes rather than into whatever directory the process happened
 * to start in, and an agent that has misunderstood a request cannot damage anything a person cares
 * about while misunderstanding it.
 *
 * A manifest with no `workspace/` falls back to the agent's own directory, because refusing every
 * write on a layout the runtime supports would be a worse answer than a narrower root.
 *
 * ## How a person opens it up
 *
 * `tools.providerConfig.writeRoots` — absolute paths, or paths relative to the agent directory. That
 * *is* "the user named where it may operate": it is in the manifest, in the file they read to
 * understand their agent, and it took a deliberate edit. Nothing the model says at runtime can add
 * one, which is the property that makes the default worth having.
 *
 * ## What this does not cover, said plainly
 *
 * **`exec` is not confined by it, and cannot be.** `sh -c "echo x > ~/notes"` carries its target
 * inside a string no path check can see; all this can do is decide where the shell *starts*. An agent
 * that pins `exec` has been granted the machine, and the roots below then apply only to the file
 * tools. That is a real reduction for a read-only or file-only agent and close to decorative for a
 * shell one — worth saying rather than leaving to be discovered.
 *
 * Reads are deliberately **not** confined. Being pointed at a project and asked about it is the
 * ordinary case, credentials are already refused everywhere by `protect.ts`, and a runtime that could
 * not read outside one directory would be answering a different question than the one anyone asked.
 */

import { existsSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

/** The subdirectory a workspace lives in, relative to the agent's own directory. */
export const WORKSPACE_DIR = "workspace"

export interface Roots {
    /** Where a relative path resolves and where writes are confined. Absolute. */
    readonly primary: string
    /** Additional writable roots from the manifest. Absolute. */
    readonly extra: readonly string[]
}

/**
 * Resolve the roots for an agent.
 *
 * `existsSync` rather than a promise because provider construction is synchronous, and because the
 * answer cannot change while the process lives: a `workspace/` created later does not retroactively
 * become the root of a session already running under a different one.
 */
export function resolveRoots(agentDir: string, writeRoots: readonly string[] = []): Roots {
    const base = resolve(agentDir)
    const workspace = resolve(base, WORKSPACE_DIR)
    return {
        primary: existsSync(workspace) ? workspace : base,
        extra: writeRoots.map((entry) =>
            isAbsolute(entry) ? resolve(entry) : resolve(base, entry),
        ),
    }
}

/** Is `absolute` inside `root`, counting the root itself? */
export function within(absolute: string, root: string): boolean {
    if (absolute === root) return true
    const rel = relative(root, absolute)
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)
}

/** Every writable root, primary first — the order the refusal message lists them in. */
export function writable(roots: Roots): readonly string[] {
    return [roots.primary, ...roots.extra]
}

/** True when this path may be written. */
export function isWritable(absolute: string, roots: Roots): boolean {
    return writable(roots).some((root) => within(absolute, root))
}
