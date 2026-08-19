/**
 * `@dispach/tools-composio` — Composio as a tool provider, over plain HTTP.
 *
 * Composio exposes roughly 25,000 tools across ~1,000 toolkits (25,438 at the time of writing,
 * reported by the live listing). That number is why `tools.pinned` exists: search-then-execute is
 * two-hop reasoning, which is where small models fail, so the catalogue is fixed at load.
 */

export { cachePath, readCache, writeCache, type CacheFile } from "./cache.ts"
export {
    ComposioClient, type ClientOptions, type FetchLike,
    type MetaResult,
    type SessionCreated
} from "./client.ts"
export {
    composioCacheMiss,
    composioExecuteFailed,
    composioKeyMissing,
    composioNoMatch,
    composioNotConnected,
    composioRequestFailed,
    composioSchemaUnsupported,
    composioSessionKeyMissing
} from "./errors.ts"
export { isMutating, isUnannotated, mapParameters, mapTool, type ComposioTool } from "./map.ts"
export {
    CONNECT_SLUG,
    CONNECT_SPEC,
    findUrl,
    META_SLUGS, metaTools,
    renderConnect,
    renderSearch,
    renderWorkbench,
    SEARCH_SLUG,
    SEARCH_SPEC,
    WORKBENCH_SLUG,
    WORKBENCH_SPEC, type MetaContext
} from "./meta.ts"
export {
    composioFromConfig, ComposioProvider,
    type ComposioProviderOptions, type RefreshReport
} from "./provider.ts"
export { readSession, sessionPath, writeSession } from "./session.ts"

