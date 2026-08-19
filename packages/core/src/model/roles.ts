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
    readonly onUsageUnsupported?: NonNullable<ChatCompletionsConfig["onUsageUnsupported"]>
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
        ...(config.streamUsage === undefined ? {} : { streamUsage: config.streamUsage }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
        ...(options.onUsageUnsupported === undefined
            ? {}
            : { onUsageUnsupported: options.onUsageUnsupported }),
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
): {
    temperature?: number
    topP?: number
    /** Absent unless `model.<role>.maxTokens` was configured. See below. */
    maxTokens?: number
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high"
} {
    // `max_tokens` is sent ONLY when someone asked for it.
    //
    // It used to be `min(capabilities.maxOutput, reserveOutput)`, and that conflated two different
    // questions. `context.reserveOutput` answers "how much of the window do I keep free so the
    // prompt cannot crowd out the reply" — a budgeting number, and it still does exactly that in
    // `assembleContext`. `model.<role>.maxTokens` answers "what is the most the endpoint may
    // generate". Feeding the first into the second turned a budget into a hard truncation, and on a
    // reasoning model that truncation lands on the thinking: qwen3.5:9b hit the 8,192 the generated
    // manifest happened to reserve and returned **empty content**, reported as
    // `empty_reply_output_exhausted` on a limit nobody chose.
    //
    // Omitted, the endpoint applies its own default, which is what every other client does and what
    // the endpoint is in a position to get right. `window - 1` still bounds an explicit value,
    // because a cap larger than the window is a request that cannot be served.
    const configured = role.config.maxTokens
    const maxTokens =
        configured === undefined
            ? undefined
            : Math.max(1, Math.min(configured, role.capabilities.maxOutput, window - 1))

    return {
        ...(role.config.temperature === undefined ? {} : { temperature: role.config.temperature }),
        ...(role.config.topP === undefined ? {} : { topP: role.config.topP }),
        ...(role.config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: role.config.reasoningEffort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
    }
}
