# 06 — VelaOps Integration

VelaOps is Dispach's first consumer and its most demanding one. That is useful — a
runtime with one real production consumer beats a runtime with none — and dangerous,
because the pressure to let VelaOps' concerns bleed into core will be constant, and you are
the only person who can refuse.

This document exists to make that refusal mechanical rather than a judgement call each time.

---

## The boundary

**Dispach is the process inside `velaops-{agentId}`. Nothing else.**

Everything in `apps/engine` stays where it is: the provisioner, `docker.ts`, `terminal.ts`,
`stream-hub.ts`, `litellm.ts`, `agent-keys.ts`, Traefik routing, MinIO backups,
`docker-socket-proxy`. Dispach replaces exactly one thing: the OpenClaw gateway process.

### What must never enter core

Write this list somewhere you'll see it during code review:

| VelaOps concern | Where it stays | Why |
| --- | --- | --- |
| Per-agent RSA-3072 `.pem` challenge | `lib/agent-keys.ts` | VelaOps' isolation model, not a runtime concern |
| LiteLLM virtual keys, budgets, 25% markup | `lib/litellm.ts` | Dispach sees a base URL and a token |
| Traefik labels, subdomain routing | `docker.ts` | Deployment topology |
| MinIO backup envelopes | `lib/backup.ts` | Storage policy |
| `velaops-net` DNS assumptions | compose | Network topology |
| Billing, entitlements, tier quotas | engine | Business logic |
| Better Auth sessions, user identity | engine | Dispach has no user model |
| `[boot-phase]` marker **format** | compat adapter | Core emits structured events; the adapter formats them |

The last one is the pattern for all of these. Core emits `runtime.ready` with a `phases`
breakdown. The compat adapter subscribes and prints `[boot-phase]` lines. Core never learns
that `boot-progress.ts` exists.

**The test:** if a feature request would make the runtime less useful to someone who has
never heard of VelaOps, it belongs in the adapter or the engine.

---

## Migration strategy

Add `agents.runtime` — `'openclaw' | 'dispach'` — plus a second agent image tag. Both
runtimes coexist per-agent. There is no cutover event.

```
Week 1   Phase 12 ships. runtime='dispach' on your own agent only.
Week 2-4 Dogfood. Every gotcha in 02-GOTCHAS.md gets checked against the new runtime.
Week 5+  Opt-in for new agents. Existing agents untouched.
Later    Default for new agents. Existing agents migrate on request.
Never    Forced migration. OpenClaw agents keep working until nobody runs one.
```

The provisioner emits the same workspace either way. Only `openclaw.json` versus
`agent.yaml` differs, and during compat mode the adapter reads `openclaw.json` directly, so
even that is deferred.

---

## The compat adapter

`@dispach/compat-openclaw` translates. It is not part of the public protocol and it is
deletable the day you're willing to touch `openclaw-ws.ts` and `openclaw-sync.ts`.

**Surface it must reproduce** (from `01-SYSTEM-CONTEXT.md` §8 and `02-GOTCHAS.md`):

| Contract | Detail |
| --- | --- |
| WS RPC on 18789 | `auth.token` (not `auth.password`), TUI client id, explicit subscribe, terminal phase `"result"` (not `"end"`) |
| HTTP scopes | `x-openclaw-scopes` header |
| Health | `/healthz` |
| Model field | Accepts only `"openclaw/main"`; rewrite to the real model id |
| Config | `openclaw.json` incl. `modelByChannel`, `delivery`, `deliveryTargets`, `memorySearch`, bootstrap caps |
| Channels | Gateway ids, notably `teams` → **`msteams`** |
| Boot | `[boot-phase]` markers on stdout |
| Cron | RPC surface mapped onto native schedules |
| Workspace | Ten persona markdown files listed under `context.files` |

### Config translation

```
openclaw.json                        agent.yaml
─────────────────────────────────    ─────────────────────────────
model: "openclaw/main"            →  model.main.{id,baseUrl,apiKeyEnv}   (LiteLLM base URL)
modelByChannel: {telegram: X}     →  channels[].modelOverride
delivery.channel + to             →  delivery.default + targets
agents.defaults.bootstrapMaxChars →  context.observationMaxTokens (converted)
bootstrapTotalMaxChars            →  context.window budgeting
memorySearch                      →  memory.{retriever,k}
subagents                         →  team
cron jobs (SQLite)                →  schedules
```

The two bootstrap caps are worth care. In OpenClaw, raising only the per-file cap starved
`MEMORY.md`. Dispach has one budget with explicit per-slot accounting, so the translation
is lossy in the direction of correctness — record it as a deviation and verify `MEMORY.md`
actually lands in context via `GET /v1/agents/:id/context`.

---

## Gotchas that become acceptance tests

`02-GOTCHAS.md` is an executable spec for Phase 12. Each row is a test that must pass.

