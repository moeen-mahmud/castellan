/**
 * The `agent.yaml` schema, in full, per docs/02-SPEC-MANIFEST.md.
 *
 * Two deliberate choices:
 *
 * **Shape here, semantics in validate.ts.** Zod checks structure and applies defaults; every
 * cross-field rule and every semantic constraint lives in `validate.ts`, where a failure can
 * carry a field path *and* a hint naming the fix. Zod's "Invalid url" satisfies neither.
 *
 * **Unknown keys are rejected, not stripped.** A typo'd key that silently does nothing is the
 * exact class of failure rule 8 exists to prevent: the config looks applied and isn't. The one
 * exception is `channels[]`, whose type-specific fields belong to the channel plugin's own
 * schema and must survive to reach it.
 *
 * Sections beyond Phase 1 (tools, phases, skills, memory, channels, schedules, plugins) are
 * fully specified here so a forward-looking manifest validates, and are refused at load by
 * `validate.ts` rather than silently ignored.
 */

import { z } from "zod"
import { BRAND } from "../brand.ts"

const slug = z.string().min(1)

export const ModelCapabilitiesSchema = z
    .object({
        nativeTools: z.boolean().optional(),
        strictSchema: z.boolean().optional(),
        thinking: z.enum(["none", "anthropic", "openai", "deepseek"]).optional(),
        promptCache: z.enum(["none", "anthropic", "openai"]).optional(),
        parallelToolCalls: z.boolean().optional(),
        contextWindow: z.number().int().positive().optional(),
        maxOutput: z.number().int().positive().optional(),
    })
    .strict()

export const ModelRoleSchema = z
    .object({
        /** Sent verbatim as the `model` parameter. */
        id: z.string().min(1),
        /** Must end at the version segment; the runtime appends `/chat/completions`. */
        baseUrl: z.string().min(1),
        /** The *name* of an env var. A literal key here fails validation. */
        apiKeyEnv: z.string().min(1).optional(),
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        maxTokens: z.number().int().positive().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        capabilities: ModelCapabilitiesSchema.optional(),
    })
    .strict()

export const ModelSchema = z
    .object({
        main: ModelRoleSchema,
        /** Cheap model for tool selection. Falls back to `main`. */
        selector: ModelRoleSchema.optional(),
        /** Cheap model for summarisation. Falls back to `main`. */
        compactor: ModelRoleSchema.optional(),
    })
    .strict()

export const ThresholdsSchema = z
    .object({
        trim: z.number().default(0.6),
        snip: z.number().default(0.7),
        micro: z.number().default(0.8),
        collapse: z.number().default(0.88),
        reset: z.number().default(0.95),
    })
    .strict()

export const ContextSchema = z
    .object({
        /** Total token budget. Defaults to the model's `contextWindow` capability. */
        window: z.number().int().positive().optional(),
        reserveOutput: z.number().int().positive().default(4096),
        observationMaxTokens: z.number().int().positive().default(2000),
        /** Ordered, concatenated into slot 0. Relative to the manifest. Missing file = failure. */
        files: z.array(z.string().min(1)).default([]),
        thresholds: ThresholdsSchema.prefault({}),
    })
    .strict()

export const ToolBudgetSchema = z
    .object({
        max: z.number().int().positive().default(24),
        /** Slots held for mutating tools so reads cannot starve writes. */
        reserveWrite: z.number().int().nonnegative().default(6),
    })
    .strict()

export const ToolsSchema = z
    .object({
        /** Config only — never auto-detected, so behaviour cannot drift with the model. */
        dialect: z.enum(["nlt", "native"]).default("nlt"),
        provider: slug.optional(),
        providerConfig: z.record(z.string(), z.unknown()).default({}),
        budget: ToolBudgetSchema.prefault({}),
        pinned: z.array(z.string().min(1)).default([]),
        search: z
            .object({ enabled: z.boolean().default(false) })
            .strict()
            .prefault({}),
        local: z.array(z.string().min(1)).default([]),
    })
    .strict()

export const PhaseSchema = z
    .object({
        /** Slugs, `tag:<name>` annotations, or `*`. */
        allow: z.array(z.string().min(1)),
        entry: z.boolean().optional(),
    })
    .strict()

export const SkillsSchema = z
    .object({
        dir: z.string().min(1).default("./skills"),
        maxActive: z.number().int().nonnegative().default(1),
        /** Normalised BM25 floor. Below it, no skill activates. */
        threshold: z.number().default(0.35),
        sources: z.array(z.string().min(1)).default([]),
    })
    .strict()

export const MemorySchema = z
    .object({
        retriever: z.string().min(1).default("fts5"),
        dir: z.string().min(1).default("./memory"),
        k: z.number().int().nonnegative().default(6),
        includeHistory: z.boolean().default(true),
    })
    .strict()

