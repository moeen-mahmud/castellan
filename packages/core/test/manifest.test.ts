import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAND } from "../src/brand.ts"
import { HarnessError } from "../src/errors.ts"
import { loadManifest } from "../src/manifest/load.ts"
import { describe, expect, test } from "./_harness.ts"

/**
 * Manifest loading is where a config mistake either becomes a named field and a fix, or becomes
 * a mystery three layers away. Each case below asserts the *diagnosis*, not just the failure.
 */

const ENV = { MODEL_API_KEY: "test-key" }

function workspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "manifest-test-"))
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content)
    }
    return dir
}

function manifestYaml(body: string): string {
    return `apiVersion: ${BRAND.apiVersion}\n${body}`
}

const VALID = manifestYaml(`id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`)

function load(files: Record<string, string>, env: Record<string, string | undefined> = ENV) {
    const dir = workspace(files)
    return loadManifest(join(dir, "agent.yaml"), { env, skipEnvFile: true })
}

function expectFailure(
    files: Record<string, string>,
    env: Record<string, string | undefined> = ENV,
): HarnessError {
    try {
        load(files, env)
    } catch (error) {
        if (error instanceof HarnessError) return error
        throw error
    }
    throw new Error("expected the load to fail")
}

/** Every detail on every failure, so assertions can look at codes, fields, and hints. */
function allDetails(error: HarnessError) {
    return error.details.length > 0 ? error.details : [error.toDetail()]
}

function codes(error: HarnessError): string[] {
    return allDetails(error).map((d) => d.code)
}

function fields(error: HarnessError): (string | undefined)[] {
    return allDetails(error).map((d) => d.field)
}

describe("a valid manifest", () => {
    test("loads, and defaults are applied", () => {
        const { manifest, window } = load({ "agent.yaml": VALID })
        expect(manifest.id).toBe("test")
        expect(manifest.tools.dialect).toBe("nlt")
        expect(manifest.limits.maxSteps).toBe(12)
        expect(manifest.context.thresholds.trim).toBe(0.6)
        // Window comes from the capability registry when the manifest does not set it.
        expect(window).toBe(128_000)
    })

    test("the default dialect is NLT, not native", () => {
        // The single most consequential default in the runtime. If this ever silently flips, small
        // models lose double-digit accuracy and nothing in the logs says why.
        expect(load({ "agent.yaml": VALID }).manifest.tools.dialect).toBe("nlt")
    })

    test("an explicit window overrides the registry", () => {
        const { window } = load({
            "agent.yaml": manifestYaml(`id: test
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 4096
  reserveOutput: 512
`),
        })
        expect(window).toBe(4096)
    })
})

describe("rule 1 — apiVersion", () => {
    test("a wrong version names both what was found and what is expected", () => {
        const error = expectFailure({ "agent.yaml": `apiVersion: ${BRAND.slug}/v2\nid: t\n` })
        expect(error.code).toBe("manifest_api_version")
        expect(error.message).toContain(`${BRAND.slug}/v2`)
        expect(error.message).toContain(BRAND.apiVersion)
        expect(error.field).toBe("apiVersion")
    })

    test("a missing version fails as a version problem, not as a schema problem", () => {
        expect(expectFailure({ "agent.yaml": "id: t\n" }).code).toBe("manifest_api_version")
    })

    test("the version is never silently upgraded", () => {
        expect(
            expectFailure({ "agent.yaml": `apiVersion: ${BRAND.slug}/v0\nid: t\n` }).hint,
        ).toContain("never silently upgraded")
    })
})

describe("rule 2 — secrets are names, never values", () => {
    test("a literal OpenAI-style key fails, naming the field", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: sk-abcdefghijklmnopqrstuvwxyz012345
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
        expect(fields(error)).toContain("model.main.apiKeyEnv")
    })

    test("an unknown `apiKey` key is reported as a secret, not as a typo", () => {
        // The user's mistake is the credential in the file. Leading with "unknown key" would send
        // them to the spec to look up a field name instead of to their shell history to rotate a key.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKey: sk-abcdefghijklmnopqrstuvwxyz012345
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
        expect(fields(error)).toContain("model.main.apiKey")
    })

    test("a Bearer header value fails", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    headers:
      authorization: "Bearer abc123def456"
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
    })

    test("a 32-character hex blob fails", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: 0123456789abcdef0123456789abcdef
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
    })

    test("an env var *name* is fine", () => {
        expect(load({ "agent.yaml": VALID }).manifest.model.main.apiKeyEnv).toBe("MODEL_API_KEY")
    })

    test("a lowercase value in apiKeyEnv fails even without a credential shape", () => {
        // `apiKeyEnv: my-key` is almost certainly a value, not a variable name.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: my-secret-value
`),
        })
        expect(codes(error)).toContain("manifest_literal_secret")
    })
})

describe("rule 3 — compaction thresholds", () => {
    const withThresholds = (thresholds: string) =>
        manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
${thresholds}`)

    test("equal thresholds are rejected", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    trim: 0.7\n    snip: 0.7\n"),
        })
        expect(codes(error)).toContain("manifest_thresholds_not_ascending")
    })

    test("inverted thresholds are rejected, naming the offending stage", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    trim: 0.9\n    snip: 0.7\n"),
        })
        expect(fields(error)).toContain("context.thresholds.snip")
    })

    test("a threshold outside (0,1) is rejected", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    reset: 1.5\n"),
        })
        expect(codes(error)).toContain("manifest_threshold_range")
    })

    test("zero is rejected — a stage that always fires is not a stage", () => {
        const error = expectFailure({
            "agent.yaml": withThresholds("  thresholds:\n    trim: 0\n"),
        })
        expect(codes(error)).toContain("manifest_threshold_range")
    })
})

