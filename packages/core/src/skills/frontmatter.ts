/**
 * `SKILL.md` frontmatter, per the agentskills.io specification.
 *
 * The spec's field set is exactly `name`, `description`, `license`, `compatibility`, `metadata` and
 * `allowed-tools`. Two consequences shape this file, and both are the opposite of how
 * `workspace/frontmatter.ts` behaves — deliberately, because these files are not ours.
 *
 * **Unknown top-level keys are kept and ignored.** `parseWorkspaceFile` throws on one, which is right
 * for a file this project authored and wrong for a file someone vendored: a skill carrying a field the
 * spec adds next year must still load. The strictness that matters here is on the two required fields.
 *
 * **Negative guidance lives under `metadata`.** `when_not_to_use` is not a spec field — it was cited as
 * one in four documents — and the spec provides `metadata` for exactly this ("clients can use this to
 * store additional properties not defined by the Agent Skills spec", recommending unique key names).
 * The key is derived from `BRAND.slug` so a rename stays one edit, and its absence is a *warning* from
 * `skills validate` rather than a refusal here: requiring it would reject every skill from
 * `anthropics/skills` and take decision 6.1's compliance claim with it.
 *
 * `allowed-tools` is parsed and never acted on. It is a third-party file declaring which tools are
 * pre-approved, and honouring that would let a folder arriving through a `git pull` widen what the
 * agent may run — the move `config_set`'s floor refuses for `writeRoots` and `allowFrom`. Reading it
 * so `skills show` can print it is strictly more useful than ignoring it silently.
 */

import { parse as parseYaml } from "yaml"
import { BRAND } from "../brand.ts"
import { skillFileInvalid } from "../errors.ts"
import { strip } from "../workspace/frontmatter.ts"

export interface SkillFrontmatter {
    /** Spec-validated, and equal to the containing directory's name. */
    readonly name: string
    readonly description: string
    /** From `metadata`. Absent is valid and warned about, never refused. */
    readonly whenNotToUse?: string
    readonly license?: string
    readonly compatibility?: string
    /** Verbatim, space-separated, **never enforced**. See the module comment. */
    readonly allowedTools?: string
    /** Every `metadata` entry, including the one `whenNotToUse` came from. */
    readonly metadata: Readonly<Record<string, string>>
}

export interface ParsedSkillFile {
    readonly frontmatter: SkillFrontmatter
    /** Frontmatter and HTML comments removed. Ready for injection. */
    readonly body: string
}

/** Same anchoring rule as the workspace parser: leading only, so a later `---` stays a rule. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * The `metadata` key negative guidance lives under.
 *
 * A function rather than a constant so it cannot be inlined into a literal somewhere and drift from
 * the brand — the same reason `BRAND` exists at all.
 */
export function whenNotToUseKey(): string {
    return `${BRAND.slug}-when-not-to-use`
}

/**
 * Lowercase alphanumerics in hyphen-separated runs.
 *
 * One expression covers four of the spec's rules at once: no uppercase, no leading or trailing hyphen,
 * and no `--`. ASCII rather than `\p{Ll}` because the spec's prose says "unicode lowercase
 * alphanumeric" and then parenthesises it as `(a-z, 0-9)`, which is also what its table, every one of
 * its examples, and the `skills-ref` reference validator use. The narrow reading is the safe direction:
 * a name this refuses fails loudly and is one edit from correct, while a name this accepts and
 * `skills-ref` rejects is a skill that works here and nowhere else — non-portability with no symptom,
 * against a spec whose entire value is portability. Widening later breaks nothing.
 */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a string is a legal skill name, for a caller creating one rather than reading one.
 *
 * Shared with `readName` below so `skills new` refuses exactly what the loader would refuse — a
 * scaffold the runtime then rejects is worse than no scaffold.
 */
export function isSkillName(name: string): boolean {
    return name.length > 0 && name.length <= NAME_MAX && NAME.test(name)
}

const NAME_MAX = 64
const DESCRIPTION_MAX = 1024
const COMPATIBILITY_MAX = 500

/**
 * @param dirName the containing directory's basename. The spec requires `name` to equal it, and the
 * runtime needs that too: the directory is how a person finds the skill and `name` is what appears in
 * a `skill.<skill>.<script>` slug, so the two disagreeing means one of them is a lie.
 */
