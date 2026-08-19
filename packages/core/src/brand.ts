/**
 * The only file in the tree that contains the product name.
 *
 * Everything brand-shaped is derived from a single slug: the env var prefix, the state
 * directory, the package scope, and the manifest `apiVersion`. A rename is therefore one
 * edit to `DEFAULT_SLUG` (see `scripts/rename-brand.ts`), not a tree-wide find-and-replace.
 *
 * `apiVersion` living here is not decoration. The manifest spec makes it a required literal
 * that `manifest/schema.ts` validates against; if that literal were hardcoded in the schema,
 * a rename would silently invalidate every existing manifest.
 */

/** Lowercase, filesystem- and env-safe. The single source of every derived field below. */
const DEFAULT_SLUG = "dispach"

/** Display form. Free-form — appears in CLI banners and log lines, never in a path. */
const DEFAULT_NAME = "dispach"

/** Major version of the manifest contract. Bumped only on a breaking manifest change. */
const MANIFEST_MAJOR = 1

export interface Brand {
    /** Lowercase slug. Safe in paths, env var names, and package scopes. */
    readonly slug: string
    /** Display name, for humans. */
    readonly name: string
    /** Prefix for every env var the runtime reads, e.g. `dispach_API_TOKEN`. */
    readonly envPrefix: string
    /** Dot-directory for runtime state, relative to the workspace. */
    readonly stateDir: string
    /** Value required in `agent.yaml`'s `apiVersion` field. */
    readonly apiVersion: string
    /** npm scope for first-party packages. */
    readonly packageScope: string
}

/**
 * The unbranded shape, given a slug. Every field a consumer can see is a function of the
 * two inputs, so there is no way to rebrand half of the runtime.
 */
export function brandFromSlug(slug: string, name: string): Brand {
    return {
        slug,
        name,
        envPrefix: `${slug.toUpperCase()}_`,
        stateDir: `.${slug}`,
        apiVersion: `${slug}/v${MANIFEST_MAJOR}`,
        packageScope: `@${slug}`,
    }
}

/** The shipped brand, before any env override is applied. */
export const DEFAULT_BRAND: Brand = brandFromSlug(DEFAULT_SLUG, DEFAULT_NAME)

/**
 * Env var carrying the override. Necessarily keyed off the *default* prefix — the brand is
 * not known until after this variable has been read.
 */
export const BRAND_OVERRIDE_ENV = `${DEFAULT_BRAND.envPrefix}BRAND`

/** Slug rules: lowercase alphanumeric, inner hyphens. Safe as a path, env prefix, and scope. */
export const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** `acme-run` → `Acme Run`. Display form only; never used in a path or an env var. */
export function titleCaseSlug(slug: string): string {
    return slug
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
}

/**
 * Resolve the brand from an optional override.
 *
 * Three decisions, all in the direction of coherence over flexibility:
 *
 * 1. **An override moves every derived field, including `apiVersion`.** A half-rebranded
 *    runtime — `.acme/` on disk but `dispach_` env vars — is worse than either end state,
 *    and there is no reading of decision 1.5 under which an embedder wants that. The
 *    consequence is deliberate: a rebranded runtime rejects a stock `apiVersion`, because a
 *    fork that has changed the runtime's identity should not silently accept manifests
 *    written for a different one.
 * 2. **A malformed override throws here, at import.** Rule 8 forbids silent failure and rule
 *    4 forbids I/O before readiness, so there is no bus to warn on and no log to write to.
 *    Throwing is the only loud channel available this early, and a bad brand poisons every
 *    path and env lookup downstream — failing at the first opportunity is cheaper than
 *    failing at the twentieth.
 * 3. **`envPrefix` is not independently overridable.** Two knobs that must agree are one bug
 *    waiting to happen.
 */
export function deriveBrand(override: string | undefined): Brand {
    if (override === undefined) return DEFAULT_BRAND

    const slug = override.trim()

    if (slug === "") {
        throw new Error(
            `${BRAND_OVERRIDE_ENV} is set but empty. ` +
                `hint: unset ${BRAND_OVERRIDE_ENV} entirely to use the default brand — an empty value ` +
                `is treated as a mistake rather than as "no override", because a declared-but-unset ` +
                `variable is usually a container passing through a name it never assigned.`,
        )
    }

    if (!SLUG_PATTERN.test(slug)) {
        throw new Error(
            `${BRAND_OVERRIDE_ENV}="${slug}" is not a usable brand slug. ` +
                `hint: the slug becomes an env var prefix, a dot-directory, an npm scope, and the ` +
                `manifest apiVersion, so it must be lowercase alphanumeric with inner hyphens — ` +
                `e.g. acme or acme-run.`,
        )
    }

    if (slug === DEFAULT_BRAND.slug) return DEFAULT_BRAND

    return brandFromSlug(slug, titleCaseSlug(slug))
}

/**
 * The resolved brand for this process. Read once at import; the brand cannot change while
 * the runtime is alive, and every derived path and env lookup depends on it being stable.
 */
export const BRAND: Brand = deriveBrand(process.env[BRAND_OVERRIDE_ENV])
