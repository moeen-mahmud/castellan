# promptStyle — the two open questions, measured

Runs 2026-08-14 · `bun scripts/eval-prompt-style.ts` · temperature 0 · qwen3.5:9b (local Ollama,
`reasoning_effort: none`) and deepseek-chat (endpoint default). Fixtures in
`evals/fixtures/prompt-style.ts`; raw replies for every attempt in `results.json` and
`results-intensity-6rules.json` under `attempts[].reply`.

**Determinism, found on the way and load-bearing for the method:** at temperature 0 this local
endpoint returns byte-identical replies for the same prompt on every pass — zero variation across
3 passes, in this eval and in `evals/tools/qwen-3pass/`. Repeats are therefore worthless here;
**the task count is the sample size**, which is why `evals/fixtures/rules.ts` grew from ten tasks
to twenty.

## A — `examplesIn: system` vs `user`

The probe: an identity file whose four examples demonstrate a reply format ("Short answer: …",
one short sentence) that **no rule states**. Adoption of the format is the measure of whether the
examples were heard; the placement — embedded in the system prompt versus moved to a user message
through the runtime's own `extractExamples` path — is the variable.

| Model | placement | prefix adoption | brevity | replies (empty) |
| --- | --- | --- | --- | --- |
| qwen3.5:9b | system | 100.0% | 100.0% | 30 (0) |
| qwen3.5:9b | user | 100.0% | 100.0% | 30 (0) |
| deepseek-chat | system | 100.0% | 100.0% | 30 (0) |
| deepseek-chat | user | 100.0% | 100.0% | 30 (0) |

**Verdict: saturated — and the saturation is itself the answer available.** With three to five
clear, delimited examples (which is what the authoring rules require), both models adopt the
demonstrated format perfectly from either position. There is no measured reason to move any
default, so each stays on its vendor's own advice: `system` for Anthropic-class and small models,
`user` for OpenAI-class. What this probe rules out is the stronger claim that either placement
*costs* anything on a well-authored workspace. A placement difference may exist for subtler
conventions or buried examples; this probe cannot see one, and no shipped default hangs on it.

## B — `intensity: emphatic` vs `neutral`

The probe: the same verifiable rules `evals/rules` uses, rendered through `renderPromptStyle`
under each framing. `intensity` varies exactly one generated line in front of the `<rules>` block,
so any difference is attributable to that line and nothing else.

At the shipped four rules, both models score 100% under both framings — saturated. At **six
rules, twenty tasks** (`--rules 6 --tasks 20`, `results-intensity-6rules.json`):

| Model | framing | all 6 followed | the one rule that moved |
| --- | --- | --- | --- |
| qwen3.5:9b | emphatic | **80.0%** (16/20) | `digits` 0.80 |
| qwen3.5:9b | neutral | **60.0%** (12/20) | `digits` 0.60 |
| deepseek-chat | emphatic | 100.0% | — |
| deepseek-chat | neutral | 100.0% | — |

Five of the six rules sit at 100% under both framings; the entire +20pp is the `digits` rule
("write numbers as digits"), whose failure rate exactly doubles when the framing line is removed —
neutral qwen writes "nineteen ninety five" where emphatic qwen writes "1995". The margin
reproduced at both n=10 and n=20 with the same magnitude and the same mechanism.

**Verdict: the small-model half of the inversion is supported.** One generated line — "Follow
these rules exactly. They are not suggestions." — moves a 9B model's all-rules compliance by
20pp on this probe, and it moves it *upward*, which is the direction the shipped
`intensity: emphatic` default for `<14B` assumes. The default stands, now with a number behind it.

Two honest limits. **Sample:** 16/20 vs 12/20 is p≈0.16 by a two-proportion test — direction and
mechanism are consistent across two probe scales, but treat the 20pp as the observed size on this
probe, not a universal constant. **The frontier half is not measured:** Anthropic's advice to
*remove* emphatic phrasing is about overtriggering (over-verification, over-exploration), which a
rule-compliance probe cannot see — deepseek's 100/100 shows emphatic framing doesn't hurt
*compliance* there, and says nothing about overtriggering. The `neutral` default for frontier
models rests on the published guidance, not on this eval.

## Reproduce

```bash
SMALL_MODEL_ID=qwen3.5:9b SMALL_MODEL_BASE_URL=http://localhost:11434/v1 \
  bun scripts/eval-prompt-style.ts --repeats 3                       # both questions, shipped settings
SMALL_MODEL_ID=qwen3.5:9b SMALL_MODEL_BASE_URL=http://localhost:11434/v1 \
  bun scripts/eval-prompt-style.ts --question intensity --rules 6 --tasks 20 --repeats 1
```
