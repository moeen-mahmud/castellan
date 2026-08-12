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
const DEFAULT_SLUG = "castellan"

/** Display form. Free-form — appears in CLI banners and log lines, never in a path. */
const DEFAULT_NAME = "Castellan"

/** Major version of the manifest contract. Bumped only on a breaking manifest change. */
const MANIFEST_MAJOR = 1

export interface Brand {
  /** Lowercase slug. Safe in paths, env var names, and package scopes. */
  readonly slug: string
  /** Display name, for humans. */
  readonly name: string
  /** Prefix for every env var the runtime reads, e.g. `CASTELLAN_API_TOKEN`. */
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

// TODO(moeen): implement the override policy. See the three trade-offs in the plan:
//   1. Does an override rewrite every derived field, or only `name`?
//   2. Does a malformed override throw at import time, or fall back with a warning?
//      (Rule 8 forbids silent failure; rule 4 forbids I/O before ready, and this module is
//      imported before an event bus exists to warn on.)
//   3. Is `envPrefix` always `${SLUG}_`, or independently overridable?
// `brandFromSlug`, `SLUG_PATTERN`, and `DEFAULT_BRAND` are the pieces this needs.
export function deriveBrand(override: string | undefined): Brand {
  if (override === undefined) return DEFAULT_BRAND

  throw new Error(
    `${BRAND_OVERRIDE_ENV} is set to "${override}", but brand override is not implemented yet. ` +
      `hint: unset ${BRAND_OVERRIDE_ENV} to use the default brand, or implement deriveBrand() ` +
      `in packages/core/src/brand.ts.`,
  )
}

/**
 * The resolved brand for this process. Read once at import; the brand cannot change while
 * the runtime is alive, and every derived path and env lookup depends on it being stable.
 */
export const BRAND: Brand = deriveBrand(process.env[BRAND_OVERRIDE_ENV])
