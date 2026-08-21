/**
 * The `config` command, end to end on a real manifest in a tmpdir.
 *
 * At this end of the pipeline on purpose. Every layer under it is asserted separately — the writer in
 * core, the rendering and the policy in `config-view.ts` — and this repo's most repeated bug is every
 * layer being individually right with one of them not connected. `apiKeyEnv`, `ChatMessage.toolCalls`,
 * `TurnInput.skills`, `ToolContext.readArtifact`, `ToolContext.memoryDir` and `StoredMessage.origin`
 * were all that shape, six rounds of debugging, and the cheap guard is always a test that reads the
 * value out at the far end.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND, HarnessError, parseDotEnv } from "@dispach/core"
import { configCommand, readAction } from "#config"

const MANIFEST = `apiVersion: ${BRAND.apiVersion}
id: cfg
name: Cfg

model:
  main:
    # A comment that must survive.
    id: deepseek-chat
    baseUrl: https://api.deepseek.com/v1
    temperature: 0.3

tools:
  dialect: nlt
  local:
    - now
  policy:
    mode: allow
    allow: []
    deny:
      - "exec(rm *)"
  untrusted:
    onMutate: refuse

limits:
  maxSteps: 6

server:
  enabled: false
  host: 127.0.0.1
  port: 7420

# channels:
#   - type: telegram
#     id: tg
#     tokenEnv: TELEGRAM_BOT_TOKEN
`

let dir = ""
let file = ""
let printed: string[] = []

/** The environment a real run sees, minus anything this machine happens to export. */
const CLEAN = { PATH: "/usr/bin" } as const

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-cmd-"))
    file = join(dir, "agent.yaml")
    writeFileSync(file, MANIFEST)
    printed = []
})

function out(text: string): void {
    printed.push(text)
}

function said(): string {
    return printed.join("")
}

function manifest(): string {
    return readFileSync(file, "utf8")
}

describe("list", () => {
    test("prints every setting with the value actually in the file", () => {
        expect(configCommand({ action: "list", ref: file, out, sandboxEnv: CLEAN })).resolves.toBe(
            0,
        )
    })

    test("the current values are read out of the manifest, not defaulted", async () => {
        await configCommand({ action: "list", ref: file, out, sandboxEnv: CLEAN })
        expect(said()).toContain("limits.maxSteps  6")
        expect(said()).toContain("tools.dialect  nlt")
        expect(said()).toContain("server.host  127.0.0.1")
        // Commented out in the file, so absent rather than empty.
        expect(said()).toContain("channels  (not set)")
    })

    test("a key inside a list entry is gathered by id", async () => {
        writeFileSync(
            file,
            MANIFEST.replace(
                "# channels:",
                'channels:\n  - type: telegram\n    id: tg\n    tokenEnv: T\n    allowFrom: ["@moeen_m"]\n# channels:',
            ),
        )
        await configCommand({ action: "list", ref: file, out, sandboxEnv: CLEAN })
        expect(said()).toContain('channels[].allowFrom  {"tg":["@moeen_m"]}')
    })
})

describe("get", () => {
    test("one setting, with what it means", async () => {
        await configCommand({
            action: "get",
            ref: file,
            name: "model.main.id",
            out,
            sandboxEnv: CLEAN,
        })
        expect(said()).toContain("model.main.id  deepseek-chat")
        expect(said()).toContain("the model this agent runs on")
    })

    test("an unknown path is refused with the nearest match", async () => {
        const error = await refusal(
            configCommand({
                action: "get",
                ref: file,
                name: "model.main.di",
                out,
                sandboxEnv: CLEAN,
            }),
        )
        expect(error.code).toBe("cli_config_path_unknown")
        expect(error.hint).toContain("Did you mean model.main.id")
    })
})

