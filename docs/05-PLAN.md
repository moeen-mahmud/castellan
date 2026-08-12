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
- [x] CI green — run `31617213199` on `cc11c22`: `bun` ✓, `node (22)` ✓, `node (24)` ✓. The Node
      legs carry `continue-on-error`, so their steps were inspected individually rather than
      trusted from the job checkmark.
- [x] `bun scripts/rename-brand.ts foo` renames throughout; `git diff` touches only `brand.ts` and `package.json` files — plus, once a second package existed, files carrying the derived `@<slug>/` import scope and `apiVersion`. See the note under Phase 1.
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
- [x] `castellan run examples/minimal/agent.yaml` reaches a prompt and answers, streaming tokens
- [ ] Works against **three** endpoints unchanged: OpenAI, an Anthropic-compat base URL, and a local Ollama — `bun run verify:endpoints` written; needs keys and Ollama
- [x] `castellan validate` on a manifest with a literal API key fails naming the field
- [x] Missing `${ENV}` fails at load naming the variable — not later as an auth error
- [x] Ctrl-C mid-stream cancels within 100 ms, no unhandled rejection — measured 4 ms via real SIGINT
- [x] Unit tests: manifest validation (≥15 cases), SSE parsing incl. split frames and `[DONE]`, capability merge
- [x] `runtime.ready` emitted with `bootMs`

**Non-goals.** Tools, storage, channels, skills, memory, compaction.

**Recorded deviations**
- A manifest configuring an unimplemented section (`channels`, `skills`, `memory`, `phases`,
  `schedules`, `plugins`, `delivery`, `tools.pinned`/`provider`/`local`/`search`) is **refused
  at load** naming the phase that implements it, rather than parsed and ignored. Silently
  dropping configuration is the failure rule 8 exists to prevent.
- `rename-brand.ts` also rewrites the `@<slug>/` import scope in source and the derived
  `apiVersion` in example manifests. Both are mechanically derived from the brand, so leaving
  them would make "renames throughout" false the moment a second package imports core.
  `.gitignore`'s state-directory entry is still a manual edit and is reported as such.
- `context.window` is normalised at load from the capability registry, so rule 11 has a real
  number to check rather than deferring to first use.

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
- [x] REPL restarts, history intact — two separate `node …/dist/index.js run` processes against
      DeepSeek: the first was told "my favourite number is 41", the second answered `41` from the
      persisted history alone
- [x] Migrations idempotent; second boot runs none — `store.ready.applied` is `[]` on reopen,
      asserted under both runners
- [x] Killing the client mid-turn does not cancel it; turn reaches `final` in the DB — the caller's
      promise is dropped on the floor while the row goes `running` → `final`
- [x] Reattaching replays buffered events then tails live — replay + tail reconstructs the reply
      exactly once, with no gap and no duplicate
- [x] Explicit stop persists partial content; disconnect does not — this criterion found a real
      Phase 1 bug, see Recorded deviations
- [x] Same test suite passes under `bun test` and `node --test`, proving the adapter — 229/229
      under both, whole suite not just the store
- [x] Boot with 1000 existing sessions still under 1000 ms — boot does not scan sessions;
      `bench:boot` median 61.4 ms with the store phase at 3.28 ms

**Non-goals.** Postgres. Outbox (Phase 4).

**Recorded deviations**

