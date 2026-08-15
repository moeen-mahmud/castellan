/**
 * `config_read` and `config_set` — the agent reading and changing its own `agent.yaml`.
 *
 * ## Why this exists at all
 *
 * Because the alternative is an agent that is illiterate about itself. Asked to do something it has
 * no tool for, an agent without these can only say "I can't" — and a person then has to work out
 * which field, in which file, with which value. The agent already knows what it needs; the only thing
 * missing was a way to say so and a way to do it. That is Moeen's requirement, and it is the right
 * one: a runtime whose own configuration is opaque to the thing being configured is a runtime that
 * makes its owner do the tedious half.
 *
 * ## Why not just let `file_write` at it
 *
 * `agent.yaml` stays in the protected set, and this is the sanctioned route instead, for three
 * reasons that all have the same shape — a whole-file overwrite cannot be checked, and a targeted
 * change can:
 *
 * 1. **Validation.** A set is applied to a parsed document, re-validated against the real schema, and
 *    written only if it still loads. A `file_write` that produces an invalid manifest bricks the agent
 *    on next boot, and the model would report success.
 * 2. **Comments survive.** `parseDocument` keeps them; a regenerated file does not. The manifest is
 *    the file a person reads to understand their agent, and its comments are most of that.
 * 3. **A rule can address it.** `policyArg: "path"` is the *manifest* path, so
 *    `deny: ["config_set(tools.policy*)"]` is expressible. Against `file_write` the only available
 *    rule is "may not write agent.yaml at all".
 *
 * ## The escalation, stated rather than buried
 *
 * `config_set` can add to `tools.policy.allow` and pin new tools. That is privilege escalation, it
 * persists across restarts, and it is exactly what makes the tool useful. Three things bound it:
 *
 * - It is `mutating`, so the write gate applies: a turn that has read untrusted content cannot call it
 *   without a rule or an approval.
 * - A `deny` rule can put the security fields out of reach entirely.
 * - **The floor below.** Two edits are refused whatever the policy says, because their only purpose is
 *   to disable a guard: removing entries from `tools.policy.deny`, and setting
 *   `tools.untrusted.onMutate` to `allow`. A guard the agent can switch off on request is not a guard.
 *   Adding tools and adding allow rules — the things a person actually asks for — are unaffected.
 *
 * That floor is a judgement call rather than a requirement anyone stated, and it is narrow on purpose:
 * everything in the direction of "help me enable this" works, and only the two edits in the direction
 * of "stop checking" do not.
 */

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentManifestSchema, type Tool, type ToolHandler } from "@castellan/core"
import { isMap, isSeq, parseDocument, stringify } from "yaml"
import {
    configInvalid,
    configPathUnknown,
    configReadFailed,
    configRefused,
    configValueUnreadable,
} from "./errors.ts"
import { SYSTEM_PROVIDER_ID } from "./paths.ts"
import { setInSource } from "./yaml-edit.ts"

export interface ConfigOptions {
    /** The agent's own directory. The manifest is `agent.yaml` inside it. */
    readonly agentDir: string
    /** Overridden in tests; the runtime always uses the manifest the agent was loaded from. */
    readonly file?: string
}

/**
 * What the agent is told it can change, and what each field means.
 *
 * Returned by `config_read` rather than carried in the catalogue, so it costs nothing until something
 * asks. This is the "knows its own system" half of the requirement: the list is the manifest spec's
 * own vocabulary, in one place, phrased for the thing that has to use it.
 */
const SETTABLE: readonly { readonly path: string; readonly means: string }[] = [
    { path: "tools.local", means: "built-in tools: now, memory_write" },
    {
        path: "tools.provider",
        means: 'which provider supplies tools — "system" for shell and files',
    },
    { path: "tools.pinned", means: "the tools from that provider this agent may call" },
    {
        path: "tools.policy.allow",
        means: 'rules permitting a call: "exec", or narrower like "exec(git *)". Also what lets a mutating tool run in a turn that has read untrusted content',
    },
    { path: "tools.policy.deny", means: "rules refusing a call. Beats any allow rule" },
    { path: "tools.policy.mode", means: "allow | ask | deny — for calls no rule mentions" },
    {
        // Present so the floor below is *reachable*. Left out, `config_set` refused this path as
        // unsettable and the floor never ran — which meant `confirm`, a perfectly reasonable thing to
        // ask for, was refused with the wrong reason, and the one value that must be refused was
        // refused by accident. A guard that fires for the wrong reason is a guard nobody can predict.
        path: "tools.untrusted.onMutate",
        means: 'refuse | confirm — what happens when a tool that changes something is asked for in a turn that has read outside content. Cannot be set to "allow"',
    },
    { path: "tools.dialect", means: "nlt | native — how tool calls are written" },
    { path: "model.main.id", means: "the model this agent runs on" },
    { path: "model.main.temperature", means: "0 to 2" },
    { path: "limits.maxSteps", means: "tool calls allowed in one turn" },
    { path: "limits.toolTimeoutMs", means: "how long any single tool may take" },
    {
        path: "context.observationMaxTokens",
        means: "how much of a tool's output reaches the model",
    },
]

