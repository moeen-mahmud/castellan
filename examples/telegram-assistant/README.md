# telegram-assistant

A worked workspace — the template in `../workspace-template/` with the placeholders actually filled
in, so the authoring rules have something concrete to point at.

> **Incomplete by design, for now.** There is no `agent.yaml` here yet: this example needs the
> tiered workspace (Phase 3.5) and the Telegram channel (Phase 4). What exists is
> `workspace/SOUL.md` and `workspace/POLICY.md`. Running anything in this directory is not
> possible and is not meant to be — use `examples/minimal/` for that.

## What it demonstrates

`workspace/SOUL.md` is prose, not bullets, because this agent lives in a Telegram window where
headers and lists render badly — and because a file written in lists produces an agent that answers
in lists regardless of what the file says about formatting.

It holds **two** rules, not six. At a per-rule compliance of 0.90 two rules gets you 0.81 and four
gets you 0.66, so the count is a budget rather than a preference. Both rules carry their reason in
the same sentence: *"I confirm before anything that sends, spends, schedules, or deletes, because he
wires me into live systems and mistakes there are expensive and public."* The reason is what lets the
model extend the rule to an action nobody enumerated.

The four examples are deliberately unalike — a failed deploy, a rejected rewrite, a draft awaiting
approval, and an admission of missing data. Four examples about deploys would produce an agent that
steers every conversation toward deploys.

The last example is the load-bearing one:

```
Moeen: how many users signed up last month
Vela: I don't have anything wired to the signup data yet, so I'd be guessing. I can pull it
if you point me at the database or an endpoint.
```

It demonstrates the uncertainty behaviour that `POLICY.md` states, and a demonstration beats the
statement. It is also the behaviour worth the most: a defined fallback measurably reduces
confabulation and gives the model somewhere to go other than inventing a number.

## What is deliberately absent

No `TOOLS.md` — the runtime renders the catalogue, and a prose copy drifts from it. No
`IDENTITY.md` separate from the identity file — split, the two contradict each other. No hard security
rules: "never email anyone outside the company" belongs in a recipient allowlist at the tool
boundary, where it is true, rather than in prose, where it is a suggestion.
