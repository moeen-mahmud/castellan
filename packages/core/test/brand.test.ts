import { describe, expect, test } from "bun:test"
import {
  BRAND,
  BRAND_OVERRIDE_ENV,
  brandFromSlug,
  DEFAULT_BRAND,
  deriveBrand,
  SLUG_PATTERN,
} from "../src/index.ts"

// Deliberately no brand literals in this file. Hard rule 3 confines the product name to
// brand.ts, and `scripts/rename-brand.ts` does not touch tests — so asserting the shipped
// slug as a literal here would both violate the rule and make this suite fail the moment
// anyone renames the project. Every assertion below is a relationship between fields, which
// holds under any brand.

describe("brand shape", () => {
  test("slug is path-, env-, and scope-safe", () => {
    expect(DEFAULT_BRAND.slug).toMatch(SLUG_PATTERN)
  })

  test("display name is non-empty", () => {
    expect(DEFAULT_BRAND.name.length).toBeGreaterThan(0)
  })

  test("every derived field is a function of the slug", () => {
    const { slug } = DEFAULT_BRAND
    expect(DEFAULT_BRAND.envPrefix).toBe(`${slug.toUpperCase()}_`)
    expect(DEFAULT_BRAND.stateDir).toBe(`.${slug}`)
    expect(DEFAULT_BRAND.packageScope).toBe(`@${slug}`)
  })

  test("apiVersion is the manifest contract the schema will validate against", () => {
    expect(DEFAULT_BRAND.apiVersion).toBe(`${DEFAULT_BRAND.slug}/v1`)
  })
})

describe("brandFromSlug", () => {
  test("derives consistently for an arbitrary slug", () => {
    const b = brandFromSlug("acme-run", "Acme Run")
    expect(b.envPrefix).toBe("ACME-RUN_")
    expect(b.stateDir).toBe(".acme-run")
    expect(b.apiVersion).toBe("acme-run/v1")
    expect(b.packageScope).toBe("@acme-run")
  })

  test("bumping the manifest major would move apiVersion and nothing else", () => {
    const b = brandFromSlug(DEFAULT_BRAND.slug, DEFAULT_BRAND.name)
    expect(b).toEqual(DEFAULT_BRAND)
  })
})

describe("override", () => {
  test("the override env var is keyed off the default prefix", () => {
    // It has to be: the brand is unknown until this variable has been read.
    expect(BRAND_OVERRIDE_ENV).toBe(`${DEFAULT_BRAND.envPrefix}BRAND`)
  })

  test("absent override resolves to the shipped brand", () => {
    expect(deriveBrand(undefined)).toEqual(DEFAULT_BRAND)
  })

  test("BRAND is resolved once at import", () => {
    // No override is set in the test environment, so the two must agree. If this ever
    // fails, something is mutating the brand mid-process, which every derived path assumes
    // cannot happen.
    expect(BRAND).toEqual(DEFAULT_BRAND)
  })

  test("a present override does not silently fall back", () => {
    // Rule 8: nothing fails silently. Until deriveBrand implements the policy, an override
    // is a loud failure rather than an ignored setting.
    expect(() => deriveBrand("acme")).toThrow(BRAND_OVERRIDE_ENV)
  })

  // Pending the policy decision in brand.ts. Not executed unless `bun test --todo`; the
  // bodies below assume the "override rewrites every derived field" reading, so edit them if
  // you decide an override should move only the display name.
  test.todo("a valid override rewrites every derived field", () => {
    const b = deriveBrand("acme")
    expect(b.slug).toBe("acme")
    expect(b.envPrefix).toBe("ACME_")
    expect(b.stateDir).toBe(".acme")
    expect(b.apiVersion).toBe("acme/v1")
    expect(b.packageScope).toBe("@acme")
  })

  test.todo("a malformed override is rejected rather than ignored", () => {
    expect(() => deriveBrand("Not A Slug")).toThrow()
  })
})
