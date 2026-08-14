/**
 * Fixtures for the two unresolved `promptStyle` questions. Both are settled by measurement or not
 * at all — each is a place where two vendors' published guidance disagrees, or where the guidance
 * exists only for frontier models and the small-model behaviour is assumed.
 *
 * ## Question A — `examplesIn: system` vs `user`
 *
 * Anthropic puts examples in the system prompt; OpenAI puts tone in the system message and
 * task-specific detail and examples in user messages. The probe: an identity file whose examples
 * *demonstrate* a reply format that no rule states — a distinctive prefix and a length. If the
 * model adopts the format, the examples were heard; the question is whether they are heard better
 * embedded in the system prompt or moved to a user message. Adoption is checked by a function,
 * never by a judgement, for the same reason as `evals/rules`: the number feeds a shipped default.
 *
 * ## Question B — `intensity: emphatic` vs `neutral` on a small model
 *
 * Anthropic now advises *removing* emphatic framing because current frontier models overtrigger on
 * it. The shipped default assumes a 7B model has the inverse failure mode and needs the framing.
 * That assumption is load-bearing — it is the whole reason `intensity` exists — and it is measured
 * here with the same verifiable rules `evals/rules` uses, rendered under each framing.
 */

export interface ImitationCheck {
    readonly id: string
    /** True when the reply shows the demonstrated convention. Never a second model call. */
    readonly check: (reply: string) => boolean
}

/**
 * The demonstrated-but-never-stated conventions the examples below carry.
 *
 * `prefix` is the strong signal: "Short answer:" appears in every example reply and nowhere in the
 * prose, so a reply carrying it can only have got it from the examples. `brevity` is the weaker,
 * imitation-of-form signal — every example reply is one short sentence.
 */
export const IMITATION_CHECKS: readonly ImitationCheck[] = [
    {
        id: "prefix",
        check: (reply) => /^short answer:/i.test(reply.trim()),
    },
    {
        id: "brevity",
        check: (reply) =>
            reply
                .trim()
                .split(/\s+/)
                .filter((word) => word !== "").length < 30,
    },
]

/**
 * The authored identity for question A.
 *
 * Deliberately *without* any rule stating the format: the file's prose describes a helper, and the
 * format lives only in the examples. A `<rules>` block here would contaminate the measurement —
 * a model following a stated rule says nothing about whether it heard the examples.
 *
 * Four examples, diverse subjects, per the authoring rules the `workspace` command enforces.
 */
export const IMITATION_AGENT: string = [
    "# Pip",
    "",
    "I'm Pip. I answer quick factual questions for someone reading on a phone between other",
    "things, so my replies are built to be glanced at rather than read.",
    "",
    "## Examples",
    "",
    "<example>",
    "user: what's the capital of France?",
    "Pip: Short answer: Paris.",
    "</example>",
    "",
    "<example>",
    "user: how many legs does a spider have?",
    "Pip: Short answer: eight.",
    "</example>",
    "",
    "<example>",
    "user: who painted the Mona Lisa?",
    "Pip: Short answer: Leonardo da Vinci.",
    "</example>",
    "",
    "<example>",
    "user: what year did the Berlin Wall fall?",
    "Pip: Short answer: 1989.",
    "</example>",
].join("\n")

/**
 * Rule count for question B. Four sits in the interesting region: at 0.90 per rule the predicted
 * all-followed rate is 0.66, far enough from both ceiling and floor for a framing effect to move
 * it visibly in either direction. One rule would saturate; six drowns the signal in interference.
 */
export const INTENSITY_RULE_COUNT = 4
