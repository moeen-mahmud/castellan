# Tool dialect comparison — NLT vs native

Run 2026-08-14T00:21:56.328Z · 37 of 37 fixtures × 1 pass(es) · temperature 0

Reproduce with `bun scripts/eval-tools.ts`. Fixtures live in `evals/fixtures/`.

**Configuration for this run** (added by hand; the script records it automatically from the next run
on). `qwen3.5:9b` was served by a local Ollama with `SMALL_MODEL_REASONING=none`, so its
`reasoning_effort` was `none`; both DeepSeek models used the endpoint default. This matters: the
setting is not neutral. Against the previous run, which had reasoning on, suppressing it traded two
correct `arguments` fixtures for two **empty replies** — `args-enum-urgent` and `args-enum-low`
returned `""` under the `native` dialect and scored `unparseable`. A run with reasoning suppressed
is not comparable to one without it.

**The aggregate figures are stabler than the fixtures underneath them.** qwen scored 94.6% / 91.9%
in both runs, identically — and the per-fixture attribution differed: two NLT fixtures flipped in
opposite directions, six native fixtures changed outcome, `deepseek-reasoner` NLT moved one fixture.

**Settled by `qwen-3pass/` (2026-08-14):** a 3-pass run with reasoning at the endpoint default —
like-for-like with the original committed figures — scored **every one of 37 fixtures identically
on all three passes, both dialects**, and landed on the same 94.6% / 91.9%. Temperature-0 qwen on
this endpoint is deterministic *within a session*; the fixture movement above is between sessions
and configurations, not sampling noise. So the +2.7pp gate margin is one fixture, but it is the
same one-fixture margin in three independent runs across two reasoning configurations: the
aggregate is a measured result, while which *specific* fixture carries it is not. NLT ≥ native has
held in every run and configuration measured, and the durable cross-model signal remains the
`restraint` group.

**Scope.** One model call per fixture; scoring is routing plus argument coercion, with no tool
executed. This measures the step where the model decides, which is what the dialect claim is
about — not multi-step behaviour, which `tool-loop.test.ts` and the live runs cover.

**Before quoting a number here, read what the model actually wrote.** `results.json` keeps the
raw text and calls on every attempt that was not `correct`, under `attempts[].raw`. The first
run of this suite reported NLT at 27% against native's 92% on the smallest model, and the cause
was a placeholder in NLT's own prompt rather than anything about the dialect — see decision 4.19.

## Accuracy

| Model | ~B params | NLT | native | Δ | NLT critical | native critical |
| --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:9b (open-weight) | 9.7 | 94.6% | 91.9% | +2.7pp | 2.7% | 0.0% |
| deepseek-chat | 685 | 97.3% | 86.5% | +10.8pp | 0.0% | 0.0% |
| deepseek-reasoner | 685 | 91.9% | 89.2% | +2.7pp | 0.0% | 0.0% |

## Tokens and latency

| Model | NLT prompt | native prompt | Δ | NLT output | native output |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:9b (open-weight) | 47978 | 60885 | -21.2% | 1985 | 2538 |
| deepseek-chat | 45328 | 58907 | -23.1% | 2371 | 3646 |
| deepseek-reasoner | 48251 | 61830 | -22.0% | 5473 | 7081 |

## By fixture group

### qwen3.5:9b (open-weight)

| Group | NLT | native | Δ |
| --- | --- | --- | --- |
| route | 100.0% | 100.0% | +0.0pp |
| discriminate | 100.0% | 100.0% | +0.0pp |
| arguments | 85.7% | 71.4% | +14.3pp |
| abstain | 100.0% | 100.0% | +0.0pp |
| restraint | 80.0% | 80.0% | +0.0pp |
| chain | 100.0% | 100.0% | +0.0pp |

### deepseek-chat

| Group | NLT | native | Δ |
| --- | --- | --- | --- |
| route | 100.0% | 90.0% | +10.0pp |
| discriminate | 100.0% | 100.0% | +0.0pp |
| arguments | 85.7% | 85.7% | +0.0pp |
| abstain | 100.0% | 100.0% | +0.0pp |
| restraint | 100.0% | 40.0% | +60.0pp |
| chain | 100.0% | 100.0% | +0.0pp |

### deepseek-reasoner

| Group | NLT | native | Δ |
| --- | --- | --- | --- |
| route | 100.0% | 100.0% | +0.0pp |
| discriminate | 100.0% | 100.0% | +0.0pp |
| arguments | 85.7% | 100.0% | -14.3pp |
| abstain | 100.0% | 100.0% | +0.0pp |
| restraint | 60.0% | 20.0% | +40.0pp |
| chain | 100.0% | 100.0% | +0.0pp |

## Critical errors in full

| Model | Dialect | Fixture | What fired |
| --- | --- | --- | --- |
| qwen3.5:9b (open-weight) | nlt | restraint-hypothetical-post | fired notify_slack |

## Phase 3 gate

> NLT ≥ native on the smallest open-weight model tested — if not, stop and investigate before proceeding.

Smallest model tested: **qwen3.5:9b (open-weight)**. NLT 94.6% vs native 91.9% — **PASS**.

