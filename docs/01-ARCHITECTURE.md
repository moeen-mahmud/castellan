# 01 — Architecture

## What Castellan is

A runtime layer that turns a stateless chat-completions endpoint into an agent that lives
in messaging channels, uses tools, remembers, and runs on a schedule.

The formal scope fence — an agent harness is a runtime layer with four necessary and
sufficient elements:

1. **An agent loop**
2. **A tool interface**
3. **Context management**
4. **Control mechanisms**

Anything outside those four is a plugin, not core. Use this every time scope creep argues
with you.

## What Castellan is not

Not an orchestration graph. Not a workflow engine. Not a RAG pipeline. Not a vector
database. Not a browser automator. Not a model gateway. Not a provisioning platform —
that's VelaOps, and the boundary is enforced in `06-VELAOPS-INTEGRATION.md`.

---

## Repository layout

Directory names contain no brand string, so a rename touches `brand.ts` and `package.json`
only.

```
castellan/
├── package.json                 # bun workspaces root
├── bunfig.toml
├── biome.json
├── tsconfig.base.json
├── CLAUDE.md                    # standing brief for coding agents
├── docs/
├── packages/
│   ├── core/                    @castellan/core
│   ├── cli/                     @castellan/cli          bin: castellan
│   ├── server/                  @castellan/server
│   ├── channel-telegram/        @castellan/channel-telegram
│   ├── channel-whatsapp/        @castellan/channel-whatsapp   (Baileys)
│   ├── tools-composio/          @castellan/tools-composio
│   ├── tools-mcp/               @castellan/tools-mcp
│   └── compat-openclaw/         @castellan/compat-openclaw
├── examples/
│   ├── minimal/                 # library usage, no channels
│   └── telegram-assistant/      # full agent.yaml
├── docker/
│   └── Dockerfile
└── scripts/
    ├── bench-boot.ts
    └── rename-brand.ts
```

### Dependency rule

`core` depends on **nothing outside the standard library plus a YAML parser and a schema
validator**. Everything else — Composio, Baileys, MCP, Telegram — lives in a package that
depends on core, never the reverse. CI enforces this with a dependency check; a PR adding
an import to core from any sibling package fails.

---

## Core module map

```
packages/core/src/
├── brand.ts                 # the only file containing the product name
├── manifest/
│   ├── schema.ts            # zod schema for agent.yaml
│   ├── load.ts              # read + resolve refs + env expansion
│   └── validate.ts          # cross-field validation, loud failures
├── runtime/
│   ├── runtime.ts           # hosts N agents in one process
│   ├── agent.ts             # a single agent instance
│   └── lifecycle.ts         # boot sequence, readiness, shutdown
├── loop/
│   ├── turn.ts              # one inbound message → final reply
│   ├── step.ts              # one model call + tool executions
│   └── phases.ts            # phase-scoped tool visibility
├── context/
│   ├── assemble.ts          # ordered, budgeted block assembly
│   ├── budget.ts            # token accounting + pressure signal
│   ├── blocks.ts            # ContextBlock types, pin flags
│   └── compaction/
│       ├── ladder.ts        # stage selection
│       └── stages.ts        # S1..S5 implementations
├── model/
│   ├── provider.ts          # ModelProvider interface
│   ├── chat-completions.ts  # the one transport (fetch + SSE)
│   ├── capabilities.ts      # shipped registry + override merge
│   └── roles.ts             # main / selector / compactor resolution
├── tools/
│   ├── registry.ts          # pinned manifest, slug validation, budget
│   ├── dialect/
│   │   ├── dialect.ts       # ToolDialect interface
│   │   ├── nlt.ts           # default
│   │   └── native.ts        # opt-in
│   ├── coerce.ts            # text → schema, with repair
│   └── execute.ts           # parallelism, timeouts, error surfaces
├── skills/
│   ├── index.ts             # frontmatter scan + cached index
│   ├── select.ts            # BM25 over descriptions, harness-side
│   ├── load.ts              # body + script registration
│   └── scripts.ts           # subprocess execution (the Python surface)
├── memory/
│   ├── retriever.ts         # Retriever interface
│   ├── fts5.ts              # the shipped implementation
│   └── writer.ts            # memory_write tool → dated markdown
├── store/
│   ├── store.ts             # Store interface
│   └── sqlite/
│       ├── driver.ts        # bun:sqlite | node:sqlite adapter
│       └── migrations/      # numbered SQL, PRAGMA user_version
├── schedule/
│   ├── scheduler.ts         # single timer, nearest-due
│   └── kinds.ts             # cron | every | at
├── channels/
│   ├── channel.ts           # Channel interface
│   ├── inbox.ts             # inbound normalisation + routing
│   └── outbox.ts            # idempotent delivery + retry
├── plugins/
│   ├── plugin.ts            # Plugin + PluginContext
│   ├── loader.ts            # boot-time resolution, version gate
│   ├── middleware.ts        # composition
│   └── permissions.ts       # declarative vocabulary (advisory in v1)
├── team/
│   ├── handoff.ts           # typed envelope + artifact validation
│   └── supervisor.ts
├── events/
│   ├── bus.ts
│   └── types.ts             # the event schema (see 04-SPEC-WIRE.md)
└── errors.ts                # typed errors, every one with a fix hint
```

