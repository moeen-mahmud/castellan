# @castellan/tools-composio

Composio as a tool provider, over plain HTTP. No MCP transport, no SDK, no sidecar.

```yaml
tools:
  providers:
    composio:
      apiKeyEnv: COMPOSIO_API_KEY  # the variable's *name*, never the key
      userId: moeen                # which connected account to act as
  pinned:
    - GMAIL_FETCH_EMAILS
    - GMAIL_SEND_EMAIL
    - GOOGLECALENDAR_EVENTS_LIST
```

`tools.providers` is a map, so this coexists with `system` and `web`. The older
`provider: composio` + `providerConfig:` spelling still loads and warns; setting both is refused.

```bash
castellan tools ./agent.yaml --warm   # fetch schemas into the cache — do this first
castellan tools ./agent.yaml          # show the catalogue the model will see
```

## The cache is the point

Composio exposes ~25,000 tools. Resolution happens **at agent load**, which is inside the boot
sequence, where no network I/O is allowed — that single rule is why this runtime exists, since the
one it replaces blocks minutes on network calls during initialisation.

So the two paths are kept strictly apart:

| | when | network |
| --- | --- | --- |
| `resolve()` | boot, before `runtime.ready` | **never** — reads `.castellan/tools.cache.json` |
| `refresh()` | after `runtime.ready`, detached | yes, then rewrites the cache |

Measured on a three-tool manifest: `Runtime.create` returns in **27 ms**, and the refresh that
follows takes **1,474 ms**. Awaiting it inside boot would have made boot sixty times slower, which is
why it is fire-and-forget and reports through the `tools.refreshed` event instead.

The consequence is that a cold agent must be warmed once before anything of Composio's is pinned. A
pinned slug that is not cached fails the load naming the slugs and the command — not with a network
call, and not by silently dropping the tools.

That failure is reported through `explainUnresolved()`, and the registry raises it only once a slug
is missing after **every** provider has answered. It used to be thrown from `resolve()`, which was
wrong for a reason worth keeping written down: the registry hands each provider the whole `pinned`
list, so a cold cache saw `config_read` — the system provider's, and about to resolve fine — and
refused the boot over it. Configuring this provider while pinning nothing from it is a normal,
startable agent, and is exactly what `init --composio connected` writes.

A warmed agent boots and serves its catalogue **with no API key present at all**. The key is needed
to refresh and to execute, and each says so at the point it needs one.

## Two decisions worth knowing

**`mutating` comes from Composio's own annotations, and defaults to `true`.** Composio publishes
MCP-style hints in `tags`. Measured over 100 tools: `readOnlyHint` on 51, `destructiveHint` on 10, and
**no hint at all on 37** — including `ABLY_PUBLISH_MESSAGE_TO_CHANNEL`. The annotation is reliable when
present (no tool carries `readOnlyHint` while having a write verb in its slug) and says nothing when
absent, so an unannotated tool is treated as mutating.

That is the safe direction rather than the cautious one. `mutating` is what makes the executor
serialise a call and never retry it, so a write mislabelled as a read runs in parallel with its
neighbours *and* is retried on failure — the side effect happens twice. Being wrong the other way
costs a slot in the write budget and some parallelism. Override per tool with the annotations in
Composio itself; `describe().assumedMutating` reports which tools were assumed rather than told.

**Value constraints are carried in the description, not enforced.** 46 of 100 sampled tools declare
at least one keyword this runtime's schema subset does not model — `minimum` (62 occurrences),
`maximum` (23), `format` (22), `pattern`, `minLength`, `maxLength`. Refusing them would refuse half of
Composio, so they are appended to the field's description where both dialects render them and the
model can read them:

```
max_results (optional, integer) How many to return. (minimum 1, maximum 500)
```

The honest consequence: an out-of-range value is rejected by Composio at execution rather than caught
locally as a repairable field error. Structural keywords are different — `anyOf`, `oneOf`, `allOf`,
`not` and `$ref` change which documents are valid, so those are **refused at load** naming the tool,
the field and the keyword. None appears anywhere in the live sample.

## Why direct HTTP rather than MCP

Composio's MCP surface 405s the GET stream leg and stalls past 120 seconds. Both are transport
properties, so going direct deletes the proxy sidecar, the held-open SSE connection, and the rebind
bug along with it. Decision 4.6.

The package depends on `@castellan/core` and nothing else. Every request goes through one injectable
`fetch`, so all of it — including the failure paths — is tested without a network.
