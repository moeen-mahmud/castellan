# 05 — Implementation Plan

Thirteen phases, dependency-ordered. Every phase ends at a **running state** — nothing is
half-wired across a boundary.

## How to use this

One phase per session. Give a coding agent `CLAUDE.md` plus this file and say
"implement Phase N". It reads Goal → Deliverables → Files → Non-goals, implements, then
stops at the acceptance criteria and reports.

**Do not start Phase N+1 until Phase N's criteria pass.** Several subsystems here are only
testable end-to-end, and skipping ahead produces a state where nothing can be isolated.

Non-goals are binding. A phase that quietly implements the next one's work destroys the
ability to review it.

---

## Phase 0 — Scaffold

**Goal.** An empty monorepo that builds, lints, tests, and refuses bad commits.

**Deliverables**
- Bun workspace root; `packages/core` with a stub export
- `biome.json`, `tsconfig.base.json`, strict TS, no `any`
- `bun test` wired; one trivial passing test
- GitHub Actions: typecheck, lint, test, on push and PR
- `brand.ts` with `BRAND` constant and env override
- `scripts/rename-brand.ts`
- CI dependency check: `packages/core` may not import any sibling package
- Apache-2.0 `LICENSE`, `README.md`, `CLAUDE.md`
- Changesets configured

**Files.** Root config, `packages/core/src/{index,brand}.ts`, `.github/workflows/ci.yml`, `scripts/`

**Acceptance**
- [x] `bun install && bun run build && bun test && bun run lint` clean
- [ ] CI green — workflow written; requires a push to verify
- [x] `bun scripts/rename-brand.ts foo` renames throughout; `git diff` touches only `brand.ts` and `package.json` files
- [x] Adding `import "@castellan/cli"` to core fails CI

**Non-goals.** Any runtime behaviour.

---

## Phase 1 — Manifest, loop, model, CLI

**Goal.** `castellan run agent.yaml` gives a working REPL against any OpenAI-compatible
endpoint. No tools, no channels, no storage.

**Deliverables**
- `manifest/schema.ts` — full zod schema per `02-SPEC-MANIFEST.md`
- `manifest/load.ts` — YAML, `$ref`, `${ENV}` expansion, `.env`
- `manifest/validate.ts` — validation rules 1–4, 10–11, each with field path and hint
- `model/chat-completions.ts` — fetch + SSE, streaming, cancellation, retry on 429/5xx
- `model/capabilities.ts` — shipped registry, glob keys, manifest merge
- `model/roles.ts` — main/selector/compactor with fallback
- `context/assemble.ts` — slots 0, 5, 6 only; token estimator
- `loop/turn.ts`, `loop/step.ts` — single step, no tools; abort support
- `events/bus.ts` + types for turn/model events
- `runtime/runtime.ts` — hosts N agents, boot sequence, `runtime.ready`
- `packages/cli` — `castellan run <manifest>` interactive REPL, `castellan validate <manifest>`

**Files.** `packages/core/src/{manifest,model,context,loop,events,runtime}/`, `packages/cli/`

**Acceptance**
- [ ] `castellan run examples/minimal/agent.yaml` reaches a prompt and answers, streaming tokens
- [ ] Works against **three** endpoints unchanged: OpenAI, an Anthropic-compat base URL, and a local Ollama
- [ ] `castellan validate` on a manifest with a literal API key fails naming the field
- [ ] Missing `${ENV}` fails at load naming the variable — not later as an auth error
- [ ] Ctrl-C mid-stream cancels within 100 ms, no unhandled rejection
- [ ] Unit tests: manifest validation (≥15 cases), SSE parsing incl. split frames and `[DONE]`, capability merge
- [ ] `runtime.ready` emitted with `bootMs`

**Non-goals.** Tools, storage, channels, skills, memory, compaction.

---

## Phase 2 — Store and sessions

**Goal.** Conversations persist. Turns are detached and reattachable.

