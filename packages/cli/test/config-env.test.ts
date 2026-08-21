/**
 * Whether a variable is set, from the agent's point of view.
 *
 * Every variable here is a probe name that cannot exist in the ambient environment. `bun test`
 * auto-loads the repo's own `.env`, so a test naming `MODEL_API_KEY` asserts against whatever this
 * machine happens to export — which is the contamination this repo has recorded as a test hazard and
 * then hit again as a *runtime* one. Two of these tests failed that way before the rename.
 *
 * The bug this covers: `ambientEnv` never adds the `.env` beside the manifest — it only *demotes* a
 * colliding cwd variable — so a token sitting next to the manifest read as unset. It showed up as an
 * editor row that still said `(not set)` immediately after somebody set it, and as `config list`
 * reporting a variable missing that plainly was not.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentEnv, isSet } from "#lib/config-env"

function agent(envFile?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "config-env-"))
    writeFileSync(join(dir, "agent.yaml"), "id: x\n")
    if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile)
    return join(dir, "agent.yaml")
}

describe("agentEnv", () => {
    test("a variable in the .env beside the manifest counts as set", () => {
        const env = agentEnv(agent("CFG_ENV_PROBE=sk-live\n"))
        expect(isSet(env, "CFG_ENV_PROBE")).toBe(true)
        expect(env.CFG_ENV_PROBE).toBe("sk-live")
    })

    test("no .env at all is simply nothing set", () => {
        expect(isSet(agentEnv(agent()), "CFG_ENV_PROBE")).toBe(false)
    })

    test("an empty value counts as unset, because a load fails on it exactly as on absent", () => {
        expect(isSet(agentEnv(agent("CFG_ENV_PROBE=\n")), "CFG_ENV_PROBE")).toBe(false)
    })

    test("a comment is not a value", () => {
        expect(isSet(agentEnv(agent("# CFG_ENV_PROBE=disabled\n")), "CFG_ENV_PROBE")).toBe(false)
    })

    test("the real environment wins over the file", () => {
        // Core's precedence, unchanged: an operator's export has to beat a file, or a container cannot
        // configure the agent it runs.
        const path = agent("PATH_PROBE=from-file\n")
        const before = process.env.PATH_PROBE
        process.env.PATH_PROBE = "from-export"
        try {
            expect(agentEnv(path).PATH_PROBE).toBe("from-export")
        } finally {
            if (before === undefined) delete process.env.PATH_PROBE
            else process.env.PATH_PROBE = before
        }
    })

    test("an unreadable .env means nothing is known to be set, not that it is", () => {
        // Claiming a variable is present when the file cannot be read is the worse answer: the caller
        // would then not report the thing that is about to fail the load.
        const dir = mkdtempSync(join(tmpdir(), "config-env-"))
        writeFileSync(join(dir, "agent.yaml"), "id: x\n")
        // A directory where the file should be: readFileSync throws EISDIR.
        writeFileSync(join(dir, ".env"), "")
        expect(isSet(agentEnv(join(dir, "agent.yaml")), "ANYTHING")).toBe(false)
    })
})
