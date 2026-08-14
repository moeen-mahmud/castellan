# 07 — Workspace Specification

The persistent files an agent carries: identity, policy, user model, memory, knowledge, and
skills. This document supersedes the flat `context.files` list in `02-SPEC-MANIFEST.md`.

**Status.** Implemented: tiers, stripping, budgets, the rule guard, the `context.files` alias,
`promptStyle` rendering for `delimiters` and `intensity`, the authoring checks behind the
`workspace` command, and `eval rules`. Still design-only: `examplesIn` / `skillsIn` placement (the
capability resolves and is carried, but nothing moves examples into a user message yet), `SOUL.md`,
and `knowledge/`.

**Why it replaced the flat list.** A flat ordered array cannot express three things that
turned out to matter: which files are cache-stable versus volatile, which sit after the
conversation history rather than before it, and which the agent may write to. Each of
those has a measurable cost when got wrong — an invalidated prompt cache, decayed rule
adherence, or persona drift.

---

## Tiers

| Tier | Slot | Position | Cache | Editable | Default budget |
| --- | --- | --- | --- | --- | --- |
| `static` | 0 | system prefix, first | before breakpoint A | no | 2,000 |
| `volatile` | 2 | system prefix, after the tool catalogue | after breakpoint A | yes | 3,500 |
| `reminder` | 7 | after history, before the current input | never | no | 500 |

Slot numbers are the ones in `01-ARCHITECTURE.md` and in `SLOT`
(`packages/core/src/context/blocks.ts`), where slot number equals prompt position. `static`
and the tool catalogue together form the cached prefix; `volatile` opens the uncached region.

Total hard cap 6,000 tokens. Exceeding it **fails the load** and names the file. No silent
truncation — that failure mode produces an agent running on partial instructions with no
error surfaced anywhere.

Every figure here is a **ceiling, not a target**, and the two are easy to confuse. What a
window *fits* and what a model still *follows* are different numbers, and only the second one
matters; the budget can only stop the first kind of mistake. Everything inside it is paid on
every turn of every session, so a workspace comfortably under budget is not thereby right-sized.

Budgets are measured with the runtime's own estimator (`estimateTokens`, 3.8 chars/token plus a
newline penalty), which is deliberately biased **high** — roughly 10% above a real BPE count on
English prose. A file that measures 554 here is nearer 480 at the endpoint. The bias is the safe
direction for window arithmetic, where under-counting overflows; treat it as slack when setting a
per-file `budget:`.

Tier 3 content (`knowledge/`, `skills/`) is not pinned and has no share of this budget.

### Position rationale

**Static first.** Prompt caching requires a byte-stable prefix. A file that changes ahead
of the breakpoint invalidates the cached prefix on every write, raising cost with no error
to explain it. Additionally, earlier instructions are favoured under moderate instruction
density, so the highest-priority rules belong at the top of `AGENT.md`.

**Volatile after the breakpoint.** This is the concrete reason `MEMORY.md` is not Tier 0.
Every `memory_write` changes it, and a changing file ahead of the breakpoint means the cache
never hits.

**Reminder last.** Rule adherence decays over a conversation and compaction does not
reliably reset it. Attention is stronger at both ends of the context than the middle, so a
rule stated once at the top of a thirty-turn conversation is effectively in the middle.
Re-asserting one or two rules at the recency position is the cheapest known countermeasure.
One or two rules — it is not a second policy file.

**Current input last of all.** Placing the query after long content improves response
quality substantially on multi-document inputs.

---

## File frontmatter

```yaml
---
tier: static | volatile | reminder
editable: none | append | replace
budget: <tokens>
eviction: oldest | none      # volatile + replace only
---
```

The loader strips frontmatter and HTML comments before injection. Authoring guidance in
comments therefore costs nothing at runtime, which is why the templates carry extensive
inline documentation. If the stripping ever regresses, every agent pays several hundred
tokens per turn, forever, for documentation it cannot use — so it is asserted on the
assembled prefix rather than trusted.