- **`runStep` lost partial text on cancellation.** Aborting a `fetch` makes the pending
  `reader.read()` reject, so cancellation reached `runStep` as an exception and `text +=
  step.text` in `runTurn` never ran. Phase 1 missed it because the REPL prints partial text from
  `model.chunk` events as they stream — a human sees the partial answer on screen and assumes it
  was captured, but `result.text` was empty and `appended` held only the user message. `runStep`
  now converts an abort back into the state it is (`turn.ts`: "cancellation is a state, not an
  exception"); anything that is not an abort still propagates.
- **`turns` is in the `Store` interface, and `status` holds six values not four.** The plan names
  `running | final | stopped | error`. `timeout` and `max_steps` are distinct `TurnEndReason`s the
  loop goes out of its way not to collapse, so flattening them at the storage layer would discard
  a diagnosis made one layer below. The column takes all six.
- **Persistence is opt-in, not the default.** `Runtime` defaults to `:memory:` and the CLI passes
  `defaultStorePath()`. Defaulting to a file would mean constructing a `Runtime` creates a
  directory in the caller's working directory uninvited. `store.ready` always reports `location`.
- **Session keys require a channel segment.** `local:default` parses; a bare `scratch` is refused
  at the boundary. Phase 4 reads the channel back out of the key for outbound delivery, so an
  unstructured key would fail much later as an unroutable session.
- **The `phase` column ships in migration 001** though phases are Phase 7. One nullable column
  now versus a migration that exists only to add it. `setPhase` is wired and tested but nothing
  in this build reads it.
- **`test/_harness.ts` supplies one test vocabulary for two runners.** `bun:test` and `node:test`
  share `describe`/`test` and no assertion library. Under Bun it re-exports `bun:test` untouched;
  under Node it wraps `node:test` and implements the twelve matchers plus `test.each` that this
  suite uses. The matcher list is deliberately closed.
- **`node:sqlite` prints an ExperimentalWarning on every CLI run under Node.** Not suppressed —
  it is Node's honest notice, and the primary runtime is Bun where it does not appear.

---

## Phase 2.5 — CLI

**Goal.** The command line stops being a means of exercising the runtime and becomes an instrument
you can trust: an Ink-rendered chat surface at a terminal, byte-identical plain text everywhere
else, and a parser that cannot fail silently.

Inserted between 2 and 3 rather than renumbered: "Phase 3", "Phase 7" and "Phase 8" are referenced
in roughly thirty places across source comments and the other docs, and every phase from here on
ships a CLI command. Doing this now makes each of their CLI deliverables one line instead of a
retrofit across nine commands.

**Deliverables**
- `lib/commands.ts` — the command and flag table; one source for parsing, `--help`, and error hints
- `lib/args.ts` — pure parser: unknown flags, missing values and bad numbers all refused
- `lib/help.ts` — help rendered *from* the table, so the two cannot drift
- `lib/output.ts` + `lib/env.ts` — `resolveMode()` → `json | plain | rich`, resolved once, with its reason
- `lib/exit.ts` — one teardown: unmount Ink, restore the terminal, flush, preserve the exit code
- `transcript.ts` — pure `AnyEvent → TranscriptState` reducer
- `keymap.ts`, `editor.ts` — pure key→intent and intent→line, including history and code-point cursors
- `lib/wrap.ts` — wrap-aware row counting, so the live pane's height cap means terminal rows
- `components/` — `App`, `Transcript` (`<Static>`), `Live`, `StatusBar`, `Prompt`
- `hooks/` — `useTurn` (bus → reducer), `useTerminalSize`, `useElapsed`
- One module per command: `run.ts`, `sessions.ts`, `validate.ts`, `agents.ts`
- `packages/cli/test/` — nine files, where there were none

**Files.** `packages/cli/src/**`, `packages/cli/test/**`

**Acceptance**
- [x] Rich path renders at a terminal — driven through a pty with injected keystrokes against the
      real DeepSeek endpoint: banner, streaming live pane, `● replying 1.1s`, then the reply
      committed with `153 prompt · 12 output · 1299 ms` and the prompt back
- [x] `run … | cat` and `run … --plain` at a terminal produce identical stdout, zero escape
      sequences in either
- [x] `--json` is valid JSON and the only thing on stdout, on all three commands that accept it
- [x] An unknown command or flag is refused, exit 1, naming the nearest match
- [x] `--input` with no value and `--limit abc` are refused naming the flag and the expected type
- [x] `--input "-5 degrees"` runs one turn with that text rather than silently opening a session
- [x] `--help` exits 0, bare invocation exits 1, `run --help` lists only `run`'s flags
- [x] Help is generated from the table — a test asserts every parseable flag appears in it
- [x] Ctrl-C mid-stream cancels the turn, the status shows `cancelling`, the prompt returns, and the
      partial reply is persisted: turn `stopped`, 309 output tokens, essay fragment in the history.
      Ctrl-C at an idle prompt exits
- [x] Terminal restored on every exit route — `stty -g` before and after a SIGTERM delivered while
      Ink held raw mode is byte-identical
- [x] `validate --json` loads neither Ink nor React — with `ink` physically removed from
      `node_modules`, `validate`, `sessions` and `--help` all still exit 0 and only the rich path
      fails. A structural test additionally forbids a static import outside `components/` and `hooks/`
- [x] The live pane is height-capped in terminal rows, and committed items are immutable — both
      asserted in tests. `<Static>`'s own write-once behaviour is Ink's documented contract, observed
      in the spike, not re-measured here
- [x] `packages/cli/test/` covers args, output, env, exit, transcript, keymap, editor, wrap, and the
      structural boundaries — 178 cases
- [x] `bun run bench:boot` unchanged: manifest 11.51 ms, store 3.45 ms, agents 0.37 ms

**Non-goals.** Interactive browsers for `sessions`/`skills`/`schedules` — those keep `--json` and a
plain table. Mouse support. Themes. A config file. Shell completions. Any command belonging to
Phase 3 or later. Any change to `packages/core`.

**Recorded deviations**

- **`ink` + `react` are the CLI's only new dependencies, and they load lazily.** Measured: importing
  them costs ~65 ms under Bun and ~170-210 ms under Node, against ~70 ms for the whole of
  `validate --json`. So the renderer sits behind a dynamic `import()` reached only on the rich path,
  `--splitting` keeps it in a separate chunk, and a structural test fails if a static import appears
  on a shared path. There is no text-input or spinner dependency: `editor.ts` is ~150 lines and owns
  the Ctrl-C semantics, which no third-party input component would respect.
- **`--packages=external` had to go.** It treats the `#…` subpath imports as packages and leaves them
  unresolved in the bundle, where they would resolve against `./src` — which `files` does not ship.
  The three real dependencies are now externalised by name and everything else is bundled.
- **`packages/cli` uses `#…` subpath imports; `packages/core` keeps relative `.ts` paths.** Verified
  working under node, bun and tsc, but only for an application: the emitted `.d.ts` carries `#…`
  specifiers that resolve through this package's own `imports` map, which is fine for a bin nobody
  imports and wrong for a published library. Apps get aliases, libraries do not. Note `#lib/const`
  must stay extensionless — `#lib/const.ts` fails tsc with TS2877.
- **A one-shot (`--input`) is always plain, even at a terminal.** Otherwise `--input` means one thing
  in a shell script and another in a shell, and scripted output would depend on who was watching.
- **The terminal restore is conditional on having dirtied the terminal.** Restoring unconditionally
  put a cursor-and-style reset at the end of plain output whenever stdout was a TTY, which broke the
  one property plain mode exists for. Only the rich path marks it, so the safety net still covers
  every route out of a raw-mode session.
- **Submitting while a turn is running is refused, not queued.** Two turns on one session would
  interleave in the history the next turn is conditioned on. The refusal is a note in the transcript.
- **A chunk containing newlines is a distinct intent.** Found by driving the real app through a pty:
  pasted text arrives as one chunk, and stripping its carriage returns as control characters joined
  the last word of one line to the first of the next and submitted nothing. Multi-line input now
  submits each finished line in order and leaves an unterminated tail on the prompt.
- **`exitOnCtrlC: false` is passed to Ink's `render`.** Ink's default is to handle Ctrl-C itself and
  exit the process, which would silently undo the contract Phase 1 measured.
- **The `agents` command gained `--json`** and moved out of the entry point, where being inline is
  how it ended up the one command whose flags the usage text never documented.
- **CLI tests are Bun-only.** Node's type-stripper cannot handle JSX, and Phase 2's dual-runtime
  criterion is about the store adapter. `bun run test:node` still runs core's 229 under Node.

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
- CLI: tool-call rows in the chat transcript — a `transcript.ts` case, not a new screen
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
- `castellan serve` — a `lib/commands.ts` entry plus a plain writer

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
- `castellan skills list|show|validate` — table entry plus a plain writer, `--json` included
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
- `castellan memory search|rebuild` — table entry plus a plain writer, `--json` included

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
- CLI: compaction and phase indicators in the status bar — reducer cases, not a new screen

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
- Schedule endpoints; `castellan schedules` — table entry plus a plain writer

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
- `castellan plugins list` — table entry plus a plain writer

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
