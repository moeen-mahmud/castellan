/**
 * Package version, surfaced on the wire (`GET /v1/health`) and in `plugin.loaded` events.
 *
 * Kept in step with `package.json` by `test/version.test.ts` rather than by discipline —
 * `changeset version` bumps the manifest, and a mismatch fails the suite.
 */
export const VERSION = "0.1.0"