export function parseSkillFile(dirName: string, raw: string): ParsedSkillFile {
    const match = FRONTMATTER.exec(raw)
    if (match === null) {
        throw skillFileInvalid(dirName, "it has no leading --- frontmatter block.")
    }

    let parsed: unknown
    try {
        parsed = parseYaml(match[1] ?? "")
    } catch (cause) {
        throw skillFileInvalid(dirName, "its frontmatter is not valid YAML.", cause)
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw skillFileInvalid(dirName, "its frontmatter did not parse to a mapping.")
    }

    const record = parsed as Record<string, unknown>
    const name = readName(dirName, record.name)
    const description = readDescription(dirName, record.description)
    const metadata = readMetadata(dirName, record.metadata)
    const whenNotToUse = metadata[whenNotToUseKey()]

    return {
        frontmatter: {
            name,
            description,
            metadata,
            ...(whenNotToUse === undefined ? {} : { whenNotToUse }),
            ...optionalText(dirName, "license", record.license, undefined, "license"),
            ...optionalText(
                dirName,
                "compatibility",
                record.compatibility,
                COMPATIBILITY_MAX,
                "compatibility",
            ),
            ...optionalText(
                dirName,
                "allowed-tools",
                record["allowed-tools"],
                undefined,
                "allowedTools",
            ),
        },
        body: strip(raw.slice(match[0].length)),
    }
}

function readName(dirName: string, value: unknown): string {
    if (typeof value !== "string" || value === "") {
        throw skillFileInvalid(dirName, "it declares no name, which the spec requires.")
    }
    if (value.length > NAME_MAX) {
        throw skillFileInvalid(
            dirName,
            `its name is ${value.length} characters, and the spec allows at most ${NAME_MAX}.`,
        )
    }
    if (!NAME.test(value)) {
        throw skillFileInvalid(
            dirName,
            `its name ${JSON.stringify(value)} is not a legal skill name: lowercase letters, digits and single hyphens, never leading, trailing or doubled.`,
        )
    }
    if (value !== dirName) {
        throw skillFileInvalid(
            dirName,
            `its name is ${JSON.stringify(value)} but its directory is ${JSON.stringify(dirName)}, and the spec requires them to match.`,
        )
    }
    return value
}

function readDescription(dirName: string, value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw skillFileInvalid(
            dirName,
            "it declares no description, which the spec requires and which is the only thing selection has to go on.",
        )
    }
    if (value.length > DESCRIPTION_MAX) {
        throw skillFileInvalid(
            dirName,
            `its description is ${value.length} characters, and the spec allows at most ${DESCRIPTION_MAX}.`,
        )
    }
    return value.trim()
}

/**
 * `metadata` is a map from string keys to string values.
 *
 * A non-string value is coerced rather than refused — `version: "1.0"` unquoted parses as a number, and
 * failing a whole skill over a YAML scalar's type would be refusing a file for something no reader
 * could see. A *non-mapping* `metadata` is a different thing and does fail: it means the author meant
 * something this cannot represent.
 */
function readMetadata(dirName: string, value: unknown): Readonly<Record<string, string>> {
    if (value === undefined || value === null) return {}
    if (typeof value !== "object" || Array.isArray(value)) {
        throw skillFileInvalid(dirName, "its metadata is not a mapping of keys to values.")
    }
    const out: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === null || entry === undefined) continue
        out[key] = typeof entry === "string" ? entry.trim() : String(entry)
    }
    return out
}

function optionalText<K extends string>(
    dirName: string,
    field: string,
    value: unknown,
    max: number | undefined,
    key: K,
): Partial<Record<K, string>> {
    if (value === undefined || value === null) return {}
    if (typeof value !== "string") {
        throw skillFileInvalid(dirName, `its ${field} is not a string.`)
    }
    const text = value.trim()
    if (text === "") return {}
    if (max !== undefined && text.length > max) {
        throw skillFileInvalid(
            dirName,
            `its ${field} is ${text.length} characters, and the spec allows at most ${max}.`,
        )
    }
    return { [key]: text } as Partial<Record<K, string>>
}
