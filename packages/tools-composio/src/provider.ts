/**
 * The Composio `ToolProvider`.
 *
 * Two paths, and keeping them apart is the whole design:
 *
 * - **`resolve()`** runs in boot phase 3, before `runtime.ready`. It reads the on-disk cache and makes
 *   no request. A slug that is not cached is a named load failure carrying the warm command, not a
 *   silent network call and not a silently dropped tool.
 * - **`refresh()`** runs after readiness. It fetches, rewrites the cache, and reports what changed.
 *
 * `resolve()` deliberately omits slugs it does not know rather than throwing. The registry diffs what
 * came back against what was asked for and fails naming every missing slug at once with the nearest
 * match — so throwing on the first one would report a single typo and hide the other three.
 *
 * The cold-cache failure follows the same rule and did not always: it lived inside `resolve()` and
 * fired on *any* non-empty request, which meant a provider map holding both `system` and `composio`
 * refused to boot over `config_read`. It is `explainUnresolved()` now, which the registry consults
 * only once a slug is genuinely missing everywhere.
 */

import {
    ConfigError,
    type Tool,
    type ToolContext,
    type ToolProvider,
    type ToolProviderContext,
    type ToolSpec,
} from "@castellan/core"
import { cachePath, readCache, writeCache } from "./cache.ts"
import { ComposioClient, type FetchLike } from "./client.ts"
import {
    composioCacheMiss,
    composioExecuteFailed,
    composioKeyMissing,
    composioNotConnected,
} from "./errors.ts"
import { type ComposioTool, isUnannotated, mapTool } from "./map.ts"

export interface ComposioProviderOptions {
    /**
     * The agent's own directory. The cache lives under it, so two agents in one runtime keep separate
     * caches and neither resolves against `process.cwd()`, which belongs to whoever launched the
     * process.
     */
    readonly dir: string
    /** Resolved environment — the manifest's, layered over the ambient one. */
    readonly env: Readonly<Record<string, string | undefined>>
    /** Env var *name*. Never a key. */
    readonly apiKeyEnv?: string
    /** Which connected account to act as at execution time. */
    readonly userId?: string
    readonly baseUrl?: string
    readonly fetch?: FetchLike
    readonly now?: () => Date
}

export interface RefreshReport {
    readonly fetched: number
    readonly missing: readonly string[]
    /** Slugs whose schema changed since the cached copy. */
    readonly changed: readonly string[]
    readonly cachePath: string
}

const DEFAULT_KEY_ENV = "COMPOSIO_API_KEY"

export class ComposioProvider implements ToolProvider {
    readonly id = "composio"

    readonly #dir: string
    readonly #userId: string
    readonly #now: () => Date
    readonly #baseUrl: string
    readonly #client: ComposioClient | undefined
    readonly #keyEnv: string
    #tools: Readonly<Record<string, ComposioTool>>
    #fetchedAt: string
    /** Recorded at resolve, reported by `describe()`. Never inferred twice. */
    #assumedMutating: readonly string[] = []