---

## Concepts

| Term | Meaning |
| --- | --- |
| **Runtime** | One process. Hosts N agents. Owns the timer, the event bus, the store. |
| **Agent** | A manifest plus its resolved plugins, tools, skills, and channels. |
| **Session** | A conversation thread, keyed `{channel}:{peerId}[:{thread}]` or an explicit key. |
| **Turn** | One inbound input → one delivered reply. Contains 1..N steps. Has an ID; reattachable. |
| **Step** | One model call plus the tool executions it triggered. |
| **Phase** | A named state carrying a tool allowlist. Default is a single phase. |
| **Skill** | An agentskills.io folder: SKILL.md plus optional scripts and resources. |
| **Plugin** | A module registering channels, providers, stores, skill sources, or middleware. |
| **Artifact** | Any large blob (tool output, file) stored outside context, referenced by pointer. |

---

## The agent loop

```
inbound event
  │
  ├─ resolve agent + session               (store)
  ├─ resolve phase                         (persisted per session)
  ├─ turn.start
  │
  ├─ ASSEMBLE CONTEXT ────────────────────── wrapContext middleware
  │
  ├─ STEP LOOP (until final, or maxSteps)
  │    ├─ model call ────────────────────── wrapModelCall middleware
  │    ├─ dialect.parse(output)
  │    │     ├─ no intents  → final answer, exit loop
  │    │     └─ intents     → continue
  │    ├─ validate + coerce intents against schemas
  │    │     └─ on failure  → one repair step with exact field errors
  │    ├─ execute tools ─────────────────── wrapToolCall middleware
  │    │     (parallel for readOnly, serial otherwise)
  │    ├─ append observations
  │    └─ compaction check → ladder if over threshold
  │
  ├─ deliver via outbox                     (idempotent)
  ├─ persist messages + tool_calls
  └─ turn.end
```

The whole turn is wrapped by `wrapTurn`. Everything is cancellable via `AbortSignal`;
cancellation is a first-class state, not an exception.

**Generation is detached from the client connection.** The turn runs to completion whether
or not anyone is listening. Clients attach and reattach to `GET /v1/agents/:id/turns/:turnId/stream`.
Partial content is persisted only on an explicit stop, never on disconnect.

---

## Context assembly

Fixed order. The prefix must be byte-stable across turns or prompt caching stops working,
and prompt caching is the largest available cost lever.

```
slot  content                                    pinned  cache
────  ─────────────────────────────────────────  ──────  ─────
 0    system: identity (manifest.context files)    yes     ┐ breakpoint A
 1    tool dialect preamble + tool catalogue       yes     ┘
 2    active skill body (0 or 1)                   no      ─ breakpoint B
 3    retrieved memory passages (k)                no
 4    rolling digest (compaction output)           no
 5    recent message window                        no
 6    current input + current task line            yes
 7    last error, if any                           yes
```

Pinned blocks survive every compaction stage. This is why anything that must always hold —
identity, guardrails, the tool catalogue — lives in slots 0/1 and never in history.
Compaction reliably eats initial instructions; the fix is structural placement, not a
stronger prompt.

