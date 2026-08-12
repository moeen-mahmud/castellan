import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { VERSION } from "../src/index.ts"

test("VERSION matches package.json", () => {
  // `changeset version` bumps the manifest and knows nothing about the constant. This is
  // the only thing standing between those two facts.
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  )
  const version = (manifest as { version?: unknown }).version
  expect(version).toBe(VERSION)
})