    constructor(options: ComposioProviderOptions) {
        this.#dir = options.dir
        this.#userId = options.userId ?? "default"
        this.#now = options.now ?? (() => new Date())
        this.#keyEnv = options.apiKeyEnv ?? DEFAULT_KEY_ENV
        const apiKey = options.env[this.#keyEnv]
        this.#baseUrl = options.baseUrl ?? "https://backend.composio.dev/api/v3"

        // Constructed without a key rather than refused here: resolution comes from the cache, so a
        // fully cached agent boots and runs offline. The key is required to *refresh* and to *execute*,
        // and each says so at the point it needs one.
        this.#client =
            apiKey === undefined || apiKey === ""
                ? undefined
                : new ComposioClient({
                      apiKey,
                      baseUrl: this.#baseUrl,
                      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                  })

        const cache = readCache(this.#dir)
        this.#tools = cache.tools
        this.#fetchedAt = cache.fetchedAt
    }

    /** Cache-only. Called before `runtime.ready`, so it must not touch the network. */
    async resolve(slugs: readonly string[]): Promise<readonly Tool[]> {
        const out: Tool[] = []
        const assumed: string[] = []
        for (const slug of slugs) {
            const raw = this.#tools[slug]
            if (raw === undefined) continue
            if (isUnannotated(raw)) assumed.push(slug)
            out.push(this.#toTool(mapTool(raw)))
        }
        this.#assumedMutating = assumed
        return out
    }

    /**
     * Every known slug, for the registry's nearest-match suggestion.
     *
     * Cache-only for the same reason as `resolve`. Before the first warm this is empty, which means a
     * typo's suggestion is absent rather than wrong — and the cache-miss failure already names the
     * command that fixes both.
     */
    async list(): Promise<readonly string[]> {
        return Object.keys(this.#tools)
    }

    /** Which pinned slugs are absent from the cache. The caller decides how loudly to fail. */
    uncached(slugs: readonly string[]): readonly string[] {
        return slugs.filter((slug) => this.#tools[slug] === undefined)
    }

    /**
     * An empty cache is a different failure from a mistyped slug, and only this provider can tell
     * them apart — the registry's generic message reads "no provider resolved GMAIL_FETCH_EMAILS …
     * Available: now, memory_write", which blames three correct slugs and offers local tools as the
     * alternative.
     *
     * Reported rather than thrown from `resolve`, which is where it used to live. The registry hands
     * every provider the *whole* pinned list, so a cold cache saw `config_read` and `config_set` —
     * the system provider's, and about to resolve fine — and refused the boot. A manifest with
     * `system` and `composio` both configured and nothing Composio-ish pinned is exactly what `init
     * --composio connected` writes, so the eager version made the generated agent unstartable.
     *
     * The registry calls this only once a slug is genuinely unresolved after every provider has
     * answered. Silent when the cache has anything in it at all: past the first warm, an unknown slug
     * really is a typo, and the nearest-match message is the better one.
     */
    explainUnresolved(slugs: readonly string[]): ConfigError | undefined {
        if (Object.keys(this.#tools).length > 0 || slugs.length === 0) return undefined
        return composioCacheMiss(slugs, cachePath(this.#dir))
    }

    describe(): {
        readonly cached: number
        readonly fetchedAt: string
        readonly cachePath: string
        readonly assumedMutating: readonly string[]
    } {
        return {
            cached: Object.keys(this.#tools).length,
            fetchedAt: this.#fetchedAt,
            cachePath: cachePath(this.#dir),
            assumedMutating: this.#assumedMutating,
        }
    }

    /**
     * Fetch the given slugs and rewrite the cache. **After readiness only.**
     *
     * Returns rather than throws for a slug Composio does not have, so one bad slug does not cost the
     * refresh of the other twenty. A transport failure does throw — that is the caller's signal to keep
     * serving the cached catalogue and report the refresh as failed.
     */
    async refresh(slugs: readonly string[], signal?: AbortSignal): Promise<RefreshReport> {
        const client = this.#client
        if (client === undefined) throw composioKeyMissing(this.#keyEnv)

        const fetched: Record<string, ComposioTool> = {}
        const missing: string[] = []
        const changed: string[] = []

        for (const slug of slugs) {
            const tool = await client.tool(slug, signal)
            if (tool === undefined) {
                missing.push(slug)
                continue
            }
            fetched[slug] = tool
            const before = this.#tools[slug]
            if (before === undefined || JSON.stringify(before) !== JSON.stringify(tool)) {
                changed.push(slug)
            }
        }

        // Merged, not replaced: a refresh of two slugs must not evict the other eighteen a second agent
        // in the same directory depends on.
        this.#tools = { ...this.#tools, ...fetched }
        const path = writeCache(this.#dir, this.#tools, this.#baseUrl, this.#now)
        this.#fetchedAt = readCache(this.#dir).fetchedAt

        return { fetched: Object.keys(fetched).length, missing, changed, cachePath: path }
    }

    #toTool(spec: ToolSpec): Tool {
        return {
            spec,
            handler: async (args: Readonly<Record<string, unknown>>, context: ToolContext) => {
                const client = this.#client
                if (client === undefined) throw composioKeyMissing(this.#keyEnv)

                const result = await client.execute(spec.slug, args, this.#userId, context.signal)
                if (!result.ok) {
                    const detail = result.error ?? "no detail supplied"
                    // Composio reports a missing connection as a tool failure rather than a status, and
                    // it is the single most common first-run failure — worth its own error so the fix
                    // names the toolkit and the userId rather than quoting an opaque string.
                    if (/connected account|not connected|no connection/i.test(detail)) {
                        const toolkit = spec.tags[0] ?? "the toolkit"
                        throw composioNotConnected(spec.slug, toolkit)
                    }
                    throw composioExecuteFailed(spec.slug, 200, detail)
                }
                return typeof result.data === "string"
                    ? result.data
                    : JSON.stringify(result.data, null, 2)
            },
        }
    }
}

/** Keys `tools.providers.composio` may carry. Anything else is a typo, and typos are refused. */
const CONFIG_KEYS = ["apiKeyEnv", "userId", "baseUrl"] as const

function configString(
    config: Readonly<Record<string, unknown>>,
    key: (typeof CONFIG_KEYS)[number],
): string | undefined {
    const value = config[key]
    if (value === undefined) return undefined
    if (typeof value !== "string" || value === "") {
        throw new ConfigError({
            code: "composio_config_invalid",
            message: `tools.providers.composio.${key} must be a non-empty string.`,
            hint: `Got ${value === null ? "null" : typeof value}. ${key === "apiKeyEnv" ? "This is the *name* of an environment variable, never the key itself — a manifest holding a literal key fails validation." : "Remove the key to use the default."}`,
            field: `tools.providers.composio.${key}`,
        })
    }
    return value
}

/**
 * The factory to register as `composio`.
 *
 * Unknown config keys are refused rather than ignored. A provider's config is a free-form record in the
 * manifest schema, so nothing upstream can catch `userid` for `userId` — and a silently ignored
 * setting is a configuration that looks applied and is not.
 */
export function composioFromConfig(context: ToolProviderContext): ComposioProvider {
    const unknown = Object.keys(context.config).filter(
        (key) => !CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number]),
    )
    if (unknown.length > 0) {
        throw new ConfigError({
            code: "composio_config_unknown",
            message: `tools.providers.composio has ${unknown.length === 1 ? "a key" : "keys"} the Composio provider does not read: ${unknown.join(", ")}.`,
            hint: `Accepted keys are ${CONFIG_KEYS.join(", ")}. Refused rather than ignored, because a setting that looks applied and is not is worse than a rejected manifest.`,
            field: "tools.providers.composio",
        })
    }

    const apiKeyEnv = configString(context.config, "apiKeyEnv")
    const userId = configString(context.config, "userId")
    const baseUrl = configString(context.config, "baseUrl")

    return new ComposioProvider({
        dir: context.dir,
        env: context.env,
        ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
        ...(userId === undefined ? {} : { userId }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
    })
}
