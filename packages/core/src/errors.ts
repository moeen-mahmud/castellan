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

import { BRAND } from "./brand.ts"
import type { EnvOverride } from "./manifest/env.ts"
import { nearest } from "./nearest.ts"

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

// ─── Tools ───────────────────────────────────────────────────────────────────────────────

/** Anything wrong with resolving, coercing, or running a tool. */
export class ToolError extends HarnessError {}

export interface UnknownToolInit {
    slug: string
    /** Providers actually consulted, so the message does not blame one that was never asked. */
    providers: readonly string[]
    available: readonly string[]
    field: string
    alsoMissing?: readonly string[]
}

/**
 * A pinned slug nothing could resolve. Fails the load, by design.
 *
 * Dropping it instead is the failure this replaces: the agent boots reporting itself healthy, the
 * model is told about a tool that does not exist or never hears about one it needs, and the symptom
 * arrives days later as "it just replies instead of doing the thing".
 */
export function unknownTool(init: UnknownToolInit): ConfigError {
    const suggestion = nearest(init.slug, init.available)
    const others =
        init.alsoMissing === undefined || init.alsoMissing.length === 0
            ? ""
            : ` Also unresolved: ${init.alsoMissing.join(", ")}.`

    return new ConfigError({
        code: "unknown_tool",
        message: `No provider resolved the tool "${init.slug}". Consulted: ${init.providers.length === 0 ? "none" : init.providers.join(", ")}.${others}`,
        hint:
            suggestion !== undefined
                ? `Did you mean "${suggestion}"? Slugs are resolved once at load, so a typo here can only ever fail — it is never a tool that appears later.`
                : `Check the slug against the provider's own catalogue. ${init.available.length === 0 ? "No provider offered a list of what it has." : `Available: ${init.available.slice(0, 12).join(", ")}${init.available.length > 12 ? ", …" : ""}.`}`,
        field: init.field,
    })
}

/** The registry was asked for a slug it does not hold. Never returns undefined instead. */
export function unknownToolAtRuntime(slug: string, known: readonly string[]): ToolError {
    return new ToolError({
        code: "unknown_tool_at_runtime",
        message: `The tool "${slug}" is not in this agent's catalogue.`,
        hint: `The catalogue is fixed at load and holds: ${known.length === 0 ? "no tools" : known.join(", ")}. A model inventing a slug is handled as a repair; reaching this error means something in the harness asked for a tool it never resolved.`,
    })
}

/**
 * A pinned tool that this configuration allows exactly once per turn.
 *
 * A tool that both changes things and returns text from outside the conversation taints the turn with
 * its own first call — after which the write gate requires the explicit authorisation nobody wrote.
 * The gate is behaving correctly; the configuration is what makes the second call fail, and only its
 * author can decide whether that is what they meant.
 *
 * A warning rather than a failure, because "run one command, then report back" is a legitimate shape
 * for an agent and nothing here can tell it apart from an oversight.
 */
export function toolGatedAfterFirstUse(slugs: readonly string[]): ErrorDetail {
    const list = slugs.join(", ")
    return {
        code: "tool_gated_after_first_use",
        message: `Only usable once per turn as configured: ${list}. ${slugs.length === 1 ? "It changes things and its output is untrusted, so its own first call blocks its second." : "Each changes things and returns untrusted output, so each one's first call blocks its second."}`,
        hint: `A tainted turn needs an explicit authorisation before it may change anything, and a blanket tools.policy.mode is the absence of one. Add a rule naming the tool — tools.policy.allow: ["${slugs[0] ?? "exec"}"] for the whole tool, or something narrower like "${slugs[0] ?? "exec"}(git *)" — or set tools.untrusted.onMutate to "confirm" to be asked each time. Leaving it as it is means the agent runs one and reports back, which is a reasonable thing to want and is why this does not fail the load.`,
        field: "tools.policy.allow",
    }
}

