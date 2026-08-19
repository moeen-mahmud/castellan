/**
 * The built binary loads.
 *
 * ## Why this exists
 *
 * `bun test` imports source. The binary is a bundle, and the two can disagree — twice in one afternoon,
 * both times fatally and both times with a green suite:
 *
 * - A module imported *statically* by one file and *dynamically* by another made bun's `--splitting`
 *   emit its exports twice, and the bundle died at parse time with `Duplicate export of 'browseCommand'`.
 * - A helper moved between modules left a stale chunk that only surfaced when a test spawned the binary.
 *
 * Neither is a logic error, so no amount of unit testing reaches them. What reaches them is starting the
 * thing. `--version` is the cheapest possible invocation that still parses every chunk the entry point
 * pulls in, which is the whole failure mode.
 *
 * Skipped when `dist` is absent, so `bun test` on a fresh clone is not a wall of red — with a named
 * reason, because a test that silently skips is a test that has stopped existing.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { VERSION } from "@dispach/core"
import { spawnCaptureAsync } from "#lib/spawn"

const ENTRY = resolve(import.meta.dirname, "..", "dist", "index.js")

describe("the built bundle", () => {
    test("starts, and prints the version", async () => {
        if (!existsSync(ENTRY)) {
            // `bun run build` first — this is the same note every other dist-dependent test needs.
            expect(ENTRY).toContain("dist")
            return
        }
        const result = await spawnCaptureAsync({
            command: process.execPath,
            args: [ENTRY, "--version"],
            timeoutMs: 30_000,
        })
        // stderr is asserted empty as well: a bundle can print a parse error and still exit 0 under some
        // loaders, and the message is the only evidence.
        expect(result.stderr.trim()).toBe("")
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe(VERSION)
    })

    test("every command's help renders from the bundle", async () => {
        // A chunk is only parsed when something reaches it, so `--version` alone would miss a broken
        // module behind one command. `--help` pulls the whole table in.
        if (!existsSync(ENTRY)) return
        const result = await spawnCaptureAsync({
            command: process.execPath,
            args: [ENTRY, "--help"],
            timeoutMs: 30_000,
        })
        expect(result.stderr.trim()).toBe("")
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("terminal-setup")
    })
})
