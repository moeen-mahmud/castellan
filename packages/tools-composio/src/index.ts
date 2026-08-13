/**
 * `@castellan/tools-composio` — Composio as a tool provider, over plain HTTP.
 *
 * Composio exposes roughly 25,000 tools across ~1,000 toolkits (25,438 at the time of writing,
 * reported by the live listing). That number is why `tools.pinned` exists: search-then-execute is
 * two-hop reasoning, which is where small models fail, so the catalogue is fixed at load.
 */

export { type CacheFile, cachePath, readCache, writeCache } from "./cache.ts"
export { type ClientOptions, ComposioClient, type FetchLike } from "./client.ts"
export {
    composioCacheMiss,
    composioExecuteFailed,
    composioKeyMissing,
    composioNotConnected,
    composioRequestFailed,
    composioSchemaUnsupported,
} from "./errors.ts"
export { type ComposioTool, isMutating, isUnannotated, mapParameters, mapTool } from "./map.ts"
export {
    ComposioProvider,
    type ComposioProviderOptions,
    composioFromConfig,
    type RefreshReport,
} from "./provider.ts"