describe("rule 4 — write reservation", () => {
    test("reserveWrite equal to max is rejected", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  budget:
    max: 6
    reserveWrite: 6
`),
        })
        expect(codes(error)).toContain("manifest_reserve_write_too_large")
        expect(fields(error)).toContain("tools.budget.reserveWrite")
    })
})

describe("rules 10 and 11 — context files and budget", () => {
    test("a missing context file fails at load, naming the path", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  files:
    - IDENTITY.md
`),
        })
        expect(codes(error)).toContain("manifest_context_file_missing")
        expect(fields(error)).toContain("context.files[0]")
    })

    test("a present context file loads", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  files:
    - IDENTITY.md
`),
            "IDENTITY.md": "You are helpful.",
        })
        expect(loaded.manifest.context.files).toEqual(["IDENTITY.md"])
    })

    test("reserveOutput above the window is rejected", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
context:
  window: 4096
  reserveOutput: 8192
`),
        })
        expect(codes(error)).toContain("manifest_reserve_output_too_large")
    })
})

describe("environment expansion", () => {
    test("an unset variable fails at load, naming the variable and the field", () => {
        const error = expectFailure(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: \${MODEL_ID}
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
`),
            },
            ENV,
        )
        expect(error.code).toBe("env_var_missing")
        expect(error.message).toContain("MODEL_ID")
        expect(error.field).toBe("model.main.id")
    })

    test("the failure explains why it is not deferred", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: \${NOPE}
    baseUrl: https://api.example.com/v1
`),
        })
        expect(error.hint).toContain("auth error")
    })

    test("a set variable expands", () => {
        const loaded = load(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: \${MODEL_ID}
    baseUrl: \${MODEL_BASE_URL}
    apiKeyEnv: MODEL_API_KEY
`),
            },
            { ...ENV, MODEL_ID: "qwen3:8b", MODEL_BASE_URL: "http://localhost:11434/v1" },
        )
        expect(loaded.manifest.model.main.id).toBe("qwen3:8b")
        expect(loaded.manifest.model.main.baseUrl).toBe("http://localhost:11434/v1")
    })

    test("an apiKeyEnv naming an unset variable fails at load, not at first request", () => {
        const error = expectFailure({ "agent.yaml": VALID }, {})
        expect(codes(error)).toContain("model_api_key_missing")
        expect(fields(error)).toContain("model.main.apiKeyEnv")
    })

    test("omitting apiKeyEnv is allowed, for a keyless local endpoint", () => {
        const loaded = load(
            {
                "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: qwen3:8b
    baseUrl: http://localhost:11434/v1
`),
            },
            {},
        )
        expect(loaded.manifest.model.main.apiKeyEnv).toBeUndefined()
    })
})