describe("set", () => {
    test("writes the value and changes nothing else in the file", async () => {
        await configCommand({
            action: "set",
            ref: file,
            name: "limits.maxSteps",
            value: "9",
            out,
            sandboxEnv: CLEAN,
        })
        expect(manifest()).toBe(MANIFEST.replace("maxSteps: 6", "maxSteps: 9"))
        expect(said()).toContain("limits.maxSteps = 9")
        expect(said()).toContain("6")
    })

    test("a person may set a field the agent is floored on", async () => {
        // The whole reason this command exists. Decision 11.29 reserves this for a person, and until
        // now the only editor was the agent's — so the fields designated theirs had no editor at all.
        await configCommand({
            action: "set",
            ref: file,
            name: "server.host",
            value: "0.0.0.0",
            out,
            sandboxEnv: CLEAN,
        })
        expect(manifest()).toContain("host: 0.0.0.0")
    })

    test("a value the schema rejects leaves the file untouched", async () => {
        await expect(
            configCommand({
                action: "set",
                ref: file,
                name: "limits.maxSteps",
                value: "plenty",
                out,
                sandboxEnv: CLEAN,
            }),
        ).rejects.toThrow()
        expect(manifest()).toBe(MANIFEST)
    })

    test("a field set by another action says which", async () => {
        const error = await refusal(
            configCommand({
                action: "set",
                ref: file,
                name: "channels[].allowFrom",
                value: '["@x"]',
                out,
                sandboxEnv: CLEAN,
            }),
        )
        expect(error.hint).toContain("config allow")
    })

    test("no value at all is refused rather than writing an empty string", async () => {
        await expect(
            configCommand({
                action: "set",
                ref: file,
                name: "tools.dialect",
                out,
                sandboxEnv: CLEAN,
            }),
        ).rejects.toThrow(/No value given/)
        expect(manifest()).toBe(MANIFEST)
    })

    describe("the confirmation", () => {
        test("a declined guard-weakening edit writes nothing", async () => {
            await configCommand({
                action: "set",
                ref: file,
                name: "tools.untrusted.onMutate",
                value: "allow",
                confirm: async () => false,
                out,
                sandboxEnv: CLEAN,
            })
            expect(manifest()).toBe(MANIFEST)
            expect(said()).toContain("unchanged")
            // The reason is printed before the question, not after the refusal.
            expect(said()).toContain("turns off the check")
        })

        test("an accepted one writes", async () => {
            await configCommand({
                action: "set",
                ref: file,
                name: "tools.untrusted.onMutate",
                value: "allow",
                confirm: async () => true,
                out,
                sandboxEnv: CLEAN,
            })
            expect(manifest()).toContain("onMutate: allow")
        })

        test("tightening the same field is not confirmed at all", async () => {
            let asked = 0
            await configCommand({
                action: "set",
                ref: file,
                name: "tools.untrusted.onMutate",
                value: "confirm",
                confirm: async () => {
                    asked += 1
                    return true
                },
                out,
                sandboxEnv: CLEAN,
            })
            expect(asked).toBe(0)
            expect(manifest()).toContain("onMutate: confirm")
        })

        test("--yes skips it", async () => {
            let asked = 0
            await configCommand({
                action: "set",
                ref: file,
                name: "tools.policy.deny",
                value: "[]",
                yes: true,
                confirm: async () => {
                    asked += 1
                    return true
                },
                out,
                sandboxEnv: CLEAN,
            })
            expect(asked).toBe(0)
        })
    })

    test("an unrelated edit says nothing about secrets", async () => {
        // A note about tokens printed on every `limits.maxSteps` change is a note nobody reads by the
        // time it matters. A live run got this wrong in the other direction, warning that an agent with
        // a disabled server "will refuse to start".
        await configCommand({
            action: "set",
            ref: file,
            name: "limits.maxSteps",
            value: "8",
            out,
            sandboxEnv: CLEAN,
        })
        expect(said()).not.toContain("is not set")
    })

    test("an edit that makes a variable load-bearing names it", async () => {
        await configCommand({
            action: "set",
            ref: file,
            name: "server.enabled",
            value: "true",
            out,
            sandboxEnv: CLEAN,
        })
        // `server.tokenEnv` is absent from this fixture, so nothing is newly required; enabling a
        // channel is the case that has one.
        await configCommand({
            action: "set",
            ref: file,
            name: "channels",
            value: "[{type: telegram, id: tg, tokenEnv: TELEGRAM_BOT_TOKEN, mode: longpoll}]",
            out,
            sandboxEnv: CLEAN,
        })
        expect(said()).toContain("TELEGRAM_BOT_TOKEN is not set")
        expect(said()).toContain("will not start")
        expect(said()).toContain("config env")
    })

    test("a commented block is uncommented in place rather than reflowing the file", async () => {
        await configCommand({
            action: "set",
            ref: file,
            name: "channels",
            value: "[{type: telegram, id: tg, tokenEnv: T, mode: longpoll}]",
            out,
            sandboxEnv: CLEAN,
        })
        expect(said()).not.toContain("re-serialised")
        expect(manifest()).toContain("\nchannels:\n  - type: telegram")
        // Everything above it is byte-identical.
        const upto = MANIFEST.indexOf("# channels:")
        expect(manifest().slice(0, upto)).toBe(MANIFEST.slice(0, upto))
    })
})

