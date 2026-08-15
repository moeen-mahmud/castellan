/**
 * The provider id, in one place.
 *
 * A string literal repeated across six files is a rename that compiles and half-works — the same
 * reasoning as `tools-system`'s `SYSTEM_PROVIDER_ID`. It is also the id a manifest names under
 * `tools.providers`, so it is part of the public contract rather than an implementation detail.
 */
export const WEB_PROVIDER_ID = "web"
