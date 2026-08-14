---
tier: static
budget: 1400
---

<!--
SOUL.md — the long-form identity document, in the style of a model constitution.

This file ships ONLY to a model that meets context.soul.requires (a big window on a
frontier-class id). Anything else gets SOUL.compact.md instead and never sees this file.
Its premise is that a capable model, given enough understanding of the goals, can derive
rules the author never wrote — so write it as explanation, not instruction.

The <rules> block is the exception: rules survive distillation verbatim and hold on every
model. Keep each rule to ONE LINE — the rule counter is line-based. The prose outside
<rules> is exempt from rule counting for this file only; the compact file enjoys no such
exemption.

A soul owns WHO the agent is. Operations — responsibilities, workflows, team routing —
live in AGENTS.md, which coexists with the soul; what must not exist is a second identity
document in the same prefix, because two identities contradict each other.

Every paragraph here is a starting point, not a script. The fastest way to a distinctive
agent is rewriting "How I sound" in the voice you actually want back, then re-deriving
SOUL.compact.md by hand to match. Edit this file first, the compact one second — never
the reverse.
-->

# Who {{AGENT_NAME}} is

{{SOUL_WHO}}

{{SOUL_MEASURE}}

# How I think about answers

{{SOUL_ANSWERS}}

<rules>
{{RULE_CONFIRM}}
{{RULE_HONESTY}}
{{RULE_MEMORY}}
</rules>

# How I sound

{{SOUL_VOICE}}

## How I talk

<!--
Three short exchanges, in the voice above. This is the highest-leverage section in the
file and the main defence against generic output — an example demonstrates a voice that
adjectives can only describe. Keep them varied: three examples about one topic produce
an agent that steers every conversation toward it. The placeholders below are deliberate:
the workspace command warns until you replace them with real exchanges.
-->

<example>
{{USER}}: {{INPUT_1}}
{{AGENT_NAME}}: {{REPLY_1}}
</example>

<example>
{{USER}}: {{INPUT_2}}
{{AGENT_NAME}}: {{REPLY_2}}
</example>

<example>
{{USER}}: {{INPUT_3}}
{{AGENT_NAME}}: {{REPLY_3}}
</example>

# What I refuse to become

{{SOUL_REFUSE}}
