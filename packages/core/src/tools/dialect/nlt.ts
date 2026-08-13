/**
 * Natural-language tool calling: prose catalogue, line-oriented invocation.
 *
 * Two properties do the work, and both are about small models.
 *
 * **The catalogue is prose, with a mandatory negative example.** A JSON Schema tells a model what
 * is *well-formed*; it says nothing about when to reach for the tool, and routing — not argument
 * formatting — is where small models actually fail. The `Do NOT use when` line is the cheapest
 * available accuracy improvement, so a spec without one renders a visible placeholder rather than
 * quietly dropping the line.
 *
 * **The invocation format is lines, not nested JSON.** A 7B model producing well-formed nested JSON
 * with quoted strings, escaped newlines and balanced braces fails often; the same model producing
 * `key: value` lines almost never does. So the format is line-oriented, and the parser is
 * deliberately tolerant: case-insensitive keywords, bullet prefixes accepted, `END` optional,
 * wrapping code fences ignored. Tolerance here is not sloppiness — every accepted variant is one
 * that was going to arrive anyway, and refusing it would spend a repair step on punctuation.
 *
 * The parser is **schema-free on purpose**. It reports what the model wrote, verbatim, and
 * `coerce.ts` alone decides what that means for a given tool. That split is why the same parse
 * result can be tested against no schema at all, and why a field-matching change cannot break
 * block detection.
 */

import type { ContextBlock } from "../../context/blocks.ts"
import { SLOT } from "../../context/blocks.ts"
import { estimateMessageTokens } from "../../context/tokens.ts"
import type { JsonSchemaNode, ToolIntent, ToolResult, ToolSpec } from "../types.ts"
import type { ParsedOutput, ToolDialect } from "./dialect.ts"

/** Opens a multi-line value. */
const HEREDOC_OPEN = "<<<"
/** Closes one, on a line of its own. A line merely *containing* it is content. */
const HEREDOC_CLOSE = ">>>"