describe("env", () => {
    test("writes the prompted value at 0600 and keeps the rest of the file", async () => {
        const envFile = join(dir, ".env")
        writeFileSync(envFile, "# a comment\nMODEL_API_KEY=\n")
        await configCommand({
            action: "env",
            ref: file,
            name: "MODEL_API_KEY",
            secret: async () => "sk-live",
            out,
            sandboxEnv: CLEAN,
        })
        const text = readFileSync(envFile, "utf8")
        expect(parseDotEnv(text).MODEL_API_KEY).toBe("sk-live")
        expect(text).toContain("# a comment")
        expect(statSync(envFile).mode & 0o777).toBe(0o600)
        expect(said()).toContain("replaced")
        // Never the value itself.
        expect(said()).not.toContain("sk-live")
    })

    test("a file that did not exist is created at 0600", async () => {
        await configCommand({
            action: "env",
            ref: file,
            name: "TELEGRAM_BOT_TOKEN",
            secret: async () => "123:abc",
            out,
            sandboxEnv: CLEAN,
        })
        expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600)
    })

    test("a loose existing file is tightened, and it says so", async () => {
        // Under a service manager this file is the only path credentials take, so tightening it is right
        // even when this command did not create it.
        const envFile = join(dir, ".env")
        writeFileSync(envFile, "K=v\n", { mode: 0o644 })
        await configCommand({
            action: "env",
            ref: file,
            name: "K2",
            secret: async () => "v2",
            out,
            sandboxEnv: CLEAN,
        })
        expect(statSync(envFile).mode & 0o777).toBe(0o600)
        expect(said()).toContain("tightened")
    })

    test("no value means nothing written, and the reason names the exposure", async () => {
        const error = await refusal(
            configCommand({
                action: "env",
                ref: file,
                name: "MODEL_API_KEY",
                secret: async () => undefined,
                out,
                sandboxEnv: CLEAN,
            }),
        )
        expect(error.code).toBe("cli_config_env_no_value")
        expect(error.hint).toContain("never from an argument or a pipe")
    })

    test("an empty value is refused, because it fails the load exactly as absent does", async () => {
        await expect(
            configCommand({
                action: "env",
                ref: file,
                name: "MODEL_API_KEY",
                secret: async () => "",
                out,
                sandboxEnv: CLEAN,
            }),
        ).rejects.toThrow(/empty value/)
    })

    test("a name that is not an env variable is refused", async () => {
        await expect(
            configCommand({
                action: "env",
                ref: file,
                name: "not-a-name",
                secret: async () => "x",
                out,
                sandboxEnv: CLEAN,
            }),
        ).rejects.toThrow(/not an environment variable name/)
    })
})

describe("allow", () => {
    beforeEach(() => {
        writeFileSync(
            file,
            MANIFEST.replace(
                "# channels:\n#   - type: telegram\n#     id: tg\n#     tokenEnv: TELEGRAM_BOT_TOKEN\n",
                "channels:\n  - type: telegram\n    id: tg\n    tokenEnv: T\n    mode: longpoll\n",
            ),
        )
    })

    test("a handle that cannot exist is refused at the moment it is typed", async () => {
        // The recorded bug: a bot connected, healthy, and refusing every message from the one person it
        // was set up for, because a handle had a hyphen where an underscore belonged.
        await expect(
            configCommand({
                action: "allow",
                ref: file,
                name: "@ada-lovelace",
                out,
                sandboxEnv: CLEAN,
            }),
        ).rejects.toThrow(/hyphen/)
        expect(manifest()).not.toContain("allowFrom")
    })

    test("a bare handle is normalised to a leading @", async () => {
        await configCommand({ action: "allow", ref: file, name: "moeen_m", out, sandboxEnv: CLEAN })
        // Quoted, because `@` is a reserved YAML indicator and a bare `- @moeen_m` does not parse.
        expect(manifest()).toContain('allowFrom:\n      - "@moeen_m"')
    })

    test("running it twice adds one entry and says so", async () => {
        await configCommand({
            action: "allow",
            ref: file,
            name: "@moeen_m",
            out,
            sandboxEnv: CLEAN,
        })
        printed = []
        await configCommand({
            action: "allow",
            ref: file,
            name: "@moeen_m",
            out,
            sandboxEnv: CLEAN,
        })
        expect(said()).toContain("already allowed")
        expect(manifest().match(/@moeen_m/g)?.length).toBe(1)
    })

    test("--remove takes it off", async () => {
        await configCommand({
            action: "allow",
            ref: file,
            name: "@moeen_m",
            out,
            sandboxEnv: CLEAN,
        })
        await configCommand({
            action: "allow",
            ref: file,
            name: "@moeen_m",
            remove: true,
            out,
            sandboxEnv: CLEAN,
        })
        expect(manifest()).not.toContain("@moeen_m")
    })

    test("two channels need --channel", async () => {
        writeFileSync(
            file,
            manifest().replace(
                "    mode: longpoll\n",
                "    mode: longpoll\n  - type: telegram\n    id: tg2\n    tokenEnv: T2\n    mode: longpoll\n",
            ),
        )
        await expect(
            configCommand({ action: "allow", ref: file, name: "@moeen_m", out, sandboxEnv: CLEAN }),
        ).rejects.toThrow(/--channel says which/)
        await configCommand({
            action: "allow",
            ref: file,
            name: "@moeen_m",
            channel: "tg2",
            out,
            sandboxEnv: CLEAN,
        })
        expect(said()).toContain("tg2")
    })

    test("an unknown channel id suggests the nearest", async () => {
        const error = await refusal(
            configCommand({
                action: "allow",
                ref: file,
                name: "@moeen_m",
                channel: "tgg",
                out,
                sandboxEnv: CLEAN,
            }),
        )
        expect(error.hint).toContain("Did you mean tg")
    })
})

