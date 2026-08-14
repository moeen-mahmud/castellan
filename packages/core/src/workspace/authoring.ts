/**
 * The authoring rules the `workspace` command enforces, from docs/07-SPEC-WORKSPACE.md.
 *
 * Every one of these is a *warning*, not a failure, and the distinction is the design. The loader's
 * checks — budgets, tiers, frontmatter — are mechanical facts about a file, and being wrong about
 * one breaks the agent. These are judgements about writing, and a heuristic judgement that refuses
 * to load a file is a heuristic nobody keeps. So each says what it found, names the file and line,
 * and leaves the decision where it belongs.
 *
 * They run against the **authored** text, not the rendered form. An author fixes what they wrote.
 */

import type { ErrorDetail } from "../errors.ts"
import { countRules } from "./rules.ts"

export interface AuthoringInput {
    readonly name: string
    /** Stripped of frontmatter and comments, not yet rendered for a model. */
    readonly authored: string
    readonly tier: string
}

const EXAMPLE_OPEN = /^[ \t]*<example(?:\s[^>]*)?>[ \t]*$/
const EXAMPLE_CLOSE = /^[ \t]*<\/example>[ \t]*$/

/**
 * A rationale clause: the part of a rule that says *why*.
 *
 * Explanation is what lets a model generalise to cases the author never enumerated, so a bare
 * prohibition covers only what it names. Matching is on connectives rather than on meaning, which
 * is crude and stated as such — a rule whose reason is in the previous sentence reads as unreasoned
 * here, and that is a false positive the author can ignore.
 */
const RATIONALE =
    /\b(?:because|since|so that|so you|so he|so she|so they|so the|otherwise|as it|which means|rather than|instead of|to avoid|in order to)\b|—|--/i

/** Prohibition markers. Heavy negative framing pushes small models toward over-refusal. */
const PROHIBITION = /\b(?:never|do not|don't|must not|cannot|can't|avoid|refuse to|no\s+\w+ing)\b/gi

/** Words too common to say anything about whether two examples are about different things. */
const STOPWORDS = new Set(
    (
        "a an and are as at be but by do does for from had has have he her his i if in is it its me my" +
        " not of on or our she that the their them then there they this to was we were what when" +
        " which who will with you your would could should im ive dont its ill"
    ).split(" "),
)

export const EXAMPLES_MIN = 3
export const EXAMPLES_MAX = 5
/** Jaccard overlap above which two examples are about the same thing. */
export const EXAMPLE_OVERLAP_LIMIT = 0.4
/** Prohibitions above which negative framing dominates. */
export const PROHIBITION_LIMIT = 5
/** Fraction of body lines that are list items, above which a file reads as structured. */
export const BULLET_DENSITY_LIMIT = 0.4

/** `{{THING}}` — the template's own placeholder form. */
const PLACEHOLDER = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/g

export function checkAuthoring(files: readonly AuthoringInput[]): ErrorDetail[] {
    const found: ErrorDetail[] = []
    for (const file of files) {
        const unfilled = checkPlaceholders(file)
        found.push(...unfilled)
        // An unfilled template fails every other check for the same reason — its placeholders are
        // identical to each other and say nothing — so reporting those too would bury the one
        // finding that matters under four that restate it.
        if (unfilled.length > 0) continue
        found.push(...checkExamples(file))
        found.push(...checkRationale(file))
        found.push(...checkFraming(file))
        found.push(...checkStructure(file))
    }
    return found
}

/**
 * A file still carrying its template placeholders.
 *
 * Worth its own check rather than letting the others infer it: an unfilled template scores 100% on
 * example similarity, which reports as a diversity problem and sends the author to fix the wrong
 * thing. And it is a real failure — `{{AGENT_NAME}}` reaching a model is an agent whose name is
 * literally that, since a model reads a placeholder as text. Decision 4.19 is the same lesson at
 * one remove.
 */
function checkPlaceholders(file: AuthoringInput): ErrorDetail[] {
    const matches = file.authored.match(PLACEHOLDER) ?? []
    if (matches.length === 0) return []
    const unique = [...new Set(matches)]
    return [
        {
            code: "workspace_unfilled_placeholder",
            message: `${file.name} still contains ${matches.length} template placeholder(s): ${unique.slice(0, 4).join(", ")}${unique.length > 4 ? ", …" : ""}`,
            hint: "Replace them with real text. A model reads {{AGENT_NAME}} as the characters {{AGENT_NAME}} — this is the placeholder-as-instruction failure of decision 4.19, where a small model copied a metasyntactic example literally and a benchmark moved 65 points. The other authoring checks are skipped for this file until they are filled.",
            field: file.name,
        },
    ]
}

function extractExamples(text: string): string[] {
    const examples: string[] = []
    let current: string[] | undefined
    for (const line of text.split("\n")) {
        if (EXAMPLE_OPEN.test(line)) {
            current = []
            continue
        }
        if (EXAMPLE_CLOSE.test(line)) {
            if (current !== undefined) examples.push(current.join("\n"))
            current = undefined
            continue
        }
        current?.push(line)
    }
    return examples
}

