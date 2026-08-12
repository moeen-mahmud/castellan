/**
 * Model role resolution: `main`, `selector`, `compactor`.
 *
 * Selector and compactor fall back to main — and fall back to the *same provider instance*, so
 * an unconfigured role costs nothing. Pointing selector and compactor at a cheap 3B model while
 * main is something larger is the intended production shape and usually the biggest available
 * cost win.
 */

import type { EnvSource } from "../manifest/env.ts"
import type { AgentManifest, ModelRole, ModelRoleConfig } from "../manifest/schema.ts"
import { type ModelCapabilities, resolveCapabilities } from "./capabilities.ts"
import { type ChatCompletionsConfig, createChatCompletionsProvider } from "./chat-completions.ts"
import type { FetchLike, ModelProvider } from "./provider.ts"

export interface ResolvedRole {
    readonly role: ModelRole
    /** The role this configuration came from — `main` when the role fell back. */
    readonly configuredAs: ModelRole
    readonly config: ModelRoleConfig
    readonly capabilities: ModelCapabilities
    readonly provider: ModelProvider
}

export type ResolvedRoles = Readonly<Record<ModelRole, ResolvedRole>>

export interface ResolveRolesOptions {
    readonly env?: EnvSource
    readonly fetch?: FetchLike
    readonly onRetry?: NonNullable<ChatCompletionsConfig["onRetry"]>
    readonly retry?: ChatCompletionsConfig["retry"]
}

function buildRole(
    role: ModelRole,
    configuredAs: ModelRole,
    config: ModelRoleConfig,
    options: ResolveRolesOptions,
): ResolvedRole {
    const capabilities = resolveCapabilities(config.id, config.capabilities)
    const provider = createChatCompletionsProvider({
        id: `chat-completions:${configuredAs}`,
        baseUrl: config.baseUrl,
        field: `model.${configuredAs}`,
        ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
    })

    return { role, configuredAs, config, capabilities, provider }
}

export function resolveRoles(
    manifest: AgentManifest,
    options: ResolveRolesOptions = {},
): ResolvedRoles {
    const main = buildRole("main", "main", manifest.model.main, options)

    const derive = (role: Exclude<ModelRole, "main">): ResolvedRole => {
        const config = manifest.model[role]
        if (config === undefined) return { ...main, role }
        return buildRole(role, role, config, options)
    }

    return { main, selector: derive("selector"), compactor: derive("compactor") }
}

/** Effective sampling parameters for a role, as sent on the wire. */
export function requestParamsFor(
    role: ResolvedRole,
    window: number,
    reserveOutput: number,
): { temperature?: number; topP?: number; maxTokens: number } {
    // Never derive max output from the window — a reasoning model given `window / 4` returns
    // empty with `finishReason: length`, and that failure looks like a broken agent rather than
    // a misconfigured limit.
    const ceiling = Math.min(role.capabilities.maxOutput, Math.max(1, reserveOutput))
    const maxTokens = Math.min(role.config.maxTokens ?? ceiling, window - 1)

    return {
        ...(role.config.temperature === undefined ? {} : { temperature: role.config.temperature }),
        ...(role.config.topP === undefined ? {} : { topP: role.config.topP }),
        maxTokens: Math.max(1, maxTokens),
    }
}
