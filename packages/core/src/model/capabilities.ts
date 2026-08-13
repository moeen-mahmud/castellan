/**
 * Per-model capability descriptors.
 *
 * A base URL and a key are not enough to drive a model correctly. Anthropic's compat endpoint
 * ignores `strict` on function calls; extended-thinking blocks must be replayed alongside tool
 * results or multi-step reasoning silently degrades; prompt-cache breakpoints are
 * provider-specific. Those are behavioural facts the loop has to know.
 *
 * **Capabilities never choose the tool dialect.** The dialect is config, so behaviour cannot
 * drift when someone swaps the model. Capabilities drive thinking-block replay and
 * cache-breakpoint placement, and nothing else.
 *
 * **This registry is conservative, not authoritative.** It is a shipped default that keeps a
 * misidentified model working badly rather than catastrophically — under-reporting a context
 * window wastes budget, while over-reporting it produces empty responses with
 * `finishReason: length`, which is the failure mode that costs a day to diagnose. Anything
 * wrong for your endpoint is one `model.<role>.capabilities` block away from fixed.
 */

import type { ModelCapabilitiesOverride } from "../manifest/schema.ts"

export interface ModelCapabilities {
    /** Whether the endpoint implements the `tools` parameter and `tool_calls` responses. */
    readonly nativeTools: boolean
    /** Whether `strict` schema conformance is honoured. Anthropic's compat endpoint ignores it. */
    readonly strictSchema: boolean
    /**
     * Reasoning protocol. Not a "does it think" flag — it says what the loop must *do* with
     * reasoning, and the non-`none` cases disagree with each other:
     *
     * - `anthropic` — blocks arrive separately and **must be replayed** alongside tool results,
     *   or multi-step reasoning silently degrades.
     * - `openai` — reasoning is server-side and opaque. Nothing to replay.
     * - `deepseek` — arrives as `reasoning_content`, separately from `content`, and is **not**
     *   replayed. Measured against api.deepseek.com on 2026-08-12: sending it back is *accepted*
     *   rather than rejected, but it buys nothing, and DeepSeek's own guidance for earlier
     *   reasoning models was to omit it. So the loop drops it.
     *
     * The distinction earns a fourth case rather than a boolean: collapsing `deepseek` into
     * `none` would let the model's scratchpad be delivered to the user as the reply, and
     * collapsing it into `anthropic` would replay text the provider never asked for.
     *
     * A separate consequence, and the one that actually bites: on a `deepseek` model, reasoning
     * tokens are billed against the **output** budget. A `max_tokens` too small to cover
     * reasoning returns empty content with `finish_reason: "length"` — verified, not theoretical.
     * `context.reserveOutput` has to be generous enough for reasoning plus the reply.
     */
    readonly thinking: "none" | "anthropic" | "openai" | "deepseek"
    /** Prompt-cache protocol, which determines where breakpoints go. */
    readonly promptCache: "none" | "anthropic" | "openai"
    readonly parallelToolCalls: boolean
    readonly contextWindow: number
    /** Max completion tokens. Never derive this from the window — see the note above. */
    readonly maxOutput: number
}

export interface CapabilityEntry {
    /** Glob over the model id. `*` matches any run of characters. */
    readonly pattern: string
    readonly capabilities: ModelCapabilities
    readonly note?: string
    /**
     * Provenance. Set when the values were measured against a live endpoint, with the date —
     * otherwise they came from provider documentation and are a conservative guess. Worth stating
     * explicitly: an unverified row that looks authoritative is how a wrong number survives.
     */
    readonly verified?: string
}

const CONSERVATIVE: ModelCapabilities = {
    nativeTools: false,
    strictSchema: false,
    thinking: "none",
    promptCache: "none",
    parallelToolCalls: false,
    contextWindow: 8192,
    maxOutput: 4096,
}

/**
 * Ordered for readability only — resolution picks the most specific match, not the first.
 */
