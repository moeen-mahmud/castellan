/**
 * Setting one variable in a `.env` without disturbing the rest of it. Pure: text in, text out.
 *
 * The same argument as `yaml-edit.ts`, for the same file's neighbour. A generated `.env` carries
 * comments naming what each variable is for and where to get it, and rewriting the file from a parsed
 * map would drop every one of them — which matters more here than in the manifest, because this is the
 * file somebody opens six months later wondering which dashboard a key came from.
 *
 * Deliberately not a `.env` *parser*: reading one is `parseDotEnv` in core, and a second implementation
 * of that would be two things that have to agree about quoting. This only ever finds a line and
 * replaces it, so the two meet at exactly one place — how a value is quoted on the way out, which is
 * written to be read back by that parser and asserted against it in the tests.
 */

/** Whether a value needs quoting to survive `parseDotEnv`, and the quoted form if so. */
export function renderEnvValue(value: string): string {
    // Unquoted values stop at ` #`, and a leading quote character would be eaten as an opening quote.
    // Everything else round-trips bare, which keeps a generated file readable.
    const needsQuotes =
        value === "" ||
        /^["']/.test(value) ||
        /\s/.test(value) ||
        value.includes("#") ||
        value !== value.trim()
    if (!needsQuotes) return value
    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
    return `"${escaped}"`
}

export interface EnvUpsert {
    readonly text: string
    /** True when the variable was already there and its line was replaced. */
    readonly replaced: boolean
}

/**
 * Set `name` to `value`, replacing an existing assignment in place or appending a new one.
 *
 * Replacing **in place** rather than appending is what stops the file growing a second, shadowing
 * assignment on every edit — `parseDotEnv` takes the last one, so an append-only writer would leave a
 * file whose earlier lines are lies. A commented-out assignment is left alone: it is documentation,
 * and uncommenting it would resurrect a value somebody deliberately disabled.
 */
export function upsertEnv(source: string, name: string, value: string): EnvUpsert {
    const assignment = `${name}=${renderEnvValue(value)}`
    const lines = source.split("\n")
    // `export FOO=` counts, because `parseDotEnv` reads it. A `#` first does not.
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`)
    const at = lines.findIndex((line) => pattern.test(line))

    if (at !== -1) {
        const existing = lines[at] ?? ""
        // The `export ` prefix is preserved: it is there because something sources this file rather
        // than reading it, and dropping it would break that quietly.
        const prefix = /^\s*export\s+/.exec(existing)?.[0] ?? ""
        return {
            text: [...lines.slice(0, at), `${prefix}${assignment}`, ...lines.slice(at + 1)].join(
                "\n",
            ),
            replaced: true,
        }
    }

    // Appended with exactly one trailing newline, whatever the file ended with. A `.env` that gains a
    // blank line on every edit is a file that looks edited by a machine, which it is, but it should not
    // look careless about it.
    const body = source.replace(/\n+$/, "")
    return { text: body === "" ? `${assignment}\n` : `${body}\n${assignment}\n`, replaced: false }
}
