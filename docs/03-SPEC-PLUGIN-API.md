# 03 — Plugin API Specification

Plugins are how Castellan varies. Core ships the loop, the context manager, the SQLite
store, and the chat-completions transport; every channel, tool provider, alternative store,
skill source, and cross-cutting behaviour arrives as a plugin — including the first-party
ones. If a first-party package needs something the plugin API can't express, the API is
wrong and gets fixed. No private back doors.

---

## The contract

```ts
import type { Plugin, PluginContext } from "@castellan/core"

export default {
  name: "telegram",
  version: "0.1.0",
  castellanApi: "^0.1",
  permissions: [
    { kind: "network", hosts: ["api.telegram.org"] },
    { kind: "env", vars: ["TELEGRAM_BOT_TOKEN"] },
  ],
  configSchema: TelegramConfig,          // zod schema, optional
  async setup(ctx) {
    ctx.defineChannel({ /* ... */ })
  },
} satisfies Plugin
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Unique within a runtime. Collision is a load failure. |
| `version` | yes | Semver. Reported in `plugin.loaded` events. |
| `castellanApi` | yes | Semver **range**. Host refuses to load on mismatch, naming both versions and the range. |
| `permissions` | no | Declarative. Advisory in v1 — recorded, surfaced, unenforced. |
| `configSchema` | no | Zod schema. Manifest `config` is validated against it before `setup` runs. |
| `setup` | yes | Runs once at boot. **Must not await network I/O.** |

### The setup contract

`setup()` registers capabilities. It does not do work.

- Budget: **200 ms**. The loader times each plugin and emits `plugin.slow` past the budget.
- No network calls. Connect in the channel's `start()`, which runs after readiness.
- No filesystem walks beyond your own package.
- Throwing fails the agent load with your plugin named. That is the correct behaviour for
  a genuine misconfiguration and the wrong behaviour for a transient failure — do not
  throw on anything you could retry later.

---

## PluginContext

```ts
interface PluginContext {
  // registration
  defineChannel(spec: ChannelSpec): void
  defineToolProvider(spec: ToolProviderSpec): void
  defineModelProvider(spec: ModelProviderSpec): void
  defineStore(spec: StoreSpec): void
  defineSkillSource(spec: SkillSourceSpec): void
  defineTools(tools: LocalTool[]): void
  use(middleware: Middleware): void

  // ambient
  readonly config: unknown          // validated against configSchema
  readonly agentId: string
  readonly paths: { workspace: string; state: string; manifest: string }
  readonly logger: Logger
  readonly events: EventBus         // subscribe only; emit is core's
  readonly brand: Brand
}
```

---

## Extension points

### Channel

```ts
interface ChannelSpec {
  type: string
  configSchema?: ZodSchema
  create(config: unknown, ctx: ChannelContext): Channel
}

interface Channel {
  readonly id: string
  readonly capabilities: ChannelCapabilities
  start(): Promise<void>
  stop(): Promise<void>
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>
  setTyping?(peerId: string, on: boolean): Promise<void>
}

interface ChannelCapabilities {
  typingIndicator: boolean
  markdown: "none" | "basic" | "full"
  attachments: boolean
  maxMessageLength: number
  edits: boolean
}
```

Inbound arrives by calling `ctx.inbound(event)`:

```ts
interface InboundEvent {
  channelId: string
  peerId: string          // stable per-user identifier
  threadId?: string
  text: string
  attachments?: Attachment[]
  providerMessageId: string
  raw: unknown            // preserved for debugging; never enters context
}
```

**Rules for channel authors:**

- `start()` may take as long as it needs. It runs after readiness, and failure is reported
  as `agent.channel.error` rather than blocking boot.
- `send()` must be idempotent given the same `idempotencyKey` — the outbox retries.
- Chunk long messages against `maxMessageLength` yourself and return the last message id.
- Never throw from an inbound handler. Report and drop.
- `allowFrom` filtering is applied by core before your handler is invoked. It is
  **inbound-only** and confers nothing on outbound delivery.

### Tool provider

```ts
interface ToolProviderSpec {
  id: string
  configSchema?: ZodSchema
  create(config: unknown, ctx: ProviderContext): ToolProvider
}

interface ToolProvider {
  resolve(slugs: string[]): Promise<ToolSpec[]>       // throws on unknown slug
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>
  search?(query: string, k: number): Promise<ToolSpec[]>
}

