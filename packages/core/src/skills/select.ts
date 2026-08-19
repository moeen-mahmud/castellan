/**
 * Harness-side skill selection: BM25 as a scoring function, with no index.
 *
 * Decision 6.2 puts selection here rather than in the model, because progressive disclosure assumes the
 * model chooses to open a file and small models do not reliably. Decision 11.44 keeps it a *scorer*:
 * fifty skills of frontmatter is a few thousand terms, so ranking every document on every turn costs
 * microseconds, and an index would be an optimisation for a corpus this is not — while also being the
 * second index `workspace/knowledge.ts` explicitly forbids Phase 6 from building. Document frequencies
 * are therefore recomputed per turn rather than cached, which is affordable for exactly the same reason.
 *
 * ## What is scored, and the one deviation from the phase plan
 *
 * `name` and `description`. **Not `whenNotToUse`**, which `05-PLAN.md` and `01-ARCHITECTURE.md` both
 * listed — and which is wrong in a way worth writing down, because the mistake is easy to repeat.
 *
 * That field describes when the skill does *not* apply. Adding it to the scored document makes a lexical
 * match on it evidence *for* the skill, which is backwards: a `pdf-processing` skill saying "not for
 * scanned images without text — use `ocr-extract`" would be activated by a query about scanned images,
 * and by a query meant for `ocr-extract`, whose name it helpfully contains. With `maxActive: 1` that
 * does not merely add noise, it displaces the right skill.
 *
 * The confusion underneath is that decision 6.3's reported 73% → 85% is a measurement of **the model's**
 * routing when negative examples are in front of it, not of a lexical scorer's. So the field keeps
 * earning its place — it is injected with the body, where that effect lives — and simply does not
 * appear in the ranking. Scoring it *negatively* is the better idea than either, and it needs a
 * weighting constant nobody has measured; noted here rather than guessed.
 *
 * ## Normalisation, and why the threshold depends on it
 *
 * `skills.threshold` is documented as a normalised floor, so a raw BM25 sum will not do — it grows with
 * query length and corpus size, and a fixed floor over it would mean something different for every
 * agent. The denominator here is `(k1 + 1) × Σ idf(q)` over the query's **informative** terms, which
 * bounds the result in `[0, 1)`: a document containing every informative query term once, at average
 * length, scores about `0.45`, and two occurrences each takes it to about `0.63`.
 *
 * "Informative" means present in at least one skill. Words no skill mentions carry no information about
 * which skill to pick, and counting them in the denominator would make the score depend on how chatty
 * the person was — "pdf" scoring well on its own and badly inside a polite sentence.
 *
 * The default `0.35` is calibrated to this formula. **Changing the formula invalidates the default**,
 * which is the cost of a normalised threshold and is worth stating where both live — it has already been
 * paid twice: the shipped fixtures scored 0.369–0.600 before stopwords and stemming, and 0.390–0.633
 * after. Re-run `evals`-style calibration against the fixtures before touching any of it.
 */

import { ceiling, counted, informative, score, terms } from "../rank/bm25.ts"
import type { Skill } from "./index.ts"

/**
 * Re-exported so `authoring.ts` and the package index keep one import site for the tokeniser.
 *
 * A re-export rather than a local wrapper on purpose: `memory/fts5.ts` stores this function's output in
 * an indexed column, so a second definition here would be a second tokeniser — and the two would drift
 * silently, every score still plausible while `skills.threshold` and `memory.threshold` stopped
 * measuring the same thing.
 */
export { terms } from "../rank/bm25.ts"

export interface ScoredSkill {
    readonly skill: Skill
    /** Normalised to `[0, 1)`. Comparable against `skills.threshold` and across agents. */
    readonly score: number
}

/**
 * The Phase 6 seam, and the twin of `KnowledgeSelector`.
 *
 * Ranking only, and *scores* rather than a filtered list, because the caller owns the threshold as well
 * as `maxActive` and the budget — a selector that filtered would be deciding one of the three limits it
 * is not allowed to widen.
 *
 * @param input the turn's input together with the previous assistant turn. Concatenated by the caller
 * rather than looked up here, so this stays a pure function of text.
 */
export type SkillSelector = (input: string, skills: readonly Skill[]) => readonly ScoredSkill[]

export const bm25Selector: SkillSelector = (input, skills) => {
    if (skills.length === 0) return []

    const documents = skills.map((skill) => {
        const list = terms(`${skill.frontmatter.name} ${skill.frontmatter.description}`)
        return { skill, counts: counted(list), length: list.length }
    })

    const df = new Map<string, number>()
    for (const document of documents) {
        for (const term of document.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1)
    }

    const total = documents.length
    const totalLength = documents.reduce((sum, document) => sum + document.length, 0)
    // A corpus of empty descriptions cannot happen — `description` is required and non-empty — but a
    // zero average would produce NaN rather than zero, and NaN sorts unpredictably instead of failing.
    const averageLength = totalLength === 0 ? 1 : totalLength / total

    const query = informative(input, df, total)
    // Sorted even when everything scores zero. An unsorted return here was inconsistent with the scored
    // path for no reason, and a caller that logs "the ranking" would have shown insertion order on the
    // one input where the ranking is the interesting part — the input that selects nothing.
    if (query.length === 0) {
        return documents
            .map((document) => ({ skill: document.skill, score: 0 }))
            .sort(byScoreThenName)
    }

    const denominator = ceiling(query, df, total)

    return documents
        .map((document) => ({
            skill: document.skill,
            score: score({
                counts: document.counts,
                length: document.length,
                averageLength,
                query,
                df,
                total,
                denominator,
            }),
        }))
        .sort(byScoreThenName)
}

/**
 * Descending score, then name.
 *
 * The tiebreak is not cosmetic: two skills scoring identically must activate in the same order on every
 * machine, or one agent behaves differently from another with the same files. `loadSkills` already
 * sorts by name, and `Array.prototype.sort` is specified stable, so this only has to say so explicitly
 * to survive someone reordering the scan.
 */
function byScoreThenName(a: ScoredSkill, b: ScoredSkill): number {
    if (b.score !== a.score) return b.score - a.score
    return a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0
}
