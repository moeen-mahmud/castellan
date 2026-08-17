/**
 * Rank, then take what fits. Shared by Tier 3 knowledge and by skills.
 *
 * Both answer the same question — given this turn's input, which documents enter the context, in what
 * order, at most how many, and inside what token budget — and the answer was written twice before this
 * existed. `knowledge.ts` records that Phase 6's scored retriever "**must not** build a second index";
 * two copies of the *activation* half is the same mistake one layer up, because a fix applied to one
 * silently does not apply to the other.
 *
 * The selectors stay separate and the walk is shared. That split is the point: a `KnowledgeSelector` and
 * a `SkillSelector` rank, and this applies the limits, so neither can quietly widen `maxActive` or the
 * budget by returning more.
 */

/** Anything with a measured token cost can be activated. */
export interface Activatable {
    readonly tokens: number
}

export interface ActivationLimits {
    readonly maxActive: number
    /**
     * Total across everything active in one turn, not per entry. **Absent means uncapped.**
     *
     * Optional because the two tiers that share this walk answer the question differently. Knowledge is
     * many small entries competing for one slot, so a total is what stops the slot growing without bound.
     * Skills are one procedure the harness picked, and `maxActive` already bounds them to one — a second
     * limit there only ever turned "the right skill" into "no skill", which is the worse of the two.
     */
    readonly budget?: number
}

/**
 * Take entries in ranked order while they fit.
 *
 * **Stops at the first entry that does not fit — it does not skip past it.** Skipping would let a
 * worse-ranked entry displace a better-ranked one purely by being shorter, and the selection would stop
 * being explainable from the ranking, which is the same quiet-reordering the tool registry refuses.
 * A caller that wants an over-budget entry to be impossible rather than unselectable refuses it at
 * load instead; that is what `knowledgeEntryOverBudget` is for. With no budget the walk is a plain
 * `maxActive` take, which is what skills use.
 */
export function activate<T extends Activatable>(
    ranked: readonly T[],
    limits: ActivationLimits,
): readonly T[] {
    if (limits.maxActive <= 0) return []

    const active: T[] = []
    let spent = 0
    for (const entry of ranked) {
        if (active.length >= limits.maxActive) break
        if (limits.budget !== undefined && spent + entry.tokens > limits.budget) break
        active.push(entry)
        spent += entry.tokens
    }
    return active
}
