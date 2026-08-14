/**
 * Where this package puts the files it needs, and what it calls itself.
 *
 * Output spills into the system temp directory rather than into the agent's own directory. The agent
 * directory is somebody's project — scattering log files through it is an unasked-for side effect of
 * running a command, and one that shows up in their `git status`. The temp directory is the one place
 * a program is allowed to leave something without asking.
 *
 * The name is derived from `BRAND`, never written out, so a rename stays one commit (hard rule 3).
 */

import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "@castellan/core"

/** `tools.provider` names this to get shell and file tools. Also `ToolSpec.provider`. */
export const SYSTEM_PROVIDER_ID = "system"

/**
 * Kept between runs on purpose: a spilled output file is handed to the model as a path, and deleting
 * it at the end of the turn would break the one thing spilling exists to make possible. The operating
 * system reclaims this directory on its own schedule, which is what it is for.
 */
export function spillDir(): string {
    return join(tmpdir(), `${BRAND.slug}-${SYSTEM_PROVIDER_ID}`)
}