export function toolBudgetExceeded(requested: number, max: number): ConfigError {
    return new ConfigError({
        code: "tool_budget_exceeded",
        message: `The manifest pins ${requested} tools but tools.budget.max is ${max}.`,
        hint: "Raise tools.budget.max or pin fewer tools. It is refused rather than trimmed because only the author can say which ones matter — and a catalogue silently cut to twenty is how write tools disappear.",
        field: "tools.budget.max",
    })
}

/**
 * A slug the `native` wire format cannot carry.
 *
 * Refused at load rather than rewritten to something legal. A rewrite is lossy in both directions —
 * `a.b` and `a_b` become the same name on the way out, and the model's reply names the rewritten form
 * — so the loop would have to guess which tool was meant. Under NLT the same slug is fine, which is
 * why this is a dialect error and not a registry one.
 */
export function nativeToolNameInvalid(slug: string, provider: string): ConfigError {
    return new ConfigError({
        code: "native_tool_name_invalid",
        message: `The tool "${slug}" (from ${provider}) cannot be used with tools.dialect: native — a native function name may only contain letters, digits, underscores and hyphens, and must be 1-64 characters.`,
        hint: `Either switch to the nlt dialect, which accepts this slug as written and is the default, or ask ${provider} for a slug within that grammar. It is refused rather than rewritten because a rewritten name is ambiguous on the way back — two different slugs can map onto one legal name.`,
        field: "tools.dialect",
    })
}

/**
 * `tools.provider` names a provider the runtime was not given.
 *
 * Refused at load rather than ignored, because ignoring it means every pinned slug fails to resolve
 * and the report blames the slugs — twenty errors about tool names when the real problem is one
 * missing registration.
 */
export function toolProviderUnknown(id: string, known: readonly string[]): ConfigError {
    return new ConfigError({
        code: "tool_provider_unknown",
        message: `tools.providers names "${id}", which this runtime has no factory for.${known.length === 0 ? " No providers are registered." : ` Registered: ${known.join(", ")}.`}`,
        hint:
            known.length === 0
                ? "A provider is supplied by the embedder, not resolved by name at runtime — nothing is installed while the process runs. Pass it as Runtime.create({ toolProviders: { composio: (ctx) => new ComposioProvider(ctx) } }), or drop tools.providers and use tools.local."
                : `Check the spelling against the registered ids, or register a factory for "${id}" in Runtime.create({ toolProviders }).`,
        field: `tools.providers.${id}`,
    })
}

/**
 * Both the map and the scalar it replaced.
 *
 * A hard failure rather than a merge, and the reason is order: the alias has no position in the map,
 * so "which provider is consulted first" would be decided by whichever branch happened to push its
 * entry — a fact about this file rather than about the manifest. `context.files` made the same call
 * against `context.static` for the same reason.
 */
export function toolsProviderAliasConflict(
    ids: readonly string[],
    legacy: string | undefined,
): ConfigError {
    return new ConfigError({
        code: "tools_provider_alias_conflict",
        message: `The manifest sets tools.providers (${ids.join(", ")}) and also the deprecated tools.provider${legacy === undefined ? "Config" : ` (${legacy})`}.`,
        hint: `Keep tools.providers and delete the other two. Merging them would give the scalar a position in the map that nobody wrote, and provider order decides which one wins a slug collision${legacy === undefined ? "" : ` — move ${legacy}'s settings into tools.providers.${legacy}`}.`,
        field: "tools.provider",
    })
}

export function toolSlugCollision(slug: string, providers: readonly string[]): ConfigError {
    return new ConfigError({
        code: "tool_slug_collision",
        message: `Two providers both resolved the tool "${slug}": ${providers.join(" and ")}.`,
        hint: "Slugs are how the model names a tool, so one name cannot mean two things. Unpin one of them, or ask the provider for a namespaced slug.",
        field: "tools.pinned",
    })
}

export function toolTimedOut(slug: string, ms: number): ToolError {
    return new ToolError({
        code: "tool_timeout",
        message: `The tool "${slug}" did not finish within limits.toolTimeoutMs (${ms} ms).`,
        hint: "Raise limits.toolTimeoutMs if the tool is genuinely slow. Note that the call is abandoned rather than killed: a handler that ignores its abort signal keeps running, and any side effect it goes on to have still happens.",
        field: "limits.toolTimeoutMs",
    })
}