`editable` is enforced, not advisory. `memory_write` against `editable: none` returns a
typed error rather than a silent no-op. Read-only identity is the most effective known
mitigation for persona drift.

Only the `volatile` tier is writable, and a `static` or `reminder` file declaring otherwise is
refused at load rather than quietly downgraded. `memory_write` takes no file argument: the runtime
resolves one write target — the first `volatile` file whose frontmatter allows a write, in declared
order — because choosing a file would be a second decision on every save, and a second decision is
the two-hop shape small models fail. A workspace whose volatile files are all `editable: none` is a
refusal with a name in it, not a fall-through to the default note file: a save the model believes
succeeded, landing somewhere the agent's own context never reads, is worse than a failed call.

---

## Standard files

| File | Tier | Editable | Budget | Purpose |
| --- | --- | --- | --- | --- |
| `AGENT.md` | static | none | 1,400 | Identity, voice, rules, examples |
| `POLICY.md` | static | none | 600 | Soft boundaries and uncertainty behaviour |
| `USER.md` | volatile | append | 1,500 | User model |
| `MEMORY.md` | volatile | replace | 2,000 | Working memory, capped, evicting |
| `REMINDER.md` | reminder | none | 500 | One or two re-asserted rules |

A file with no `budget:` in its frontmatter takes its tier's budget. There is no per-filename
default in the loader — the figures above are what the templates declare, not magic the runtime
knows about `AGENT.md`.

All are optional. A missing file is skipped; a file listed in the manifest but absent from
disk fails the load.

### Deliberate omissions

`TOOLS.md` (duplicates the rendered tool catalogue and drifts from it), `HEARTBEAT.md`
(schedules are a queryable resource), `PLATFORM.md` / `PLATFORM_STATE.md` (volatile state
in a cached prefix destroys the cache and is stale on read), `IDENTITY.md` (folded into
`AGENT.md`; splitting it from personality produces two files that contradict each other).

Safety-critical guardrails are also absent by design. Prose guardrails are advisory and can
be talked around; anything with real consequences belongs in code at the tool boundary —
allowlists, typed parameters, scoped credentials, `wrapToolCall` middleware. `POLICY.md`
survives only for *soft* boundaries.

---

## `SOUL.md` — capability-gated

Long-form character and reasoning documents in the style of a model constitution are
legitimate and, on a sufficiently capable model, better than a compact identity file. Their
premise is that a model given enough understanding of the goals can derive rules the author
never wrote. Derivation is exactly what small models cannot do, and a document of that size
consumes a prohibitive share of a small model's window.

So the runtime supports it, gated:

```yaml
context:
  soul:
    file: SOUL.md
    requires:
      contextWindow: ">=200000"
      class: frontier
    onUnmet: distill      # distill | omit | fail
```

`onUnmet: distill` keeps the long document as the human-authored source of truth and ships
the compact kernel to models that cannot carry it. This is the character-bible pattern: the
writers' room keeps the bible, nobody recites it before every scene.

Distillation is not automatic. `castellan soul distill SOUL.md` emits a scaffold the author
edits; the runtime uses the committed compact file. Automatic summarisation of an identity
document is a bad idea — the parts that produce voice are exactly the parts a summariser
drops.

---

## `promptStyle` — per-model rendering

Authors write one markdown file with `<example>` delimiters. The runtime renders it per
model.

```yaml
model:
  main:
    capabilities:
      promptStyle:
        delimiters: xml | markdown | plain
        intensity: emphatic | neutral | soft
        examplesIn: system | user
        skillsIn: system | user
```

Shipped defaults:

| Model class | delimiters | intensity | examplesIn |
| --- | --- | --- | --- |
| `claude-*` | `xml` | `neutral` | `system` |
| `gpt-*`, `o*` | `markdown` | `neutral` | `user` |
| `<14B` open-weight | `plain` | `emphatic` | `system` |

**`delimiters`.** Anthropic recommends XML tags for separating instruction types, because
Claude was trained on them. Controlled cross-model work finds no reliable markdown
advantage in general and a 22–37% token penalty for structured formats. Both results hold;
the resolution is per-model rendering rather than a house style.

