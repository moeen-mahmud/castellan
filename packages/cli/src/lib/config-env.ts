/**
 * Whether a variable an agent depends on is actually set, from that agent's point of view.
 *
 * `ambientEnv` is **not** this. It layers the *cwd*'s `.env` against an agent's — demoting a colliding
 * variable so a project checkout cannot silently change which model a sandbox agent runs on — and it
 * returns `process.env` unchanged whenever nothing is in tension. It never *adds* the agent's own file.
 *
 * The agent's `.env` is merged by `loadManifest`, through core's `layeredEnv`, and that is the answer a
 * question about this agent needs. Reading `process.env` alone reported a variable as unset while the
 * file beside the manifest plainly had it — the same class of mistake `serve` made once, reporting
 * "unauthenticated" for a token sitting next to the manifest. It showed up here as an editor row that
 * still read `(not set)` immediately after somebody set it, which is the "did that work?" failure this
 * whole surface exists to remove.
 *
 * Precedence is core's, unchanged: the real environment wins, because an operator's export has to beat
 * a file for a container to be able to configure the agent it runs.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type EnvSource, layeredEnv, parseDotEnv } from "@dispach/core"
import { ambientEnv } from "#lib/ambient"

/** The environment this agent will actually see: its own `.env` under the ambient one. */
export function agentEnv(manifestPath: string): EnvSource {
    const path = join(dirname(manifestPath), ".env")
    let beside: Record<string, string> = {}
    if (existsSync(path)) {
        try {
            beside = parseDotEnv(readFileSync(path, "utf8"))
        } catch {
            // An unreadable `.env` is reported by the loader, in the words the loader uses. Here it
            // simply means nothing is known to be set, which is the safe reading for a "is it set?"
            // question — claiming a variable is present when the file cannot be read would be worse.
        }
    }
    return layeredEnv(beside, ambientEnv([manifestPath]))
}

/** Whether `name` has a non-empty value. Empty counts as unset: it fails a load exactly as absent does. */
export function isSet(env: EnvSource, name: string): boolean {
    const value = env[name]
    return value !== undefined && value !== ""
}
