#!/usr/bin/env bun
/**
 * Rewrites `./x.ts` → `./x.js` in emitted declaration files.
 *
 * Source imports carry the `.ts` extension so one unbundled tree runs under both Bun and
 * Node (see the comment in tsconfig.base.json). `rewriteRelativeImportExtensions` handles
 * that for JS emit — verified — but as of TypeScript 5.9 it does **not** rewrite declaration
 * emit, so `dist/index.d.ts` ships `from "./brand.ts"`. A consumer without
 * `allowImportingTsExtensions` then fails to resolve the package's types:
 *
 *   error TS5097: An import path can only end with a '.ts' extension when
 *   'allowImportingTsExtensions' is enabled.
 *
 * Which nobody would see until the first external consumer typechecked against a published
 * build. Nine lines of post-processing beats making every downstream package opt into a
 * compiler flag to read our types.
 *
 * Delete this the day TypeScript rewrites declaration specifiers itself.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const PACKAGES = join(ROOT, "packages")

/** Relative specifiers only. A bare `pkg/x.ts` specifier would be someone else's problem. */
const RELATIVE_TS_SPECIFIER = /(["'])(\.\.?\/[^"']*)\.ts\1/g

function declarationFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...declarationFiles(full))
        else if (entry.endsWith(".d.ts")) out.push(full)
    }
    return out
}

const rewritten: string[] = []

for (const pkg of readdirSync(PACKAGES)) {
    const dist = join(PACKAGES, pkg, "dist")
    let isDir = false
    try {
        isDir = statSync(dist).isDirectory()
    } catch {
        // No dist — package has nothing built. Not an error; not every package emits.
    }
    if (!isDir) continue

    for (const file of declarationFiles(dist)) {
        const source = readFileSync(file, "utf8")
        const next = source.replace(RELATIVE_TS_SPECIFIER, "$1$2.js$1")
        if (next === source) continue
        writeFileSync(file, next)
        rewritten.push(relative(ROOT, file))
    }
}

console.log(
    rewritten.length === 0
        ? "rewrite-dts-extensions: nothing to rewrite"
        : `rewrite-dts-extensions: ${rewritten.length} file(s) — ${rewritten.join(", ")}`,
)