**`intensity`.** Anthropic's current guidance is to *remove* emphatic phrasing — "CRITICAL:
You MUST use this tool when…" becomes "Use this tool when…" — because frontier models now
overtrigger on it, and prompts tuned for older models cause over-verification and
over-exploration. A 7B model has the inverse failure mode.

It varies **one generated line** in front of an author-marked `<rules>` block, and touches nothing
inside it:

```
<rules>
I cite a source, so you can check it.
</rules>
```

| intensity | what precedes the block |
| --- | --- |
| `emphatic` | `Follow these rules exactly. They are not suggestions.` |
| `neutral` | nothing |
| `soft` | `Where it helps:` |

Authors mark rules the way they already mark examples, so no heuristic decides where the framing
goes — and the author's sentences are byte-identical under all three, which is asserted. The
alternative, rewriting rule text automatically, is decision 4.19's failure applied to a file whose
rendered form nobody ever looks at.

The "repetition" half of the original description is the `reminder` tier. It already re-asserts one
or two rules at the recency position, where attention is strongest; duplicating a block inside slot
0 would pay twice to say the same thing in the same place.

This is the general shape of a problem worth naming: **published prompting guidance is
written for frontier models, and a significant fraction of it inverts at 3–8B.** Anywhere
Castellan encodes vendor advice, it encodes it as a capability rather than a constant.

Phase 3 supplied a worked example of the cost of getting this wrong, from the other
direction. NLT's preamble carried a metasyntactic placeholder — `field: value` under the
heading "exactly like this" — which frontier models read as metasyntax and qwen3.5:9b read
as the format, copying it literally in 25 of 37 fixtures. Same bytes, opposite
interpretations, 65 points of measured difference. See decision 4.19.

**`examplesIn` / `skillsIn`.** Genuinely unresolved. Anthropic places examples in the system
prompt; OpenAI's guidance puts tone and role in the system message and task-specific detail
and examples in user messages. Settled by the **Phase 3.5** eval matrix in
`evals/prompt-style/`, not by picking a vendor. (Phase 3's eval compared *dialects* and says
nothing about this.)

---

## `compactionNotice`

When compaction is enabled, the runtime injects a generated line telling the model its
context will be compacted automatically and it should not stop work early on budget
grounds. Without it, models sense the approaching limit and wrap up prematurely.

Runtime-generated rather than author-written, because the author does not know the
threshold values. Suppress with `compactionNotice: false`. Delivered in Phase 7 with the
compaction ladder it describes.

---

## Rule budgeting

Compliance with n simultaneous rules falls roughly as the per-rule success rate to the
power of n. At 0.90 per rule:

| rules | all followed |
| --- | --- |
| 1 | 90% |
| 2 | 81% |
| 3 | 73% |
| 4 | 66% |
| 6 | 53% |
| 10 | 35% |

The runtime counts imperatives across `static` and `reminder` — the model does not know they
came from different files — and enforces:

```yaml
context:
  rules:
    perRuleSuccess: 0.90
    reliabilityTarget: 0.80
    onExceed: fail
```

At 0.90 per rule, a 0.80 target permits **two** rules, not four. The guard exists because
this arithmetic is unintuitive and authors consistently overestimate their budget. The
runtime computes it rather than trusting a table.

`eval rules` measures `perRuleSuccess` against the configured model with a verifiable-instruction
probe — orthogonal rules whose compliance is checked by a function, never by a second model call,
because the number goes straight into a guard that refuses manifests. Guessing produces a guard that
validates nothing, and small models run well below 0.90.

It reports two things beyond the rate. **Saturation:** a perfect score says the probe was easy for
that model, not that the model will follow any rule you write, and `perRuleSuccess: 1.00` in a
manifest switches the guard off entirely — so a saturated run says so and points at the smallest
model in use rather than printing a recommendation. **Independence:** the guard's `p ** n` assumes
rules fail independently, which is load-bearing and was nowhere verified, so each run reports the
observed all-followed rate beside the predicted one.