function checkExamples(file: AuthoringInput): ErrorDetail[] {
    // Only the identity tier is expected to carry examples. A policy file or a reminder with none
    // is not a finding, and reporting it as one trains the reader to skip the output.
    if (file.tier !== "static") return []
    const examples = extractExamples(file.authored)
    if (examples.length === 0) return []

    const found: ErrorDetail[] = []

    if (examples.length < EXAMPLES_MIN || examples.length > EXAMPLES_MAX) {
        found.push({
            code: "workspace_example_count",
            message: `${file.name} has ${examples.length} example(s); ${EXAMPLES_MIN} to ${EXAMPLES_MAX} is the range that works.`,
            hint:
                examples.length < EXAMPLES_MIN
                    ? "Fewer than three under-determines voice — the model has too little to generalise from and falls back on its default register. Examples are the highest-leverage part of an identity file and the main defence against robotic output."
                    : "More than five over-fits: the agent starts reproducing the examples rather than the voice behind them, and every one costs tokens on every turn.",
            field: file.name,
        })
    }

    const overlap = worstOverlap(examples)
    if (overlap !== undefined && overlap.score > EXAMPLE_OVERLAP_LIMIT) {
        found.push({
            code: "workspace_example_diversity",
            message: `${file.name}: examples ${overlap.a + 1} and ${overlap.b + 1} share ${Math.round(overlap.score * 100)}% of their distinctive words.`,
            hint: "Vary the situations. Three examples about deploys produce an agent that steers every conversation toward deploys — the model latches onto the subject as readily as onto the voice, and it cannot tell which one you meant to demonstrate.",
            field: file.name,
        })
    }

    return found
}

function worstOverlap(
    examples: readonly string[],
): { a: number; b: number; score: number } | undefined {
    const sets = examples.map(contentWords)
    let worst: { a: number; b: number; score: number } | undefined

    for (let a = 0; a < sets.length; a += 1) {
        for (let b = a + 1; b < sets.length; b += 1) {
            const left = sets[a]
            const right = sets[b]
            if (left === undefined || right === undefined) continue
            if (left.size === 0 || right.size === 0) continue
            let shared = 0
            for (const word of left) if (right.has(word)) shared += 1
            const score = shared / (left.size + right.size - shared)
            if (worst === undefined || score > worst.score) worst = { a, b, score }
        }
    }
    return worst
}

function contentWords(text: string): Set<string> {
    const words = new Set<string>()
    for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
        const word = raw.replace(/'/g, "")
        if (word.length < 3 || STOPWORDS.has(word)) continue
        words.add(word)
    }
    return words
}

function checkRationale(file: AuthoringInput): ErrorDetail[] {
    const found: ErrorDetail[] = []
    for (const rule of countRules(file.authored)) {
        if (RATIONALE.test(rule.text)) continue
        found.push({
            code: "workspace_rule_no_rationale",
            message: `${file.name}:${rule.line} states a rule with no reason: ${JSON.stringify(shorten(rule.text))}`,
            hint: "Add the why, even as a clause. A rule with a rationale generalises to situations you never enumerated; a bare one covers only what it names. Detection is by connective (because, so that, since, an em dash), so a reason stated in the previous sentence reads as absent here.",
            field: file.name,
        })
    }
    return found
}

function checkFraming(file: AuthoringInput): ErrorDetail[] {
    const matches = file.authored.match(PROHIBITION) ?? []
    if (matches.length <= PROHIBITION_LIMIT) return []
    return [
        {
            code: "workspace_negative_framing",
            message: `${file.name} carries ${matches.length} prohibitions.`,
            hint: "Say what to do rather than what to avoid. Heavy negative framing pushes small models toward over-refusal, where the agent declines things nobody prohibited — and an agent that will not act is a failure that looks like caution.",
            field: file.name,
        },
    ]
}

/**
 * Bullet density.
 *
 * Reported unconditionally for now, and `07-SPEC-WORKSPACE.md` says it should be conditional on
 * every bound channel having `markdown: none | basic`. Channels arrive in Phase 4; gating on a
 * section the runtime refuses to load would make this dead code, so it reports the measurement and
 * names the condition instead of pretending to evaluate it.
 */
function checkStructure(file: AuthoringInput): ErrorDetail[] {
    if (file.tier !== "static") return []
    const lines = file.authored.split("\n").filter((line) => line.trim() !== "")
    if (lines.length < 5) return []
    const bullets = lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)).length
    const density = bullets / lines.length
    if (density <= BULLET_DENSITY_LIMIT) return []
    return [
        {
            code: "workspace_bullet_density",
            message: `${file.name} is ${Math.round(density * 100)}% list items.`,
            hint: "Models imitate form as readily as content, so a bulleted file produces a bulleted agent — and a line reading 'keep formatting light' inside one is fighting itself, with the file winning. If this agent answers in a chat window, write it as prose. Ignore this if it produces documents.",
            field: file.name,
        },
    ]
}

function shorten(text: string): string {
    return text.length > 64 ? `${text.slice(0, 61)}…` : text
}
