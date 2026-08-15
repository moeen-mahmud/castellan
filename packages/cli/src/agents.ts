/**
 * `agents` — what one or more manifests produce.
 *
 * Small, and it proves the runtime hosts N agents from one process. It was inline in the entry point
 * before, which is how it ended up being the one command whose flags the usage text never mentioned.
 */

import { Runtime } from "@castellan/core"
import { ambientEnv } from "#lib/ambient"
import { EXIT_OK } from "#lib/const"
import { onExit } from "#lib/exit"
import { TOOL_PROVIDERS } from "#lib/providers"
import type { AgentsOptions } from "#lib/schema"

export async function agentsCommand(options: AgentsOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [...options.manifestPaths],
        toolProviders: TOOL_PROVIDERS,
        env: ambientEnv(options.manifestPaths),
    })
    onExit(() => runtime.stop("cli-exit"))

    const described = runtime.list().map((agent) => agent.describe())

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify({ agents: described }, null, 2)}\n`)
        return EXIT_OK
    }

    for (const agent of described) {
        process.stdout.write(`${agent.id}\t${agent.model}\twindow=${agent.window}\t${agent.name}\n`)
    }
    return EXIT_OK
}
