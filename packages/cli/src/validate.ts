/**
 * `validate` — load a manifest through exactly the same path `run` uses, then report.
 *
 * Sharing the load path is the point. A validator that approves a manifest the runtime then refuses
 * is worse than no validator, so this calls `loadManifest` rather than reimplementing any part of it.
 *
 * Synchronous, and it imports neither Ink nor React. That is what keeps it at ~70 ms: the rich
 * renderer costs ~170-210 ms to import under Node, which would be most of this command's runtime.
 */

import {
    HarnessError,
    loadManifest,
    loadWorkspace,
    planWorkspace,
    resolveCapabilities,
    ruleBudgetFailure,
} from "@castellan/core"
import { EXIT_FAILURE, EXIT_OK } from "#lib/const"
import { PROVIDER_IDS } from "#lib/providers"
import type { ValidateOptions } from "#lib/schema"

export function validateCommand(options: ValidateOptions): number {
    try {
        const loaded = loadManifest(options.manifestPath, { knownProviders: PROVIDER_IDS })
        const { manifest } = loaded
        const capabilities = resolveCapabilities(
            manifest.model.main.id,
            manifest.model.main.capabilities,
        )

        // Loaded rather than counted, because the interesting failures are all in the loading:
        // a budget bust, a tier the frontmatter disagrees with, an unreadable file. `validate` that
        // only counted names would report ok on a manifest `run` refuses.
        const plan = planWorkspace(manifest.context, loaded.dir)
        const workspace = loadWorkspace({ refs: plan.refs, budgets: manifest.context.budgets })
        // The same check `run` applies, applied here for the same reason it exists at all: a
        // validator that accepts a manifest the runtime refuses is worse than no validator.
        const ruleFailure = ruleBudgetFailure(workspace, manifest.context.rules)
        if (ruleFailure !== undefined && manifest.context.rules.onExceed === "fail")
            throw ruleFailure

        const tiers = (["static", "volatile", "reminder"] as const)
            .map((tier) => {
                const names = workspace.files
                    .filter((file) => file.tier === tier)
                    .map((file) => file.name)
                if (names.length === 0) return undefined
                return `${tier}=${names.join(",")} (${workspace.tokens[tier]}/${manifest.context.budgets[tier]})`
            })
            .filter((entry) => entry !== undefined)
            .join(" ")

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
                        workspace: {
                            files: workspace.files.map((file) => ({
                                name: file.name,
                                tier: file.tier,
                                editable: file.editable,
                                tokens: file.tokens,
                                budget: file.budget,
                            })),
                            tokens: workspace.tokens,
                        },
                        warnings: [
                            ...plan.warnings,
                            ...(ruleFailure === undefined ? [] : [ruleFailure.toDetail()]),
                        ],
                    },
                    null,
                    2,
                )}\n`,
            )
            return EXIT_OK
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
                `  workspace    ${tiers === "" ? "(none)" : tiers}\n` +
                `  limits       maxSteps=${manifest.limits.maxSteps} turnTimeoutMs=${manifest.limits.turnTimeoutMs}\n` +
                [...plan.warnings, ...(ruleFailure === undefined ? [] : [ruleFailure.toDetail()])]
                    .map((warning) => `  warning      ${warning.message}\n`)
                    .join(""),
        )
        return EXIT_OK
    } catch (error) {
        if (options.json === true && error instanceof HarnessError) {
            process.stdout.write(
                `${JSON.stringify({ ok: false, error: error.toDetail(), details: error.details }, null, 2)}\n`,
            )
            // A returned code rather than `process.exit`: exiting here would discard buffered stdout
            // when this is piped, which is exactly how `--json` output gets read.
            return EXIT_FAILURE
        }
        throw error
    }
}
