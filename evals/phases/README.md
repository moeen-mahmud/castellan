# Phase-scoped tool visibility, measured — and the number is negative

Decision 4.8 puts phase scoping in **core** rather than in a plugin on the strength of a striking
published figure: constraining the tool space per phase took local models from 2/10 to 10/10 on a
benchmark subset with no model change. This repo had never measured it. `CLAUDE.md` is explicit —
never claim a performance property without a number in `evals/` — so here is the number, and it does
not say what the feature's rationale says.

```bash
bun run eval:phases                                   # uses MODEL_ID / MODEL_BASE_URL
bun run eval:phases -- --repeats 3 --model <id> --base-url <url>
```

## Method

Two arms over the same fixtures, same endpoint, same prompts:

| arm | catalogue |
| --- | --- |
| `full` | all 10 fixture tools, as an unphased agent sees it |
| `triage` | the 5 read tools plus `phase_set`, as a `triage` phase sees it |

Scored on the **24 of 37** tasks where both arms answer the same question: those whose correct first
step is a read tool, and those whose correct first step is no tool at all (`abstain`, `restraint`).
Write-expecting tasks are excluded, and the exclusion is the honest half — under phases those become
two-step problems (`phase_set`, then the tool), so scoring them against a single-step harness would
measure the harness. Three outcomes only: `correct`, `misrouted`, `critical`. Argument coercion is
orthogonal to how many tools were in front of the model, and folding it in would let a change in
field-filling move a figure about routing.

## Two runs — deepseek-v4-pro, 24 tasks, 1 repeat

| run | `full` | `triage` | delta |
| --- | --- | --- | --- |
| first | 87.5% | 75.0% | **−12.5pp** |
| second, after re-wording `phase_set`'s refusal guidance | 83.3% | 75.0% | **−8.3pp** |

**The constraint cost accuracy on this model, and the mechanism is visible.** Both arms fail the same
three `calendar_list_events` tasks. The `triage` arm adds three more, and every one is in the
**`restraint` group** — tasks whose correct answer is to call nothing:

```
triage, run 1:  email_search / phase_set / file_read   called when none was wanted
triage, run 2:  email_search ×2 / phase_set            called when none was wanted
```

Routing was not damaged; **abstention** was. One failure is a literal `phase_set` call on a task
needing no tool, which names the cause: being told you are in a narrow phase with more tools elsewhere
reads as an instruction to move. Two of the others are read tools present in *both* arms, so what
changed was not their availability but the framing around them.

**Re-wording did not fix it.** `phase_set`'s `whenNotToUse` now leads with "most turns" and states that
being in a narrow phase is not a reason to leave it. The `triage` arm did not move at all (18/24 both
times). The wording is kept because it is more accurate, not because it helped.

## Why this is not yet a result to act on

**The endpoint is not deterministic.** The `full` arm scored 21/24 and then 20/24 on identical runs at
`temperature: 0` — 4.2pp of run-to-run variance. This repo has recorded the opposite for a local
qwen endpoint, where two runs were byte-identical and `--repeats` measured nothing; a hosted MoE is not
that, and the lesson generalises the wrong way if only half of it is remembered. With n=24 and ~4pp of
noise, an 8pp difference is a signal to investigate, not a measurement.

**And this is the wrong population.** Decision 4.8's claim is about *small* models — the 2/10 → 10/10
figure is from local models, where the benefit of a smaller search space is supposed to outweigh the
cost of an extra decision. deepseek-v4-pro is a frontier model with no trouble routing over ten tools,
so the only thing this arm can show is the **cost** side. It shows it clearly.

`SMALL_MODEL_BASE_URL` was not configured when this ran. Until it is, the acceptance criterion in
`docs/05-PLAN.md` stays unticked.

## What would settle it

1. A small model (`qwen3.5:9b` or below) through both arms, `--repeats 3`.
2. Harder read tasks, so the `full` arm is not near its ceiling — a 24-task probe on which a frontier
   model scores 87% cannot show a benefit even if one exists.
3. A multi-step harness, so write-expecting tasks stop being excluded and the two-hop cost is measured
   rather than reasoned about.