const ACTION_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?action\s*:\s*(.+?)\s*$/i
const KEY_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?([A-Za-z_][\w .-]*?)\s*:\s*(.*)$/
const FENCE_LINE = /^\s*`{3,}\s*[\w+-]*\s*$/
const END_LINE = /^\s*end\s*$/i

/** Strip the decoration a model puts around a tool name: backticks, quotes, trailing full stop. */
function cleanSlug(raw: string): string {
    return raw
        .replace(/^[`'"*]+/, "")
        .replace(/[`'"*]+$/, "")
        .replace(/[.,;:]+$/, "")
        .trim()
}

interface Block {
    readonly slug: string
    /** Key → every occurrence, in order. Repeats are kept: an array field is often written twice. */
    readonly fields: Map<string, string[]>
}

interface ParseState {
    block: Block | undefined
    /** Field whose value a bare continuation line extends. Cleared by a blank line. */
    openKey: string | undefined
    heredocKey: string | undefined
    heredocLines: string[]
    /** A block just ended, so a fence on the next meaningful line is its closing fence. */
    justClosed: boolean
    text: string[]
    blocks: Block[]
}

function push(block: Block, key: string, value: string): void {
    const existing = block.fields.get(key)
    if (existing === undefined) block.fields.set(key, [value])
    else existing.push(value)
}

function closeHeredoc(state: ParseState): void {
    if (state.block === undefined || state.heredocKey === undefined) return
    // One trailing blank line is an artefact of writing `>>>` on its own line, not content.
    const lines = [...state.heredocLines]
    if (lines[lines.length - 1] === "") lines.pop()
    push(state.block, state.heredocKey, lines.join("\n"))
    state.heredocKey = undefined
    state.heredocLines = []
}

function closeBlock(state: ParseState): void {
    closeHeredoc(state)
    if (state.block !== undefined) state.blocks.push(state.block)
    state.block = undefined
    state.openKey = undefined
}

/**
 * Split a model's output into invocation blocks and reply text.
 *
 * Exported for the parser tests, which are the ones that matter here: this function is the entire
 * surface between a model's prose habits and the executor.
 */
export function parseNlt(output: string): ParsedOutput {
    const lines = output.split(/\r\n|\r|\n/)
    const state: ParseState = {
        block: undefined,
        openKey: undefined,
        heredocKey: undefined,
        heredocLines: [],
        justClosed: false,
        text: [],
        blocks: [],
    }

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ""
        const trimmed = line.trim()

        // Inside a heredoc almost nothing is special: this is the one place where the model's own
        // formatting has to survive byte for byte, so only a lone terminator ends it.
        if (state.heredocKey !== undefined) {
            if (trimmed === HEREDOC_CLOSE) {
                closeHeredoc(state)
                continue
            }
            // A forgotten `>>>` would otherwise swallow the rest of the output into one field.
            if (END_LINE.test(trimmed)) {
                closeBlock(state)
                state.justClosed = true
                continue
            }
            if (ACTION_LINE.test(line)) {
                closeBlock(state)
                const match = ACTION_LINE.exec(line)
                const slug = cleanSlug(match?.[1] ?? "")
                if (slug !== "") state.block = { slug, fields: new Map() }
                continue
            }
            state.heredocLines.push(line)
            continue
        }

        const action = ACTION_LINE.exec(line)
        if (action !== null) {
            const slug = cleanSlug(action[1] ?? "")
            closeBlock(state)
            if (slug === "") continue
            state.block = { slug, fields: new Map() }
            continue
        }

        if (state.block === undefined) {
            // A fence that wraps a block belongs to the block, not to the reply — so the one just
            // before an ACTION and the one just after an END are dropped. A fence anywhere else is
            // the model writing markdown at the person, and eating it would mangle their reply.
            if (
                FENCE_LINE.test(line) &&
                (state.justClosed || nextMeaningfulIsAction(lines, index))
            ) {
                state.justClosed = false
                continue
            }
            state.text.push(line)
            if (trimmed !== "") state.justClosed = false
            continue
        }

        if (trimmed === "") {
            // Ends continuation without ending the block: models put blank lines between fields,
            // and gluing whatever follows onto the last value is how prose ends up in an argument.
            state.openKey = undefined
            continue
        }

        if (END_LINE.test(trimmed)) {
            closeBlock(state)
            state.justClosed = true
            continue
        }

        if (FENCE_LINE.test(line)) continue

        const keyed = KEY_LINE.exec(line)
        if (keyed !== null) {
            const key = (keyed[1] ?? "").trim()
            const value = (keyed[2] ?? "").trim()
            if (value === HEREDOC_OPEN) {
                state.heredocKey = key
                state.heredocLines = []
                state.openKey = undefined
            } else {
                push(state.block, key, value)
                state.openKey = key
            }
            continue
        }

        if (state.openKey !== undefined) {
            const values = state.block.fields.get(state.openKey)
            const last = values?.[values.length - 1]
            if (values !== undefined && last !== undefined) {
                values[values.length - 1] = last === "" ? trimmed : `${last}\n${trimmed}`
            }
            continue
        }

        // A block with no END, followed by prose. The prose is the reply.
        closeBlock(state)
        state.text.push(line)
    }

    closeBlock(state)

    const intents: ToolIntent[] = state.blocks.map((block, index) => ({
        // Deterministic, so a parser test can assert one. Uniqueness comes from the step id in the
        // event envelope, which is where a call is actually identified.
        callId: `c${index + 1}`,
        slug: block.slug,
        args: Object.fromEntries(
            [...block.fields].map(([key, values]) => [
                key,
                values.length === 1 ? values[0] : values,
            ]),
        ),
    }))

    return { intents, text: state.text.join("\n").trim() }
}

/** Is the next non-blank line an ACTION? Decides whether a fence is decoration or content. */
function nextMeaningfulIsAction(lines: readonly string[], from: number): boolean {
    for (let i = from + 1; i < lines.length; i += 1) {
        const line = lines[i] ?? ""
        if (line.trim() === "") continue
        return ACTION_LINE.test(line)
    }
    return false
}

const PREAMBLE = `# Tools

To use a tool, write an ACTION block. Start each line at the left margin, exactly like this:

ACTION: tool_name
field: value
END

Rules for a block:
- One field per line, written as \`name: value\`.
- For a value spanning several lines, open it with \`${HEREDOC_OPEN}\` and close it with \`${HEREDOC_CLOSE}\` alone on its own line.
- Finish every block with \`END\` alone on its own line.
- Several blocks are allowed. They run in the order you write them.
- Use only the tools listed below, only their listed fields, and always give every required field.

Anything you write outside a block is shown to the person you are talking to, so keep explanations
short and keep them out of the block. When no tool fits, simply reply — never invent a tool, and
never guess a value for a required field you have not been given.`

function typeLabel(node: JsonSchemaNode): string {
    if (node.type === "array") {
        const item = node.items?.type
        return item === undefined ? "list" : `list of ${item}`
    }
    return node.type
}

function fieldLine(name: string, node: JsonSchemaNode, required: boolean, pad: number): string {
    const parts: string[] = []
    parts.push(required ? "(required" : "(optional")
    // `string` is the overwhelming default and naming it on every line is noise the model has to
    // read past. Anything else is worth the tokens, because it changes what it must write.
    parts.push(node.type === "string" ? ")" : `, ${typeLabel(node)})`)
    const head = `  ${name.padEnd(pad)} ${parts.join("")}`

    const notes: string[] = []
    if (node.description !== undefined && node.description.trim() !== "") {
        notes.push(node.description.trim())
    }
    if (node.enum !== undefined && node.enum.length > 0) {
        notes.push(`one of: ${node.enum.map((value) => String(value)).join(" | ")}`)
    }
    if (node.default !== undefined) notes.push(`defaults to ${JSON.stringify(node.default)}`)

    return notes.length === 0 ? head : `${head} ${notes.join("; ")}`
}

const NO_NEGATIVE_GUIDANCE =
    "no guidance was supplied for this tool — if it does not clearly match what was asked, prefer another tool or reply without one"

export function renderNltEntry(spec: ToolSpec): string {
    const required = new Set(spec.parameters.required ?? [])
    const names = Object.keys(spec.parameters.properties)
    const pad = names.reduce((longest, name) => Math.max(longest, name.length), 0)

    const lines = [`### ${spec.slug}`, spec.summary.trim()]
    if (spec.whenToUse.trim() !== "") lines.push(`Use when: ${spec.whenToUse.trim()}`)
    lines.push(
        `Do NOT use when: ${
            spec.whenNotToUse === undefined || spec.whenNotToUse.trim() === ""
                ? NO_NEGATIVE_GUIDANCE
                : spec.whenNotToUse.trim()
        }`,
    )
    // On its own line rather than beside the name: anything appended to the header is something a
    // model will faithfully copy into `ACTION:`.
    if (spec.mutating) lines.push("Changes state: yes — only use it when the person asked for it.")

    if (names.length === 0) {
        lines.push("Fields: none — write the ACTION line and END.")
    } else {
        lines.push("Fields:")
        for (const name of names) {
            const node = spec.parameters.properties[name]
            if (node === undefined) continue
            lines.push(fieldLine(name, node, required.has(name), pad))
        }
    }

    return lines.join("\n")
}

function block(content: string): ContextBlock {
    return {
        slot: SLOT.tools,
        role: "system",
        content,
        // Pinned because compaction reliably eats initial instructions, and a model that has
        // forgotten the invocation format produces tool calls nothing can parse.
        pinned: true,
        tokens: estimateMessageTokens(content),
        label: "tools",
    }
}

function renderObservationText(result: ToolResult): string {
    const head = `OBSERVATION ${result.slug} — ${result.ok ? "ok" : "failed"}`
    const body = result.output.trim() === "" ? "(no output)" : result.output.trimEnd()
    return `${head}\n${body}`
}

export const nltDialect: ToolDialect = {
    id: "nlt",

    renderCatalogue(specs) {
        if (specs.length === 0) return []
        const entries = specs.map(renderNltEntry).join("\n\n")
        return [block(`${PREAMBLE}\n\n## Available tools\n\n${entries}`)]
    },

    parse: parseNlt,

    renderObservation(results) {
        const body = results.map(renderObservationText).join("\n\n")
        return {
            role: "user",
            content: `${body}\n\nContinue. Write another ACTION block if more is needed, or reply to the person if the task is done.`,
        }
    },

    renderRepair(errors) {
        const lines = errors.map((error) => `- ${error.field}: ${error.message} ${error.hint}`)
        return {
            role: "user",
            content: [
                "That ACTION block could not be used:",
                "",
                ...lines,
                "",
                "Write the block again, corrected. This is the only retry — if you cannot fill a required field, say so in a plain reply instead of guessing.",
            ].join("\n"),
        }
    },
}
