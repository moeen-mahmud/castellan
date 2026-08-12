/**
 * Typed errors, every one carrying a hint that names the likely fix.
 *
 * The expensive part of a failure is almost never the failure — it is that the failure did
 * not say what was wrong. So `hint` is a *required* constructor parameter rather than a
 * convention: an error type without one does not compile.
 *
 * `code` is stable and machine-readable; it appears verbatim in the wire protocol's error
 * envelope and must not change once published.
 */

export interface ErrorDetail {
    /** Stable, machine-readable. Snake case. */
    readonly code: string
    readonly message: string
    /** What to do about it. Never empty. */
    readonly hint: string
    /** Dotted path into the manifest, where applicable: `tools.pinned[2]`. */
    readonly field?: string
}

export interface HarnessErrorInit {
    code: string
    message: string
    hint: string
    field?: string
    cause?: unknown
    /** Sub-failures, when one load surfaces several independent problems at once. */
    details?: ErrorDetail[]
}

/** Base for every error this runtime raises deliberately. */
export class HarnessError extends Error {
    readonly code: string
    readonly hint: string
    readonly field: string | undefined
    readonly details: ErrorDetail[]

    constructor(init: HarnessErrorInit) {
        super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
        this.name = new.target.name
        this.code = init.code
        this.hint = init.hint
        this.field = init.field
        this.details = init.details ?? []
    }

    toDetail(): ErrorDetail {
        return this.field === undefined
            ? { code: this.code, message: this.message, hint: this.hint }
            : { code: this.code, message: this.message, hint: this.hint, field: this.field }
    }

    /** Multi-line, for a terminal. The wire surface uses `toDetail()` instead. */
    format(): string {
        const lines = [`${this.code}: ${this.message}`]
        if (this.field !== undefined) lines.push(`  field: ${this.field}`)
        lines.push(`  hint: ${this.hint}`)

        // A single failure is already fully described by the summary above — the wrapper adopts
        // its message, field, and hint. Printing it twice makes one problem look like two.
        if (this.details.length === 1) return lines.join("\n")

        for (const detail of this.details) {
            lines.push("")
            lines.push(`  ${detail.code}: ${detail.message}`)
            if (detail.field !== undefined) lines.push(`    field: ${detail.field}`)
            lines.push(`    hint: ${detail.hint}`)
        }
        return lines.join("\n")
    }
}

/** Anything wrong with a manifest, its referenced files, or the environment it needs. */
export class ConfigError extends HarnessError {}

/** Anything wrong between us and a model endpoint. */
export class ModelError extends HarnessError {}

/** A turn ended because something asked it to, not because it failed. */
export class AbortedError extends HarnessError {}

// ─── Config ──────────────────────────────────────────────────────────────────────────────

export function manifestUnreadable(path: string, cause: unknown): ConfigError {
    return new ConfigError({
        code: "manifest_unreadable",
        message: `Cannot read manifest at ${path}.`,
        hint: "Check the path and file permissions. Paths are resolved relative to the current working directory.",
        cause,
    })
}

export function manifestNotYaml(path: string, cause: unknown): ConfigError {
    return new ConfigError({
        code: "manifest_not_yaml",
        message: `Manifest at ${path} is not valid YAML.`,
        hint: "Check indentation and quoting. A tab character anywhere in YAML indentation is the usual cause.",
        cause,
    })
}

export function manifestNotObject(path: string): ConfigError {
    return new ConfigError({
        code: "manifest_not_object",
        message: `Manifest at ${path} did not parse to a mapping.`,
        hint: "The top level of a manifest is a YAML mapping starting with apiVersion and id.",
    })
}

export function apiVersionMismatch(found: unknown, expected: string): ConfigError {
    return new ConfigError({
        code: "manifest_api_version",
        message: `Unsupported apiVersion ${JSON.stringify(found)} — expected "${expected}".`,
        hint: `Set apiVersion: ${expected}. Manifests are never silently upgraded, because a config that quietly means something different is worse than one that refuses to load.`,
        field: "apiVersion",
    })
}

export function schemaInvalid(details: ErrorDetail[]): ConfigError {
    const first = details[0]
    return new ConfigError({
        code: "manifest_schema_invalid",
        message:
            details.length === 1 && first !== undefined
                ? `Manifest is invalid: ${first.message}`
                : `Manifest is invalid — ${details.length} problems.`,
        hint: "Each problem below names its field path. See docs/02-SPEC-MANIFEST.md for the field reference.",
        ...(first?.field === undefined ? {} : { field: first.field }),
        details,
    })
}

