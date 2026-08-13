# Agent Workspace

The files an agent carries with it. Copy this directory, fill in the templates, point
`agent.yaml` at it.

**The governing constraint:** everything in Tier 0 and Tier 1 goes to the model on **every
single turn**, forever. A word you add here is a word the model reads a thousand times.
Files earn their place or they get deleted.

---

## Tiers

| Tier | Files | Position | Cached | Agent may edit | Budget |
| --- | --- | --- | --- | --- | --- |
| **0 — static** | `AGENT.md`, `POLICY.md` | system prefix, first | yes, before breakpoint A | **no** | 700 tok |
| **1 — volatile** | `USER.md`, `MEMORY.md` | system prefix, after | no | yes, via tools | 500 tok |
| **2 — reminder** | `REMINDER.md` | after conversation history | no | no | 60 tok |
| **3 — on demand** | `knowledge/`, `skills/` | retrieved / activated | n/a | no | not pinned |

**Hard total for Tiers 0–2: 1,300 tokens.** The runtime refuses to load a workspace over
budget and names the offending file. It does not silently truncate — silent truncation is
how an agent ends up running on half its instructions with no error anywhere.

### Why tier controls cache position

Prompt caching only works on a byte-stable prefix, and both major providers reward one.
Put a file that changes — memory, user facts, a timestamp — ahead of the breakpoint and
every write invalidates the whole cached prefix, so cost rises with no error to explain it.
Static first, volatile after.

That is the concrete reason `MEMORY.md` is not Tier 0.

### Why REMINDER.md exists

Rule adherence decays measurably over a conversation, and compaction does not reliably
reset it. Models attend more strongly to both ends of the context than the middle, so
re-asserting one or two critical rules *after* the history is a cheap, well-attested
countermeasure. One or two rules. It is not a second policy file.

---

## Frontmatter

Every Tier 0–2 file starts with:

```yaml
---
tier: static          # static | volatile | reminder
editable: none        # none | append | replace
budget: 500           # token cap for this file
---
```

The loader strips frontmatter and `<!-- HTML comments -->` before injection, so authoring
guidance in these templates costs nothing at runtime. Write freely in comments.

`editable` is enforced. An agent calling `memory_write` against an `editable: none` file
gets a typed error, not a silent no-op. Making identity read-only is the single most
effective known fix for persona drift.

---

## The three rules that matter most

### 1. Write the files in the style you want back

Models imitate form as readily as content. Anthropic's formatting guidance says so
directly: matching prompt style to desired output style improves steerability, and
removing markdown from a prompt reduces markdown in the output.

Your agent lives in Telegram and WhatsApp, where headers and bullet lists render badly.
So **write `AGENT.md` and `POLICY.md` as prose.** Paragraphs, full sentences, no bullets.

A line saying "keep formatting light" inside a file made of bullet lists is fighting
itself, and the file wins. This is a larger voice lever than the voice description itself.

If the agent's job is producing structured documents, invert this and structure the files.

### 2. Give the reason with the rule

Anthropic's guidance: explaining the motivation behind an instruction produces
better-targeted responses, because the model generalises from the explanation. A clause is
enough, and it buys coverage of cases you never enumerated.

```
Weak:    Confirm before sending anything.
Better:  Confirm before anything that sends, spends, or deletes — this runs against live
         systems and mistakes there are expensive.
```

This is the soul-document philosophy — teach the reasoning, not just the rule — compressed
to a scale a small model can actually use.

### 3. Show, don't describe

Three to five short dialogue examples in `AGENT.md` do more for voice than any number of
adjectives, and an example demonstrating a rule beats the sentence stating it.

Keep them relevant, and keep them **varied** — three examples about deploys produce an
agent that steers every conversation toward deploys.

---

## Rendering is per-model

You author markdown with `<example>` delimiters. The runtime re-renders per model via
`capabilities.promptStyle`:

| | delimiters | intensity | examples in |
| --- | --- | --- | --- |
| Claude | `xml` | neutral | system |
| OpenAI frontier | `markdown` | neutral | user |
| Small open-weight | `plain` | emphatic | system |

Two reasons this is a capability rather than a constant.

**Delimiters.** Anthropic recommends XML tags because Claude was trained on them.
Controlled cross-model work finds no reliable markdown advantage generally and a 22–37%
token penalty for structured formats. Both are true; the right answer is per-model.

**Intensity.** Anthropic now advises *removing* emphatic phrasing — "CRITICAL: You MUST"
becomes "Use this tool when" — because current frontier models overtrigger on it. A 7B
model has the opposite failure mode and needs the emphasis. Same file, different register,
chosen by capability rather than by the author.

Write once. Don't hand-tune per provider.

---

## What does NOT belong here

Deleting these is the point of the design, not an oversight.

| Tempting file | Where it goes | Why |
| --- | --- | --- |
| `TOOLS.md` | tool schemas | Prose descriptions duplicate the catalogue the runtime already renders, and drift out of sync |
| `HEARTBEAT.md` | `schedules` in `agent.yaml` | Schedules are a queryable resource, not prompt text |
| `PLATFORM.md`, `PLATFORM_STATE.md` | a `get_status` tool | Volatile state in a cached prefix destroys the cache and is stale by the time it's read |
| `LORE.md`, `KNOWLEDGE.md` | `knowledge/` | Keyword-gated retrieval. Facts needed *sometimes* shouldn't cost tokens *always* |
| Long procedures, checklists | `skills/` | Progressive disclosure: ~50 tokens pinned for the description, body loads on relevance |
| `IDENTITY.md` | folded into `AGENT.md` | Splitting name-and-vibe from personality yields two files that contradict each other |
| Safety-critical guardrails | **code**, at the tool boundary | Prose guardrails are advisory. If it matters, enforce with allowlists, typed parameters, scoped credentials |

`POLICY.md` survives only for *soft* boundaries. Anything with real consequences goes in
code.

---

## Rule budgeting

Compliance with n simultaneous rules falls roughly as the per-rule success rate to the
power of n. At 90% per rule:

| rules | all followed |
| --- | --- |
| 1 | 90% |
| 2 | 81% |
| 3 | 73% |
| 4 | 66% |
| 6 | 53% |
| 10 | 35% |

Count every imperative across `AGENT.md`, `POLICY.md`, and `REMINDER.md` together — the
model doesn't know they came from different files. Over budget, the fix is to **delete
rules or move them into code**, never to reformat them.

Measure your model's per-rule rate rather than assuming 90%; small models run lower.

---

## Validation

```bash
castellan workspace validate ./workspace
```

Checks frontmatter, per-file and total budgets, tier ordering, rule count against the
configured reliability target, `editable` coherence, example count and diversity, and that
no file duplicates a registered tool or skill. Failures name the file, the line, and the
fix.

Run it in CI. Treat these files the way OpenAI's guidance treats prompts generally — as
application code, versioned in git, reviewed in the PR that changes the behaviour they
support, covered by evaluation fixtures that run on deploy.