/** A handler threw. Wrapped rather than propagated, so the model sees it and can react. */
export function toolFailed(slug: string, cause: unknown): ToolError {
    const message = cause instanceof Error ? cause.message : String(cause)
    return new ToolError({
        code: cause instanceof HarnessError ? cause.code : "tool_failed",
        message: `The tool "${slug}" failed: ${message}`,
        hint:
            cause instanceof HarnessError
                ? cause.hint
                : "This is the tool's own failure, passed through. The observation the model sees carries this same text, so it can explain or retry with different arguments.",
        cause,
    })
}

/**
 * The model could not produce a usable call even after the one repair.
 *
 * There is deliberately no second repair. Two failed attempts at the same block is a routing or
 * catalogue problem, and a loop that keeps asking burns the budget while producing the same output.
 */
export function toolRepairFailed(errors: readonly ErrorDetail[]): ToolError {
    return new ToolError({
        code: "tool_repair_failed",
        message: `The model's tool call could not be used, and the corrected attempt failed the same way: ${errors.map((error) => error.message).join(" ")}`,
        hint: "Usually the catalogue rather than the model: check that the tool's field descriptions say what a valid value looks like, and that its 'do not use when' line rules out the case being asked for. One repair is attempted, never two.",
        details: [...errors],
    })
}

// ─── Channels ────────────────────────────────────────────────────────────────────────────

/**
 * A `channels[].type` no factory is registered for.
 *
 * Refused at boot rather than skipped. A channel entry that constructs nothing is a channel that
 * never receives, and the only symptom is a bot that does not answer — indistinguishable from a
 * network problem, a wrong token, or an `allowFrom` refusal.
 */
export function channelTypeUnknown(type: string, known: readonly string[]): ConfigError {
    return new ConfigError({
        code: "channel_type_unknown",
        message: `A channels entry declares type "${type}", which this runtime has no factory for.${
            known.length === 0
                ? " No channel types are registered."
                : ` Registered: ${known.join(", ")}.`
        }`,
        hint:
            known.length === 0
                ? `A channel is supplied by the embedder, not resolved by name at runtime. Pass it as Runtime.create({ channels: { telegram: telegramChannel } }). The ${BRAND.slug} binary registers the shipped channels for you — a library caller registers the ones it wants.`
                : `Check the spelling against the registered types, or register a factory for "${type}" in Runtime.create({ channels }).`,
        field: `channels.${type}`,
    })
}

// ─── Workspace ───────────────────────────────────────────────────────────────────────────

export function workspaceFileMissing(name: string, path: string, field: string): ConfigError {
    return new ConfigError({
        code: "workspace_file_missing",
        message: `${field} names ${name}, which is not readable at ${path}.`,
        hint: "Workspace paths resolve against context.workspace, which itself resolves against the manifest. A file the manifest lists but disk does not have is a load failure rather than a skip: the alternative is an agent silently missing the instructions its author believes it has.",
        field,
    })
}

export function workspaceFrontmatterInvalid(
    name: string,
    detail: string,
    cause?: unknown,
): ConfigError {
    return new ConfigError({
        code: "workspace_frontmatter_invalid",
        message: `The frontmatter in ${name} is unusable: ${detail}`,
        hint: "Frontmatter is the leading --- block and takes only tier, editable, budget, and eviction. It is stripped before the file reaches the model, so it costs nothing to be explicit there.",
        ...(cause === undefined ? {} : { cause }),
    })
}

export interface WorkspaceBudgetInit {
    /** The file that pushed the tier over, or the tier name when the total is what overflowed. */
    readonly name: string
    readonly scope: "file" | "tier" | "total"
    readonly tier?: string
    readonly tokens: number
    readonly budget: number
    readonly field: string
}

/**
 * Over budget. Never truncated to fit.
 *
 * Truncation is the tempting behaviour and the wrong one: it produces an agent running on partial
 * instructions with no error anywhere, which is the same silent-degradation shape as a dropped tool
 * call and is harder to notice, because the agent still answers.
 */
