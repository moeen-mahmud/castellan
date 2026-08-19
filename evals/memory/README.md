# Memory retrieval

```bash
bun run eval:memory                      # 5,000 passages, 5 repeats
bun scripts/eval-memory.ts --passages 200
```

No endpoint, no model, no network. Both claims are local: that retrieval stays inside its latency
budget over a corpus far larger than any real one, and that the shipped `memory.threshold` admits the
answers a person would call correct while refusing the ones they would not.

## Results — 2026-08-19

`results.json`, this machine, 5,000 passages averaging 15.92 terms:

| | |
| --- | --- |
| **Recall** | **100.0%** — 12/12 questions whose answer is in the corpus were injected |
| **Restraint** | **75.0%** — 3/4 questions with no answer injected nothing |
| **Latency** | median **0.43 ms**, slowest **1.35 ms** |

The acceptance criterion is 20 ms over 5,000 passages. The measurement is roughly **forty-six times**
inside it, which is worth stating precisely because it says the *index* is not where a budget will ever
be spent — FTS5 narrows the candidate set and `rank/bm25.ts` scores a few dozen rows, so the cost is
flat in corpus size for any corpus a person accumulates.

Twelve of the sixteen questions are phrased as a person asks them rather than as keyword queries, and
the interesting ones are partial matches. "how does the deploy approval work" shares two informative
terms with its answer and not the third, and scores **0.394** — under the previous `0.35` default,
borrowed from `skills.threshold`, it was withheld. That measurement is what moved the memory default
to `0.20` (decision 5.33).

## The one failure, and why no threshold fixes it

> `volunteered  0.490  who won the 1998 world cup`

The query tokenises to `won 1998 world cup`. Three of those appear nowhere in the corpus, so
`informative()` drops them and the query reduces to **`{1998}`** — which appears in exactly one filler
note, `Note 1998 concerning warehouse stock counts`. The normalisation divides by `Σ idf` over the same
terms it sums, so **idf cancels**: with one query term, matching a maximally rare token scores exactly
as well as matching a maximally relevant one. 0.490.

This is the identical failure recorded for skill selection — "what's the weather in dhaka" scored
**0.771** against `git-release` because the query reduced to `{the}` — but the fixes that worked there
cannot work here. That collapse was caused by a *common* term, so a stopword list and a
"present in more than half the corpus" rule removed it. This one is caused by a term the corpus
contains **once**, which idf calls maximally informative and which no frequency rule can distinguish
from a real signal.

And no threshold separates them: the false positive at **0.490** outranks the genuine two-of-three
match at **0.394**. Written down rather than tuned away, in the same terms the skills fixture uses —
"no threshold fixes it" is a property of a normalised score, not a bug awaiting a constant.

**Accepted, and the reason is the cost asymmetry.** For skills the same collapse *displaces* the right
skill at `maxActive: 1`. Here it spends about twenty tokens on a "Remembered" block about warehouse
stock counts, which the model can disregard — the same event, an order of magnitude cheaper. Paying for
it with a rule that refused single-term queries would refuse "frankfurt?" and "what happened in 2019",
where the lone term genuinely *is* the signal.

The fixture also exaggerates it: the padding is numbered `Note 0 … Note 4999`, so a bare year is
guaranteed to appear. A real corpus is less likely to contain a query's only shared token as filler —
less likely, not immune, which is why it stays in the fixture and stays counted against restraint
rather than being edited out to make the number look better.

## What is *not* measured here

- **Whether a model uses a retrieved passage.** That needs an endpoint and a judgement about the reply.
  Recall here is "did the runtime inject it", which is the half this eval can settle.
- **The recency weight and half-life** (`0.25`, 30 days). The fixture spreads stamps across months so
  the boost is exercised rather than constant, but nothing here distinguishes a good half-life from a
  bad one — that would need questions whose right answer *changed over time*, and the constants ship as
  a documented guess until such a fixture exists (decision 5.34).
- **Anything about a real agent's corpus size.** 5,000 is a ceiling chosen to outrun reality, not a
  prediction.
