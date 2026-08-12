# 02 — Manifest Specification

`agent.yaml` is the single configuration contract. Everything about an agent is either in
this file or referenced from it.

Two equal construction paths:

```bash
castellan run ./agent.yaml
```

```ts
import { Runtime, defineAgent } from "@castellan/core"
const runtime = await Runtime.create({ agents: [defineAgent({ /* same shape */ })] })
```

The YAML path parses into exactly the object the TS builder produces. There is no
YAML-only feature and no TS-only feature.

---

## Full example

```yaml
apiVersion: castellan/v1
id: assistant
name: Moeen's Assistant

model:
  main:
    id: qwen3-8b-instruct
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
    temperature: 0.3
  selector:
    id: qwen3-1.7b-instruct
    baseUrl: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  compactor: { $ref: model.selector }

context:
  window: 32768
  reserveOutput: 4096
  observationMaxTokens: 2000
  files:
    - IDENTITY.md
    - GUARDRAILS.md
    - MEMORY.md
  thresholds:
    trim: 0.60
    snip: 0.70
    micro: 0.80
    collapse: 0.88
    reset: 0.95

tools:
  dialect: nlt
  provider: composio
  budget:
    max: 24
    reserveWrite: 6
  pinned:
    - GMAIL_FETCH_EMAILS
    - GMAIL_SEND_EMAIL
    - GOOGLECALENDAR_LIST_EVENTS
    - GOOGLECALENDAR_CREATE_EVENT
  search:
    enabled: false
  local:
    - memory_write
    - phase_set

phases:
  default:
    allow: ["*"]

skills:
  dir: ./skills
  maxActive: 1
  threshold: 0.35

memory:
  retriever: fts5
  dir: ./memory
  k: 6

channels:
  - type: telegram
    id: tg
    mode: longpoll
    tokenEnv: TELEGRAM_BOT_TOKEN
    allowFrom: ["@moeen"]
  - type: whatsapp
    id: wa
    authDir: ./.castellan/wa-auth

delivery:
  default: tg

schedules:
  - id: morning-brief
    kind: cron
    expr: "0 8 * * *"
    task: "Summarise today's calendar and unread email."
    deliver: { channel: tg, to: "@moeen" }
    session: isolated

plugins:
  - "@castellan/channel-telegram"
  - "@castellan/tools-composio"
  - spec: "./plugins/custom-metrics"
    config: { endpoint: "http://localhost:9090" }

limits:
  maxSteps: 12
  turnTimeoutMs: 1800000
  toolTimeoutMs: 120000

server:
  enabled: true
  port: 7420
  tokenEnv: CASTELLAN_API_TOKEN
```

---

## Field reference

### Top level

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `apiVersion` | `"castellan/v1"` | yes | Refused if unknown. Never silently upgraded. |
| `id` | string | yes | Slug. Unique within a runtime. Used in session keys and API paths. |
| `name` | string | no | Display only. |
| `extends` | string | no | Path to a base manifest. Shallow merge, arrays replace. |

### `model`

Three roles. `main` required; `selector` and `compactor` fall back to `main`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Sent verbatim as the `model` parameter. |
| `baseUrl` | string | Must end at the version segment, e.g. `.../v1`. Requests go to `{baseUrl}/chat/completions`. |
| `apiKeyEnv` | string | **Name of the env var**, never the key itself. A literal key in the manifest fails validation. |
| `temperature`, `topP`, `maxTokens` | number | Optional passthrough. |
| `headers` | map | Extra headers. Values may use `${ENV_VAR}`. |
| `capabilities` | object | Override the shipped registry. See below. |

`$ref: model.selector` reuses another role's definition without repetition.

#### `model.*.capabilities`

Only override when the shipped registry is wrong for your endpoint.

```yaml
capabilities:
  nativeTools: false
  strictSchema: false
  thinking: none          # none | anthropic | openai | deepseek
  promptCache: none       # none | anthropic | openai
  parallelToolCalls: false
  contextWindow: 32768
  maxOutput: 4096
```

Capabilities affect thinking-block replay and cache-breakpoint placement **only**. They
never change the tool dialect.

`thinking` says what the loop must *do* with reasoning, and the non-`none` cases disagree:

