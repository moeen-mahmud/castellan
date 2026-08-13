# 07 — Workspace Specification

The persistent files an agent carries: identity, policy, user model, memory, knowledge, and
skills. This document supersedes the flat `context.files` list in `02-SPEC-MANIFEST.md`.

**Why it replaced the flat list.** A flat ordered array cannot express three things that
turned out to matter: which files are cache-stable versus volatile, which sit after the
conversation history rather than before it, and which the agent may write to. Each of
those has a measurable cost when got wrong — an invalidated prompt cache, decayed rule
adherence, or persona drift.

---

## Tiers

| Tier | Position | Cache | Editable | Default budget |
| --- | --- | --- | --- | --- |
| `static` | system prefix, slots 0–1 | before breakpoint A | no | 700 |
| `volatile` | system prefix, after static | after breakpoint A | yes | 500 |
| `reminder` | after history, before current input | never | no | 60 |

Total hard cap 1,300 tokens. Exceeding it **fails the load** and names the file. No silent
truncation — that failure mode produces an agent running on partial instructions with no
error surfaced anywhere.

Tier 3 content (`knowledge/`, `skills/`) is not pinned and has no share of this budget.

### Position rationale

**Static first.** Prompt caching requires a byte-stable prefix. A file that changes ahead
of the breakpoint invalidates the cached prefix on every write, raising cost with no error
to explain it. Additionally, earlier instructions are favoured under moderate instruction
density, so the highest-priority rules belong at the top of `AGENT.md`.

**Reminder last.** Rule adherence decays over a conversation and compaction does not
reliably reset it. Attention is stronger at both ends of the context than the middle, so a
rule stated once at the top of a thirty-turn conversation is effectively in the middle.
Re-asserting one or two rules at the recency position is the cheapest known countermeasure.

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
inline documentation.

`editable` is enforced, not advisory. `memory_write` against `editable: none` returns
`ErrReadOnlyContextFile`. Read-only identity is the most effective known mitigation for
persona drift.

---

## Standard files

| File | Tier | Editable | Budget | Purpose |
| --- | --- | --- | --- | --- |
| `AGENT.md` | static | none | 500 | Identity, voice, rules, examples |
| `POLICY.md` | static | none | 200 | Soft boundaries and uncertainty behaviour |
| `USER.md` | volatile | append | 250 | User model |
| `MEMORY.md` | volatile | replace | 400 | Working memory, capped, evicting |
| `REMINDER.md` | reminder | none | 60 | One or two re-asserted rules |

All are optional. A missing file is skipped; a file listed in the manifest but absent from
disk fails the load.

### Deliberate omissions

`TOOLS.md` (duplicates the rendered tool catalogue and drifts from it), `HEARTBEAT.md`
(schedules are a queryable resource), `PLATFORM.md` / `PLATFORM_STATE.md` (volatile state
in a cached prefix destroys the cache and is stale on read), `IDENTITY.md` (folded into
`AGENT.md`; splitting it from personality produces two files that contradict each other),
`SOUL.md` (see below).

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

Distillation is not automatic in v0.1. `castellan soul distill SOUL.md` emits a scaffold the
author edits; the runtime uses the committed compact file. Automatic summarisation of an
identity document is a bad idea — the parts that produce voice are exactly the parts a
summariser drops.

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
over-exploration. A 7B model has the inverse failure mode. `emphatic` adds imperative
framing and repetition to rule blocks; `soft` strips it.

This is the general shape of a problem worth naming: **published prompting guidance is
written for frontier models, and a significant fraction of it inverts at 3–8B.** Anywhere
Castellan encodes vendor advice, it encodes it as a capability rather than a constant.

**`examplesIn` / `skillsIn`.** Genuinely unresolved. Anthropic places examples in the system
prompt; OpenAI's guidance puts tone and role in the system message and task-specific detail
and examples in user messages. Settled by the Phase 3 eval matrix, not by picking a vendor.

---

## `compactionNotice`

When compaction is enabled, the runtime injects a generated line telling the model its
context will be compacted automatically and it should not stop work early on budget
grounds. Without it, models sense the approaching limit and wrap up prematurely.

Runtime-generated rather than author-written, because the author does not know the
threshold values. Suppress with `compactionNotice: false`.

---

## Rule budgeting

Compliance with n simultaneous rules falls roughly as the per-rule success rate to the
power of n. The runtime counts imperatives across `static` and `reminder` and enforces:

```yaml
context:
  rules:
    perRuleSuccess: 0.90
    reliabilityTarget: 0.80
    onExceed: fail
```

At 0.90 per rule, a 0.80 target permits two rules. Four rules yield 0.66. The guard exists
because this arithmetic is unintuitive and authors consistently overestimate their budget.

`castellan eval rules` measures `perRuleSuccess` against the configured model with a
verifiable-instruction probe. Guessing produces a guard that validates nothing.

Remedy for exceeding the budget is deleting rules or moving them into `wrapToolCall`
middleware. Never raising the target, and never reformatting — structured formatting costs
tokens and buys no reliable compliance.

---

## Authoring rules the validator enforces

1. **Style matches target output.** Files for chat-channel agents must be prose; the
   validator warns on bullet density above a threshold in `AGENT.md` when every bound
   channel has `markdown: none | basic`. Models imitate form as readily as content, so a
   bulleted file produces a bulleted agent regardless of what the file says.
2. **Rules carry reasons.** A rule without a rationale clause is a warning. Explanation
   lets the model generalise to unenumerated cases.
3. **Three to five examples.** Fewer under-determines voice; more over-fits. The validator
   warns on lexical overlap above a threshold, since three examples about deploys produce
   an agent that steers toward deploys.
4. **Positive framing.** More than five prohibitions is a warning; heavy negative framing
   pushes small models toward over-refusal.
5. **`when_not_to_use` is mandatory** on every skill. Negative examples in a manifest are
   the cheapest available routing improvement.

---

## Validation

```bash
castellan workspace validate ./workspace
```

Checks frontmatter validity, per-file and total budgets, tier ordering, rule count against
the reliability target, `editable` coherence, example count and diversity, prose/structure
match against bound channel capabilities, and duplication between workspace files and
registered tools or skills.

Every failure names file, line, and fix. Runs in CI.

The framing here follows OpenAI's guidance on prompts generally — treat them as application
code: versioned in git, reviewed in the PR that changes the behaviour they support, covered
by evaluation fixtures that run on deploy. Worth noting that OpenAI is retiring its own
reusable prompt-object abstraction in favour of exactly this, which is a useful data point
for the file-canonical decision recorded in `00-DECISIONS.md` §5.5.
