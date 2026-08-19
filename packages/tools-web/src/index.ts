/**
 * `@dispach/tools-web` — searching the web and reading one page of it.
 *
 * Two tools, both read-only, both `untrusted` by declaration rather than by default. The interesting
 * part of this package is not the fetching, which is a GET; it is `address.ts` and `guard.ts`, which
 * decide what the agent is allowed to point a GET at. See `README.md` for the boundary this does and
 * does not draw — in particular, that none of it binds `exec`.
 */

export {
    type AddressKind,
    type AddressVerdict,
    classifyAddress,
    classifyIPv4,
    classifyIPv6,
    parseIPv4,
    parseIPv6,
} from "./address.ts"
export { BACKEND_IDS, type Backend, type BackendId, backend, type SearchHit } from "./backends.ts"
export {
    decodeEntities,
    extract,
    extractTitle,
    htmlToText,
    isTextual,
} from "./extract.ts"
export {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_CHARS,
    effectiveTimeout,
    FETCH_SPEC,
    type FetchLike,
    type FetchOptions,
    fetchTool,
    MAX_REDIRECTS,
    readCapped,
} from "./fetch.ts"
export {
    assertFetchable,
    checkUrlShape,
    type LookupLike,
    parseUrl,
    systemLookup,
} from "./guard.ts"
export { WEB_PROVIDER_ID } from "./paths.ts"
export {
    WEB_TOOL_SLUGS,
    WebProvider,
    type WebProviderOptions,
    webFromConfig,
} from "./provider.ts"
export {
    clampResults,
    DEFAULT_MAX_RESULTS,
    MAX_MAX_RESULTS,
    render,
    SEARCH_SPEC,
    type SearchOptions,
    searchTool,
} from "./search.ts"