/**
 * Edits refused whatever the policy says.
 *
 * Three entries, all in the direction of "stop checking". Every other field above, including the ones
 * that grant new powers, is settable — granting is what a person asks for; disabling a check is not.
 *
 * **Checked before the settable list, not after.** A floored path is deliberately absent from that
 * list, so a settable-first order would refuse it as "not a setting" and the reason a person actually
 * needs would never be printed. That ordering bug already happened once with `onMutate`, where the
 * floor turned out to be unreachable and the one value that must be refused was refused by accident.
 *
 * `value` is optional because two of the three depend only on the path, and those have to fire before
 * the value is even parsed.
 */
function floorRefusal(path: string, value?: unknown): string | undefined {
    const key = path.toLowerCase()
    if (key.startsWith("tools.providerconfig.writeroots")) {
        return "widening where you may write is not yours to do. Asked to create a file, an agent granted itself the whole home directory and then wrote there — which is what this refusal exists to prevent"
    }
    if (key === "tools.policy.deny") {
        return "removing or replacing the deny rules is the one edit whose only purpose is to remove a restriction someone deliberately set"
    }
    if (
        value !== undefined &&
        key === "tools.untrusted.onmutate" &&
        String(value).toLowerCase() === "allow"
    ) {
        return 'setting the write gate to "allow" turns off the check that stops text from outside the conversation driving a tool that changes things'
    }
    return undefined
}

function manifestPath(options: ConfigOptions): string {
    return options.file ?? join(options.agentDir, "agent.yaml")
}

export const CONFIG_READ_SPEC: Tool["spec"] = {
    slug: "config_read",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Reads this agent's own configuration and lists what can be changed in it.",
    whenToUse:
        "you need to know how you are configured, or what would have to change for you to do something you currently cannot — which tool to enable, which permission rule to add",
    whenNotToUse:
        "for anything that is not your own configuration; an ordinary file is file_read. You do not need to read it before every answer, only when the question is about how you are set up",
    mutating: false,
    trust: "trusted",
    trustReason:
        "The manifest is the runtime's own file, written and validated by the runtime. Fencing it would put a warning about strangers around the agent's own settings.",
    policyArg: "path",
    tags: ["read", "config"],
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description:
                    "A single setting, such as tools.pinned. Omit to see the whole configuration and every setting that can be changed.",
            },
        },
    },
}

export const CONFIG_SET_SPEC: Tool["spec"] = {
    slug: "config_set",
    provider: SYSTEM_PROVIDER_ID,
    summary: "Changes one setting in this agent's own configuration.",
    whenToUse:
        "the person asks you to change how you are configured, or asks you to do something that needs a tool or permission you do not have and tells you to go ahead and enable it",
    whenNotToUse:
        "on your own initiative. Say what you would change and why, and let them ask — and never to remove a restriction someone set, which is refused anyway. The change takes effect when the agent next starts, not in this conversation",
    mutating: true,
    trust: "trusted",
    trustReason:
        "It reports the old and new value of one setting the runtime just validated, and nothing else.",
    policyArg: "path",
    tags: ["write", "config"],
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description:
                    "The setting, as a dotted path: tools.pinned, tools.policy.allow, model.main.temperature. config_read with no path lists them.",
            },
            value: {
                type: "string",
                description:
                    'The new value, written the way it would appear in the file: a bare word, a number, or a list as ["a", "b"]. Replaces what is there.',
            },
        },
        required: ["path", "value"],
    },
}

/**
 * Read a value written as a scalar or a JSON-ish list.
 *
 * `stringify`-then-`parseDocument` rather than `JSON.parse`, because a model writing YAML is the
 * common case and `["a", "b"]` happens to be valid in both. A value that parses as neither is refused
 * by name — guessing at it is how `tools.pinned: "exec"` becomes a one-character tool list.
 */
export function parseValue(raw: string): unknown {
    const text = raw.trim()
    if (text === "") return ""
    try {
        const doc = parseDocument(text)
        if (doc.errors.length > 0) throw new Error(doc.errors[0]?.message ?? "unparseable")
        return doc.toJS()
    } catch (cause) {
        throw configValueUnreadable(raw, String(cause))
    }
}

