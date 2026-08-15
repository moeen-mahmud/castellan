/**
 * Changing one setting in a YAML file without touching a byte of the rest of it.
 *
 * ## Why a line editor and not the obvious round-trip
 *
 * `parseDocument` → `setIn` → `String(doc)` is four lines, keeps comments, and was the first
 * implementation. It also **reflows the whole file**, and the damage is worse than it sounds. A
 * comment block sitting between two top-level keys is attached by the parser to the *end of the
 * first* one, so re-emitting it puts a section header inside the section above it, indented two
 * spaces. Aligned trailing comments lose their alignment. Blank lines move.
 *
 * Measured on a generated manifest: one `config_set` call produced a 30-line diff for a one-line
 * change. The manifest is the file a person reads to understand their agent, and "your comments
 * survived, in different places, at different indentation" is not preserving it.
 *
 * So the value is edited **in the source text**, and the document parse is kept for what it is
 * genuinely good at — validating the result before anything is written.
 *
 * ## Scope, deliberately narrow
 *
 * Two-or-three-level dotted paths whose values are scalars or lists of strings. That is exactly the
 * settable set and no more. Anything this cannot place with certainty returns `undefined` rather than
 * guessing, and the caller falls back to the round-trip — a reflowed file being strictly better than a
 * wrong one.
 */

/** How a value is written into the file. Nothing else is settable, so nothing else is handled. */
function renderScalar(value: unknown): string {
    if (typeof value === "string") {
        // Quoted only when it has to be. A bare `system` reads the way a person would have typed it,
        // and a value containing a comment marker or a colon would silently change meaning unquoted.
        return /^[A-Za-z0-9_./@~-]+$/.test(value) ? value : JSON.stringify(value)
    }
    return String(value)
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length
}

function isBlankOrComment(line: string): boolean {
    const trimmed = line.trim()
    return trimmed === "" || trimmed.startsWith("#")
}

/** The line index of `key` at `indent`, searching from `from` until the block ends. */
function findKey(
    lines: readonly string[],
    key: string,
    indent: number,
    from: number,
): number | undefined {
    const pattern = new RegExp(`^\\s{${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`)
    for (let i = from; i < lines.length; i += 1) {
        const line = lines[i] ?? ""
        if (isBlankOrComment(line)) continue
        // Dedent past this block: the key is not here.
        if (indentOf(line) < indent) return undefined
        if (indentOf(line) === indent && pattern.test(line)) return i
    }
    return undefined
}

/** The last line belonging to the block that starts at `start`, comments and blanks excluded. */
function endOfBlock(lines: readonly string[], start: number, indent: number): number {
    let last = start
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i] ?? ""
        if (isBlankOrComment(line)) continue
        if (indentOf(line) <= indent) break
        last = i
    }
    return last
}

/**
 * The trailing `# …` on a line, whitespace run included, or empty.
 *
 * The run matters: `dialect: nlt   # never auto-detected` is aligned with its neighbours, and returning
 * the comment without the spaces in front of it collapses the column on every edited line. Quotes are
 * tracked because a `#` inside a policy rule — `deny: ["exec(rm #)"]` — is a value and not a comment,
 * and treating it as one would silently truncate the rule.
 */
function trailingComment(line: string): string {
    let quote: string | undefined
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i]
        if (quote !== undefined) {
            if (char === quote) quote = undefined
            continue
        }
        if (char === '"' || char === "'") {
            quote = char
            continue
        }
        if (char !== "#" || i === 0 || !/\s/.test(line[i - 1] ?? "")) continue
        let start = i
        while (start > 0 && /\s/.test(line[start - 1] ?? "")) start -= 1
        return line.slice(start)
    }
    return ""
}

function renderBlock(key: string, value: unknown, indent: number): string[] {
    const pad = " ".repeat(indent)
    if (Array.isArray(value)) {
        if (value.length === 0) return [`${pad}${key}: []`]
        return [`${pad}${key}:`, ...value.map((entry) => `${pad}  - ${renderScalar(entry)}`)]
    }
    return [`${pad}${key}: ${renderScalar(value)}`]
}

/**
 * Set a dotted path in YAML source, or return `undefined` if it cannot be done confidently.
 *
 * `undefined` is not a failure — it is the honest answer that this editor is too simple for the file
 * in front of it, and the caller has a correct-but-reflowing fallback.
 */
export function setInSource(
    source: string,
    path: readonly string[],
    value: unknown,
): string | undefined {
    if (path.length === 0) return undefined
    const lines = source.split("\n")

    // Walk as far down the chain as the file actually goes, tracking where each level's block starts
    // and how deep its children sit. Stopping early is normal rather than a failure: `providerConfig`
    // is commented out in every generated manifest, so `tools.providerConfig.writeRoots` has a
    // missing *intermediate* on the very first call anyone makes.
    let searchFrom = 0
    let indent = 0
    let parent: number | undefined
    let depth = 0
    for (; depth < path.length - 1; depth += 1) {
        const at = findKey(lines, path[depth] ?? "", indent, searchFrom)
        if (at === undefined) break
        parent = at
        searchFrom = at + 1
        // The child indent is whatever the first child actually uses, not an assumed two spaces — a
        // file indented with four would otherwise get a mixed one.
        const firstChild = lines
            .slice(at + 1)
            .find((line) => !isBlankOrComment(line) && indentOf(line) > indent)
        if (firstChild === undefined) return undefined
        indent = indentOf(firstChild)
    }

    // A missing intermediate: everything from here down is written as one nested block, inserted at
    // the end of the deepest parent that does exist.
    if (depth < path.length - 1) {
        if (parent === undefined) return undefined
        const insertAt = endOfBlock(lines, parent, indent - 1) + 1
        return [
            ...lines.slice(0, insertAt),
            ...renderNested(path.slice(depth), value, indent),
            ...lines.slice(insertAt),
        ].join("\n")
    }

    const leaf = path[path.length - 1] ?? ""
    const existing = findKey(lines, leaf, indent, searchFrom)

    if (existing !== undefined) {
        const line = lines[existing] ?? ""
        const comment = Array.isArray(value) ? "" : trailingComment(line)
        const end = endOfBlock(lines, existing, indent)
        const replacement = renderBlock(leaf, value, indent)
        if (comment !== "") replacement[0] = `${replacement[0]}${comment}`
        return [...lines.slice(0, existing), ...replacement, ...lines.slice(end + 1)].join("\n")
    }

    // Missing leaf, parent present: appended to the end of its parent's block. Inserting at the end of
    // the *file* would put a `tools:` child outside `tools`.
    if (parent === undefined) return undefined
    const insertAt = endOfBlock(lines, parent, indent - 1) + 1
    return [
        ...lines.slice(0, insertAt),
        ...renderBlock(leaf, value, indent),
        ...lines.slice(insertAt),
    ].join("\n")
}

/** `["providerConfig", "writeRoots"]` → the two nested lines that create both. */
function renderNested(keys: readonly string[], value: unknown, indent: number): string[] {
    const [head, ...rest] = keys
    if (head === undefined) return []
    if (rest.length === 0) return renderBlock(head, value, indent)
    return [`${" ".repeat(indent)}${head}:`, ...renderNested(rest, value, indent + INDENT_STEP)]
}

/** Two spaces, matching every file this project generates. Only used for levels being created. */
const INDENT_STEP = 2
