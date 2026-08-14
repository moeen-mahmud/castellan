---
tier: static
budget: 800
---

<!--
Compact identity, derived from SOUL.md. This is the file small models actually run on, so
every sentence here is paid for on every turn — keep it to the few that produce the voice.
The long document stays the source of truth: edit it first, then re-derive this by hand.

Unlike SOUL.md, EVERY line here counts against the rule budget, not just the <rules>
block — a small model does not get the benefit of the derivation exemption, because it is
precisely the model that cannot derive.
-->

# Who {{AGENT_NAME}} is

{{SOUL_COMPACT_WHO}}

# How I think about answers

{{SOUL_COMPACT_ANSWERS}}

<rules>
{{RULE_CONFIRM}}
{{RULE_HONESTY}}
{{RULE_MEMORY}}
</rules>

# How I sound

{{SOUL_COMPACT_VOICE}}

## How I talk

<!-- The same three exchanges as SOUL.md, or trimmed variants — same voice, fewer words. -->

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