The count is a **heuristic**: a line is a rule if it carries an obligation marker (`must`,
`never`, `always`, `do not`, …) or opens with a recognised imperative verb. Fenced code and
`<example>` blocks are excluded, since an example demonstrates an obligation rather than adding one,
and headings are excluded even when they read like rules. Because it is a heuristic, **every counted
line is reported back in the failure** — a guard whose reasoning is invisible is one authors learn
to route around rather than satisfy. `onExceed: warn` is the escape when it has misread a line. It
is deliberately not "raise `reliabilityTarget`", which changes the number without changing anything
the number describes.

`validate` and `run` apply the same check from the same function. A validator that accepts what the
runtime refuses is worse than no validator.

Remedy for exceeding the budget is deleting rules or moving them into `wrapToolCall`
middleware. Never raising the target, and never reformatting — structured formatting costs
tokens and buys no reliable compliance.

---

## Authoring rules the validator enforces

1. **Style matches target output.** Files for chat-channel agents must be prose; the
   validator warns on bullet density above a threshold in `AGENT.md` when every bound
   channel has `markdown: none | basic`. Models imitate form as readily as content, so a
   bulleted file produces a bulleted agent regardless of what the file says. A line reading
   "keep formatting light" inside a bulleted file is fighting itself, and the file wins.
2. **Rules carry reasons.** A rule without a rationale clause is a warning. Explanation
   lets the model generalise to unenumerated cases, which buys coverage of situations the
   author never listed.
3. **Three to five examples.** Fewer under-determines voice; more over-fits. The validator
   warns on lexical overlap above a threshold, since three examples about deploys produce
   an agent that steers every conversation toward deploys.
4. **Positive framing.** More than five prohibitions is a warning; heavy negative framing
   pushes small models toward over-refusal.
5. **`when_not_to_use` is mandatory** on every skill. Negative examples in a manifest are
   the cheapest available routing improvement — the same lever `ToolSpec.whenNotToUse`
   already pulls for tools.

---

## Validation

```bash
castellan validate  ./agent.yaml    # does it load?
castellan workspace ./agent.yaml    # is it written well?
```

The split is deliberate. `validate` reports mechanical facts — frontmatter validity, per-file and
total budgets, tier coherence, `editable` coherence, the rule count against the reliability target —
and being wrong about one of those breaks the agent, so they fail the load.

`workspace` reports judgements about writing, and every one is a warning:

| Check | Fires when |
| --- | --- |
| `workspace_unfilled_placeholder` | `{{PLACEHOLDER}}` survives into a file. Suppresses the rest for that file — an unfilled template trips every other check for the same reason. |
| `workspace_example_count` | Fewer than three examples, or more than five. |
| `workspace_example_diversity` | Two examples share more than 40% of their distinctive words. |
| `workspace_rule_no_rationale` | A counted rule carries no connective (`because`, `so that`, `rather than`, an em dash). |
| `workspace_negative_framing` | More than five prohibitions. |
| `workspace_bullet_density` | More than 40% of a static file's lines are list items. |

A heuristic judgement that refuses to load a file is a heuristic nobody keeps, so the command exits
0 by default. `--strict` exits non-zero for CI, where a warning someone has accepted and a warning
nobody has read look identical.

The bullet-density check is currently **unconditional** rather than gated on every bound channel
having `markdown: none | basic`. Channels arrive in Phase 4 and the manifest section is refused
until then, so gating it now would ship a check that could never fire.

Not yet checked: duplication between workspace files and registered tools or skills, which needs
both to exist (Phases 3.6 and 5).

The framing here follows OpenAI's guidance on prompts generally — treat them as application
code: versioned in git, reviewed in the PR that changes the behaviour they support, covered
by evaluation fixtures that run on deploy. Worth noting that OpenAI is retiring its own
reusable prompt-object abstraction in favour of exactly this, which is a useful data point
for the file-canonical decision recorded in `00-DECISIONS.md` §5.5.
