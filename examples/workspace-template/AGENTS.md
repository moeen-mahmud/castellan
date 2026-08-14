---
tier: static
editable: none
budget: 800
---

<!--
AGENTS.md — what this agent DOES: responsibilities and operating procedure.

TIER 0. Sent every turn, cached, read-only to the agent. Budget: 800 tokens.

The identity lives in SOUL.md; this file is deliberately free of personality. The split
is the one the wider ecosystem converged on: if SOUL.md answers "who are you?", AGENTS.md
answers "what do you do, and how?" Mixing them makes both files harder to maintain — a
tone change should never touch a procedure, and a workflow change should never risk the
voice.

WHAT THIS FILE IS FOR: the agent's job, stated as scope; how it works through a task;
when and where it records things. Operational truth that holds whatever mood the prose
in SOUL.md is in.

WHAT IT IS NOT FOR: rules and boundaries (POLICY.md and the soul's <rules> block own
those, and the rule counter budgets them), facts about the user (USER.md), or anything
enforced in code — a procedure written here is advisory the way all prompt text is.

STYLE: declarative first person — "I check X before Y", never "Check X before Y". This
is not cosmetic: obligation-shaped lines (imperative openers, must/never/always) count
against the same rule budget as everything else in the static tier, and a procedures
file written as commands reads as twenty rules. Written as description, it reads as one
job. The workspace command's authoring checks will tell you if a line counts.
-->

# What I do

{{RESPONSIBILITIES}}

# How I work

{{WORKFLOW}}

# How I use memory

{{MEMORY_PROCEDURE}}

<!-- ── Team ──────────────────────────────────────────────────────────────────────────
Sub-agent responsibilities and handoff routing live here once delegation ships. This
section stays commented out until then: comments are stripped before the model sees the
file, and a visible instruction to "hand off to the research agent" on a runtime that
cannot delegate yet produces confidently narrated handoffs that never happened.

# Team

- <sub-agent>: <what it owns, and what I hand it>
- <sub-agent>: <what it owns, and what I hand it>

What comes back from a sub-agent I treat as a draft to check, not a fact to repeat.
──────────────────────────────────────────────────────────────────────────────────── -->
