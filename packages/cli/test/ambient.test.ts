/**
 * Which `.env` wins.
 *
 * The scenario is the one that produced the bug, and it is worth restating because every step of it
 * was working as designed: an agent in the home sandbox names `deepseek-v4-flash` in its own `.env`,
 * the binary is launched from a project checkout whose `.env` names `deepseek-v4-pro`, Bun folds that
 * file into `process.env` before any of this runs, and core's rule is that the real environment beats
 * a `.env` beside the manifest. Correct rule, wrong outcome — because a file in the directory you
 * happened to be standing in is not an operator's explicit export.
 */

import { describe, expect, test } from "bun:test"
import { ambientEnv, demotedKeys } from "#lib/ambient"

/** Two directories with `.env` files, without touching disk. */
function dirs(map: Record<string, Record<string, string>>) {
    return (dir: string) => map[dir] ?? {}
}

const AGENT = "/home/me/.castellan/agents/milo"
const CHECKOUT = "/work/castellan"

describe("ambientEnv", () => {
    test("the agent's own .env beats a .env in the directory you launched from", () => {
        const env = ambientEnv([`${AGENT}/agent.yaml`], {
            cwd: CHECKOUT,
            env: { MODEL_ID: "deepseek-v4-pro", PATH: "/usr/bin" },
            readDir: dirs({
                [CHECKOUT]: { MODEL_ID: "deepseek-v4-pro" },
                [AGENT]: { MODEL_ID: "deepseek-v4-flash" },
            }),
        })
        // Removed rather than replaced: core layers the agent's own `.env` under whatever this
        // returns, so absence here *is* "the agent's file decides".
        expect("MODEL_ID" in env).toBe(false)
        expect(env.PATH).toBe("/usr/bin")
    })

    test("a genuine export still wins", () => {
        // The whole reason core's rule exists. An exported value differs from the file's, so it is
        // recognisably not the file, and it survives.
        const env = ambientEnv([`${AGENT}/agent.yaml`], {
            cwd: CHECKOUT,
            env: { MODEL_ID: "exported-on-the-command-line" },
            readDir: dirs({
                [CHECKOUT]: { MODEL_ID: "deepseek-v4-pro" },
                [AGENT]: { MODEL_ID: "deepseek-v4-flash" },
            }),
        })
        expect(env.MODEL_ID).toBe("exported-on-the-command-line")
    })

    test("a cwd variable the agent does not set is left alone", () => {
        // Demoting it would delete configuration nobody else supplies — the cwd `.env` is a
        // perfectly good place to keep a key for an agent whose own file omits it.
        const env = ambientEnv([`${AGENT}/agent.yaml`], {
            cwd: CHECKOUT,
            env: { TAVILY_API_KEY: "from-checkout" },
            readDir: dirs({
                [CHECKOUT]: { TAVILY_API_KEY: "from-checkout" },
                [AGENT]: { MODEL_ID: "deepseek-v4-flash" },
            }),
        })
        expect(env.TAVILY_API_KEY).toBe("from-checkout")
    })

    test("running from inside the agent's own directory changes nothing", () => {
        // The cwd file *is* the agent's file. Demoting it against itself would delete the
        // configuration it exists to supply.
        const env = ambientEnv([`${AGENT}/agent.yaml`], {
            cwd: AGENT,
            env: { MODEL_ID: "deepseek-v4-flash" },
            readDir: dirs({ [AGENT]: { MODEL_ID: "deepseek-v4-flash" } }),
        })
        expect(env.MODEL_ID).toBe("deepseek-v4-flash")
    })

    test("no cwd .env is the common case and returns the environment untouched", () => {
        const original = { MODEL_ID: "x" }
        expect(
            ambientEnv([`${AGENT}/agent.yaml`], {
                cwd: "/somewhere",
                env: original,
                readDir: dirs({ [AGENT]: { MODEL_ID: "y" } }),
            }),
        ).toBe(original)
    })

    test("what was demoted is reportable, so the change is never silent", () => {
        // Silence was half the original bug. Someone who has just written MODEL_ID into a project
        // .env and finds their agent ignoring it needs the same sentence as the person who found
        // their agent obeying it.
        expect(
            demotedKeys([`${AGENT}/agent.yaml`], {
                cwd: CHECKOUT,
                env: { MODEL_ID: "deepseek-v4-pro" },
                readDir: dirs({
                    [CHECKOUT]: { MODEL_ID: "deepseek-v4-pro" },
                    [AGENT]: { MODEL_ID: "deepseek-v4-flash" },
                }),
            }),
        ).toEqual(["MODEL_ID"])
    })
})