export function workspaceBudgetExceeded(init: WorkspaceBudgetInit): ConfigError {
    const where =
        init.scope === "file"
            ? `${init.name} is ${init.tokens} tokens against its ${init.budget}-token budget`
            : init.scope === "tier"
              ? `the ${init.tier} tier is ${init.tokens} tokens against its ${init.budget}-token budget (largest file: ${init.name})`
              : `the workspace totals ${init.tokens} tokens against a ${init.budget}-token cap (largest file: ${init.name})`
    return new ConfigError({
        code: "workspace_budget_exceeded",
        message: `Workspace over budget: ${where}.`,
        hint: "Shorten the file, or raise the cap under context.budgets if the model's window genuinely affords it. Nothing is truncated to fit — an agent running on half its instructions with no error anywhere is worse than one that refuses to start.",
        field: init.field,
    })
}

export function workspaceTierMismatch(name: string, declared: string, listed: string): ConfigError {
    return new ConfigError({
        code: "workspace_tier_mismatch",
        message: `${name} declares tier: ${declared} in its frontmatter but is listed under context.${listed}.`,
        hint: `Make the two agree. The tier decides prompt position and cache behaviour, so a file in the wrong one is not a cosmetic problem: a volatile file listed as static invalidates the cached prefix on every write, and the only symptom is the bill.`,
        field: `context.${listed}`,
    })
}

export function workspaceAliasConflict(): ConfigError {
    return new ConfigError({
        code: "workspace_alias_conflict",
        message: "The manifest sets both context.files and context.static.",
        hint: "context.files is the deprecated alias for context.static and resolves against the manifest directory, while context.static resolves against context.workspace. Merging them would produce an order nobody wrote and paths nobody can predict from reading the manifest, so pick one — context.static.",
        field: "context.files",
    })
}

export function workspaceNotWritableTier(
    name: string,
    tier: string,
    editable: string,
): ConfigError {
    return new ConfigError({
        code: "workspace_not_writable_tier",
        message: `${name} is in the ${tier} tier but declares editable: ${editable}.`,
        hint: `Only the volatile tier is writable. A ${tier} file sits inside the cache-stable prefix or is re-asserted verbatim after the history, and a write to either invalidates prompt caching on every turn with no error and no symptom beyond the bill. Move the file to context.volatile, or set editable: none.`,
        field: `context.${tier}`,
    })
}

export function workspaceRuleBudget(init: {
    counted: number
    allowed: number
    perRuleSuccess: number
    reliabilityTarget: number
    lines: readonly string[]
}): ConfigError {
    return new ConfigError({
        code: "workspace_rule_budget",
        message:
            `The workspace states ${init.counted} rules; at perRuleSuccess ${init.perRuleSuccess} a ` +
            `reliabilityTarget of ${init.reliabilityTarget} permits ${init.allowed}. ` +
            `Expected compliance with all ${init.counted}: ${(init.perRuleSuccess ** init.counted).toFixed(2)}.`,
        hint: "Delete rules, or move the ones with real consequences into tool-boundary code where they are enforced rather than requested. Do not raise reliabilityTarget — that changes the number without changing the behaviour. Counted lines are listed below; the count is a heuristic, so context.rules.onExceed: warn is the escape if it has misread a line.",
        field: "context.rules",
        details: init.lines.map((line) => ({
            code: "workspace_rule_counted",
            message: line,
            hint: "Counted as a rule because it states an obligation or begins with an imperative.",
        })),
    })
}

export function workspaceNotEditable(name: string, editable: string): ToolError {
    return new ToolError({
        code: "workspace_not_editable",
        message: `${name} is declared editable: ${editable}, so it cannot be written to.`,
        hint: "Point the write at a volatile file whose frontmatter allows it (editable: append or replace), or change that file's frontmatter. Read-only identity is deliberate — it is the most effective known mitigation for persona drift, so this refuses rather than silently doing nothing.",
    })
}

// ─── Soul ────────────────────────────────────────────────────────────────────────────────