**Deliverables**
- `store/store.ts` interface
- `store/sqlite/driver.ts` — `bun:sqlite` / `node:sqlite` adapter, the only conditional in the tree
- Migrations 001: `sessions`, `messages`, `turns`, `kv`
- Session resolution `{channel}:{peerId}[:{thread}]` and explicit keys
- Turn records with status: `running` | `final` | `stopped` | `error`
- In-memory buffer per running turn, replayable on attach
- `castellan sessions` CLI

**Files.** `packages/core/src/store/`, `loop/turn.ts` (persistence), `packages/cli/`

**Acceptance**
- [ ] REPL restarts, history intact
- [ ] Migrations idempotent; second boot runs none
- [ ] Killing the client mid-turn does not cancel it; turn reaches `final` in the DB
- [ ] Reattaching replays buffered events then tails live
- [ ] Explicit stop persists partial content; disconnect does not
- [ ] Same test suite passes under `bun test` and `node --test`, proving the adapter
- [ ] Boot with 1000 existing sessions still under 1000 ms

**Non-goals.** Postgres. Outbox (Phase 4).

---

## Phase 3 — Tools and the NLT dialect

**Goal.** The agent uses tools. NLT is the default and demonstrably works on a small model.

**Deliverables**
- `tools/registry.ts` — resolution, budget with `reserveWrite`, loud failure on unknown slug
- `tools/dialect/dialect.ts`, `nlt.ts`, `native.ts`
- NLT catalogue renderer (prose, mandatory `whenNotToUse`)
- NLT parser: `ACTION:` blocks, `<<< >>>` heredoc, tolerant key matching
- `tools/coerce.ts` — text → JSON Schema coercion, one repair step, then honest failure
- `tools/execute.ts` — parallel read-only, serial mutating, timeouts, error surfaces
- Local tools: `now`, `memory_write` stub
- `packages/tools-composio` — direct SDK/HTTP, **no MCP**
- Context slot 1; cache breakpoint A
- Eval harness: `scripts/eval-tools.ts`, ≥30 fixture tasks

**Files.** `packages/core/src/tools/`, `packages/tools-composio/`, `scripts/eval-tools.ts`

**Acceptance**
- [ ] Agent completes a two-tool task end to end on an 8B-class model
- [ ] Eval suite: NLT vs native on the same fixtures, ≥3 models, results committed to `evals/`
- [ ] NLT ≥ native on the smallest model tested — if not, stop and investigate before proceeding
- [ ] Unknown pinned slug fails **at load**, naming slug and provider
- [ ] Budget honoured; a manifest pinning 40 tools fails naming the cap
- [ ] Write reservation holds: 20 read + 6 write pinned yields ≥6 write tools in the catalogue
- [ ] Malformed model output triggers exactly one repair, then an honest `tool.repair` failure — no loop
- [ ] Parser unit tests ≥25 cases: multi-block, missing END, wrong case, bullets, embedded `>>>`
- [ ] Composio path uses zero MCP transport — grep proves it

**Non-goals.** Tool search. Phases. MCP provider.

---

## Phase 4 — Channels, server, outbox

**Goal.** Telegram works. The HTTP API works. Delivery is idempotent.

**Deliverables**
- `channels/channel.ts`, `inbox.ts` (normalisation, `allowFrom`), `outbox.ts`
- Migration 002: `outbox` with idempotency keys, retry, backoff
- `packages/channel-telegram` — raw Bot API, long-poll and webhook, chunking at 4096, typing indicator
- `packages/server` — every endpoint in `04-SPEC-WIRE.md` except schedules
- SSE with heartbeat; WS endpoint
- `castellan serve`

**Files.** `packages/core/src/channels/`, `packages/channel-telegram/`, `packages/server/`