| Value | Reasoning arrives as | Replayed with tool results |
| --- | --- | --- |
| `none` | not exposed | n/a |
| `anthropic` | separate thinking blocks | **required** — omitting it degrades multi-step reasoning silently |
| `openai` | server-side, opaque | nothing to replay |
| `deepseek` | `reasoning_content`, beside `content` | **no** — sending it back is accepted but buys nothing |

`deepseek` carries a second consequence, and it is the one that actually bites: **reasoning
tokens are billed against the output budget.** A `max_tokens` too small to cover the model's
thinking returns empty content with `finish_reason: "length"`. Measured against
`deepseek-v4-pro` on 2026-08-12: `max_tokens: 16` produced 16 reasoning tokens and no reply.
Set `context.reserveOutput` high enough for reasoning *plus* the answer — the runtime reports
this case as a failed turn rather than an empty success, but it cannot fix the budget for you.

`promptCache: none` means there are no breakpoints for the runtime to place. It does not mean
the provider caches nothing: DeepSeek caches context automatically server-side and reports
`prompt_cache_hit_tokens` on every response.

### `context`

| Field | Default | Notes |
| --- | --- | --- |
| `window` | from capabilities | Total token budget. |
| `reserveOutput` | 4096 | Held back for the response. |
| `observationMaxTokens` | 2000 | Above this a single tool observation is trimmed to head+tail with an artifact pointer. |
| `files` | `[]` | Ordered. Concatenated into context slot 0 (pinned, cache-stable). Relative to the manifest. Missing file = load failure. |
| `thresholds` | see architecture | Compaction ladder trigger fractions. Must be strictly ascending; validated. |

### `tools`

| Field | Default | Notes |
| --- | --- | --- |
| `dialect` | `nlt` | `nlt` or `native`. Config only — never auto-detected. |
| `provider` | none | Provider id registered by a plugin: `composio`, `mcp`, or custom. Omit for local-only. |
| `providerConfig` | `{}` | Passed to the provider. Secrets via `${ENV_VAR}`. |
| `budget.max` | 24 | Hard cap on catalogue size. |
| `budget.reserveWrite` | 6 | Slots held for mutating tools so reads cannot starve writes. |
| `pinned` | `[]` | Slugs resolved at load. **An unknown slug fails the load** with the slug and provider named. |
| `search.enabled` | false | Exposes a provider search meta-tool as an escape hatch. Off by default: search-then-execute is two-hop reasoning and small models fail it. |
| `local` | `[]` | Built-in tools: `memory_write`, `phase_set`, `handoff`, `now`. |

### `phases`

```yaml
phases:
  triage: { allow: ["tag:read"], entry: true }
  act:    { allow: ["tag:read", "tag:write"] }
```

- `allow` matches slugs, `tag:<name>` annotations, or `*`
- `entry: true` marks the starting phase; defaults to the first declared
- Declaring more than one phase auto-registers the `phase_set` local tool
- A single implicit `default: { allow: ["*"] }` phase exists if the key is omitted

Phase state persists per session.

### `skills`

| Field | Default | Notes |
| --- | --- | --- |
| `dir` | `./skills` | Scanned for `*/SKILL.md`. Frontmatter only at boot. |
| `maxActive` | 1 | Skill bodies injected per turn. |
| `threshold` | 0.35 | Normalised BM25 floor. Below it, no skill activates. |
| `sources` | `[]` | Additional sources registered by plugins. |

### `memory`

| Field | Default | Notes |
| --- | --- | --- |
| `retriever` | `fts5` | Interface id. `fts5` is the only shipped implementation. |
| `dir` | `./memory` | Dated markdown. Written by the agent through `memory_write`. |
| `k` | 6 | Passages retrieved into context slot 3. |
| `includeHistory` | true | Whether past messages are indexed alongside memory files. |

### `channels`

Common fields; type-specific fields are validated by the channel's own schema.

| Field | Notes |
| --- | --- |
| `type` | Registered channel type. |
| `id` | Unique within the agent. Used in session keys and delivery targets. |
| `allowFrom` | Inbound allowlist. `["*"]` permits anyone. **Inbound only** — it has no effect on outbound delivery. |
| `enabled` | Default true. |

