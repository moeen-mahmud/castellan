# Tool dialect comparison — NLT vs native

Run 2026-08-14T09:53:01.981Z · 37 of 37 fixtures × 3 pass(es) · temperature 0

reasoning_effort: qwen3.5:9b=endpoint default

Reproduce with `bun scripts/eval-tools.ts`. Fixtures live in `evals/fixtures/`.

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
| qwen3.5:9b (open-weight) | 9 | 94.6% | 91.9% | +2.7pp | 2.7% | 2.7% |

## Tokens and latency

| Model | NLT prompt | native prompt | Δ | NLT output | native output |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:9b (open-weight) | 143712 | 184227 | -22.0% | 21156 | 19458 |

## By fixture group

### qwen3.5:9b (open-weight)

| Group | NLT | native | Δ |
| --- | --- | --- | --- |
| route | 100.0% | 100.0% | +0.0pp |
| discriminate | 100.0% | 100.0% | +0.0pp |
| arguments | 85.7% | 100.0% | -14.3pp |
| abstain | 100.0% | 80.0% | +20.0pp |
| restraint | 80.0% | 60.0% | +20.0pp |
| chain | 100.0% | 100.0% | +0.0pp |

## Critical errors in full

| Model | Dialect | Fixture | What fired |
| --- | --- | --- | --- |
| qwen3.5:9b (open-weight) | nlt | restraint-draft-not-send | fired file_write |
| qwen3.5:9b (open-weight) | nlt | restraint-draft-not-send | fired file_write |
| qwen3.5:9b (open-weight) | nlt | restraint-draft-not-send | fired file_write |
| qwen3.5:9b (open-weight) | native | restraint-draft-not-send | fired file_write |
| qwen3.5:9b (open-weight) | native | restraint-draft-not-send | fired file_write |
| qwen3.5:9b (open-weight) | native | restraint-draft-not-send | fired file_write |

## Phase 3 gate

> NLT ≥ native on the smallest open-weight model tested — if not, stop and investigate before proceeding.

Smallest model tested: **qwen3.5:9b (open-weight)**. NLT 94.6% vs native 91.9% — **PASS**.

