/**
 * The home sandbox: where agents live when nobody says otherwise.
 *
 * `~/<stateDir>/` (brand-derived, so a rename moves it) holds `agents/<ref>/` for init-created
 * agents and `store.db` for their sessions. One root, one store: the store schema is already
 * keyed by agent id, and a cwd-relative default meant the same agent got a different session
 * history in every directory you happened to be in.
 *
 * Discovery reads manifest *headers*, never `loadManifest`: loading expands env references and
 * checks that key variables are set, so a picker built on it would fail exactly when it is
 * needed most — on a machine where the key is not exported yet. A broken manifest becomes a
 * listed entry with a `problem`, never a broken listing.
 *
 * Tests override the root with `<ENVPREFIX>HOME` pointed at a tmpdir; nothing here touches the
 * real home directory when that is set.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { BRAND, HarnessError, nearest, readManifestHeader } from "@castellan/core"
import { readEnv } from "#lib/env"

export function sandboxRoot(
    env: Readonly<Record<string, string | undefined>> = process.env,
): string {
    const override = readEnv(env).sandboxHome
    return override ?? join(homedir(), BRAND.stateDir)
}

export function agentsDir(env?: Readonly<Record<string, string | undefined>>): string {
    return join(sandboxRoot(env), "agents")
}

export function storePath(env?: Readonly<Record<string, string | undefined>>): string {
    return join(sandboxRoot(env), "store.db")
}

export interface SandboxAgent {
    /** The directory name — what `run <ref>` takes. Filesystem-unique by construction. */
    readonly ref: string
    /** Absolute agent directory. */
    readonly dir: string
    /** Absolute path to its agent.yaml. */
    readonly manifestPath: string
    /** From the manifest header; may differ from `ref` for hand-copied directories. */
    readonly id?: string
    readonly name?: string
    /** Raw — may literally be an unexpanded `${MODEL_ID}` reference. */
    readonly modelId?: string
    /** Modification time of the manifest, for "recently used" ordering hints. */
    readonly mtimeMs: number
    /** Present when the manifest could not be read; the entry lists anyway, honestly. */
    readonly problem?: string
}

/**
 * Every agent directory in the sandbox, alphabetical by ref with broken entries last.
 *
 * Broken means the header could not be read — the entry still appears, carrying the problem,
 * because a listing that silently hides a corrupted agent turns "why is my agent gone" into a
 * filesystem investigation. Duplicate manifest ids are marked the same way: both run, but their
 * sessions share a store keyed by that id, which is worth a warning rather than a pretence.
 */
export function listAgents(
    env?: Readonly<Record<string, string | undefined>>,
): readonly SandboxAgent[] {
    const dir = agentsDir(env)
    let entries: string[]
    try {
        entries = readdirSync(dir)
    } catch {
        // No sandbox yet is the normal first-run state, not an error.
        return []
    }

    const agents: SandboxAgent[] = []
    for (const ref of entries.sort()) {
        const agentDir = join(dir, ref)
        const manifestPath = join(agentDir, "agent.yaml")
        try {
            if (!statSync(agentDir).isDirectory()) continue
        } catch {
            continue
        }
        if (!existsSync(manifestPath)) continue

        let mtimeMs = 0
        try {
            mtimeMs = statSync(manifestPath).mtimeMs
        } catch {
            // Raced away between existsSync and statSync; list it with what we have.
        }

        try {
            const header = readManifestHeader(manifestPath)
            agents.push({
                ref,
                dir: agentDir,
                manifestPath,
                mtimeMs,
                ...(header.id === undefined ? {} : { id: header.id }),
                ...(header.name === undefined ? {} : { name: header.name }),
                ...(header.modelId === undefined ? {} : { modelId: header.modelId }),
            })
        } catch (error) {
            agents.push({
                ref,
                dir: agentDir,
                manifestPath,
                mtimeMs,
                problem: error instanceof Error ? error.message : String(error),
            })
        }
    }

    // Duplicate manifest ids share session history — say so rather than pretend it is fine.
    const byId = new Map<string, SandboxAgent[]>()
    for (const agent of agents) {
        if (agent.id === undefined) continue
        byId.set(agent.id, [...(byId.get(agent.id) ?? []), agent])
    }
    const marked = agents.map((agent) => {
        if (agent.id === undefined || (byId.get(agent.id)?.length ?? 0) < 2) return agent
        return {
            ...agent,
            problem: `manifest id "${agent.id}" is shared with another sandbox agent — their sessions share one history`,
        }
    })

    return [
        ...marked.filter((a) => a.problem === undefined),
        ...marked.filter((a) => a.problem !== undefined),
    ]
}

/**
 * Turn what the user typed into a manifest path.
 *
 * The filesystem wins: anything that looks like a path (a separator, a .yaml suffix, or a thing
 * that exists here) is a path, so `./milo` always forces the file even when a sandbox agent
 * `milo` exists — the same rule git applies to pathspec-versus-branch, with the same free escape
 * hatch. Only then is the ref tried as a sandbox agent name.
 */
export function resolveAgentRef(
    ref: string,
    env?: Readonly<Record<string, string | undefined>>,
    cwd: string = process.cwd(),
): string {
    const looksLikePath =
        ref.includes(sep) || ref.includes("/") || ref.endsWith(".yaml") || ref.endsWith(".yml")
    const asPath = isAbsolute(ref) ? ref : resolve(cwd, ref)

    // A bare name that happens to exist in the cwd wins as a path — but silently running the
    // wrong agent is worse than one stderr line. Only fires on genuine ambiguity.
    if (!looksLikePath && existsSync(asPath) && existsSync(join(agentsDir(env), ref))) {
        process.stderr.write(
            `note: using ./${ref} from the current directory; a sandbox agent "${ref}" also exists — run it from elsewhere, or as ${join(agentsDir(env), ref)}\n`,
        )
    }

    if (looksLikePath || existsSync(asPath)) {
        if (existsSync(asPath)) {
            if (statSync(asPath).isDirectory()) {
                const inside = join(asPath, "agent.yaml")
                if (existsSync(inside)) return inside
                throw new HarnessError({
                    code: "cli_agent_dir_without_manifest",
                    message: `${ref} is a directory with no agent.yaml inside.`,
                    hint: "Point at the manifest itself, or at a directory that holds one. Sandbox agents are run by bare name, with no path separators.",
                })
            }
            return asPath
        }
        throw new HarnessError({
            code: "cli_agent_path_missing",
            message: `${ref} looks like a path, and nothing is there.`,
            hint: `Paths resolve against the current directory. For an agent in the sandbox, use its bare name — \`${BRAND.slug} run <name>\` — which resolves under ${agentsDir(env)}.`,
        })
    }

    const sandboxManifest = join(agentsDir(env), ref, "agent.yaml")
    if (existsSync(sandboxManifest)) return sandboxManifest

    const known = listAgents(env).map((agent) => agent.ref)
    const suggestion = nearest(ref, known)
    throw new HarnessError({
        code: "cli_agent_unknown",
        message: `No agent named "${ref}" in the sandbox${known.length === 0 ? ", which is empty" : ""}.`,
        hint:
            known.length === 0
                ? `Create one with \`${BRAND.slug} init\`, or pass a path to an agent.yaml.`
                : `Known agents: ${known.join(", ")}.${suggestion === undefined ? "" : ` Did you mean ${suggestion}?`} A path (./dir or file.yaml) is also accepted.`,
    })
}
