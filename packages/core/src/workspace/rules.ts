/**
 * The rule budget guard.
 *
 * Compliance with n simultaneous rules falls roughly as the per-rule success rate raised to n. At
 * 0.90 per rule, a 0.80 reliability target permits **two** rules, not four — and that is the whole
 * point of the guard. The arithmetic is unintuitive in a specific direction: authors consistently
 * overestimate how many rules they can state, because each individual rule looks obviously
 * followable. Six of them at 0.90 is a coin flip.
 *
 * So the allowance is *computed* rather than read from a table. A table gets copied into a doc,
 * drifts, and then validates nothing.
 *
 * Counting is across `static` and `reminder` together, because the model does not know they came
 * from different files. `volatile` is excluded: it holds the user model and working memory, which
 * are facts rather than obligations.
 */

/**
 * How many rules the target affords.
 *
 * `perRuleSuccess ** n >= reliabilityTarget` solved for n. Both logs are negative, so the quotient
 * is positive and floor is the right rounding: a fractional allowance is not a rule you may state.
 */
export function allowedRules(perRuleSuccess: number, reliabilityTarget: number): number {
    if (perRuleSuccess >= 1) return Number.POSITIVE_INFINITY
    if (perRuleSuccess <= 0 || reliabilityTarget <= 0) return 0
    if (reliabilityTarget >= 1) return 0
    return Math.floor(Math.log(reliabilityTarget) / Math.log(perRuleSuccess))
}

export interface CountedRule {
    /** 1-based, within the concatenated text handed to `countRules`. */
    readonly line: number
    readonly text: string
}

/**
 * Fenced code blocks, and `<example>` blocks.
 *
 * Neither is a rule. An example *demonstrates* an obligation rather than adding one, and counting
 * the imperatives inside three worked examples would make the guard punish exactly the authoring
 * practice the spec asks for (three to five examples).
 */
const FENCE = /^\s*(?:```|~~~)/
const EXAMPLE_OPEN = /<example[\s>]/i
const EXAMPLE_CLOSE = /<\/example>/i

/**
 * Obligation markers. A line carrying one of these states a rule wherever it sits in the sentence.
 */
const MODAL = /\b(?:must(?:\s+not)?|never|always|do\s+not|don't|shall|should(?:\s+not)?|avoid)\b/i

/**
 * Imperative openers.
 *
 * A closed list rather than part-of-speech tagging, and the list is the honest part of this
 * heuristic: it recognises the verbs identity files actually open rules with, and it will miss
 * others. That is why every counted line is reported back in the failure — a guard whose reasoning
 * is invisible is one authors learn to route around rather than satisfy.
 */
const IMPERATIVE =
    /^(?:use|ask|reply|respond|answer|write|say|tell|keep|prefer|treat|check|confirm|report|stop|start|send|call|refuse|assume|cite|limit|ensure|include|omit|ignore|explain|summari[sz]e|acknowledge|escalate|decline|state|follow|apply|read|verify)\b/i

/** Leading list marker, blockquote, or heading hash — stripped before the patterns run. */
const LEADER = /^\s*(?:[-*+]|\d+[.)]|>|#{1,6})\s+/

const RULES_OPEN = /^[ \t]*<rules(?:\s[^>]*)?>[ \t]*$/
const RULES_CLOSE = /^[ \t]*<\/rules>[ \t]*$/

/**
 * Only the text inside `<rules>` blocks, for the one file where prose is not obligation: the
 * full soul document.
 *
 * A constitution-style document explains at length — that is its entire premise, and it ships only
 * to a model its author has declared capable of deriving rules from explanation. Running the
 * keyword heuristic over that explanation counts sentences like "never gets tired of being asked"
 * as rules and fails every soul-bearing manifest, which would ban the feature the gate exists to
 * ship. The `<rules>` blocks still count: they survive distillation verbatim and hold on every
 * model, so they are obligations wherever they appear. The *distilled* file gets no such exemption
 * — it ships to small models, where the budget is the point.
 */
export function rulesBlocksOnly(text: string): string {
    const kept: string[] = []
    let inFence = false
    let inRules = false

    for (const line of text.split("\n")) {
        if (FENCE.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        if (RULES_OPEN.test(line)) {
            inRules = true
            continue
        }
        if (RULES_CLOSE.test(line)) {
            inRules = false
            continue
        }
        if (inRules) kept.push(line)
    }

    return kept.join("\n")
}

export function countRules(text: string): CountedRule[] {
    const found: CountedRule[] = []
    let inFence = false
    let inExample = false

    const lines = text.split("\n")
    for (const [index, raw] of lines.entries()) {
        if (FENCE.test(raw)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue

        if (EXAMPLE_OPEN.test(raw)) inExample = true
        const closes = EXAMPLE_CLOSE.test(raw)
        if (inExample) {
            if (closes) inExample = false
            continue
        }
        if (closes) continue

        const body = raw.replace(LEADER, "").trim()
        if (body === "") continue

        // A heading is a label for a section, not an obligation, even when it reads like one.
        // `LEADER` has already removed the hashes, so the test is on the original line.
        if (/^\s*#{1,6}\s/.test(raw)) continue

        if (MODAL.test(body) || IMPERATIVE.test(body)) {
            found.push({ line: index + 1, text: body })
        }
    }

    return found
}

export interface RuleCheck {
    readonly counted: readonly CountedRule[]
    readonly allowed: number
    /** `perRuleSuccess ** counted.length` — what all-rules-followed actually works out to. */
    readonly expectedCompliance: number
    readonly withinBudget: boolean
}

export function checkRules(
    text: string,
    config: { perRuleSuccess: number; reliabilityTarget: number },
): RuleCheck {
    const counted = countRules(text)
    const allowed = allowedRules(config.perRuleSuccess, config.reliabilityTarget)
    return {
        counted,
        allowed,
        expectedCompliance: config.perRuleSuccess ** counted.length,
        withinBudget: counted.length <= allowed,
    }
}
