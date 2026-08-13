/**
 * Composio's tool JSON → this runtime's `ToolSpec`.
 *
 * Everything here is grounded on the live `GET /api/v3/tools` response rather than on the API
 * reference, because two of the decisions below only became obvious from real data.
 *
 * **Constraints are folded into the description, not modelled.** Measured over 100 tools: 46 carry at
 * least one keyword `JsonSchemaNode` does not express — `minimum` (62 occurrences), `maximum` (23),
 * `format` (22), `pattern`, `minLength`, `maxLength`, `minItems`. Refusing those tools would refuse
 * nearly half of Composio, and `types.ts` keeps the schema subset deliberately small on purpose. So
 * the constraint text reaches the model in the field's description, where both dialects render it,
 * and `coerce` does not enforce it. The honest consequence: an out-of-range value is rejected by
 * Composio at execution rather than caught locally as a repairable field error.
 *
 * **Structural keywords are refused, loudly.** `anyOf`, `oneOf`, `allOf`, `not` and `$ref` change
 * which documents are valid, so dropping them would hand the model a schema that disagrees with the
 * endpoint's. None appears anywhere in the sample — every tool is a flat-ish `type: "object"` nested
 * at most four deep — so the refusal costs nothing today and is the difference between a named load
 * failure and a mystery 400 if Composio's shape changes.
 *
 * **`default: null` is dropped.** `GMAIL_SEND_EMAIL.subject` ships `{"default": null, "nullable":
 * true}`, and `coerce` applies any default that is not `undefined` — so keeping it would send an
 * explicit `subject: null` on every call the model left blank. A null default is the schema saying
 * "no default", not "default to null".
 */

import type { JsonSchemaNode, JsonType, ToolParameters, ToolSpec } from "@castellan/core"
import { composioSchemaUnsupported } from "./errors.ts"

/** The fields of Composio's tool object this runtime reads. Everything else is ignored. */
export interface ComposioTool {
    readonly slug: string
    readonly name?: string
    readonly description?: string
    readonly human_description?: string
    readonly input_parameters?: Readonly<Record<string, unknown>>
    readonly tags?: readonly string[]
    readonly toolkit?: { readonly slug?: string; readonly name?: string }
    readonly no_auth?: boolean
    readonly is_deprecated?: boolean
}

/** Changes which documents validate. Dropping one is lying to the model about the schema. */
const STRUCTURAL = ["anyOf", "oneOf", "allOf", "not", "$ref"] as const

/**
 * Rendered into the description in this order. `additionalProperties` is deliberately absent: the
 * common value is `false`, which is already how `coerce` behaves — an unknown field is a field error
 * — so echoing it would spend tokens restating the runtime's own rule.
 */
const CONSTRAINTS = [
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
] as const

const TYPES = new Set<string>(["string", "number", "integer", "boolean", "array", "object"])

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined
}

/** `minimum: 1, maximum: 100` — appended so the model sees a bound the coercer will not enforce. */
function constraintText(raw: Readonly<Record<string, unknown>>): string {
    const parts: string[] = []
    for (const key of CONSTRAINTS) {
        const value = raw[key]
        if (value === undefined || value === null) continue
        if (typeof value === "object") continue
        parts.push(`${key} ${String(value)}`)
    }
    return parts.join(", ")
}

function describe(raw: Readonly<Record<string, unknown>>): string | undefined {
    const base = typeof raw.description === "string" ? raw.description.trim() : ""
    const constraints = constraintText(raw)
    if (base === "" && constraints === "") return undefined
    if (constraints === "") return base
    return base === "" ? constraints : `${base} (${constraints})`
}

/**
 * One schema node. `path` is carried only so a refusal can name the field rather than the tool.
 */
function node(raw: Readonly<Record<string, unknown>>, slug: string, path: string): JsonSchemaNode {
    for (const keyword of STRUCTURAL) {
        if (raw[keyword] !== undefined) throw composioSchemaUnsupported(slug, path, keyword)
    }

    // Composio always writes a string type in the sample. A union type (`["string", "null"]`) would
    // be a structural change in disguise, so it is refused rather than collapsed to its first member.
    const declared = raw.type
    if (Array.isArray(declared)) throw composioSchemaUnsupported(slug, path, "type: []")
    const type: JsonType =
        typeof declared === "string" && TYPES.has(declared) ? (declared as JsonType) : "string"

    const description = describe(raw)
    const enumValues = Array.isArray(raw.enum)
        ? raw.enum.filter(
              (value): value is string | number | boolean =>
                  typeof value === "string" ||
                  typeof value === "number" ||
                  typeof value === "boolean",
          )
        : undefined

    const items = type === "array" ? asRecord(raw.items) : undefined
    const properties = type === "object" ? asRecord(raw.properties) : undefined

    return {
        type,
        ...(description === undefined ? {} : { description }),
        ...(enumValues === undefined || enumValues.length === 0 ? {} : { enum: enumValues }),
        ...(items === undefined ? {} : { items: node(items, slug, `${path}[]`) }),
        ...(properties === undefined
            ? {}
            : {
                  properties: mapProperties(properties, slug, path),
                  required: stringArray(raw.required),
              }),
        // Not `!== undefined`: a null default means the schema has none, and applying it would send an
        // explicit null the caller never asked for.
        ...(raw.default === undefined || raw.default === null ? {} : { default: raw.default }),
    }
}

function stringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []
}

function mapProperties(
    properties: Readonly<Record<string, unknown>>,
    slug: string,
    path: string,
): Readonly<Record<string, JsonSchemaNode>> {
    const out: Record<string, JsonSchemaNode> = {}
    for (const [name, value] of Object.entries(properties)) {
        const raw = asRecord(value)
        if (raw === undefined) continue
        out[name] = node(raw, slug, path === "" ? name : `${path}.${name}`)
    }
    return out
}

export function mapParameters(tool: ComposioTool): ToolParameters {
    const raw = tool.input_parameters
    if (raw === undefined) return { type: "object", properties: {} }

    for (const keyword of STRUCTURAL) {
        if (raw[keyword] !== undefined) {
            throw composioSchemaUnsupported(tool.slug, "input_parameters", keyword)
        }
    }

    const properties = asRecord(raw.properties) ?? {}
    const required = stringArray(raw.required)
    const mapped = mapProperties(properties, tool.slug, "")

    return {
        type: "object",
        properties: mapped,
        // Filtered against what actually resolved: `required` naming a property that is not in
        // `properties` would make every call fail coercion on a field the model cannot supply. None was
        // seen in the sample, and the filter costs nothing.
        ...(required.length === 0 ? {} : { required: required.filter((name) => name in mapped) }),
    }
}

/**
 * Read or write, from the provider's own annotations rather than from its slug.
 *
 * Composio publishes MCP-style hints in `tags`. Measured over 100 tools: `readOnlyHint` on 51,
 * `destructiveHint` on 10, and **no hint at all on 37** — including `ABLY_PUBLISH_MESSAGE_TO_CHANNEL`
 * and `_2CHAT_CREATE_CONTACT`, which are plainly writes. So the annotation is trustworthy when
 * present (zero tools carry `readOnlyHint` while having a write verb in the slug) and carries no
 * information when absent.
 *
 * An unannotated tool is therefore treated as **mutating**, which is the safe direction and not the
 * cautious one: `mutating` is what makes the executor serialise a call and never retry it. A write
 * mislabelled as a read runs in parallel with its neighbours and is retried on failure, so the
 * failure mode is a side effect happening twice.
 */
export function isMutating(tool: ComposioTool): boolean {
    const tags = new Set(tool.tags ?? [])
    if (tags.has("destructiveHint")) return true
    return !tags.has("readOnlyHint")
}

/** True when the provider told us nothing either way, so the caller can report the assumption. */
export function isUnannotated(tool: ComposioTool): boolean {
    const tags = new Set(tool.tags ?? [])
    return !tags.has("readOnlyHint") && !tags.has("destructiveHint")
}

function firstSentence(text: string): string {
    const trimmed = text.replace(/\s+/g, " ").trim()
    const stop = trimmed.search(/\.\s|\.$/)
    return stop === -1 ? trimmed : trimmed.slice(0, stop + 1)
}

/**
 * `whenNotToUse` is deliberately left unset.
 *
 * Composio supplies no negative guidance, and the registry already renders a visible placeholder and
 * warns naming the slug (decision 4.11). Fabricating a line here would put words the tool's author
 * never wrote in front of the model, under the tool's own name.
 */
export function mapTool(tool: ComposioTool): ToolSpec {
    const description = (tool.description ?? tool.human_description ?? "").trim()
    const summary = description === "" ? `The ${tool.slug} tool.` : firstSentence(description)
    const toolkit = tool.toolkit?.slug

    return {
        slug: tool.slug,
        provider: "composio",
        summary,
        // The full description, where Composio puts the "call this when…" material. `summary` is its
        // first sentence, so this is the same text at two lengths rather than two descriptions that
        // can disagree.
        whenToUse: description === "" ? `the task needs ${tool.slug}` : description,
        mutating: isMutating(tool),
        tags: [
            ...(toolkit === undefined ? [] : [toolkit]),
            ...(isMutating(tool) ? ["write"] : ["read"]),
        ],
        parameters: mapParameters(tool),
    }
}