export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = [
    // ── OpenAI ─────────────────────────────────────────────────────────────────────────────
    {
        pattern: "gpt-4o*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "none",
            promptCache: "openai",
            parallelToolCalls: true,
            contextWindow: 128_000,
            maxOutput: 16_384,
        },
    },
    {
        pattern: "gpt-4.1*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "none",
            promptCache: "openai",
            parallelToolCalls: true,
            contextWindow: 1_000_000,
            maxOutput: 32_768,
        },
    },
    {
        pattern: "gpt-4-turbo*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 128_000,
            maxOutput: 4096,
        },
    },
    {
        pattern: "gpt-3.5*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 16_385,
            maxOutput: 4096,
        },
    },
    {
        pattern: "gpt-5*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: true,
            contextWindow: 200_000,
            maxOutput: 32_768,
        },
        note: "Deliberately conservative on window and output. Override if your endpoint serves more.",
    },
    {
        pattern: "o1*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: false,
            contextWindow: 200_000,
            maxOutput: 100_000,
        },
    },
    {
        pattern: "o3*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: false,
            contextWindow: 200_000,
            maxOutput: 100_000,
        },
    },
    {
        pattern: "o4*",
        capabilities: {
            nativeTools: true,
            strictSchema: true,
            thinking: "openai",
            promptCache: "openai",
            parallelToolCalls: false,
            contextWindow: 200_000,
            maxOutput: 100_000,
        },
    },

    // ── Anthropic, via its OpenAI-compatible endpoint ──────────────────────────────────────
    {
        pattern: "claude-*",
        capabilities: {
            nativeTools: true,
            // Not a typo. The compat endpoint accepts `strict` and does not honour it, so the
            // coercion layer runs regardless of dialect.
            strictSchema: false,
            thinking: "anthropic",
            promptCache: "anthropic",
            parallelToolCalls: true,
            contextWindow: 200_000,
            maxOutput: 8192,
        },
        note: "Thinking blocks must be replayed with tool results or multi-step reasoning degrades silently.",
    },

    // ── Google, via its OpenAI-compatible endpoint ─────────────────────────────────────────
    {
        pattern: "gemini*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 1_000_000,
            maxOutput: 8192,
        },
    },

    // ── Open weights, typically local via Ollama or vLLM ───────────────────────────────────
    //
    // More specific patterns first: `patternSpecificity` decides, but reading order should match.
    {
        // qwen3.5 reasons, and the generic `qwen*` row below says it does not. Measured through
        // Ollama's OpenAI-compatible endpoint: reasoning arrives in a `reasoning` delta field,
        // separately from `content`, which is the `deepseek` protocol — separate field, nothing to
        // replay. Left as `none` it would be the "model's scratchpad delivered as the reply" case
        // the fourth enum value exists to prevent, and the empty-reply-at-`length` diagnosis would
        // name the wrong cause.
        pattern: "qwen3.5*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
        note: "Served locally by Ollama, which reports no token usage unless model.<role>.streamUsage is set — token figures come from the estimator until it is. Reasoning is billed to the output budget, so context.reserveOutput must cover reasoning plus the reply.",
        verified: "2026-08-13 against qwen3.5:9b on localhost:11434/v1",
    },
    {
        pattern: "qwen*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
    },
    {
        pattern: "llama*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 128_000,
            maxOutput: 4096,
        },
    },
    {
        pattern: "mistral*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
    },
    {
        pattern: "mixtral*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 32_768,
            maxOutput: 8192,
        },
    },
    // ── DeepSeek ───────────────────────────────────────────────────────────────────────────
    // `promptCache: "none"` is not "no caching" anywhere below. DeepSeek caches context
    // automatically server-side — its responses carry `prompt_cache_hit_tokens` — with no
    // breakpoints for a client to place. `none` is a statement about the runtime's job, not the
    // provider's behaviour.
    //
    // The v4 rows were measured; the older rows came from documentation. See `verified`.
    {
        pattern: "deepseek-v4-pro*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            // One `tool_calls` entry came back for a single-tool prompt, which demonstrates tool
            // calling but not parallelism. Left conservative until something proves otherwise.
            parallelToolCalls: false,
            // A floor, not a ceiling: `max_tokens: 393216` alongside an 85-token prompt was
            // accepted, so the real window is at least 393,301. Claiming only what was shown.
            contextWindow: 393_216,
            // Authoritative — the endpoint's own rejection message names the range:
            // "the valid range of max_tokens is [1, 393216]".
            maxOutput: 393_216,
        },
        note: "Reasoning tokens are billed to the output budget. With max_tokens=16 this model returned empty content and finish_reason=length; context.reserveOutput must cover reasoning plus the reply.",
        verified: "2026-08-12 against api.deepseek.com/v1",
    },
    {
        pattern: "deepseek-v4-flash*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            // Verified: flash streams reasoning_content too. It is a reasoning model, not a
            // cheap non-reasoning sibling, which is the assumption a "flash" name invites.
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 393_216,
            maxOutput: 393_216,
        },
        verified:
            "2026-08-12 against api.deepseek.com/v1 (reasoning confirmed; limits assumed same as pro)",
    },
    {
        pattern: "deepseek-v4*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 393_216,
            maxOutput: 393_216,
        },
        note: "Family fallback for v4 ids this registry has not seen. Assumes reasoning, because both measured v4 models emit it.",
    },
    {
        pattern: "deepseek-reasoner*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
        note: "Not served by the account this registry was tested against. Numbers are from provider documentation and are deliberately low — override them if your endpoint serves this id.",
    },
    {
        pattern: "deepseek-chat*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: true,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
        note: "Unverified, from provider documentation.",
    },
    {
        pattern: "deepseek-r1*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "deepseek",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
        note: "The open-weight name for the reasoner, used by self-hosted and Ollama deployments.",
    },
    {
        pattern: "deepseek*",
        capabilities: {
            nativeTools: true,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 65_536,
            maxOutput: 8192,
        },
    },
    {
        pattern: "gemma*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 8192,
            maxOutput: 4096,
        },
    },
    {
        pattern: "phi*",
        capabilities: {
            nativeTools: false,
            strictSchema: false,
            thinking: "none",
            promptCache: "none",
            parallelToolCalls: false,
            contextWindow: 16_384,
            maxOutput: 4096,
        },
    },

    { pattern: "*", capabilities: CONSERVATIVE },
]