### Budget

`budget.ts` tracks consumed tokens using the API-reported `prompt_tokens` from the previous
call as the calibration anchor, with a local estimator between calls. The estimator is
allowed to be approximate; the anchor corrects drift each turn.

Configured as fractions of the model's window:

```yaml
context:
  window: 32768          # or inferred from capabilities
  reserveOutput: 4096
  observationMaxTokens: 2000
  thresholds: { trim: 0.60, snip: 0.70, micro: 0.80, collapse: 0.88, reset: 0.95 }
```

---

## Compaction ladder

Progressive, five stages, each strictly more aggressive. Never a single lossy summarise-at-95%.

| Stage | Trigger | Action | Loss |
| --- | --- | --- | --- |
| **S0 observe** | every step | record usage, emit `context.pressure` | none |
| **S1 trim** | 0.60 | any single observation over `observationMaxTokens` → head+tail excerpt, full body written to `.castellan/artifacts/<id>`, replaced by a pointer the agent can re-read | recoverable |
| **S2 snip** | 0.70 | drop superseded observations — same `tool + argsHash`, keep only the latest | low |
| **S3 micro** | 0.80 | summarise the oldest N turn-pairs into a digest delta using the `compactor` model | moderate |
| **S4 collapse** | 0.88 | replace all but the last K turns with the digest plus pinned blocks | high |
| **S5 reset** | 0.95 | pinned blocks plus digest only; emit `context.reset` at warn level | severe |

Every stage emits `compaction.stage` with before/after token counts. If S5 fires more than
once per session, that's a manifest misconfiguration and the event says so.

---

## Tool layer

### Resolution

Tools are resolved **at agent load**, not per turn:

1. Read `tools.pinned` from the manifest.
2. Ask the provider to resolve each slug to a schema.
3. **Fail loudly on any unknown slug.** Never silently drop.
4. Enforce `budget.max` (default 24) with `budget.reserveWrite` (default 6) held for
   tools annotated as mutating.
5. Cache resolved schemas to `.castellan/tools.cache.json`; refresh asynchronously after ready.

### Phases

```yaml
phases:
  default: { allow: ["*"] }
  triage:  { allow: ["tag:read"] }
  act:     { allow: ["tag:read", "tag:write"] }
```

Only tools visible in the current phase enter the catalogue block. Transition via the
built-in `phase_set` tool, exposed only when more than one phase is declared. This is the
single highest-leverage knob for small-model reliability.

### Dialects

```ts
interface ToolDialect {
  id: "nlt" | "native"
  renderCatalogue(tools: ToolSpec[]): ContextBlock[]
  parse(output: ModelOutput): { intents: ToolIntent[]; text: string }
  renderObservation(result: ToolResult): Message
  renderRepair(errors: FieldError[]): Message
}
```

**NLT** is the default. The catalogue renders as prose, not JSON schema:

```
### send_email
Sends an email from the owner's connected mailbox.
Use when: the user asks you to email or reply to someone.
Do NOT use when: the user only wants a draft, or has not named a recipient.
Fields:
  to       (required) recipient address
  subject  (required)
  body     (required) plain text
```

The `Do NOT use when` line is required by the skill/tool template — negative examples are
the cheapest available routing-accuracy improvement.

Invocation format is line-oriented, which small models produce far more reliably than
nested JSON:

```
ACTION: send_email
to: moeen@example.com
subject: Weekly report
body: <<<
Numbers are attached.
Second line.
>>>
END
```

Multiple `ACTION` blocks per output are permitted. Text outside blocks is the reply.

The parser is deliberately tolerant — case-insensitive keys, whitespace trimmed, bullet
prefixes accepted — then coerces to the JSON Schema (string → number/boolean/array) and
validates. On validation failure it emits **one** repair step quoting exact field errors,
then gives up and surfaces an honest error rather than looping.

**native** uses the provider's `tools` parameter and `tool_calls` response. Opt-in only.
Note that Anthropic's compat endpoint ignores `strict`, so schema conformance is not
guaranteed there even in native mode — the coercion layer runs regardless.

---

## Model layer

```ts
interface ModelProvider {
  id: string
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>
}
```