Telegram: `tokenEnv`, `mode` (`longpoll` \| `webhook`), `webhookPath`, `secretTokenEnv`.
WhatsApp: `authDir`, `printQr`.

Channel connection failures never block readiness; they surface as `agent.channel.error`.

### `delivery`

```yaml
delivery:
  default: tg
  targets:
    alerts: { channel: tg, to: "@moeen" }
```

`default` names the channel used when a turn has no originating channel — scheduled runs,
API-initiated turns.

### `schedules`

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable. Used for updates and idempotency. |
| `kind` | yes | `cron` \| `every` \| `at` |
| `expr` | yes | cron: 5 or 6 field. every: duration (`15m`, `2h`). at: ISO 8601, max +10 years. |
| `task` | yes | Prompt text for the run. |
| `deliver` | yes | `{ channel, to }` or the literal `none`. **Validated at write time** with a specific error naming what's missing. |
| `session` | no | `isolated` (default) or `shared:<key>`. |
| `enabled` | no | Default true. Disabled schedules are listed by default. |
| `timezone` | no | IANA name. Defaults to `TZ` then UTC. |

Schedules declared in the manifest are reconciled into the store at load: created,
updated, or removed to match. Schedules created through the API and absent from the
manifest are left alone — the manifest owns manifest schedules only.

### `plugins`

```yaml
plugins:
  - "@castellan/channel-telegram"          # shorthand, no config
  - spec: "./plugins/custom-metrics"       # relative path
    config: { endpoint: "http://localhost:9090" }
```

Resolved at boot from `node_modules` or a relative path. **Never installed at runtime.**
Load order is manifest order; middleware composes outermost-first. A plugin whose
`castellanApi` range does not satisfy the host refuses to load and names both versions.

### `limits`

| Field | Default | Notes |
| --- | --- | --- |
| `maxSteps` | 12 | Steps per turn before forced termination. Hitting it emits `turn.end` with `reason: max_steps` — an honest failure, not a silent truncation. |
| `turnTimeoutMs` | 1800000 | 30 min. Must exceed any upstream timeout on the model endpoint. |
| `toolTimeoutMs` | 120000 | Per tool execution. |
| `maxParallelTools` | 4 | Read-only tools only; mutating tools always serialise. |

### `server`

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | false | Library use needs no server. |
| `port` | 7420 | |
| `host` | `127.0.0.1` | Binds loopback by default. Public binding is explicit. |
| `tokenEnv` | `CASTELLAN_API_TOKEN` | Bearer token env var name. Server refuses to start on a non-loopback host without a token. |

---

## Multi-agent manifests

A runtime-level file lists agents and declares the team:

```yaml
apiVersion: castellan/v1
kind: Runtime
agents:
  - ./agents/supervisor.yaml
  - ./agents/researcher.yaml
  - ./agents/writer.yaml
team:
  supervisor: supervisor
  members: [researcher, writer]
```

The supervisor gets the `handoff` local tool. Members do not, unless they declare their own
team — nesting is permitted but each level must be declared explicitly.

---

## Validation rules

Enforced by `manifest/validate.ts`, all failing at load with a field path and a fix hint:

1. `apiVersion` must be exactly `castellan/v1`.
2. Secrets must be `*Env` references. A literal-looking key (`sk-`, `Bearer `, 32+ char hex) in a value fails.
3. `context.thresholds` must be strictly ascending and within `(0, 1)`.
4. `tools.budget.reserveWrite` must be less than `budget.max`.
5. Every `pinned` slug must resolve against the provider.
6. Every `phases.*.allow` entry must match at least one resolved tool, or be `*`.
7. Exactly one phase may be `entry: true`.
8. Every schedule must have a `deliver` target or explicit `none`.
9. Every `channels[].id` referenced by `delivery` must exist.
10. `context.files` must all exist and be readable.
11. `reserveOutput` must be less than `window`.
12. Plugin `castellanApi` ranges must satisfy the host version.

Rule 2 exists because a manifest is a file people paste into issues.

---

## Environment expansion

`${VAR}` expands anywhere in a string value, at load, from `process.env`. An unset variable
referenced in a required field fails the load naming the variable — it does not expand to
an empty string and fail later as a confusing auth error.

`.env` next to the manifest is loaded if present. Real environment always wins.