export function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
        char === "*" ? ".*" : `\\${char}`,
    )
    return new RegExp(`^${escaped}$`, "i")
}

/** Literal characters in the pattern. More literal characters means more specific. */
export function patternSpecificity(pattern: string): number {
    return pattern.replace(/\*/g, "").length
}

/**
 * Candidate ids to match against, most qualified first. Gateways prefix ids with a vendor
 * (`openai/gpt-4o`, `anthropic/claude-3-5-sonnet`), so the bare model name is tried too.
 */
function candidateIds(modelId: string): string[] {
    const slash = modelId.lastIndexOf("/")
    const bare = slash === -1 ? undefined : modelId.slice(slash + 1)
    const colon = modelId.indexOf(":")
    // Ollama tags: `qwen3.5:9b`.
    const untagged = colon === -1 ? undefined : modelId.slice(0, colon)
    const candidates = [modelId, bare, untagged]
    if (bare !== undefined) {
        const bareColon = bare.indexOf(":")
        if (bareColon !== -1) candidates.push(bare.slice(0, bareColon))
    }
    return candidates.filter((id): id is string => id !== undefined && id !== "")
}

/**
 * The most specific matching entry. Ties break toward the longer pattern, then toward
 * declaration order — resolution has to be deterministic or two identical deployments
 * behave differently.
 */
export function matchCapabilities(modelId: string): CapabilityEntry {
    const candidates = candidateIds(modelId)
    let best:
        | { entry: CapabilityEntry; specificity: number; length: number; index: number }
        | undefined

    for (const [index, entry] of CAPABILITY_REGISTRY.entries()) {
        const regex = globToRegExp(entry.pattern)
        if (!candidates.some((candidate) => regex.test(candidate))) continue

        const specificity = patternSpecificity(entry.pattern)
        const length = entry.pattern.length
        if (
            best === undefined ||
            specificity > best.specificity ||
            (specificity === best.specificity && length > best.length) ||
            (specificity === best.specificity && length === best.length && index < best.index)
        ) {
            best = { entry, specificity, length, index }
        }
    }

    // The registry ends in `*`, so this is unreachable in practice. Keeping the fallback means a
    // future edit that removes it degrades instead of throwing.
    return best?.entry ?? { pattern: "*", capabilities: CONSERVATIVE }
}

/** Registry match merged with a manifest override. Only defined override keys are applied. */
export function resolveCapabilities(
    modelId: string,
    override?: ModelCapabilitiesOverride,
): ModelCapabilities {
    const base = matchCapabilities(modelId).capabilities
    if (override === undefined) return base

    const defined: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(override)) {
        if (value !== undefined) defined[key] = value
    }
    return { ...base, ...defined } as ModelCapabilities
}
