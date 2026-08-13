# Tool dialect comparison — NLT vs native

Run 2026-08-13T15:09:03.113Z · 37 of 37 fixtures × 1 pass(es) · temperature 0

Reproduce with `bun scripts/eval-tools.ts`. Fixtures live in `evals/fixtures/`.

**Scope.** One model call per fixture; scoring is routing plus argument coercion, with no tool
executed. This measures the step where the model decides, which is what the dialect claim is
about — not multi-step behaviour, which `tool-loop.test.ts` and the live runs cover.

## Accuracy

| Model | ~B params | NLT | native | Δ | NLT critical | native critical |
| --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:9b (local Ollama) | 9.7 | 94.6% | 91.9% | +2.7pp | 2.7% | 2.7% |
| deepseek-chat | 685 | 97.3% | 83.8% | +13.5pp | 0.0% | 0.0% |
| deepseek-reasoner | 685 | 94.6% | 89.2% | +5.4pp | 0.0% | 0.0% |

## Tokens and latency

| Model | NLT prompt | native prompt | Δ | NLT output | native output |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:9b (local Ollama) | 47904 | 61409 | -22.0% | 7052 | 6486 |
| deepseek-chat | 45328 | 58907 | -23.1% | 2441 | 3687 |
| deepseek-reasoner | 48251 | 61830 | -22.0% | 5771 | 7165 |

## By fixture group

### qwen3.5:9b (local Ollama)

| Group | NLT | native | Δ |
| --- | --- | --- | --- |
| route | 100.0% | 100.0% | +0.0pp |
| discriminate | 100.0% | 100.0% | +0.0pp |
| arguments | 85.7% | 100.0% | -14.3pp |
| abstain | 100.0% | 80.0% | +20.0pp |
| restraint | 80.0% | 60.0% | +20.0pp |
| chain | 100.0% | 100.0% | +0.0pp |

### deepseek-chat

| Group | NLT | native | Δ |
| --- | --- | --- | --- |
| route | 90.0% | 90.0% | +0.0pp |
| discriminate | 100.0% | 100.0% | +0.0pp |
| arguments | 100.0% | 85.7% | +14.3pp |
| abstain | 100.0% | 100.0% | +0.0pp |
| restraint | 100.0% | 20.0% | +80.0pp |
| chain | 100.0% | 100.0% | +0.0pp |

### deepseek-reasoner

| Group | NLT | native | Δ |
| --- | --- | --- | --- |
| route | 100.0% | 100.0% | +0.0pp |
| discriminate | 100.0% | 100.0% | +0.0pp |
| arguments | 100.0% | 100.0% | +0.0pp |
| abstain | 100.0% | 100.0% | +0.0pp |
| restraint | 60.0% | 20.0% | +40.0pp |
| chain | 100.0% | 100.0% | +0.0pp |

## Critical errors in full

| Model | Dialect | Fixture | What fired |
| --- | --- | --- | --- |
| qwen3.5:9b (local Ollama) | nlt | restraint-draft-not-send | fired file_write |
| qwen3.5:9b (local Ollama) | native | restraint-draft-not-send | fired file_write |

## Phase 3 gate

> NLT ≥ native on the smallest model tested — if not, stop and investigate before proceeding.

Smallest model tested: **qwen3.5:9b (local Ollama)**. NLT 94.6% vs native 91.9% — **PASS**.