**Acceptance**
- [ ] Real Telegram bot: message in, agent replies, typing indicator shows
- [ ] Both long-poll and webhook modes verified
- [ ] Message over 4096 chars chunks correctly, order preserved
- [ ] Killing the process mid-delivery and restarting sends **exactly once**
- [ ] `allowFrom` blocks a non-listed sender inbound but does not affect outbound
- [ ] Bad bot token → `agent.channel.error`, `runtime.ready` still fires, `/v1/health` 200
- [ ] `POST /v1/agents/:id/messages` → 202, SSE streams, disconnect does not cancel
- [ ] Non-loopback host without a token refuses to start
- [ ] Boot budget still met with channels configured

**Non-goals.** WhatsApp. Schedules.

---

## Phase 5 — Skills

**Goal.** agentskills.io-compliant skills, harness-side selection, script execution.

**Deliverables**
- `skills/index.ts` — frontmatter-only scan, `.castellan/skills.idx.json` cache with mtime check
- `skills/select.ts` — BM25 over name + description + `when_not_to_use`, threshold, `maxActive`
- `skills/load.ts` — body into slot 2, cache breakpoint B
- `skills/scripts.ts` — subprocess; `uv run` when Python metadata present, else `python3`; TS/JS via host; loud failure on missing runtime
- Scripts registered as `skill.<skill>.<script>`, visible only while active
- Skill template with mandatory `when_not_to_use`
- `castellan skills list|show|validate`
- 3 example skills, one shipping a Python script

**Files.** `packages/core/src/skills/`, `examples/*/skills/`, `packages/cli/`

**Acceptance**
- [ ] 50 skills index in under 50 ms cold, under 5 ms cached
- [ ] Selection picks the right skill on ≥20 fixture inputs; below-threshold inputs select none
- [ ] Active skill's scripts appear in the catalogue; inactive ones do not
- [ ] Python script skill runs end to end with `uv`
- [ ] Skill declaring Python with no runtime fails **at load**, naming both
- [ ] Adding a skill file and reloading picks it up without restart
- [ ] `castellan skills validate` rejects missing `description` or `when_not_to_use`
- [ ] Boot budget met with 50 skills

**Non-goals.** Remote skill sources. Skill authoring UI.

---

## Phase 6 — Memory

**Goal.** The agent remembers across sessions without an embedding model.

**Deliverables**
- `memory/retriever.ts` interface
- `memory/fts5.ts` — FTS5 over memory markdown + message history, BM25 with recency boost
- `memory/writer.ts` — real `memory_write` appending to `memory/YYYY-MM-DD.md`
- Incremental index on write; rebuild on mtime mismatch
- Context slot 3
- `castellan memory search|rebuild`

**Files.** `packages/core/src/memory/`, migration 003

**Acceptance**
- [ ] Fact stated in session A is recalled in session B
- [ ] `memory_write` produces valid dated markdown, human-readable and diffable
- [ ] Index rebuild after external file edit
- [ ] Retrieval under 20 ms over 5000 passages
- [ ] Deleting a session leaves memory files untouched
- [ ] Boot budget met with a 5000-passage index
- [ ] Zero Python, zero model weights, zero network in the memory path

**Non-goals.** Vectors. Reranking. Knowledge graphs.

---

## Phase 7 — Budget, compaction, phases

**Goal.** Long sessions degrade gracefully. Phase-scoped tools work.

**Deliverables**
- `context/budget.ts` — `prompt_tokens` anchor + local estimator
- `context/compaction/ladder.ts` + `stages.ts` — S1–S5
- Artifact store for trimmed observations; pointer format the agent can re-read
- `loop/phases.ts` + `phase_set` local tool
- `GET /v1/agents/:id/context`
- Events: `context.pressure`, `compaction.stage`, `context.reset`, `phase.changed`

**Files.** `packages/core/src/context/`, `loop/phases.ts`, migration 004