| VelaOps gotcha | Dispach behaviour to verify |
| --- | --- |
| Model field only accepts `openclaw/main` | Adapter rewrites; native manifest takes a real id |
| Config silently rolls back on version skew | `apiVersion` mismatch fails loudly at boot |
| Two bootstrap caps truncate `MEMORY.md` | One budget; `/context` shows `MEMORY.md` present with token count |
| Channel change needs external gateway restart | Channel config change applies on `reload` without restart |
| Plugin crash-loop from install-record trust gate | No runtime install, no trust gate; version mismatch fails by name |
| `dmPolicy: "open"` boots healthy, drops every DM | Incoherent channel config fails validation, not a warning |
| OpenAI-compat HTTP drops tool + thinking streams | One transport; thinking blocks replayed per capabilities |
| Cron in SQLite, CLI writes scope-denied | Cron is a first-class API and CLI resource |
| `cron.list` hides disabled unless asked | Disabled listed by default |
| `cron.add` rejects `payload.model: null` | Omitted optional fields are omitted, never null-rejected |
| Keyless implicit isolated crons hard-refused | Delivery validated at write with a specific error |
| 7.1 hard-fails boot on legacy memory layouts | Migrations are ours; layout changes are versioned |
| Reasoning models empty with `stopReason=length` | `maxOutput` from capabilities, never `window/4` |
| Tool count is a shared budget, writes starved | Explicit `budget.max` + `reserveWrite` |
| Dead slugs dropped silently | `resolve()` throws naming slug and provider |
| Composio MCP 405s the GET leg | No MCP in the Composio path — `composio-proxy` deleted |
| `mcp.update()` doesn't rebind tools | Not applicable; direct SDK |
| Tools vanish after rotating `COMPOSIO_API_KEY` | Key read from env at call time, not baked at create |
| Agent → LiteLLM TCP dies after 4–5h idle | Connection re-established per request; no warmup ticker needed |
| Generation dies on browser refresh | Detached turns + reattach are core |
| Tokens arrive in ~40ms clumps | Server sets `TCP_NODELAY` |
| Turn aborts at `stopReason=aborted` | `limits.turnTimeoutMs`, reported as `turn.end.reason=timeout` |
| `openclaw.json` regeneration must fire on deploy/reload/restart | Single load path; `reload` returns a diff |

Phase 12 is not done until each of these has a passing test or a recorded, justified
deviation.

---

## What VelaOps gains beyond parity

Not the pitch — the specific things that become possible once the runtime is yours.

**Container weight.** The current agent container runs the gateway, a Python embed-service
with model weights, the Baileys bridge, the Teams channel, and `composio-proxy`. Dispach
is one process. FTS5 replaces the embed-service, which is the single largest per-agent cost
line and the reason `EMBED_MODEL` exists. Direct Composio deletes `composio-proxy`. One
ingress port also resolves the unverified whatsapp-bridge/Teams 3978 collision flagged in
`01-SYSTEM-CONTEXT.md` §8.

**Free tier economics.** Free is "1 agent, auto-pause 7d idle" — a hibernation requirement
expressed as a business constraint. Sub-second cold start makes pausing invisible, which
makes aggressive auto-pause viable, which is where the margin is.

**The first-boot stepper becomes deletable.** `use-boot-progress.ts` exists because boot is
slow enough to need narration. Removing it is the visible proof the runtime changed.

**Model routing stops being a hot-patch.** `POST /api/agents/:id/model` currently
hot-patches `openclaw.json`. Against Dispach it's a manifest field.

**Upgrades stop being a treadmill.** `pnpm check:openclaw` guards a version pin on a
runtime you don't control. That constant disappears.

---

## What VelaOps must keep doing

Dispach does not replace these, and requests to make it do so should be declined:

- **Identity and auth.** No user model. Better Auth stays authoritative.
- **Cost control.** No budgets, no markup, no quotas. LiteLLM stays.
- **Isolation.** No opinion on containers. The `.pem` model stays.
- **Provisioning.** No agent lifecycle management. That is literally VelaOps.
- **Persistence beyond its own tables.** Core emits events; the engine subscribes and writes
  `sub_agent_invocations` and `tool_calls`. Dispach never writes to the `velaops` database.

That last one is the cleanest boundary in the whole design. Core owns its SQLite file inside
the container. Everything the platform wants to know arrives over `GET /v1/events`.

---

## Operational notes

**Verification stays Docker Compose.** The VelaOps standing mandate is unchanged for
engine-side work. Dispach itself has `bun test`, and those are different questions.

**Version pinning inverts.** Today `OPENCLAW_RUNTIME_VERSION` pins a foreign runtime and
`check:openclaw` asserts agreement. With Dispach, VelaOps pins a git SHA or version range
of its own dependency. Same discipline, but a bump is now a decision rather than an
emergency.

**Two runtimes means two debugging paths** for as long as both exist. Budget for that. It is
the price of not doing a cutover, and it is much cheaper than the alternative.
