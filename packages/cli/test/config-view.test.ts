/**
 * What `config` prints, and which edits it asks about first.
 *
 * The policy assertions are the load-bearing ones: this surface can disable the write gate and open a
 * bind address to the network, so "which edits need a confirmation" has to be checkable without
 * performing one.
 */

import { describe, expect, test } from "bun:test"
import { SETTINGS, settingByPath } from "@dispach/core"
import {
    confirmationFor,
    editorRows,
    envNeeds,
    renderChange,
    renderSettings,
    type SettingValue,
    showValue,
    unmet,
} from "#lib/config-view"

function rows(): readonly SettingValue[] {
    return SETTINGS.map((setting) => ({ setting, value: undefined }))
}

describe("renderSettings", () => {
    test("each manifest block appears exactly once", () => {
        // A real listing came out with `server` and `tools` as two sections each, because the
        // person-only rows sit at the end of the catalogue and a heading was printed whenever the block
        // *changed*. It reads as though the file has two server sections.
        const text = renderSettings(rows(), "/x/agent.yaml")
        for (const block of [
            "tools",
            "model",
            "limits",
            "context",
            "channels",
            "delivery",
            "server",
        ]) {
            const headings = text.split("\n").filter((line) => line.trim() === block)
            expect(headings.length).toBe(1)
        }
    })

    test("a person-only row is marked, and an agent-settable one is not", () => {
        const text = renderSettings(rows(), "/x/agent.yaml")
        // The markers ride on the *description* line under the path, not on the path's own row — so the
        // assertion reads the pair together rather than one line, which is how it is on screen.
        const entry = (path: string) => {
            const lines = text.split("\n")
            const at = lines.findIndex((row) => row.trim().startsWith(`${path} `))
            return at === -1 ? "" : `${lines[at]}\n${lines[at + 1] ?? ""}`
        }
        expect(entry("server.host")).toContain("yours only")
        expect(entry("channels[].allowFrom")).toContain("set with `config allow`")
        expect(entry("tools.policy.deny")).toContain("asks first")
        // `tools.dialect` is ordinary: no ownership marker and no confirmation.
        expect(entry("tools.dialect")).not.toContain("yours only")
        expect(entry("tools.dialect")).not.toContain("asks first")
    })

    test("every setting reaches the listing", () => {
        // A field missing from a listing reads as "no such concept" — the reason slot 2 prints a `none`
        // row instead of leaving the line out.
        const text = renderSettings(rows(), "/x/agent.yaml")
        for (const setting of SETTINGS) expect(text).toContain(setting.path)
    })
})

describe("confirmationFor", () => {
    test("onMutate asks about allow and not about confirm", () => {
        // The asymmetry is the point: `confirm` tightens the gate and `allow` removes it. Asking about
        // both would teach people to agree to the one that matters.
        const onMutate = settingByPath("tools.untrusted.onMutate")
        if (onMutate === undefined) throw new Error("onMutate is not in the catalogue")
        expect(confirmationFor(onMutate, "allow")).toBeDefined()
        expect(confirmationFor(onMutate, "confirm")).toBeUndefined()
        expect(confirmationFor(onMutate, "refuse")).toBeUndefined()
    })

    test("replacing the deny rules always asks", () => {
        const deny = settingByPath("tools.policy.deny")
        if (deny === undefined) throw new Error("deny is not in the catalogue")
        expect(confirmationFor(deny, [])).toBeDefined()
    })

    test("nothing else asks", () => {
        for (const setting of SETTINGS) {
            if (
                setting.path === "tools.policy.deny" ||
                setting.path === "tools.untrusted.onMutate"
            ) {
                continue
            }
            expect(confirmationFor(setting, "anything")).toBeUndefined()
        }
    })
})

describe("envNeeds", () => {
    test("a model key is a load failure and says so", () => {
        const needs = envNeeds({ model: { main: { apiKeyEnv: "MODEL_API_KEY" } } })
        expect(needs).toEqual([
            { name: "MODEL_API_KEY", why: "the manifest will not load until it is set" },
        ])
    })

    test("a disabled server contributes nothing", () => {
        // The bug this fixes: `server.enabled: false` with a `tokenEnv` reported "the agent will refuse
        // to start", for an agent that starts perfectly well.
        expect(envNeeds({ server: { enabled: false, tokenEnv: "API_TOKEN" } })).toEqual([])
    })

    test("an enabled server's token is not a startup failure", () => {
        const needs = envNeeds({ server: { enabled: true, tokenEnv: "API_TOKEN" } })
        expect(needs[0]?.name).toBe("API_TOKEN")
        expect(needs[0]?.why).toContain("unauthenticated")
        expect(needs[0]?.why).not.toContain("will not start")
    })

    test("an enabled channel's token is a startup failure, and a disabled one is not", () => {
        const enabled = envNeeds({ channels: [{ id: "tg", tokenEnv: "TG" }] })
        expect(enabled[0]?.why).toContain("will not start")
        expect(envNeeds({ channels: [{ id: "tg", tokenEnv: "TG", enabled: false }] })).toEqual([])
    })

    test("a provider key stops that provider, not the agent", () => {
        const needs = envNeeds({ tools: { providers: { web: { apiKeyEnv: "TAVILY_API_KEY" } } } })
        expect(needs[0]?.why).toContain("web provider's tools will not work")
    })

    test("junk in, nothing out", () => {
        expect(envNeeds(undefined)).toEqual([])
        expect(envNeeds("not a document")).toEqual([])
        expect(envNeeds({ channels: "not a list" })).toEqual([])
    })
})