**Acceptance**
- [ ] 200-turn synthetic session never exceeds the window and never hard-fails
- [ ] Each stage fires at its threshold in order; `compaction.stage` reports before/after
- [ ] Pinned blocks survive every stage including S5
- [ ] Trimmed observation retrievable via its artifact pointer
- [ ] Token estimate within 10% of API-reported across 50 calls
- [ ] Two-phase manifest: `triage` exposes only read tools; after `phase_set("act")`, writes appear
- [ ] Small-model eval improves measurably with phases on vs off — number recorded in `evals/`
- [ ] S5 firing twice in one session emits a misconfiguration warning

**Non-goals.** Agent-triggered compaction. Learned compaction.

---

## Phase 8 — Scheduling

**Goal.** Cron, interval, and one-shot schedules that survive restart.

**Deliverables**
- `schedule/kinds.ts` — cron (5/6 field), every (duration), at (ISO, ≤10y), lossless round-trip
- `schedule/scheduler.ts` — single timer to nearest due across all agents
- Migration 005: `schedules`
- Write-time validation with specific errors
- Isolated vs `shared:<key>` session modes
- Manifest reconciliation: manifest owns manifest schedules; API-created ones untouched
- Schedule endpoints; `castellan schedules`

**Files.** `packages/core/src/schedule/`, `packages/server/`, `packages/cli/`

**Acceptance**
- [ ] All three kinds fire correctly; timezone honoured
- [ ] Restart preserves schedules; missed fires handled per policy (skip, not stampede)
- [ ] Missing delivery target rejected at write with the documented error
- [ ] `GET /schedules` includes disabled by default
- [ ] Isolated runs do not pollute the live session
- [ ] Removing a manifest schedule removes it on reload; API-created survives
- [ ] 100 schedules across 10 agents: one timer, drift under 1 s
- [ ] Idle agent with schedules makes zero model calls until a schedule fires

**Non-goals.** Distributed scheduling. Retry policies beyond fire-and-log.

---

## Phase 9 — Plugin API and WhatsApp

**Goal.** The plugin API is real, proven by refactoring first-party packages onto it.

**Deliverables**
- `plugins/plugin.ts`, `loader.ts`, `middleware.ts`, `permissions.ts`
- Version gating; 200 ms setup budget with `plugin.slow`
- Middleware composition, all four wrap points
- **Refactor** telegram and composio into plugins using only the public API
- `packages/channel-whatsapp` — Baileys, auth dir, QR, reconnect, credential wipe on `loggedOut`
- Documented risk note in that package's README
- `@castellan/core/testing` conformance suite
- `castellan plugins list`

**Files.** `packages/core/src/plugins/`, `packages/channel-whatsapp/`, refactors

**Acceptance**
- [ ] Telegram and Composio use zero private core APIs — enforced by an export-surface test
- [ ] A plugin with a mismatched `castellanApi` refuses to load naming both versions
- [ ] Middleware ordering matches manifest order; a short-circuit returns a well-formed result
- [ ] Retry middleware demonstrably retries a 429
- [ ] Approval middleware blocks a mutating tool and the agent adapts rather than crashing
- [ ] WhatsApp: QR pairing, message round-trip, reconnect after network drop
- [ ] Revoking the WhatsApp session wipes credentials before re-auth; no stuck no-QR state
- [ ] Conformance suite passes for all first-party plugins
- [ ] Boot budget met with 5 plugins

**Non-goals.** Sandboxing. Enforced permissions. Hot reload. A plugin registry.

---

## Phase 10 — Multi-agent

**Goal.** A supervisor delegates to members with isolated context and typed results.

**Deliverables**
- `team/handoff.ts` — envelope, artifact validation against declared JSON Schema
- `team/supervisor.ts`
- `handoff` local tool, supervisor only
- Runtime-kind manifest with `agents` and `team`
- Sub-agent budget enforcement; `handoff.start` / `handoff.result`
- Migration 006: `handoffs`

**Files.** `packages/core/src/team/`, `manifest/schema.ts`, `examples/team/`

