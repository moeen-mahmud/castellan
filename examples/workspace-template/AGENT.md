---
tier: static
editable: none
budget: 1400
---

<!--
AGENT.md — who this agent is and how it speaks.

TIER 0. Sent every turn, cached, read-only to the agent. Budget: 500 tokens.

Replaces SOUL.md and IDENTITY.md. Splitting those produced two files that contradicted
each other and doubled the maintenance surface.

WHAT THIS FILE IS FOR: voice, stance, and a small number of behavioural rules.

WHAT IT IS NOT FOR: making the model smarter. Role prompts do not reliably improve
accuracy on objective tasks and can make a model prioritise sounding right over being
right. Anthropic's own guidance puts role-setting at ONE SENTENCE — "even a single
sentence makes a difference." Write this file to control how the agent sounds, not how
well it thinks. Capability comes from tools and skills.

=============================================================================
THE MOST IMPORTANT RULE: WRITE THIS FILE IN THE STYLE YOU WANT BACK
=============================================================================

Models imitate the form of what they read, not just the content. Anthropic's formatting
guidance is explicit: matching your prompt style to the desired output style improves
steerability, and removing markdown from a prompt reduces markdown in the output.

So if your agent lives in Telegram or WhatsApp, where headers and bullet lists render
badly, WRITE THIS FILE AS PROSE. Paragraphs. Full sentences. No bullets.

An instruction saying "keep formatting light" inside a file made of bullet lists is
fighting itself, and the file wins.

If your agent produces reports or documents, the inverse applies — structure this file
the way you want the reports structured.

=============================================================================
AUTHORING NOTES
=============================================================================

VOICE — write it as the agent, in first person, in the target style. Concrete beats
abstract: "I answer in one paragraph unless you ask for more" is usable; "I am concise
and helpful" is not. Three to five distinct traits. More than that and they blur.

RULES — two to four, maximum. Every rule you add makes every other rule less likely to
be followed; compliance falls roughly as the per-rule success rate to the power of the
rule count. Count these together with POLICY.md and REMINDER.md.

  Phrase them positively. Tell the agent what to do, not what to avoid.

  GIVE THE REASON. Anthropic's guidance: providing motivation behind an instruction
  produces better-targeted responses because the model generalises from the explanation.
  A clause is enough, and it lets the agent extend the rule to cases you never listed.

    Weak:    Confirm before sending anything.
    Better:  Confirm before anything that sends, spends, or deletes — this runs against
             live systems and mistakes there are expensive.

  Anything with real consequences — money, credentials, deletion, sending on someone's
  behalf — does NOT belong here. Enforce those at the tool boundary with middleware.
  Text in this file is advisory and can be talked around.

EXAMPLES — three to five short exchanges. This is the highest-leverage section in the
file and the main defence against robotic output. A dialogue example shows voice that
adjectives can only describe.

  Make them RELEVANT (mirror real use), DIVERSE (vary the situation enough that the model
  doesn't latch onto an unintended pattern — three examples about deploys produce an agent
  that steers everything toward deploys), and DELIMITED (wrapped so the model can tell
  examples from instructions).

  Prefer examples that DEMONSTRATE a rule over restating it. An example showing the agent
  asking before sending is worth more than the sentence telling it to.

  The <example> delimiters here are the authored form. The runtime re-renders them per
  model — XML for Claude, plain sections elsewhere — so write them this way once and
  don't think about it again.
-->

# {{AGENT_NAME}}

<!-- One or two sentences. Who this is and what it's for. Written as the agent, in the
     style you want back. -->

{{IDENTITY_PARAGRAPH}}

<!-- Voice. If this is a chat agent, write it as a paragraph, not a list. -->

{{VOICE_PARAGRAPH}}

<!-- Rules, each with its reason. Two to four.

     The <rules> delimiters are the authored form, like <example> below. The runtime varies only
     the framing *around* this block per model — a 7B model gets imperative framing that a frontier
     model no longer needs, because current models overtrigger on it. Your sentences are never
     touched, so what you write here is what the model reads. -->

<rules>
{{RULES_PARAGRAPH}}
</rules>

## Examples

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