describe("$ref", () => {
    test("a role can reuse another role's definition", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  selector:
    id: gpt-4o-mini-small
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    $ref: model.selector
`),
        })
        expect(loaded.manifest.model.compactor?.id).toBe("gpt-4o-mini-small")
    })

    test("an unresolvable $ref names the path", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    $ref: model.nonexistent
`),
        })
        expect(error.code).toBe("manifest_ref_unresolved")
        expect(error.message).toContain("model.nonexistent")
    })

    test("a self-referential $ref is a cycle, not a hang", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor:
    $ref: model.compactor
`),
        })
        expect(error.code).toBe("manifest_ref_cycle")
    })
})

describe("unknown keys and shapes", () => {
    test("an unknown top-level key is refused, not ignored", () => {
        const error = expectFailure({ "agent.yaml": `${VALID}unexpected: true\n` })
        expect(error.code).toBe("manifest_schema_invalid")
        expect(allDetails(error)[0]?.hint).toContain("refused rather than ignored")
    })

    test("a misspelled nested key is refused", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    tempurature: 0.3
`),
        })
        expect(error.code).toBe("manifest_schema_invalid")
        expect(fields(error).some((f) => f?.startsWith("model.main"))).toBe(true)
    })

    test("a missing model section is a schema failure naming the path", () => {
        const error = expectFailure({ "agent.yaml": manifestYaml("id: t\n") })
        expect(error.code).toBe("manifest_schema_invalid")
        expect(fields(error)).toContain("model")
    })

    test("an invalid dialect names the field", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  dialect: freestyle
`),
        })
        expect(fields(error)).toContain("tools.dialect")
    })

    test("malformed YAML is reported as YAML, with the tab hint", () => {
        const error = expectFailure({ "agent.yaml": "apiVersion: x\n\tid: bad\n" })
        expect(error.code).toBe("manifest_not_yaml")
        expect(error.hint).toContain("tab")
    })

    test("a missing file names the path and the resolution rule", () => {
        let error: HarnessError | undefined
        try {
            loadManifest("/definitely/not/here/agent.yaml", { env: ENV, skipEnvFile: true })
        } catch (caught) {
            error = caught as HarnessError
        }
        expect(error?.code).toBe("manifest_unreadable")
    })
})

describe("baseUrl", () => {
    test("a baseUrl that already includes /chat/completions is rejected", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1/chat/completions
    apiKeyEnv: MODEL_API_KEY
`),
        })
        expect(codes(error)).toContain("manifest_base_url_includes_path")
    })

    test("a relative baseUrl is rejected with the version-segment hint", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: /v1
    apiKeyEnv: MODEL_API_KEY
`),
        })
        expect(codes(error)).toContain("manifest_base_url_invalid")
        expect(allDetails(error)[0]?.hint).toContain("version segment")
    })
})

describe("sections this build does not implement", () => {
    test("configuring channels is refused rather than silently ignored", () => {
        // A manifest that configures Telegram against a runtime with no channel support would
        // otherwise boot healthy and deliver nothing.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
channels:
  - type: telegram
    id: tg
    tokenEnv: TELEGRAM_BOT_TOKEN
`),
        })
        expect(codes(error)).toContain("not_implemented_yet")
        expect(allDetails(error)[0]?.hint).toContain("Phase 4")
    })

    test("pinning tools is refused, naming the phase that implements them", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  pinned:
    - GMAIL_SEND_EMAIL
`),
        })
        expect(codes(error)).toContain("not_implemented_yet")
        expect(allDetails(error)[0]?.hint).toContain("Phase 3")
    })

    test("setting the dialect alone is accepted — it is recorded and validated now", () => {
        const loaded = load({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
tools:
  dialect: native
`),
        })
        expect(loaded.manifest.tools.dialect).toBe("native")
    })
})

describe("extends", () => {
    test("a child manifest overrides its base, shallowly", () => {
        const loaded = load({
            "base.yaml": manifestYaml(`id: base
model:
  main:
    id: base-model
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
limits:
  maxSteps: 3
`),
            "agent.yaml": manifestYaml(`id: child
extends: ./base.yaml
`),
        })
        expect(loaded.manifest.id).toBe("child")
        expect(loaded.manifest.model.main.id).toBe("base-model")
        expect(loaded.manifest.limits.maxSteps).toBe(3)
    })

    test("a missing base names the path", () => {
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: child
extends: ./nope.yaml
`),
        })
        expect(error.code).toBe("manifest_extends_unresolved")
    })
})

describe("failure reporting", () => {
    test("several independent problems are reported together", () => {
        // Three edit-run cycles for three mistakes in one file is a bad trade for the user.
        const error = expectFailure({
            "agent.yaml": manifestYaml(`id: t
model:
  main:
    id: gpt-4o-mini
    baseUrl: https://api.example.com/v1/chat/completions
    apiKeyEnv: MODEL_API_KEY
context:
  window: 2048
  reserveOutput: 4096
  files:
    - MISSING.md
`),
        })
        expect(error.details.length).toBeGreaterThanOrEqual(3)
        expect(codes(error)).toContain("manifest_context_file_missing")
        expect(codes(error)).toContain("manifest_reserve_output_too_large")
        expect(codes(error)).toContain("manifest_base_url_includes_path")
    })

    test("every failure carries a non-empty hint", () => {
        const error = expectFailure({ "agent.yaml": `${VALID}unexpected: true\n` })
        for (const detail of allDetails(error)) {
            expect(detail.hint.length).toBeGreaterThan(0)
        }
    })

    test("format() prints the field and hint for a terminal", () => {
        const error = expectFailure({ "agent.yaml": "apiVersion: wrong\nid: t\n" })
        const printed = error.format()
        expect(printed).toContain("field:")
        expect(printed).toContain("hint:")
    })
})
