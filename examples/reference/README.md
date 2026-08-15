# reference

Every field `agent.yaml` accepts, in one runnable file. `../minimal/` is the smallest thing that
works; this is the opposite end — the worked copy of `docs/02-SPEC-MANIFEST.md`.

```bash
cp .env.example .env    # then fill in one preset
castellan validate ./agent.yaml
castellan run ./agent.yaml
```

## How to read it

Everything a phase has delivered is **live**. Everything it has not is **commented**, labelled with
the phase that unlocks it. Completing a phase means uncommenting a block here and watching it work,
instead of hunting for a field name in the spec.

The commenting is load-bearing rather than tidy. A section this build does not implement is
**refused at load**, naming the phase — because a runtime that parses configuration and ignores it
lies about what it is doing. Uncomment `channels` today and you get:

```
manifest_validation_failed: This build does not implement channels, but the manifest configures it.
  field: channels
  hint: channels arrives in Phase 4. Remove the "channels" section for now — it is refused rather
        than silently ignored, because a runtime that drops configuration lies about what it is doing.
```

Live now: `model` (all three roles, capabilities, `streamUsage`), `context.files` and
`context.thresholds`, the whole of `tools` including both dialects and a remote provider, and
`limits`. Commented, with their phase: the workspace tiers and `promptStyle` (3.5), `channels` /
`delivery` / `server` (4), `skills` (5), `memory` (6), `phases` (7), `schedules` (8), `plugins` (9).

## Why this one has tools and `minimal` does not

`minimal` pins nothing on purpose, so `/tools` there reports an empty catalogue and the model
correctly tells you it has none. That is the honest output for that manifest, not a bug — a
frequent first surprise.

This one pins `now` and `memory_write`. Both are built in, so the only credential needed is a model
key: no provider, no network beyond the model call, nothing to warm.

They also demonstrate the two execution modes. `now` is read-only and runs in parallel with other
reads; `memory_write` is mutating, so it serialises, holds one of the six reserved write slots, and
is never retried. Ask for both in one message and the transcript shows the chain:

```
› What time is it right now? Save a note that you checked.
  · now — ok · 18 ms
  · memory_write — ok · 1 ms
It is Thursday, 13 August 2026 at 16:56 UTC. I saved a note that I checked the time.
  751 prompt · 254 output · 6814 ms
```

`memory_write` appends to `./memory/notes.md` beside this file — a real file, deliberately, because
a mutating tool that cannot succeed teaches the model to retry until the step budget runs out.

## Adding Composio

Uncomment the `composio:` block inside `tools.providers`, add its slugs to `pinned`, then:

```bash
castellan tools ./agent.yaml --warm    # fetch the schemas into .castellan/tools.cache.json
castellan tools ./agent.yaml           # see the catalogue the model will get
```

The warm step is required rather than convenient. Resolution happens during boot, where no network
call is allowed, so a cold cache fails the load naming the slugs and that command. Once warmed, the
agent boots and serves its catalogue with no Composio key present at all.