**Acceptance**
- [ ] Supervisor delegates to two members; both return validated artifacts
- [ ] Parent context contains the artifact and **not** the sub-agent transcript — asserted on token counts
- [ ] Schema-violating artifact is a typed failure the supervisor can handle, not an exception
- [ ] Budget exceeded terminates the sub-agent and reports honestly
- [ ] Measured: delegation uses fewer parent tokens than the equivalent in-context approach; recorded in `evals/`
- [ ] Members lack the `handoff` tool unless they declare their own team

**Non-goals.** A2A. Free-form agent chat. Dynamic team formation.

---

## Phase 11 — Docker, benchmark, release

**Goal.** v0.1.0, deployable, with the boot claim enforced.

**Deliverables**
- `docker/Dockerfile` on `oven/bun` slim, non-root, healthcheck
- `scripts/bench-boot.ts` with per-step breakdown
- CI gate failing above 1200 ms
- README with the measured number and how to reproduce it
- Complete `examples/`
- API docs generated from types
- v0.1.0 tagged

**Acceptance**
- [ ] Image under 150 MB
- [ ] Container start → `/v1/ready` 200 under 2 s including container overhead
- [ ] In-process boot under 1000 ms; CI enforces 1200 ms
- [ ] Benchmark names the slowest step so a regression self-diagnoses
- [ ] `docker run` with a mounted manifest works with no other setup
- [ ] Every example runs as documented
- [ ] Published boot number is reproducible on a clean clone

**Non-goals.** npm publish. Multi-arch. Helm.

---

## Phase 12 — VelaOps compat adapter

**Goal.** A VelaOps agent container runs Castellan instead of OpenClaw, with `apps/engine`
unchanged.

**Deliverables**
- `packages/compat-openclaw` — WS RPC on 18789, `x-openclaw-scopes`, `auth.token`, TUI client id, subscribe, terminal phase `result`
- `/healthz`
- `openclaw.json` → `agent.yaml` translation incl. `modelByChannel`, `delivery`, `deliveryTargets`
- `model: "openclaw/main"` indirection accepted and rewritten
- Gateway channel ids incl. `msteams`
- `[boot-phase]` markers on stdout for `boot-progress.ts`
- Cron RPC surface mapped to native schedules
- Compatibility test suite recorded against a live OpenClaw gateway

**Acceptance**
- [ ] A VelaOps agent container with `runtime: castellan` boots and serves chat with **zero** engine changes
- [ ] Telegram and WhatsApp work through the existing wiring
- [ ] `boot-progress.ts` renders the stepper correctly
- [ ] Cron round-trips through the existing UI including all three kinds and disabled jobs
- [ ] Detached chat reattach works via existing `stream-hub.ts`
- [ ] Both runtimes run side by side, selected per agent
- [ ] Documented deviations recorded in `06-VELAOPS-INTEGRATION.md`

**Non-goals.** Migrating existing agents. Changing engine code. Feature parity with OpenClaw.

---

## Deferred to v0.2

A2A agent card and server. MCP tool provider. Postgres store. Plugin sandboxing and enforced
permissions. Hot reload. Remote skill sources. Agent-triggered compaction. Code-execution
tool mode. Slack and Discord channels. Native tool dialect as default for large models
(revisit with Phase 3 eval data, not intuition).

---

## Working rules

1. **Acceptance criteria are the definition of done.** Not "it runs."
2. **Non-goals are binding.** Scope creep into the next phase makes review impossible.
3. **Boot budget is checked every phase**, not at the end. Regressions are cheap to fix the day they appear.
4. **Evals are committed.** Every claim about small-model performance has a number in `evals/` and a script to reproduce it.
5. **Errors get hints.** A new error type without a `hint` fails review.
6. **No brand strings outside `brand.ts` and `package.json`.**
7. **Core imports nothing from siblings.** CI enforces it.