/**
 * Not strict: `tokenEnv`, `mode`, `authDir` and friends are validated by the channel plugin's
 * own schema, and stripping them here would delete the channel's entire configuration.
 */
export const ChannelSchema = z
    .object({
        type: slug,
        id: slug,
        /** Inbound allowlist. `["*"]` permits anyone. Inbound only — no effect on delivery. */
        allowFrom: z.array(z.string().min(1)).optional(),
        enabled: z.boolean().default(true),
    })
    .passthrough()

export const DeliveryTargetSchema = z.object({ channel: slug, to: z.string().min(1) }).strict()

export const DeliverySchema = z
    .object({
        /** Channel used when a turn has no origin — schedules, API-initiated turns. */
        default: slug.optional(),
        targets: z.record(z.string(), DeliveryTargetSchema).default({}),
    })
    .strict()

export const ScheduleSchema = z
    .object({
        id: slug,
        kind: z.enum(["cron", "every", "at"]),
        /** cron: 5 or 6 field. every: duration (`15m`). at: ISO 8601, max +10 years. */
        expr: z.string().min(1),
        task: z.string().min(1),
        /** Required at write time — `{channel,to}` or the literal `"none"`. */
        deliver: z.union([z.literal("none"), DeliveryTargetSchema]),
        session: z.string().min(1).default("isolated"),
        enabled: z.boolean().default(true),
        /** IANA name. Defaults to `TZ`, then UTC. */
        timezone: z.string().min(1).optional(),
    })
    .strict()

export const PluginRefSchema = z.union([
    z.string().min(1),
    z
        .object({
            spec: z.string().min(1),
            config: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
])

export const LimitsSchema = z
    .object({
        /** Steps per turn before forced termination, reported as `reason: max_steps`. */
        maxSteps: z.number().int().positive().default(12),
        /** Must exceed any upstream timeout on the model endpoint. */
        turnTimeoutMs: z.number().int().positive().default(1_800_000),
        toolTimeoutMs: z.number().int().positive().default(120_000),
        /** Read-only tools only; mutating tools always serialise. */
        maxParallelTools: z.number().int().positive().default(4),
    })
    .strict()

export const ServerSchema = z
    .object({
        enabled: z.boolean().default(false),
        port: z.number().int().min(1).max(65535).default(7420),
        /** Loopback by default. A public bind is explicit, and requires a token. */
        host: z.string().min(1).default("127.0.0.1"),
        tokenEnv: z.string().min(1).default(`${BRAND.envPrefix}API_TOKEN`),
    })
    .strict()

export const AgentManifestSchema = z
    .object({
        apiVersion: z.string().min(1),
        id: slug,
        name: z.string().min(1).optional(),
        /** Path to a base manifest. Shallow merge; arrays replace. */
        extends: z.string().min(1).optional(),

        model: ModelSchema,
        context: ContextSchema.prefault({}),
        tools: ToolsSchema.prefault({}),
        phases: z.record(z.string(), PhaseSchema).optional(),
        skills: SkillsSchema.optional(),
        memory: MemorySchema.optional(),
        channels: z.array(ChannelSchema).default([]),
        delivery: DeliverySchema.optional(),
        schedules: z.array(ScheduleSchema).default([]),
        plugins: z.array(PluginRefSchema).default([]),
        limits: LimitsSchema.prefault({}),
        server: ServerSchema.prefault({}),
    })
    .strict()

export type ModelCapabilitiesOverride = z.infer<typeof ModelCapabilitiesSchema>
export type ModelRoleConfig = z.infer<typeof ModelRoleSchema>
export type ModelConfig = z.infer<typeof ModelSchema>
export type ContextConfig = z.infer<typeof ContextSchema>
export type ThresholdsConfig = z.infer<typeof ThresholdsSchema>
export type ToolsConfig = z.infer<typeof ToolsSchema>
export type PhaseConfig = z.infer<typeof PhaseSchema>
export type SkillsConfig = z.infer<typeof SkillsSchema>
export type MemoryConfig = z.infer<typeof MemorySchema>
export type ChannelConfig = z.infer<typeof ChannelSchema>
export type DeliveryConfig = z.infer<typeof DeliverySchema>
export type ScheduleConfig = z.infer<typeof ScheduleSchema>
export type LimitsConfig = z.infer<typeof LimitsSchema>
export type ServerConfig = z.infer<typeof ServerSchema>
export type AgentManifest = z.infer<typeof AgentManifestSchema>

/** The role names a manifest may configure. */
export const MODEL_ROLES = ["main", "selector", "compactor"] as const
export type ModelRole = (typeof MODEL_ROLES)[number]