describe("readAction", () => {
    test("a known action word wins", () => {
        expect(readAction("list", "milo")).toEqual({ action: "list", ref: "milo" })
        expect(readAction("set", "milo")).toEqual({ action: "set", ref: "milo" })
    })

    test("anything else is the agent, and the action is the editor", () => {
        // `config milo` is the obvious thing to type, so it has to work. Same rule as a slash command
        // taking arguments only after an exact match, and as `resolveAgentRef` letting a path win.
        expect(readAction("milo", undefined)).toEqual({ action: "edit", ref: "milo" })
        expect(readAction("./somewhere/agent.yaml", undefined)).toEqual({
            action: "edit",
            ref: "./somewhere/agent.yaml",
        })
    })

    test("nothing at all is the editor with no agent", () => {
        expect(readAction(undefined, undefined)).toEqual({ action: "edit", ref: undefined })
    })

    test("two action words note which was read as which", () => {
        // The collision is an agent literally named after an action. Running the wrong one quietly is
        // the failure worth avoiding, and it does not look wrong in the output.
        const said: string[] = []
        expect(readAction("list", "edit", (line) => said.push(line))).toEqual({
            action: "list",
            ref: "edit",
        })
        expect(said.join("")).toContain('reading "list" as the action')
    })

    test("a bare action word carries no agent, so the usual missing-manifest error applies", () => {
        expect(readAction("edit", undefined)).toEqual({ action: "edit", ref: undefined })
        expect(readAction("set", undefined)).toEqual({ action: "set", ref: undefined })
    })
})

describe("edit", () => {
    test("refuses without a terminal rather than writing an escape into a pipe", async () => {
        // Attempted, it wrote the alternate-screen sequence to a *pipe* and Ink's own "raw mode is not
        // supported" error left the command exiting **0** — a failure reported as success.
        const error = await refusal(
            configCommand({ action: "edit", ref: file, out, sandboxEnv: CLEAN }),
        )
        expect(error.code).toBe("cli_config_edit_needs_terminal")
        expect(error.hint).toContain("config list")
        expect(said()).toBe("")
    })
})

describe("the action itself", () => {
    test("an unknown action names the ones that exist", async () => {
        const error = await refusal(
            configCommand({ action: "sett", ref: file, out, sandboxEnv: CLEAN }),
        )
        expect(error.hint).toContain("list, get, set, env, allow")
        expect(error.hint).toContain("Did you mean set")
    })
})

/**
 * The error a call threw, for asserting on `hint`.
 *
 * A suggestion lives in the hint rather than the message — `toThrow` matches the message only, so
 * asserting a "did you mean" through it passes for the wrong reason or fails for the wrong one.
 */
async function refusal(run: Promise<unknown>): Promise<HarnessError> {
    try {
        await run
    } catch (error) {
        if (error instanceof HarnessError) return error
        throw error
    }
    throw new Error("expected a refusal, and the call succeeded")
}
