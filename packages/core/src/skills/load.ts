/**
 * Activation: rank, threshold, take what fits, then read only the bodies that won.
 *
 * The read happens here rather than at boot, and that ordering is the whole reason the catalogue holds
 * frontmatter and a token count instead of text. At most `maxActive` files are opened per turn — one, by
 * default — against fifty held in memory and re-rendered on every boot. It also means an edited body
 * takes effect on the next turn rather than the next restart, which is the behaviour anyone editing a
 * skill expects.
 *
 * Selection happens **once per turn**, never per step, exactly as knowledge does. Re-selecting per step
 * would let two steps of one turn follow different procedures, which is worse than following a
 * mediocre one consistently.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { activate } from "../context/activate.ts"
import { estimateTokens } from "../context/tokens.ts"
import { type ErrorDetail, skillNotApplied } from "../errors.ts"
import { DEFAULT_PROMPT_STYLE, type PromptStyle, renderPromptStyle } from "../model/prompt-style.ts"
import { parseSkillFile } from "./frontmatter.ts"
import type { Skill, SkillCatalogue } from "./index.ts"
import { bm25Selector, type SkillSelector } from "./select.ts"

export interface ActiveSkill {
    readonly name: string
    readonly score: number
    /** Rendered and stripped. What goes into `SLOT.skill`. */
    readonly content: string
    readonly tokens: number
    /** Absolute. Part B resolves `scripts/` against it. */
    readonly dir: string
}

export interface Activation {
    readonly active: readonly ActiveSkill[]
    /**
     * Anything a person should be told about this activation, for the caller to put on the bus.
     *
     * Returned rather than emitted because core does not own the bus at this depth — and returned at
     * all because the alternative is dropping a skill silently, which is how a workspace ends up with
     * a procedure that appears to be installed and never runs.
     */
    readonly notes: readonly ErrorDetail[]
}

export interface ActivateSkillsOptions {
    /**
     * The turn's input, and the previous assistant turn when there is one.
     *
     * Both, because a follow-up rarely repeats the subject: "now do the other one" carries no term any
     * skill's description contains, and the assistant's previous turn is where the subject still is.
     */
    readonly input: string
    readonly catalogue: SkillCatalogue
    readonly selector?: SkillSelector
    /** The same style the catalogue's token counts were measured under. */
    readonly style?: PromptStyle
}

export function activateSkills(options: ActivateSkillsOptions): Activation {
    const { catalogue } = options
    if (catalogue.skills.length === 0 || catalogue.maxActive <= 0) return { active: [], notes: [] }

    const selector = options.selector ?? bm25Selector
    const style = options.style ?? DEFAULT_PROMPT_STYLE

    const ranked = selector(options.input, catalogue.skills)
    // The threshold is the caller's to apply, not the selector's — a selector that filtered would be
    // deciding one of the three limits it exists to be prevented from widening.
    const above = ranked.filter((scored) => scored.score >= catalogue.threshold)
    const chosen = activate(
        above.map((scored) => scored.skill),
        { maxActive: catalogue.maxActive, budget: catalogue.budget },
    )
    const scoreOf = new Map(above.map((scored) => [scored.skill.name, scored.score]))

    const active: ActiveSkill[] = []
    const notes: ErrorDetail[] = []
    let spent = 0

    for (const skill of chosen) {
        let content: string
        try {
            content = renderPromptStyle(bodyOf(skill), style)
        } catch (cause) {
            // A skill that indexed cleanly and cannot be read now has been deleted or broken between
            // boot and this turn. Reported and skipped: refusing the turn would make an unrelated
            // question fail because of a file it never needed.
            notes.push(
                skillNotApplied(
                    skill.name,
                    `its SKILL.md could not be read — ${reason(cause)}`,
                    "The file was readable when the catalogue was scanned, so it has been deleted, renamed or broken since. Run `skills validate` to see the current state; the next restart re-scans.",
                ),
            )
            continue
        }

        // Re-measured rather than trusted. The catalogue's figure was taken at the last cold scan, and
        // a body edited since could have grown past the budget — in which case the honest outcome is
        // to drop it and say so, not to quietly overspend a budget somebody chose.
        const tokens = estimateTokens(content)
        if (spent + tokens > catalogue.budget) {
            notes.push(
                skillNotApplied(
                    skill.name,
                    `its body is now ${tokens} tokens against the ${catalogue.budget - spent} remaining in skills.budget, and it was ${skill.tokens} when the catalogue was scanned`,
                    "The file has grown since the last scan. Raise skills.budget or shorten the body — a restart re-scans and would refuse the load outright if it exceeds the whole budget, which is the louder version of this.",
                ),
            )
            continue
        }

        active.push({
            name: skill.name,
            score: scoreOf.get(skill.name) ?? 0,
            content,
            tokens,
            dir: skill.dir,
        })
        spent += tokens
    }

    return { active, notes }
}

function bodyOf(skill: Skill): string {
    const path = join(skill.dir, "SKILL.md")
    return parseSkillFile(skill.name, readFileSync(path, "utf8")).body
}

function reason(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause)
}
