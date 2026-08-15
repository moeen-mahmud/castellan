/**
 * Which tool providers a manifest asked for, in one answer.
 *
 * `tools.providers` is a map and `tools.provider` is the scalar it replaced. Three call sites need to
 * agree about what a manifest selected — the runtime that builds them, `validate` that checks the ids
 * are registered, and the `tools` command that warms them — and a check only one of them performs is
 * a check they disagree on. So the reading happens once, here, and returns both the selections and
 * whatever needs saying about how they were written.
 *
 * **Both forms set is a hard failure, never a merge.** Merging would produce an order nobody wrote:
 * the alias has no position in the map, so "first" would be whichever the implementation happened to
 * push. The same call `context.files` made, for the same reason.
 */

import type { ErrorDetail } from "../errors.ts"
import { toolsProviderAliasConflict } from "../errors.ts"

export interface ProviderSelection {
    readonly id: string
    /** That provider's own block, verbatim. Core never looks inside it. */
    readonly config: Readonly<Record<string, unknown>>
    /** True when this came from the deprecated scalar. Only the warning cares. */
    readonly legacy: boolean
}

/** The shape this reads. Narrower than `AgentManifest["tools"]` so a test can call it with a literal. */
export interface ProviderFields {
    readonly providers?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined
    readonly provider?: string | undefined
    readonly providerConfig?: Readonly<Record<string, unknown>> | undefined
}

export interface ProviderPlan {
    readonly selections: readonly ProviderSelection[]
    /** Non-fatal; the runtime emits these as `agent.warning`. */
    readonly warnings: readonly ErrorDetail[]
}

export function resolveProviders(tools: ProviderFields): ProviderPlan {
    const map = tools.providers ?? {}
    const ids = Object.keys(map)
    const legacyId = tools.provider
    const legacyConfig = tools.providerConfig ?? {}

    if (ids.length > 0 && (legacyId !== undefined || Object.keys(legacyConfig).length > 0)) {
        throw toolsProviderAliasConflict(ids, legacyId)
    }

    if (legacyId !== undefined) {
        return {
            selections: [{ id: legacyId, config: legacyConfig, legacy: true }],
            warnings: [
                {
                    code: "tools_provider_deprecated",
                    message: `tools.provider is deprecated; "${legacyId}" was loaded as tools.providers.${legacyId}.`,
                    hint: `Rewrite it as:\n  tools:\n    providers:\n      ${legacyId}: { … the contents of providerConfig … }\nThe scalar permits exactly one provider, which is why an agent could not have the shell and the web at the same time. It still works and will keep working for now; nothing about the resolved catalogue changes.`,
                    field: "tools.provider",
                },
            ],
        }
    }

    const selections = ids.map((id) => ({ id, config: map[id] ?? {}, legacy: false }))

    // A non-empty `providerConfig` with nothing to configure. Not a hard error — the field defaults
    // to `{}` and an empty one means nothing — but silence would leave a manifest whose settings look
    // applied and are not, which is the exact failure the provider packages refuse unknown keys to
    // avoid. It is also the natural half-finished state of a migration.
    if (Object.keys(legacyConfig).length > 0) {
        return {
            selections,
            warnings: [
                {
                    code: "tools_provider_config_orphaned",
                    message: `tools.providerConfig has ${Object.keys(legacyConfig).length} setting(s) and no tools.provider names a provider to apply them to, so they do nothing.`,
                    hint: "Move them into the matching tools.providers.<id> block and delete tools.providerConfig. Reported rather than ignored: a configuration that looks applied and is not is worse than one that fails.",
                    field: "tools.providerConfig",
                },
            ],
        }
    }

    return { selections, warnings: [] }
}

/** Just the ids, for a message that has to list them. */
export function providerIds(tools: ProviderFields): readonly string[] {
    return Object.keys(tools.providers ?? {}).concat(
        tools.provider === undefined ? [] : [tools.provider],
    )
}
