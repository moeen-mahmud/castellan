# 04 — Wire Protocol

The HTTP surface exposed by `@castellan/server`. Deliberately boring: HTTP + JSON for
control, SSE for streaming, WebSocket only where genuinely bidirectional. **`curl` must be
sufficient to drive everything.**

This is Castellan's *own* protocol. The OpenClaw-compatible surface VelaOps currently
speaks is a separate adapter documented in `06-VELAOPS-INTEGRATION.md`, and it is not part
of this spec.

---

## Conventions

- Base path `/v1`. The version changes only on a breaking change.
- `Authorization: Bearer <token>`, from `server.tokenEnv`. Loopback binds may omit it;
  a non-loopback host without a token refuses to start.
- All bodies JSON. All timestamps RFC 3339 UTC.
- Errors:

```json
{ "error": { "code": "unknown_tool", "message": "...", "hint": "...", "field": "tools.pinned[2]" } }
```

`code` is stable and machine-readable. `hint` names the likely fix. Every error type in
`errors.ts` populates it.

---

## Endpoints

### Health and readiness

```
GET /v1/health   → 200 { status, version, uptimeMs, agents: number }
GET /v1/ready    → 200 when every agent has loaded; 503 with { pending: [...] } otherwise
```

`/ready` flips at `runtime.ready` — before channels connect. Channel state is separately
visible on the agent resource. This distinction is deliberate: a channel that cannot
connect must not make the process look dead to an orchestrator.

### Agents

```
GET /v1/agents           → [{ id, name, status, model, channels[], phase }]
GET /v1/agents/:id       → full status incl. tool count, skills indexed, schedule count
POST /v1/agents/:id/reload
```

`reload` re-reads the manifest and context files and rebuilds the tool and skill indexes.
It does **not** restart channels unless their config changed, and it never drops in-flight
turns. Returns a diff of what changed.

### Turns

```
POST /v1/agents/:id/messages
```

```json
{
  "text": "what's on my calendar today?",
  "sessionKey": "api:moeen",
  "deliver": "none",
  "stream": true
}
```

Returns `202` with `{ turnId, sessionKey }` immediately, then streams SSE if `stream` is
true. **The turn is not bound to this connection.** Disconnecting does not cancel it.

```
GET  /v1/agents/:id/turns/:turnId/stream   → SSE, replays buffered events then tails
POST /v1/agents/:id/turns/:turnId/stop     → cooperative cancel; persists partial content
GET  /v1/agents/:id/turns/:turnId          → final state once complete
```

Reattach is core, not a convenience. Generation must survive a client refresh; partial
content is saved on explicit stop only, never on disconnect.

`deliver` accepts `"none"` (result via API only), a channel id, or `{ channel, to }`.

### Sessions

```
GET    /v1/agents/:id/sessions
GET    /v1/agents/:id/sessions/:key
GET    /v1/agents/:id/sessions/:key/messages?before=&limit=
DELETE /v1/agents/:id/sessions/:key          → clears history; keeps memory files
POST   /v1/agents/:id/sessions/:key/phase    → { phase }
```

`DELETE` clears conversation state only. Memory markdown is a file artifact and is never
deleted by an API call.

### Schedules

```
GET    /v1/agents/:id/schedules              → all, including disabled
POST   /v1/agents/:id/schedules
GET    /v1/agents/:id/schedules/:sid
PATCH  /v1/agents/:id/schedules/:sid
DELETE /v1/agents/:id/schedules/:sid
POST   /v1/agents/:id/schedules/:sid/run     → fire now, out of band
```

```json
{
  "id": "morning-brief",
  "kind": "cron",
  "expr": "0 8 * * *",
  "timezone": "Asia/Dhaka",
  "task": "Summarise today's calendar and unread email.",
  "deliver": { "channel": "tg", "to": "@moeen" },
  "session": "isolated",
  "enabled": true
}
```

Validation is at write time, not fire time. Missing delivery target:

```json
{ "error": {
  "code": "schedule_missing_delivery",
  "message": "Schedule 'morning-brief' has no delivery target.",
  "hint": "Set deliver to { channel, to }, or the literal \"none\" to return results only via the event stream.",
  "field": "deliver"
}}
```

Listing includes disabled schedules by default. `?enabled=true` filters.

### Tools and skills (introspection)

```
GET /v1/agents/:id/tools     → resolved catalogue with tags, mutating, phase visibility
GET /v1/agents/:id/skills    → indexed skills with description and last-selected time
GET /v1/agents/:id/context   → the assembled context for the next turn, with token counts per slot
```

`/context` exists because "why did it do that?" is almost always a context question, and
guessing at it is how days get lost.

### Channel webhooks

```
POST /v1/channels/:channelId/webhook/:agentId
```

Signature verification is the channel plugin's responsibility. Core enforces a body-size
cap and rate limit before the plugin sees anything.

### Runtime event stream

```
GET /v1/events?agentId=&types=   → SSE, all lifecycle events
```

Filterable. This is the observability surface — VelaOps subscribes here to populate
`sub_agent_invocations` and `tool_calls`. **Core emits; consumers persist.** Core writes no
rows it does not own.

