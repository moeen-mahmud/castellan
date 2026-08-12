/**
 * Public export surface. Phase 0 is a scaffold: the brand seam and the version, nothing
 * that runs. The loop, context, tools, and control surfaces land in later phases.
 */

export type { Brand } from "./brand.ts"
export {
  BRAND,
  BRAND_OVERRIDE_ENV,
  brandFromSlug,
  DEFAULT_BRAND,
  deriveBrand,
  SLUG_PATTERN,
} from "./brand.ts"
export { VERSION } from "./version.ts"
