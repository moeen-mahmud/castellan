# `perRuleSuccess`, measured

The rule guard in `packages/core/src/workspace/rules.ts` refuses a manifest when its stated rule
count exceeds what `perRuleSuccess ** n >= reliabilityTarget` permits. The shipped `perRuleSuccess`
is **0.90** — a plausible figure from the literature and, for any particular endpoint, a guess. A
guard whose input is guessed validates nothing.

```bash
bun scripts/eval-rules.ts --manifest examples/minimal/agent.yaml
bun scripts/eval-rules.ts --model <id> --base-url <url> --api-key-env SMALL_MODEL_API_KEY
```

There is no default base URL. One pointing at localhost turns "you have not configured this" into
"connection refused", and those need different responses.

## Method

Six orthogonal rules, each checked by a function rather than by a judgement — a second model call
grading compliance would fold a second model's error bar into a number that goes straight into a
load-time refusal. For each rule count *n* in 1, 2, 3, 4, 6, the model answers *T* neutral questions
under the first *n* rules, and every rule is checked on every reply: n×T observations per count.

Rules are stated through the real `renderPromptStyle` path at the model's own resolved
`promptStyle`, inside an authored `<rules>` block. So the figure describes the pipeline that will
carry them, and `intensity` is exercised rather than assumed.

The rules are orthogonal on purpose. Obeying one must neither help nor hinder another, or the
measurement is of the interaction. The `suffix` rule's `DONE` marker is stripped before the other
checks run for exactly this reason — otherwise `lowercase` and `brevity` would be scored against a
word another rule required.

## Results

### `deepseek-v4-pro` — 2026-08-14

**The probe saturated: 64/64 observations passed, at every rule count from 1 to 6.**

Recorded because a saturated run is a result, and a specific one: it says these instructions were
easy for this model, and says nothing about what rule budget the model can carry. The script refuses
to print a recommendation here. `perRuleSuccess: 1.00` in a manifest permits an unbounded rule count
and switches the guard off — the same failure as a guessed input, reached by a different route.

Frontier models are not where rule budgets bite. Run this against the smallest model an agent will
actually use.

### A small open-weight model

**Not yet recorded.** Two attempts on `qwen3.5:9b` served by a local Ollama: the first produced a
number that was an artifact (below), the second was stopped after eighteen minutes without
finishing. Local inference is no longer how this eval reaches a small model — set `SMALL_MODEL_ID`
and `SMALL_MODEL_BASE_URL` to a hosted open-weight endpoint.

No figure is reported until a run finishes and writes `results.json`. `evals/tools/` is the
precedent: a killed run is reported as killed, never estimated.

#### The first run, and why its 0.688 was worthless

Worth keeping, because the failure looked exactly like a measurement.

`qwen3.5:9b` reasons for roughly 380 tokens under a rules prompt — about 2.5× what it spends on a
bare question — and the script capped output at 300. A reasoning model bills thinking against that
budget, so **all thirty replies came back empty**. This is the `deepseek` failure `CLAUDE.md` already
records, on a model whose capability row does not mention reasoning at all.

Five of the six checks are satisfied by the empty string. `no-commas`, `lowercase`, `brevity`,
`no-questions` and `digits` all pass on `""`; only `suffix` requires content. The arithmetic then
produced:

```
pooled perRuleSuccess   0.688  (66/96 observations)
Independence: observed all-followed runs 29.9pp BELOW p^n — rules interfere,
              so the guard is optimistic
```

Both figures are fiction. The tell was in the per-rule table:

```
suffix       0.000  (30 observations)
brevity      1.000  (24 observations)
no-commas    1.000  (18 observations)
lowercase    1.000  (12 observations)
```

One rule at 0/30 while every other sits at exactly 1.000 is a broken check, not a model. Diagnosing
it took a single probe that printed the raw reply — which the script was not recording, repeating a
defect already fixed once in `eval-tools`.

Three changes came out of it: `--max-tokens` defaulting to 2000, empty replies excluded and counted
rather than scored as passes, and raw replies written to `results.json`. Above 20% empty the script
now refuses to report a figure at all.

The general lesson is Phase 3's, unlearned and relearned: **read what the model actually wrote before
believing a number.**

## The independence check

`perRuleSuccess ** n` assumes rules fail independently. That assumption is load-bearing — it is the
whole arithmetic of the guard — and was nowhere verified. Every run therefore reports the observed
all-followed rate beside the predicted one at each *n*:

- observed consistently **below** predicted → rules interfere, and the guard is optimistic: it
  permits more rules than the model can carry together.
- observed consistently **above** → failures cluster on the same replies, and the guard is
  pessimistic.

On `deepseek-v4-pro` the two agreed to within 0.0pp, which is what saturation looks like and is not
evidence either way. The interesting reading is on a model that fails sometimes.