describe("unmet", () => {
    test("an empty string counts as unset", () => {
        // A variable present and empty fails the load exactly as a missing one does.
        const needs = [
            { name: "A", why: "x" },
            { name: "B", why: "y" },
        ]
        expect(unmet(needs, { A: "", B: "set" })).toEqual([{ name: "A", why: "x" }])
    })
})

describe("renderChange", () => {
    const base = {
        path: "limits.maxSteps",
        before: 6,
        after: 9,
        file: "/x/agent.yaml",
        reflowed: false,
        pending: [],
        restartHint: "it is started again",
    }

    test("reports the old value, so a mistake is undoable from the output", () => {
        const text = renderChange(base)
        expect(text).toContain("limits.maxSteps = 9")
        expect(text).toContain("was")
        expect(text).toContain("6")
    })

    test("a running agent is named, never refused", () => {
        const text = renderChange({ ...base, running: { pid: 4242, mode: "daemon" } })
        expect(text).toContain("pid 4242")
        expect(text).toContain("it is started again")
    })

    test("a reflow is surfaced", () => {
        expect(renderChange({ ...base, reflowed: true })).toContain("re-serialised")
    })

    test("a newly required variable is named with its real consequence", () => {
        const text = renderChange({
            ...base,
            pending: [{ name: "TG", why: "the tg channel is read at boot" }],
        })
        expect(text).toContain("TG is not set")
        expect(text).toContain("config env <agent> TG")
    })
})

describe("showValue", () => {
    test("absent is distinguishable from empty", () => {
        expect(showValue(undefined)).toBe("(not set)")
        expect(showValue("")).toBe('""')
    })

    test("a list of maps is JSON, not flattened YAML", () => {
        // Flattening rendered `[type: telegram id: tg]`, one run-on string where fields were needed —
        // and `String(entry)` on an object writes `[object Object]`, which has been a real defect three
        // times in three different renderers.
        expect(showValue([{ type: "telegram", id: "tg" }])).toBe('[{"type":"telegram","id":"tg"}]')
    })
})

describe("editorRows", () => {
    const SETTINGS_ROWS: readonly SettingValue[] = SETTINGS.map((setting) => ({
        setting,
        value: undefined,
    }))

    function build(channels: readonly { id: string; type: string; allowFrom: string[] }[] = []) {
        return editorRows(SETTINGS_ROWS, {
            channels,
            secrets: [{ name: "MODEL_API_KEY", why: "the manifest will not load" }],
            present: () => false,
        })
    }

    test("a row nobody can act on is not offered at all", () => {
        // `tools.providers.<id>.writeRoots` needs a provider named, and the editor has no way to ask
        // which — a row that cannot be used is the dead end this surface exists to remove. `config list`
        // still shows it, which is where a listing belongs.
        const paths = build().map((row) => (row.kind === "setting" ? row.setting.path : ""))
        expect(paths).not.toContain("tools.providers.<id>.writeRoots")
        expect(paths).not.toContain("channels[].allowFrom")
    })

    test("allowFrom is expanded to one row per declared channel", () => {
        const rows = build([
            { id: "tg", type: "telegram", allowFrom: ["@a"] },
            { id: "tg2", type: "telegram", allowFrom: [] },
        ])
        const allow = rows.filter((row) => row.kind === "allow")
        expect(allow.map((row) => (row.kind === "allow" ? row.channelId : ""))).toEqual([
            "tg",
            "tg2",
        ])
    })

    test("no channels means no allow section at all, heading included", () => {
        // A heading over nothing is a row the cursor has to step past for no reason.
        expect(build().some((row) => row.kind === "allow")).toBe(false)
        expect(build().some((row) => row.kind === "heading" && row.label.includes("reach"))).toBe(
            false,
        )
    })

    test("every secret the manifest depends on gets a row", () => {
        const secrets = build().filter((row) => row.kind === "secret")
        expect(secrets.length).toBe(1)
        expect(secrets[0]?.kind === "secret" && secrets[0].name).toBe("MODEL_API_KEY")
    })

    test("each manifest block gets exactly one heading", () => {
        const headings = build()
            .filter((row) => row.kind === "heading")
            .map((row) => (row.kind === "heading" ? row.label : ""))
        expect(new Set(headings).size).toBe(headings.length)
    })

    test("a heading always has at least one row under it", () => {
        // Otherwise the cursor steps over a label describing nothing.
        const rows = build([{ id: "tg", type: "telegram", allowFrom: [] }])
        for (const [at, row] of rows.entries()) {
            if (row.kind !== "heading") continue
            expect(rows[at + 1]?.kind).not.toBe("heading")
            expect(rows[at + 1]).toBeDefined()
        }
    })
})
