/**
 * The `tools` command: `<binary> tools <manifest> [--warm]`.
 *
 * Two jobs, and the split matters.
 *
 * Without `--warm` it boots the runtime and prints the catalogue the model will actually see. That is
 * the same view the in-session `/tools` command renders, from the same `toolsReport` — a second
 * formatter would eventually disagree with the first about what is pinned.
 *
 * With `--warm` it does **not** boot. It loads the manifest, constructs the provider directly, and
 * fetches every pinned slug into the resolution cache. Booting would be circular: a remote provider
 * resolves from disk so that nothing touches the network before `runtime.ready`, so an empty cache
 * fails the load on unresolved slugs — which means the post-readiness refresh that would have filled
 * the cache never runs. This command is how the cache gets its first contents.
 */

import { loadManifest, Runtime } from "@castellan/core"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { PROVIDER_IDS, TOOL_PROVIDERS } from "#lib/providers"
import { toolsReport, toolsView } from "#lib/session-commands"

export interface ToolsOptions {
    readonly manifestPath: string
    readonly warm?: boolean
    readonly json?: boolean
}

interface WarmResult {
    readonly provider: string
    readonly fetched: number
    readonly changed: readonly string[]
    readonly missing: readonly string[]
    readonly cachePath: string
}

export async function toolsCommand(options: ToolsOptions): Promise<number> {
    return options.warm === true ? await warm(options) : await show(options)
}

async function warm(options: ToolsOptions): Promise<number> {
    const loaded = loadManifest(options.manifestPath, { knownProviders: PROVIDER_IDS })
    const id = loaded.manifest.tools.provider
    const pinned = loaded.manifest.tools.pinned

    if (id === undefined) {
        // Not an error worth exiting 1 for, but saying nothing would leave someone waiting for a
        // network call that was never going to happen.
        process.stdout.write(
            "nothing to warm — this manifest names no tools.provider, so every tool it pins resolves locally.\n",
        )
        return EXIT_OK
    }
    if (pinned.length === 0) {
        process.stdout.write(
            `nothing to warm — tools.provider is "${id}" but tools.pinned is empty, so there are no schemas to fetch.\n`,
        )
        return EXIT_OK
    }

    // `loadManifest` already refused an unregistered id, so this is present.
    const factory = TOOL_PROVIDERS[id]
    if (factory === undefined) return EXIT_FAILURE

    const provider = factory({
        dir: loaded.dir,
        env: loaded.env,
        config: loaded.manifest.tools.providerConfig,
        agentId: loaded.manifest.id,
    })

    if (provider.refresh === undefined) {
        process.stdout.write(
            `nothing to warm — the "${id}" provider resolves without a cache, so there is nothing to fetch ahead of time.\n`,
        )
        return EXIT_OK
    }

    const report = await provider.refresh(pinned)
    const cachePath =
        "cachePath" in report && typeof report.cachePath === "string" ? report.cachePath : ""
    const result: WarmResult = {
        provider: id,
        fetched: report.fetched,
        changed: [...report.changed],
        missing: [...report.missing],
        cachePath,
    }

    if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
        process.stdout.write(
            `${result.fetched} of ${pinned.length} pinned tools fetched from ${id}\n`,
        )
        if (result.changed.length > 0) {
            process.stdout.write(`  changed: ${result.changed.join(", ")}\n`)
        }
        if (cachePath !== "") process.stdout.write(`  cache: ${cachePath}\n`)
        for (const slug of result.missing) {
            process.stdout.write(`  missing: ${slug} — ${id} has no tool with that slug\n`)
        }
    }

    // A slug the provider does not have is a manifest error, and exiting 0 here would let it through
    // to a load failure on the next start — after the person believed this had succeeded.
    return result.missing.length > 0 ? EXIT_FAILURE : EXIT_OK
}

async function show(options: ToolsOptions): Promise<number> {
    const runtime = await Runtime.create({
        agents: [options.manifestPath],
        toolProviders: TOOL_PROVIDERS,
    })
    try {
        const agent = runtime.list()[0]
        if (agent === undefined) throw new Error("The manifest produced no agent.")

        const view = toolsView(agent)
        process.stdout.write(
            options.json === true ? `${JSON.stringify(view, null, 2)}\n` : `${toolsReport(view)}\n`,
        )
        return EXIT_OK
    } finally {
        await runtime.stop("cli-exit")
    }
}