One implementation: `chat-completions.ts`. Hand-rolled `fetch`, manual SSE parsing, no SDK,
no gateway.

### Capabilities

A shipped registry keyed by model-id glob, merged with any manifest override:

```ts
interface ModelCapabilities {
  nativeTools: boolean
  strictSchema: boolean
  thinking: "none" | "anthropic" | "openai" | "deepseek"
  promptCache: "none" | "anthropic" | "openai"
  parallelToolCalls: boolean
  contextWindow: number
  maxOutput: number
}
```

Capabilities affect **only** thinking-block replay and cache-breakpoint placement. They
never change the tool dialect — that is config, so behaviour cannot drift when the model
changes.

Thinking-block handling matters, and it is not uniform. With `thinking: "anthropic"` the blocks
must be replayed alongside tool results or multi-step reasoning silently degrades. With
`thinking: "deepseek"` reasoning arrives as `reasoning_content` beside `content` and is **not**
replayed — sending it back is accepted and confers nothing. `openai` reasoning is opaque and
server-side. The loop follows the capability rather than a single rule, which is why this is a
four-valued field and not a boolean.

A `deepseek` model also bills reasoning tokens to the **output** budget, so an allowance that
does not cover the thinking returns empty content with `finish_reason: "length"`. The loop
treats that as a failed turn — code `empty_reply_output_exhausted`, naming
`context.reserveOutput` — because an empty reply reported as success is the precise shape of
failure the error philosophy below exists to prevent.

### Roles

`main`, `selector`, `compactor`. Selector and compactor fall back to main. Pointing
selector and compactor at a cheap 3B model while main is a larger one is the intended
production configuration and typically the largest cost win available.

---

## Storage

```ts
interface Store {
  sessions: SessionStore     // Phase 2
  messages: MessageStore     // Phase 2
  turns: TurnStore           // Phase 2
  kv: KVStore                // Phase 2
  toolCalls: ToolCallStore   // Phase 3
  artifacts: ArtifactStore   // Phase 7
  schedules: ScheduleStore   // Phase 8
  location: string
  close(): Promise<void>
}
```

Sub-stores land with their subsystems rather than as stubs. An empty implementation is
indistinguishable from a working one at the type level, which is exactly how a later phase
ships a silent no-op.

**Every method is async** even though SQLite is synchronous. The driver returns resolved
promises and pays an allocation per call; that buys the ability to add the deferred Postgres
driver as a new file rather than as a rewrite of every call site.

Default driver is SQLite. `sqlite/driver.ts` picks `bun:sqlite` or `node:sqlite` — the only
runtime-conditional code in the tree. Migrations are numbered, inline, and gated on
`PRAGMA user_version`; each runs in its own transaction that also bumps the counter, so a
crash leaves the schema at the last fully-applied version rather than halfway through one.

The two bindings differ in six ways that all produce the same class of bug — green under one
runner, wrong under the other. The adapter normalises all six rather than passing them
through, and `PRAGMA foreign_keys` is the one that matters most: **off** by default in
`bun:sqlite` and **on** in `node:sqlite`, so `ON DELETE CASCADE` would silently do nothing
under Bun. The same test suite runs under `bun test` and `node --test` because that is the
only thing that actually demonstrates the adapter works.

**Persistence is opt-in.** `Runtime` defaults to `:memory:`; the CLI passes a file path.
A library that creates a directory in the caller's working directory as a side effect of
construction is badly behaved, and `store.ready` reports `location` either way so which one
is in use is observable rather than assumed. The database location is a `Runtime` option, not
a manifest field — one process hosts N agents from N manifests but has exactly one store.

**Canonicality split:**

- **Files**: manifest, context markdown, skills, memory markdown, artifacts
- **SQLite**: sessions, messages, turns, tool_calls, schedules, phase state, kv, outbox

**Turn durability.** The turn row is written `running` *before* the first model call, so a
turn is durable from the moment it starts rather than the moment it finishes — which is what
lets a crash be distinguished from a turn that never began. A process that dies mid-generation
leaves the row `running`; the next boot marks those `error` with code `turn_abandoned` and
reports them on `store.ready` rather than fixing them quietly. Nothing resumes them: the model
stream that was being read is gone.