interface ToolSpec {
  slug: string
  description: string
  whenToUse: string
  whenNotToUse: string          // required — negative examples improve routing materially
  schema: JSONSchema
  tags: string[]                // "read" | "write" | custom; drives phases and write quota
  mutating: boolean             // counts against reserveWrite; never parallelised
}
```

**`resolve()` must throw on an unknown slug, naming it.** Silently dropping dead slugs is
the exact failure that starves write tools and produces "tool not found" at runtime instead
of at load.

`whenNotToUse` is not optional. If you have nothing to say, say what the adjacent tool is
for instead.

### Model provider

```ts
interface ModelProviderSpec {
  id: string
  create(config: unknown): ModelProvider
}
```

Core ships `chat-completions`. Implement this only for a genuinely different wire protocol
(a native Messages-API adapter, a local in-process runner). Not for a different vendor —
that's a base URL.

### Store driver

```ts
interface StoreSpec {
  id: string
  create(config: unknown): Promise<Store>
}
```

Core ships `sqlite`. A Postgres driver is the expected second implementation. The interface
lives in `store/store.ts` and is deliberately narrow — no query builder, no ORM, no
transactions spanning subsystems.

### Skill source

```ts
interface SkillSourceSpec {
  id: string
  list(): Promise<SkillMeta[]>              // frontmatter only — called at boot
  load(id: string): Promise<SkillBody>      // called on activation
}
```

`list()` runs inside the boot budget. Cache aggressively; a network-backed skill source
must serve `list()` from a local cache and refresh after readiness.

### Local tools

```ts
interface LocalTool {
  slug: string
  description: string
  whenToUse: string
  whenNotToUse: string
  schema: JSONSchema
  tags: string[]
  mutating: boolean
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}
```

In-process functions. Same catalogue, same budget, same phase rules as provider tools.

---

## Middleware

The wrapping shape, not before/after events. Wrapping permits retry, substitution, and
short-circuit; events permit only observation. Events are derived from the wrap points, so
nothing is lost by choosing wrapping.

```ts
interface Middleware {
  name: string
  wrapTurn?(ctx: TurnContext, next: () => Promise<TurnResult>): Promise<TurnResult>
  wrapContext?(ctx: ContextContext, next: () => Promise<ContextBlock[]>): Promise<ContextBlock[]>
  wrapModelCall?(ctx: ModelCallContext, next: () => Promise<ModelResult>): Promise<ModelResult>
  wrapToolCall?(ctx: ToolCallContext, next: () => Promise<ToolResult>): Promise<ToolResult>
  onEvent?(event: Event): void
}
```

Composition is manifest order, outermost first. Given plugins `[a, b]`:

```
a.wrapTurn( b.wrapTurn( core.turn ) )
```

### What middleware is for

| Use | Hook |
| --- | --- |
| Redact PII before it reaches the model | `wrapContext` |
| Retry on 429 with backoff | `wrapModelCall` |
| Swap to a fallback model on failure | `wrapModelCall` |
| Require approval for mutating tools | `wrapToolCall` |
| Per-tenant rate limiting | `wrapTurn` |
| Cost accounting | `wrapModelCall` + `onEvent` |
| Export traces to OTel | `onEvent` |

### Rules

1. **Always call `next()`** unless deliberately short-circuiting, and when short-circuiting
   return a well-formed result — never `undefined`.
2. **Never mutate the context argument.** Return a new array from `wrapContext`.
3. Respect `ctx.signal`. A middleware that ignores cancellation makes stop unreliable.
4. Errors propagate. Do not swallow. If you handle an error, return a valid result and
   record why.
5. `onEvent` is fire-and-forget, must not throw, and must not block. Anything slow goes on
   a queue you own.

### Short-circuit example

```ts
const approvals: Middleware = {
  name: "approvals",
  async wrapToolCall(ctx, next) {
    if (!ctx.tool.mutating) return next()
    const ok = await requestApproval(ctx.tool.slug, ctx.args)
    if (!ok) {
      return {
        ok: false,
        error: { code: "denied_by_policy", message: "Operator denied this action." },
      }
    }
    return next()
  },
}
```

The denial returns a well-formed `ToolResult`, so the agent sees an honest observation and
can adapt, rather than an exception that kills the turn.

---

## Permissions vocabulary

Declarative in v1. Recorded at load, surfaced by `castellan plugins` and in the
`plugin.loaded` event. Not enforced.

```ts
type Permission =
  | { kind: "network"; hosts: string[] }
  | { kind: "env"; vars: string[] }
  | { kind: "fs"; paths: string[]; mode: "read" | "write" }
  | { kind: "exec"; commands: string[] }
  | { kind: "store"; tables: string[] }
```

Shipping the vocabulary now means enforcement later is not a breaking change. Plugin
authors who declare accurately today get grandfathered; those who don't will have to
scramble. That trade is stated in the README.

**The honest position, printed in the README verbatim:**

> Castellan plugins run in-process with full privileges. The `permissions` block is
> documentation, not a sandbox. Install plugins you trust, the same way you treat any npm
> dependency. Real isolation requires separate processes or V8 isolates, both of which cost
> the startup time and simplicity this project exists to preserve. If you need to run
> untrusted plugin code, run the whole agent in a container and treat that as the boundary.

---

## Authoring checklist

- [ ] `castellanApi` range is accurate and narrow
- [ ] `setup()` does no network I/O and returns under 200 ms
- [ ] `configSchema` covers every field, secrets referenced by env var name
- [ ] Every tool declares `whenNotToUse`
- [ ] `resolve()` throws on unknown slugs
- [ ] `send()` is idempotent
- [ ] Middleware calls `next()` and respects `ctx.signal`
- [ ] `onEvent` never throws and never blocks
- [ ] Permissions declared honestly
- [ ] `bun test` passes against `@castellan/core`'s plugin conformance suite

Core ships `@castellan/core/testing` with `conformance(plugin)` — a suite asserting boot
budget, version gating, config validation, and, for channels, idempotent send. Every
first-party plugin runs it in CI.
