/**
 * The home sandbox: discovery, resolution, and the property both are built on — a listing never
 * requires credentials, and a broken agent is listed with its problem rather than hidden.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, HarnessError } from "@dispach/core"
import { agentsDir, listAgents, resolveAgentRef, sandboxRoot, storePath } from "#lib/sandbox"

// Resolution is cwd-sensitive by design (the filesystem wins), so every test pins an empty cwd
// rather than inheriting whatever happens to be in the repo checkout.
const EMPTY_CWD = mkdtempSync(join(tmpdir(), "sandbox-cwd-"))

const HOME_VAR = `${BRAND.envPrefix}HOME`

function sandbox(agents: Record<string, string | undefined>): Record<string, string> {
    const root = mkdtempSync(join(tmpdir(), "sandbox-test-"))
    for (const [ref, manifest] of Object.entries(agents)) {
        mkdirSync(join(root, "agents", ref), { recursive: true })
        if (manifest !== undefined) {
            writeFileSync(join(root, "agents", ref, "agent.yaml"), manifest, "utf8")
        }
    }
    return { [HOME_VAR]: root }
}

function manifest(id: string): string {
    return `apiVersion: x/v1\nid: ${id}\nname: ${id}\nmodel:\n  main:\n    id: \${MODEL_ID}\n    baseUrl: \${MODEL_BASE_URL}\n`
}

describe("paths", () => {
    test("the env override wins; everything derives from it", () => {
        const env = { [HOME_VAR]: "/tmp/somewhere" }
        expect(sandboxRoot(env)).toBe("/tmp/somewhere")
        expect(agentsDir(env)).toBe(join("/tmp/somewhere", "agents"))
        expect(storePath(env)).toBe(join("/tmp/somewhere", "store.db"))
    })

    test("without the override, the root is brand-derived under home", () => {
        const root = sandboxRoot({})
        expect(root.endsWith(BRAND.stateDir)).toBe(true)
        expect(root.startsWith("/")).toBe(true)
    })
})

describe("listAgents", () => {
    test("no sandbox yet is an empty list, not an error", () => {
        expect(listAgents({ [HOME_VAR]: "/nonexistent/nowhere" })).toEqual([])
    })

    test("lists agents with headers read and env references unexpanded", () => {
        const env = sandbox({ milo: manifest("milo"), ada: manifest("ada") })
        const agents = listAgents(env)
        expect(agents.map((a) => a.ref)).toEqual(["ada", "milo"])
        expect(agents[0]?.modelId).toBe("${MODEL_ID}")
        expect(agents[0]?.problem).toBe(undefined)
    })

    test("a broken manifest is listed with its problem, never thrown, and sorts last", () => {
        const env = sandbox({ good: manifest("good"), broken: "id: [unclosed" })
        const agents = listAgents(env)
        expect(agents.map((a) => a.ref)).toEqual(["good", "broken"])
        expect(agents[1]?.problem).toContain("YAML")
    })

    test("a directory without agent.yaml is not an agent", () => {
        const env = sandbox({ real: manifest("real"), stray: undefined })
        expect(listAgents(env).map((a) => a.ref)).toEqual(["real"])
    })

    test("duplicate manifest ids are marked — their sessions would share a history", () => {
        const env = sandbox({ one: manifest("same"), two: manifest("same") })
        const agents = listAgents(env)
        expect(agents.every((a) => a.problem?.includes("shared"))).toBe(true)
    })
})

describe("resolveAgentRef", () => {
    test("a sandbox name resolves to its manifest", () => {
        const env = sandbox({ milo: manifest("milo") })
        expect(resolveAgentRef("milo", env, EMPTY_CWD)).toBe(
            join(agentsDir(env), "milo", "agent.yaml"),
        )
    })

    test("the filesystem beats the sandbox: ./name forces the path", () => {
        const env = sandbox({ milo: manifest("milo") })
        let error: HarnessError | undefined
        try {
            resolveAgentRef("./milo", env, EMPTY_CWD)
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        // No ./milo here — a path-looking ref must fail as a path, not fall back to the name.
        expect(error?.code).toBe("cli_agent_path_missing")
    })

    test("an unknown name lists the candidates and suggests the nearest", () => {
        const env = sandbox({ milo: manifest("milo") })
        let error: HarnessError | undefined
        try {
            resolveAgentRef("milu", env, EMPTY_CWD)
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.code).toBe("cli_agent_unknown")
        expect(error?.hint).toContain("milo")
        expect(error?.hint).toContain("Did you mean milo?")
    })

    test("an empty sandbox points at init", () => {
        let error: HarnessError | undefined
        try {
            resolveAgentRef("anything", { [HOME_VAR]: "/nonexistent/nowhere" }, EMPTY_CWD)
        } catch (thrown) {
            if (thrown instanceof HarnessError) error = thrown
        }
        expect(error?.message).toContain("empty")
        expect(error?.hint).toContain("init")
    })

    test("a directory path resolves to the agent.yaml inside it", () => {
        const env = sandbox({ milo: manifest("milo") })
        const dir = join(agentsDir(env), "milo")
        expect(resolveAgentRef(dir, env, EMPTY_CWD)).toBe(join(dir, "agent.yaml"))
    })
})