export function validationFailed(details: ErrorDetail[]): ConfigError {
    const first = details[0]
    return new ConfigError({
        code: "manifest_validation_failed",
        message:
            details.length === 1 && first !== undefined
                ? first.message
                : `Manifest failed ${details.length} validation rules.`,
        hint:
            details.length === 1 && first !== undefined
                ? first.hint
                : "Each failure below names its field path and its fix.",
        ...(first?.field === undefined ? {} : { field: first.field }),
        details,
    })
}

export function envVarMissing(name: string, field: string): ConfigError {
    return new ConfigError({
        code: "env_var_missing",
        message: `Environment variable ${name} is referenced by ${field} but is not set.`,
        hint: `Export ${name}, or add it to a .env file beside the manifest. This fails at load on purpose — an unset variable expanding to an empty string surfaces later as a confusing auth error.`,
        field,
    })
}

export function refUnresolved(ref: string, field: string): ConfigError {
    return new ConfigError({
        code: "manifest_ref_unresolved",
        message: `$ref "${ref}" at ${field} does not resolve to anything.`,
        hint: "A $ref is a dotted path from the manifest root, e.g. $ref: model.selector. The target must be defined before it is referenced.",
        field,
    })
}

export function refCycle(ref: string, field: string): ConfigError {
    return new ConfigError({
        code: "manifest_ref_cycle",
        message: `$ref "${ref}" at ${field} is part of a cycle.`,
        hint: "A $ref cannot resolve to itself or to a chain that leads back to itself.",
        field,
    })
}

export function extendsUnresolved(path: string, field: string, cause: unknown): ConfigError {
    return new ConfigError({
        code: "manifest_extends_unresolved",
        message: `Base manifest ${path} could not be loaded.`,
        hint: "extends takes a path relative to the manifest that declares it. The merge is shallow, and arrays replace rather than concatenate.",
        field,
        cause,
    })
}

// ─── Model ───────────────────────────────────────────────────────────────────────────────

export function apiKeyMissing(envName: string, field: string): ConfigError {
    return new ConfigError({
        code: "model_api_key_missing",
        message: `Environment variable ${envName} is named by ${field} but is not set.`,
        hint: `Export ${envName}. The manifest holds the variable's *name*, never its value, and the value is read fresh on every request so rotating the key needs no restart.`,
        field,
    })
}

export function modelHttpError(status: number, body: string, url: string): ModelError {
    const trimmed = body.length > 500 ? `${body.slice(0, 500)}…` : body
    return new ModelError({
        code: "model_http_error",
        message: `Model endpoint returned ${status} for ${url}: ${trimmed}`,
        hint:
            status === 401 || status === 403
                ? "Check the API key named by model.main.apiKeyEnv, and that baseUrl points at the right provider."
                : status === 404
                  ? "baseUrl must end at the version segment, e.g. https://api.example.com/v1 — the runtime appends /chat/completions itself."
                  : "Retried on 429 and 5xx already. If this persists, the endpoint is genuinely unavailable or the model id is not served there.",
    })
}

export function modelStreamMalformed(payload: string, cause: unknown): ModelError {
    const trimmed = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload
    return new ModelError({
        code: "model_stream_malformed",
        message: `Model endpoint sent a stream frame that is not JSON: ${trimmed}`,
        hint: "This is usually a proxy injecting an error page into an SSE stream, or a gateway that does not implement streaming. Try the same request with a plain curl to see the raw bytes.",
        cause,
    })
}

export function modelUnreachable(url: string, cause: unknown): ModelError {
    return new ModelError({
        code: "model_unreachable",
        message: `Cannot reach the model endpoint at ${url}.`,
        hint: "Check baseUrl and that the endpoint is running. For a local Ollama, the base URL is http://localhost:11434/v1.",
        cause,
    })
}

// ─── Turn ────────────────────────────────────────────────────────────────────────────────

export function turnStopped(turnId: string): AbortedError {
    return new AbortedError({
        code: "turn_stopped",
        message: `Turn ${turnId} was stopped.`,
        hint: "This is a normal outcome of an explicit stop. Partial content is persisted; a disconnect would not have stopped it.",
    })
}

export function turnTimeout(turnId: string, ms: number): AbortedError {
    return new AbortedError({
        code: "turn_timeout",
        message: `Turn ${turnId} exceeded limits.turnTimeoutMs (${ms} ms).`,
        hint: "Raise limits.turnTimeoutMs, which must exceed any upstream timeout on the model endpoint.",
        field: "limits.turnTimeoutMs",
    })
}

// ─── Unsupported ─────────────────────────────────────────────────────────────────────────

export function notImplementedYet(feature: string, phase: string): ConfigError {
    return new ConfigError({
        code: "not_implemented_yet",
        message: `The manifest configures ${feature}, which this build does not implement.`,
        hint: `${feature} arrives in ${phase}. Remove the section for now — it is refused rather than ignored, because silently dropping configuration is how a runtime lies about what it is doing.`,
    })
}