export function soulRequirementInvalid(expr: string): ConfigError {
    return new ConfigError({
        code: "soul_requirement_invalid",
        message: `context.soul.requires.contextWindow is ${JSON.stringify(expr)}, which is not a comparison.`,
        hint: 'Write a comparator and a number, like ">=200000". Supported comparators: >=, >, <=, <, ==. The comparison runs against the resolved context window of model.main.',
        field: "context.soul.requires.contextWindow",
    })
}

export function soulRequirementUnmet(init: {
    readonly file: string
    readonly reasons: readonly string[]
}): ConfigError {
    return new ConfigError({
        code: "soul_requirement_unmet",
        message: `${init.file} requires a model this manifest does not configure: ${init.reasons.join("; ")}.`,
        hint: "onUnmet: fail is what asked for this refusal. Point model.main at a model that meets context.soul.requires, or set onUnmet to distill (ships the hand-edited compact file named by context.soul.distilled) or omit (ships nothing and warns).",
        field: "context.soul",
    })
}

export function soulDistilledMissing(file: string): ConfigError {
    return new ConfigError({
        code: "soul_distilled_missing",
        message: `${file} does not meet context.soul.requires and onUnmet is distill, but context.soul.distilled names no compact file.`,
        hint: "Run the soul distill command against the long document to scaffold a compact file, edit it by hand, and name it in context.soul.distilled. Distillation is never automatic — a summariser drops exactly the parts that produce voice.",
        field: "context.soul.distilled",
    })
}

// ─── Knowledge ───────────────────────────────────────────────────────────────────────────

export function knowledgeDirMissing(dir: string, path: string): ConfigError {
    return new ConfigError({
        code: "knowledge_dir_missing",
        message: `knowledge.dir names ${dir}, which is not a readable directory at ${path}.`,
        hint: "knowledge.dir resolves against the manifest directory. A configured directory that does not exist is a load failure rather than an empty catalogue — the alternative is an agent silently missing reference material its author believes it has.",
        field: "knowledge.dir",
    })
}

export function knowledgeFileInvalid(name: string, detail: string, cause?: unknown): ConfigError {
    return new ConfigError({
        code: "knowledge_file_invalid",
        message: `The knowledge file ${name} is unusable: ${detail}`,
        hint: "A knowledge file is markdown with a leading --- frontmatter block whose only key is keywords: a non-empty list of words or phrases. The entry activates when the current input mentions one of them.",
        field: "knowledge.dir",
        ...(cause === undefined ? {} : { cause }),
    })
}

export function knowledgeEntryOverBudget(
    name: string,
    tokens: number,
    budget: number,
): ConfigError {
    return new ConfigError({
        code: "knowledge_entry_over_budget",
        message: `The knowledge entry ${name} is ${tokens} tokens against knowledge.budget ${budget}, so it could never activate.`,
        hint: "Split the file or raise knowledge.budget. An entry larger than the whole activation budget would sit in the catalogue and silently never be selected — the same starved-by-configuration shape as a dropped tool call, refused at load for the same reason.",
        field: "knowledge.budget",
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

/**
 * The ambient environment beat the `.env` beside the manifest.
 *
 * A warning rather than a failure, because the layering is deliberate: an operator's explicit export
 * has to win, or a container cannot configure the agent it runs. What is not acceptable is silence.
 * The values are shown for ordinary variables and withheld for anything whose *name* looks like a
 * secret — the useful half of the diff is which variable, and printing a key to explain a model id
 * would be a poor trade.
 */
export function envOverridden(overrides: readonly EnvOverride[]): ErrorDetail {
    const described = overrides
        .map((entry) =>
            entry.mine === undefined ? entry.key : `${entry.key} (${entry.mine} → ${entry.theirs})`,
        )
        .join(", ")
    return {
        code: "env_overridden",
        message: `The environment overrode ${overrides.length === 1 ? "a variable" : `${overrides.length} variables`} set in this agent's own .env: ${described}.`,
        hint: "The real environment always wins over a .env beside the manifest, so an operator's export beats a committed file. That is usually what you want and occasionally a surprise — most often a .env in the directory you launched from, which is why running from a project checkout can silently change the model. Unset the variable there, or run from elsewhere, if the agent's own .env is the one you meant.",
    }
}
