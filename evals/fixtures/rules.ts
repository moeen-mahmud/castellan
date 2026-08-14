/**
 * Verifiable instructions, and neutral work to do while obeying them.
 *
 * Every rule here is checked by a function rather than by a judgement, which is the whole design.
 * "Did it follow the rule?" answered by a second model call is a measurement with a second model's
 * error bar folded into it, and the number this eval produces goes straight into a load-time guard
 * that refuses manifests.
 *
 * The rules are deliberately *orthogonal* — obeying one neither helps nor hinders another. Rules
 * that interact would measure the interaction rather than the per-rule rate, and the guard's
 * arithmetic (`perRuleSuccess ** n`) already assumes independence. Whether that assumption survives
 * contact with a real model is one of the things the eval reports.
 */

export interface VerifiableRule {
    readonly id: string
    /** Stated to the model, with a rationale clause — the authoring rules require one. */
    readonly text: string
    /** True when the reply obeys. Never a judgement, never a second model call. */
    readonly check: (reply: string) => boolean
}

export const VERIFIABLE_RULES: readonly VerifiableRule[] = [
    {
        id: "suffix",
        text: "End every reply with the word DONE on its own line, so the person can tell a complete answer from a truncated one.",
        // Case-insensitive, and that is not laxity — it is the orthogonality this set depends on.
        // The `lowercase` rule forces the marker to `done`, so a case-sensitive check here would
        // make obeying one rule break another and report the collision as model failure. Measured:
        // it did exactly that, turning "the capital of portugal is lisbon done" into a suffix
        // failure and inflating the interference finding it was supposed to be independent of.
        check: (reply) => /\bdone$/i.test(reply.trimEnd()),
    },
    {
        id: "brevity",
        text: "Keep every reply under forty words, because this is read on a phone.",
        check: (reply) => words(stripMarker(reply)).length < 40,
    },
    {
        id: "no-commas",
        text: "Write without commas, since the text is fed to a parser that splits on them.",
        check: (reply) => !stripMarker(reply).includes(","),
    },
    {
        id: "lowercase",
        text: "Write entirely in lower case, because the display it renders on has no capitals.",
        check: (reply) => {
            const body = stripMarker(reply)
            return body === body.toLowerCase()
        },
    },
    {
        id: "no-questions",
        text: "Never end a reply with a question, as this channel is one-way and nobody can answer.",
        check: (reply) => !stripMarker(reply).trimEnd().endsWith("?"),
    },
    {
        id: "digits",
        text: "Write any number as digits rather than words, so it can be extracted automatically.",
        check: (reply) =>
            !/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(stripMarker(reply)),
    },
]

/**
 * The suffix rule's marker is removed before the other checks run.
 *
 * Without this, `lowercase` and `brevity` would be scored against a word the *suffix* rule required,
 * so obeying one rule would break another — and the eval would report interaction as failure.
 */
function stripMarker(reply: string): string {
    return reply.replace(/\bdone\b\s*$/i, "").trimEnd()
}

function words(text: string): string[] {
    return text.split(/\s+/).filter((word) => word !== "")
}

/**
 * Neutral work.
 *
 * Short factual questions on purpose: the point is to measure rule adherence while the model is busy
 * with something, not to test knowledge. A task the model gets wrong still counts — a wrong answer
 * that obeys every rule is a pass here, because the rules are what is under test.
 */
export const RULE_TASKS: readonly string[] = [
    "What is the capital of Portugal?",
    "How many days are in February in a leap year?",
    "Name a programming language created at Bell Labs.",
    "What does HTTP stand for?",
    "Which planet is closest to the Sun?",
    "What is the boiling point of water at sea level in Celsius?",
    "Who wrote the play Hamlet?",
    "What is the largest ocean on Earth?",
    "In what year did the first Moon landing happen?",
    "What gas do plants absorb from the air?",
    // The second ten exist because a deterministic endpoint makes repeats worthless: at
    // temperature 0 the same task returns the same bytes every pass, so the only way to grow the
    // sample is to grow the task list. Same design as the first ten — short, factual, neutral.
    "How many continents are there?",
    "What metal is liquid at room temperature?",
    "Who painted the ceiling of the Sistine Chapel?",
    "What is the longest river in Africa?",
    "How many strings does a standard violin have?",
    "What country has the largest population?",
    "In what year did the Berlin Wall fall?",
    "What is the chemical symbol for gold?",
    "How many minutes are in a full day?",
    "Which language has the most native speakers?",
]

/** Rule counts to probe. The guard's interesting region is 1–4; 6 shows the curve continuing. */
export const RULE_COUNTS: readonly number[] = [1, 2, 3, 4, 6]
