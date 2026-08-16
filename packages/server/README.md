# @castellan/server

The HTTP, SSE and WebSocket surface described in `docs/04-SPEC-WIRE.md`. Framework-free.

```ts
import { serve } from "@castellan/server"

const running = await serve({ runtime, host: "127.0.0.1", port: 7420, token })
console.log(running.url)
```

Or mount it inside something you already run — `createHandler` is a plain function:

```ts
import { createHandler } from "@castellan/server"

const handler = createHandler({ runtime, token })
const response = await handler(new Request("http://x/v1/health"))
```

That shape is the point. Every route is testable by constructing a `Request` and asserting on a
`Response`, so the only tests that open a port are the ones about ports.

From the CLI:

```bash
castellan serve ./agent.yaml            # reads the manifest's server block
castellan serve ./agent.yaml --port 8080 --host 0.0.0.0
```

## Authentication

`Authorization: Bearer <token>`, from the variable named by `server.tokenEnv`.

- `GET /v1/health` is open — a load balancer probing it cannot hold your token.
- `POST /v1/channels/:channelId/webhook/:agentId` is open — the provider does not have it either.
  Verification is the channel transport's, because only it knows what its provider signs.
- **A non-loopback bind with no token refuses to start.** An agent with shell access on `0.0.0.0`
  behaves identically to a safe one right up until someone finds it, and bind time is the one moment
  the person who made the choice is present to see the refusal.

## Streaming

SSE frames name their event so `EventSource` can dispatch without parsing, with a comment heartbeat
every 15 seconds to survive proxy idle timeouts. `Bun.serve`'s own `idleTimeout` is derived from
that heartbeat rather than left at its 10-second default, which was closing streams before the first
keep-alive frame.

**A turn is not bound to the connection that started it.** Disconnecting unsubscribes a listener;
only `POST /v1/agents/:id/turns/:turnId/stop` ends a turn early, and partial content is persisted
then and never on disconnect. Reattaching replays the turn's buffered events and then tails.

## Known divergences from the spec

| Endpoint | Behaviour | Why |
| --- | --- | --- |
| `POST /v1/agents/:id/reload` | `501` | An agent's catalogue resolves once and the cached prompt prefix depends on it staying fixed. Restart instead. Decision 11.20. |
| `GET /v1/ws` | `501` under Node | Bun has an upgrade path; Node needs a dependency for an endpoint the spec itself calls secondary. Decision 11.21. |
| `GET /v1/agents/:id/skills` | `{ skills: [], supported: false }` | Skills are Phase 5. A bare empty array cannot be told apart from "this agent has no skills". |
| `/v1/agents/:id/schedules*` | absent | Phase 8. |