---

## Event schema

Every event:

```ts
interface Event {
  v: 1
  ts: string          // RFC 3339
  runtimeId: string
  agentId: string
  sessionKey?: string
  turnId?: string
  stepId?: string
  type: string
  data: unknown
}
```

| Type | When | Key `data` |
| --- | --- | --- |
| `runtime.ready` | boot complete | `bootMs`, `phases: {step: ms}` |
| `store.ready` | store open, migrations done | `location`, `driver`, `from`, `to`, `applied[]`, `reaped[]` |
| `runtime.stopping` | shutdown begins | `reason` |
| `plugin.loaded` | per plugin | `name`, `version`, `setupMs`, `permissions` |
| `plugin.slow` | setup over budget | `name`, `setupMs` |
| `agent.loaded` | per agent | `tools`, `skills`, `schedules` |
| `agent.error` | load failure | `code`, `message`, `hint` |
| `agent.channel.status` | connect/disconnect | `channelId`, `status`, `detail` |
| `turn.start` | inbound accepted | `source`, `inputTokens` |
| `context.assembled` | per turn | `slots: [{slot, tokens, pinned}]`, `total` |
| `context.pressure` | per step | `used`, `window`, `fraction` |
| `compaction.stage` | ladder fires | `stage`, `before`, `after`, `dropped` |
| `context.reset` | S5 fires | `sessionKey` — warn level |
| `skill.selected` | activation | `skill`, `score` |
| `skill.none` | below threshold | `topScore` |
| `phase.changed` | transition | `from`, `to`, `by` |
| `model.call` | request sent | `role`, `model`, `promptTokens`, `cached` |
| `model.chunk` | streaming | `delta` — suppressed unless subscriber opted in |
| `model.result` | response done | `outputTokens`, `finishReason`, `latencyMs`, `costUsd?` |
| `tool.call` | before execute | `slug`, `callId`, `argsHash`, `mutating` |
| `tool.result` | after execute | `slug`, `callId`, `ok`, `latencyMs`, `bytes`, `truncated` |
| `tool.repair` | step unusable | `slugs[]`, `errors[]` |
| `handoff.start` | delegation | `to`, `task` |
| `handoff.result` | returned | `to`, `ok`, `steps`, `tokens` |
| `delivery.sent` | outbox success | `channelId`, `providerMessageId` |
| `delivery.failed` | after retries | `channelId`, `attempts`, `error` |
| `schedule.fired` | timer | `scheduleId`, `kind`, `drift Ms` |
| `turn.end` | complete | `reason`, `steps`, `tokens`, `durationMs` |
| `error` | anything uncaught | `code`, `message`, `hint`, `stack?` |

`callId` identifies a call within its step; the envelope's `stepId` makes it unique. Arguments
themselves never appear on the wire — `argsHash` is a stable hash over them, because arguments carry
whatever the conversation carried and an event stream is the wrong place to copy it to.

`tool.repair` fires whenever a step's calls cannot be used as written, which includes a slug the
model invented and a field that failed coercion. The first occurrence is followed by one correction
request; a second in a row ends the turn with `tool_repair_failed` rather than asking again, so two
of these back to back is the signal that a catalogue needs work rather than that a model does.

`turn.end.reason`: `final` \| `max_steps` \| `stopped` \| `timeout` \| `error`.
Hitting `max_steps` is reported honestly rather than dressed up as a normal completion.

### SSE framing

```
event: tool.call
data: {"v":1,"ts":"2026-08-12T09:15:04Z","agentId":"assistant","turnId":"t_01H...","type":"tool.call","data":{...}}
```

The event name mirrors `type` so `EventSource` handlers work without parsing. Heartbeat
comment every 15 s to survive proxies.

---

## WebSocket

One endpoint, for genuinely bidirectional use — an interactive client needing token
streaming plus mid-turn interrupts:

```
GET /v1/ws?agentId=&token=
```

Client frames: `{ type: "message" | "stop" | "subscribe" | "ping" }`.
Server frames: the same event objects as SSE.

Everything achievable over HTTP + SSE stays there. WS exists for interactive clients, not
as the primary API. VelaOps' web chat is the intended consumer.

---

## Design notes

**Why turn IDs are client-visible.** Reattach needs a handle. Deriving one from a session
key breaks the moment two turns overlap.

**Why `/context` exists.** Debugging an agent means inspecting what it was actually shown.
Without this, that's guesswork against a prompt you can't see.

**Why `deliver` is per-request.** A single agent serves a Telegram user, a schedule, and an
API caller. Where output goes is a property of the request, not the agent.

**Why no batch endpoint.** Fan-out is the caller's job. A batch endpoint is a queue with
extra steps, and Castellan is not a queue.

**Why no auth beyond a bearer token.** Castellan is a runtime, not a multi-tenant service.
Identity, RBAC, and per-user scoping belong to whatever embeds it — VelaOps has Better
Auth, its own session store, and per-agent `.pem` keys already. Duplicating that here would
create two sources of truth for authorisation, which is worse than none.
