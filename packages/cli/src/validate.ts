/**
 * `validate` — load a manifest through exactly the same path `run` uses, then report.
 *
 * Sharing the load path is the point. A validator that approves a manifest the runtime then
 * refuses is worse than no validator, so this calls `loadManifest` rather than reimplementing
 * any part of it.
 */

import { HarnessError, loadManifest, resolveCapabilities } from "@castellan/core"

export interface ValidateOptions {
    readonly manifestPath: string
    readonly json?: boolean
}

export async function validateCommand(options: ValidateOptions): Promise<void> {
    try {
        const loaded = loadManifest(options.manifestPath)
        const { manifest } = loaded
        const capabilities = resolveCapabilities(
            manifest.model.main.id,
            manifest.model.main.capabilities,
        )

        if (options.json === true) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        ok: true,
                        path: loaded.path,
                        id: manifest.id,
                        model: manifest.model.main.id,
                        window: loaded.window,
                        capabilities,
                    },
                    null,
                    2,
                )}\n`,
            )
            return
        }

        const roles = (["main", "selector", "compactor"] as const)
            .map((role) => {
                const config = manifest.model[role]
                return config === undefined ? `${role}=→main` : `${role}=${config.id}`
            })
            .join(" ")

        process.stdout.write(
            `ok  ${loaded.path}\n` +
                `  id           ${manifest.id}${manifest.name === undefined ? "" : ` (${manifest.name})`}\n` +
                `  models       ${roles}\n` +
                `  window       ${loaded.window} (reserveOutput ${manifest.context.reserveOutput}, maxOutput ${capabilities.maxOutput})\n` +
                `  capabilities thinking=${capabilities.thinking} promptCache=${capabilities.promptCache} nativeTools=${capabilities.nativeTools} strictSchema=${capabilities.strictSchema}\n` +
                `  dialect      ${manifest.tools.dialect}\n` +
                `  context      ${manifest.context.files.length} file(s): ${manifest.context.files.join(", ") || "(none)"}\n` +
                `  limits       maxSteps=${manifest.limits.maxSteps} turnTimeoutMs=${manifest.limits.turnTimeoutMs}\n`,
        )
    } catch (error) {
        if (options.json === true && error instanceof HarnessError) {
            process.stdout.write(
                `${JSON.stringify({ ok: false, error: error.toDetail(), details: error.details }, null, 2)}\n`,
            )
            process.exit(1)
        }
        throw error
    }
}