export function configReadHandler(options: ConfigOptions): ToolHandler {
    return async (args) => {
        const file = manifestPath(options)
        let source: string
        try {
            source = await readFile(file, "utf8")
        } catch (cause) {
            throw configReadFailed(file, String(cause))
        }

        const asked = typeof args.path === "string" ? args.path.trim() : ""
        if (asked !== "") {
            const doc = parseDocument(source)
            const value = doc.getIn(asked.split("."), false)
            if (value === undefined) {
                return `${asked} is not set in this configuration. It can be — see config_read with no path for the full list.`
            }
            return `${asked}:\n${stringify(isMap(value) || isSeq(value) ? value.toJS(doc) : value).trimEnd()}`
        }

        // A summary with the current values, not the file.
        //
        // Returning the whole manifest was the obvious thing and measured at 2,766 tokens against a
        // 2,000-token observation budget — so every call was middle-cut, and a real model read it
        // three times in one turn trying to find what the cut had removed. Eight thousand output
        // tokens to change one line. What it actually needs is "what can I change, and what is it
        // now", which is a fifth the size and directly actionable.
        const doc = parseDocument(source)
        const rows = SETTABLE.map((entry) => {
            const current = doc.getIn(entry.path.split("."), false)
            // Lists inline as `[a, b]` rather than as block YAML flattened onto one line, which
            // renders `- a - b` and reads as a subtraction.
            const value = isMap(current) || isSeq(current) ? current.toJS(doc) : current
            const shown =
                value === undefined || value === null
                    ? "(not set)"
                    : Array.isArray(value)
                      ? `[${value.map((entry) => String(entry)).join(", ")}]`
                      : stringify(value).trim()
            return `- ${entry.path} = ${shown}\n    ${entry.means}`
        }).join("\n")

        return [
            `This agent is ${doc.get("name") ?? doc.get("id")}, configured at ${file}.`,
            "",
            "Settings config_set can change, with their current values:",
            rows,
            "",
            "Anything not on this list is not settable from a conversation. A change takes effect when the agent next starts, not in the current conversation.",
            "",
            "Three edits are refused whatever the rules say, because each one only ever removes a check: widening tools.providerConfig.writeRoots, replacing tools.policy.deny, and setting tools.untrusted.onMutate to allow. Where you may write is the person's decision and not yours — if you need somewhere outside your workspace, say which directory and why, and let them add it.",
            "",
            `The whole file, comments and all, is at ${file} — read it with file_read if that tool is enabled, or ask the person to open it.`,
        ].join("\n")
    }
}

export function configSetHandler(options: ConfigOptions): ToolHandler {
    return async (args) => {
        const file = manifestPath(options)
        const path = typeof args.path === "string" ? args.path.trim() : ""
        const raw = typeof args.value === "string" ? args.value : String(args.value ?? "")

        // The floor first. Two of its three entries depend only on the path, and they name paths that
        // are deliberately not in the settable list — so checking the list first would answer "not a
        // setting" and swallow the reason that matters.
        const pathFloor = floorRefusal(path)
        if (pathFloor !== undefined) throw configRefused(path, pathFloor)

        if (!SETTABLE.some((entry) => entry.path === path)) {
            throw configPathUnknown(
                path,
                SETTABLE.map((entry) => entry.path),
            )
        }

        const value = parseValue(raw)

        const valueFloor = floorRefusal(path, value)
        if (valueFloor !== undefined) throw configRefused(path, valueFloor)

        let source: string
        try {
            source = await readFile(file, "utf8")
        } catch (cause) {
            throw configReadFailed(file, String(cause))
        }

        const parts = path.split(".")
        const doc = parseDocument(source)
        const before = doc.getIn(parts, false)

        // Edited in the source text, not by re-serialising the document. A round-trip keeps every
        // comment and moves half of them: a comment block between two top-level keys belongs, as far
        // as the parser is concerned, to the *end of the first*, so re-emitting it indents a section
        // header into the section above. Measured on a generated manifest, one change produced a
        // thirty-line diff. `setInSource` returns undefined when it cannot place the path with
        // certainty, and the round-trip is then the fallback — a reflowed file beats a wrong one.
        const surgical = setInSource(source, parts, value)
        let next: string
        if (surgical === undefined) {
            const fallback = parseDocument(source)
            fallback.setIn(parts, value)
            next = String(fallback)
        } else {
            next = surgical
        }

        // Validated against the real schema before anything is written. An invalid manifest bricks the
        // agent at its next boot, and without this the model would have reported success.
        const parsed = AgentManifestSchema.safeParse(parseDocument(next).toJS())
        if (!parsed.success) {
            const first = parsed.error.issues[0]
            throw configInvalid(
                path,
                raw,
                `${first?.path.join(".") ?? path}: ${first?.message ?? "does not fit the schema"}`,
            )
        }

        await writeFile(file, next, "utf8")

        const wasSet = before !== undefined && before !== null
        return [
            `Set ${path} in ${file}.`,
            wasSet
                ? `It was: ${stringify(isMap(before) || isSeq(before) ? before.toJS(doc) : before).trim()}`
                : "It was not set before.",
            `It is now: ${stringify(value).trim()}`,
            "",
            "The configuration still validates. This takes effect when the agent next starts — nothing in the current conversation changes, so do not try the new tool yet.",
        ].join("\n")
    }
}

export function configTools(options: ConfigOptions): readonly Tool[] {
    return [
        { spec: CONFIG_READ_SPEC, handler: configReadHandler(options) },
        { spec: CONFIG_SET_SPEC, handler: configSetHandler(options) },
    ]
}

/** For the "not enabled" hint and for tests, without exporting the table itself. */
export const SETTABLE_PATHS: readonly string[] = SETTABLE.map((entry) => entry.path)
