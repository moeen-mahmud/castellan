# The estimator's bias, and the weight that corrects it

`packages/core/src/context/tokens.ts` estimates tokens by dividing characters by 3.8 and adding
newlines. `packages/core/src/context/budget.ts` corrects that estimate against the endpoint's own
`prompt_tokens`, one call late, folded with an exponential moving average. **`EMA_ALPHA` is the
weight, and it is measured here rather than chosen.**

```bash
bun run eval:budget                                    # uses MODEL_ID / MODEL_BASE_URL
bun run eval:budget -- --manifest examples/reference/agent.yaml
bun run eval:budget -- --from evals/budget/results.json   # re-score, no API calls
```

## Method

`evals/fixtures/budget.ts` is a session that grows from prose into observation-heavy work, which is
the arc of a real session. At each turn the prompt is assembled through the **real**
`assembleContext`, sent with `max_tokens: 1`, and the reply discarded — only `prompt_tokens` is read.
That yields a sequence of (estimated, charged) pairs.

Every candidate is then scored **one step ahead**: learn from turns 1..t−1, predict turn t, compare
with what the endpoint charged. A retrospective fit over the whole sequence would flatter all of them
and rank them wrongly, because what separates them is how they behave with little history.

Errors on prompts under **1,000 tokens are excluded from the ranking**. This is not convenience. The
first run ranked `last` first on mean error while it carried the worst maximum, and every one of those
large errors was on a prompt of a few hundred tokens — where the endpoint's fixed chat-template
overhead (~60 tokens here) is most of the total and the pressure is indistinguishable from zero.
Ranking on those tunes the control for the one regime in which it is switched off. Learning still
happens on every sample; only the scoring is floored.

## Committed run — deepseek-v4-pro, 31 turns

| strategy | mean err | worst turn | within 10% |
| --- | --- | --- | --- |
| no calibration | 14.21% | 16.60% | 8.70% |
| running mean | 14.38% | 47.60% | 47.83% |
| last value only | 2.29% | 13.59% | 95.65% |
| **ema 0.6 — shipped** | **2.88%** | **12.00%** | **91.30%** |
| ema 0.2 | 3.42% | 24.73% | 91.30% |

**Calibration is worth having.** Uncorrected, 14.21% mean error and only 8.7% of turns within 10%;
corrected, 2.88% and 91.3%. Phase 7A's acceptance criterion is 10%.

**A running mean is disqualified**, at 14.38% — no better than no calibration at all. It weights the
opening turns as heavily as the current one, and the opening turns of this session have ratios above
2.0 because a 50-token prompt is mostly chat template. That is the concrete form of "early samples
dominate forever".

**Mean error does not choose α.** Nine strategies sit within one percentage point of the best, so the
argmin there is this endpoint's noise. Worst turn is not flat, and 0.6 is its minimum across every
candidate — including `last`. A control is judged by its worst case.

**`last` (α = 1) has the better mean and was not taken**, for a reason this eval cannot measure: the
fixture is deterministic at temperature 0, so it contains no anomalous sample, and α = 1 hands a
single anomaly the entire correction. That is a judgement, stated as one.

## What this run also found, which was not the question

The estimator's own file said it was *"biased slightly high"* for five phases. Measured, on an
observation-heavy prompt it runs **16–20% low** — 14,057 estimated against 16,835 charged — because
JSON and shell output split into more tokens per character than the 3.8 divisor assumes. A session
under compaction pressure is mostly observations by definition, so the error is in the **overflow**
direction exactly when the window is tight. The divisor was not retuned: one constant cannot serve
prose and JSON, and moving it trades one silent bias for another. The comment now states the
measurement, and the correction is the fix.

Separately, `streamUsage` had never been exercised — the flag was written for this phase — and threw
on the first real call, because an OpenAI-compatible endpoint sends `"usage": null` on every chunk but
the last and the guard tested only for `undefined`.

## Scope

One endpoint, one tokeniser. The *value* of the ratio does not transfer: it is a fact about
deepseek-v4-pro's vocabulary and framing. What the weight is chosen from — how fast the ratio moves
within a session, and how noisy the samples are — are properties of prompt composition and transfer in
direction, not in magnitude. A second endpoint would strengthen this; `SMALL_MODEL_BASE_URL` was not
configured when it was run.