A turn record is the audit trail and records every outcome including failures and their hints.
The message history is the conversation, and gets nothing on a failed turn — a half-answer left
in history is a half-answer the next turn is conditioned on. An explicit stop is different: it
persists the partial content, because someone decided to stop it.

---

## Memory

```ts
interface Retriever {
  search(query: string, opts: { k: number; filters?: Filters }): Promise<Passage[]>
  index(doc: MemoryDoc): Promise<void>
}
```

Shipped implementation is SQLite FTS5 over memory markdown plus message history, ranked by
BM25 with a recency boost. The index is maintained incrementally on write and rebuilt when
directory mtime disagrees with the cache.

The agent writes memory through a built-in `memory_write` tool that appends to
`memory/YYYY-MM-DD.md`. The agent is the author; the harness is the librarian.

---

## Skills

**Boot**: read frontmatter only (`name`, `description`, `when_not_to_use`), build an index,
cache to `.castellan/skills.idx.json` keyed by directory mtime and size. Bodies are never
read at boot.

**Selection**: harness-side BM25 over `name + description + when_not_to_use` against the
turn input and the previous assistant turn. Score threshold; at most one active skill per
turn by default (`skills.maxActive`).

**Injection**: the full SKILL.md body enters context slot 2.

**Scripts**: a skill may ship `scripts/`. Those register as tools named
`skill.<skill>.<script>`, visible **only while the skill is active**. Executed via
subprocess:

- `pyproject.toml` or `requirements.txt` present → `uv run <script>`
- else `.py` → `python3 <script>`
- else `.ts`/`.js` → the host runtime
- else executable bit → direct exec

If a skill declares a Python script and no Python runtime exists, the skill **fails at
load** with a named error. It does not fail silently at use time.

---

## Multi-agent

One supervisor, typed handoffs, no free-form chat.

```ts
interface HandoffRequest {
  to: string
  task: string
  inputs: Record<string, unknown>
  expect: JSONSchema
  budget: { maxSteps: number; maxTokens: number }
}
```

The sub-agent runs in an isolated session with its own context budget and phase set, and
returns an artifact validated against `expect`. **The parent sees the artifact, never the
sub-agent's transcript** — context isolation is the entire point and is why subagents cost
substantially fewer tokens than the equivalent in-context skill in multi-domain work.

Handoff failure is a typed result, not an exception. The supervisor decides whether to
retry, reassign, or surface it.

---

## Boot sequence and budget

**Target: process start → `runtime.ready` in under 1000 ms.** CI fails a PR above 1200 ms.
Measured for one agent, three plugins, twenty skills, on 2 vCPU.

```
1. parse argv / read env                            ~0ms
2. read + validate manifest (zod)                   <10ms
3. open SQLite, run pending migrations              <20ms
4. import plugins, run setup()                      <200ms budget, warned per plugin
5. load skill index from cache (mtime check)        <10ms
6. load tool schemas from cache                     <10ms
7. register channels (construct only, no connect)   <5ms
8. emit runtime.ready ────────────────────────────── READY
9. (async) channels connect, status via events
10.(async) tool schema refresh, skill index rebuild
```

**Hard rules:**

- **No network I/O before step 8.** This is the single rule that separates Castellan from
  OpenClaw, whose gateway blocks roughly four minutes on hook handlers making network calls
  during initialisation.
- No filesystem walk deeper than the skills directory, and only frontmatter is read.
- No plugin may `await` a network call in `setup()`. The loader times each one and warns
  past 200 ms.
- Channel connection failure does not block readiness. It is reported as `agent.channel.error`.

`scripts/bench-boot.ts` runs in CI and prints the breakdown per step, so a regression names
its own cause.

---

## Error philosophy

Every error in `errors.ts` is typed and carries a `hint` field naming the likely fix.
Modelled directly on the VelaOps gotcha corpus, where the expensive part was almost never
the failure — it was that the failure didn't say what was wrong.

Specifically:

- Config validation failures name the **field path** and the **expected shape**.
- Unknown tool slugs name the slug and the provider that rejected it.
- Plugin version mismatch names both versions and the required range.
- A skill with a missing runtime names the runtime and the skill.
- Nothing fails silently and exits 0. Ever.
