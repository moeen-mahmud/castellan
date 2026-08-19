/**
 * The on-disk resolution cache — the reason this provider can exist at all.
 *
 * Hard rule 4: no network I/O before `runtime.ready`. Tool resolution happens in boot phase 3, before
 * readiness, so a provider that reached for the network there would reintroduce exactly the failure
 * this runtime was built to remove — the one it replaces blocks roughly four minutes on network calls
 * during hook initialisation. So boot reads this file and nothing else, and the refresh happens after
 * readiness.
 *
 * Reads are synchronous. Boot is budgeted at 1000 ms and the file is a few hundred kilobytes at worst;
 * an async read here would buy nothing and add a scheduling hop to the measured path.
 *
 * The file is written atomically — temp file then rename — because a boot that reads a half-written
 * cache would fail on a JSON parse error naming a file the user never edited. A corrupt or unreadable
 * cache is treated as an empty one, which surfaces as a named cache miss with the warm command in its
 * hint rather than as a parse error.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { BRAND } from "@dispach/core"
import type { ComposioTool } from "./map.ts"

/** Bumped when the cached shape changes, so an old file is ignored rather than misread. */
const CACHE_VERSION = 1

const CACHE_FILE = "tools.cache.json"

export interface CacheFile {
    readonly version: number
    readonly provider: string
    /** ISO 8601. Reported by `describe()` so the age of a catalogue is observable, not guessed. */
    readonly fetchedAt: string
    readonly baseUrl: string
    readonly tools: Readonly<Record<string, ComposioTool>>
}

export function cachePath(dir: string): string {
    return isAbsolute(dir)
        ? join(dir, BRAND.stateDir, CACHE_FILE)
        : join(resolve(dir), BRAND.stateDir, CACHE_FILE)
}

function isTool(value: unknown): value is ComposioTool {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { slug?: unknown }).slug === "string"
    )
}

/**
 * Read the cache, or return an empty one.
 *
 * Never throws. Every reason this can fail — absent, unreadable, truncated, written by an older
 * version — has the same correct response at boot: behave as though nothing is cached, so the caller
 * reports a cache miss naming the slugs and the command that fixes it.
 */
export function readCache(dir: string): CacheFile {
    const empty: CacheFile = {
        version: CACHE_VERSION,
        provider: "composio",
        fetchedAt: "",
        baseUrl: "",
        tools: {},
    }
    let raw: string
    try {
        raw = readFileSync(cachePath(dir), "utf8")
    } catch {
        return empty
    }
    try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== "object" || parsed === null) return empty
        const file = parsed as Partial<CacheFile>
        if (file.version !== CACHE_VERSION) return empty
        const tools: Record<string, ComposioTool> = {}
        for (const [slug, tool] of Object.entries(file.tools ?? {})) {
            if (isTool(tool)) tools[slug] = tool
        }
        return {
            version: CACHE_VERSION,
            provider: "composio",
            fetchedAt: typeof file.fetchedAt === "string" ? file.fetchedAt : "",
            baseUrl: typeof file.baseUrl === "string" ? file.baseUrl : "",
            tools,
        }
    } catch {
        return empty
    }
}

export function writeCache(
    dir: string,
    tools: Readonly<Record<string, ComposioTool>>,
    baseUrl: string,
    now: () => Date,
): string {
    const path = cachePath(dir)
    mkdirSync(dirname(path), { recursive: true })
    const file: CacheFile = {
        version: CACHE_VERSION,
        provider: "composio",
        fetchedAt: now().toISOString(),
        baseUrl,
        tools,
    }
    // Temp-then-rename: a reader either sees the previous complete file or the new complete one, never
    // half of either. Same directory, so the rename stays on one filesystem and is atomic.
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
    renameSync(temp, path)
    return path
}
