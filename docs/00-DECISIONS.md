# 00 — Decisions

Every decision below is locked unless explicitly marked open. Each carries its rationale,
because the rationale is what tells a future reader (human or agent) whether a proposed
change is a refinement or a regression.

Many of these are negative decisions — things Castellan deliberately does *not* do.
Those matter most. Most of them trace to specific, expensive failures observed in
OpenClaw as consumed by VelaOps; those are cited as `[VO]`.

---

## 1. Identity and packaging

| # | Decision | Rationale |
| --- | --- | --- |
| 1.1 | Name: **Castellan** | Bare npm name free; no agent-space collision; word predates Games Workshop by ~700 years (Latin *castellanus*), so no trademark exposure unlike *Omnissiah*/*Skitarii*/*Adeptus*. Metaphor is load-bearing: holds the keep, gates access, runs unattended. |
| 1.2 | Repo `github.com/moeen-mahmud/castellan`, transfers to HelicanHQ later | Owner's call. |
| 1.3 | Package scope `@castellan/*`, **not** `@helican/*` | Scoping to the project rather than the owner means the org transfer changes zero import paths. |
| 1.4 | Brand centralised in `packages/core/src/brand.ts` | A rename must be one commit, not a tree-wide find-and-replace. Directory names, config filenames, and type names contain **no** brand string. Only `package.json` fields, `brand.ts`, and prose docs do. |
| 1.5 | Env prefix and dot-dir derive from `brand.ts`, overridable via `CASTELLAN_BRAND` | Lets an embedder rebrand without forking. Default: env prefix `CASTELLAN_`, state dir `.castellan/`. |
| 1.6 | License **Apache-2.0** | Explicit patent grant, which MIT lacks. Matches Mastra and Letta. `anthropics/skills` is Apache-2.0 too, so vendoring skills stays licence-compatible. |
| 1.7 | **Semver**, not CalVer | VelaOps uses CalVer internally, but OSS consumers read semver to reason about breakage. `0.x` until the plugin API stops moving. |
| 1.8 | Changesets for releases | Standard, works with workspaces, produces a changelog people can read. |
| 1.9 | Not published to npm during v0.1 development | Consumed by VelaOps via git dependency or local link until the API settles. Names are held, not shipped. |

## 2. Runtime and toolchain

| # | Decision | Rationale |
| --- | --- | --- |
| 2.1 | **Bun** primary runtime and package manager | Owner's call. Bun's startup is materially faster than Node's, which directly serves the sub-second boot target. |
| 2.2 | Node 22+ compatibility is a **soft** goal, tested in CI, never a blocker | Reach without a second toolchain. Only two things differ: SQLite binding and subprocess spawn — both isolated behind one adapter file each. |
| 2.3 | Bun workspaces, monorepo | Core / channels / providers / cli / server need independent versioning, and channels carry heavy optional deps (Baileys) that must not land in core's dependency graph. |
| 2.4 | Build: `bun build` + `tsc --emitDeclarationOnly` | Zero extra build dependencies. Contradicting "lightweight" in the build pipeline of a lightweight runtime is a bad look. |
| 2.5 | **ESM only** | New project, 2026, Bun-first. Dual CJS doubles build and test surface for consumers who don't exist. |
| 2.6 | **Biome** for lint + format | Matches VelaOps muscle memory; single binary; fast. |
| 2.7 | **`bun test`**, not Vitest | Built in, no dependency, fast. Loses Node-runner portability, which is acceptable since CI runs Bun. |
| 2.8 | Tests are **required for `packages/core`**, optional elsewhere | Reverses the standing VelaOps "no test runner" mandate, and deliberately. A harness is a state machine plus a scheduler plus a tool executor; those break in ways that manual Docker exercise cannot reach. Channels and providers stay manually verified — their failures are visible immediately. |
| 2.9 | No runtime dependency on any agent framework | Not LangChain, not Mastra, not the AI SDK. The loop *is* the product. |

## 3. Model layer

| # | Decision | Rationale |
| --- | --- | --- |
| 3.1 | **OpenAI-compatible `/chat/completions` is the only transport** | Universal denominator. Anything reachable — OpenAI, Anthropic's compat endpoint, Gemini's compat endpoint, OpenRouter, Ollama, vLLM, any gateway — speaks it. |
| 3.2 | **Hand-rolled `fetch` client**, no SDK | The `openai` SDK is heavy and leans toward the Responses API, which most compat proxies don't implement. The Vercel AI SDK defaults to routing through Vercel's AI Gateway when handed a model string — a hidden network dependency, unacceptable in a runtime advertising no gateway requirement. |
| 3.3 | **No LiteLLM, no gateway, no proxy requirement** | User supplies `baseUrl` + API key. A gateway remains possible — it's just another base URL. |
| 3.4 | Per-model **capability descriptor**, shipped registry + manifest override | Base URL and key are not sufficient. Anthropic's compat endpoint ignores `strict` on function calls; extended-thinking blocks must be replayed with tool results or multi-step reasoning silently degrades; prompt-cache breakpoints are provider-specific. These are behavioural facts the loop must know. |
| 3.5 | Capabilities drive **thinking handling and cache breakpoints only** — never the tool dialect | Consistency requirement. Behaviour must not silently change when the model changes. |
| 3.6 | Three model roles: `main`, `selector` (optional), `compactor` (optional) | Lets a cheap small model do tool selection and summarisation while a stronger one writes. Defaults: both fall back to `main`. |

## 4. Tool layer

| # | Decision | Rationale |
| --- | --- | --- |
| 4.1 | **NLT (natural-language tool calling) is the default dialect**; `native` is an explicit manifest opt-in | Published replication across 14 models / 8,560 trials: +14.9pp accuracy overall, **93% fewer critical errors**, −25% tokens; models without native tool calling and smaller models gain +24 to +43pp. Frontier models show smaller or reversed gains — hence the opt-in escape hatch. |
| 4.2 | Dialect is chosen by **config, never auto-detected** | One code path in production. Auto-switching creates a bug class where behaviour differs per provider and nobody can reproduce it. |
| 4.3 | Tool manifest **pinned at provision time**; runtime search is an escape hatch, off by default | Composio exposes ~20,000 tools across ~982 toolkits. Search-then-execute is two-hop reasoning, which is exactly where small models fail. |
| 4.4 | Hard tool budget with **reserved write quota** | `[VO]` The observed failure: a shared cap of 48 across toolkits with a silent auto-cap near 20 "important" tools starved write tools, and dead slugs were dropped without warning. Castellan computes the manifest, validates every slug at load, and fails loudly on an unknown one. |
| 4.5 | **Phase-scoped tool visibility in core**, not a plugin | The strongest published small-model lever: constraining the tool space per workflow phase took local models from 2/10 to 10/10 on a SWE-bench subset with no model change. Too central to be optional. |
| 4.6 | Composio accessed via its **SDK/HTTP directly, not MCP** | `[VO]` The `composio-proxy` sidecar exists solely because Composio's MCP 405s the GET stream leg and stalls past 120s. Both are transport properties. Going direct deletes the sidecar, the held-open SSE, and the `mcp.update()` rebind bug. |
| 4.7 | MCP supported as **one tool provider among several**, never the substrate | MCP is a fine integration protocol and a poor internal architecture. |
| 4.8 | A step's tool calls are **all-or-nothing** | A step may carry several blocks. Executing the good ones and repairing the bad one means the model rewrites the whole step, and the mutating call that already succeeded runs again. No idempotency key exists at this layer, so partial execution cannot be made safe. |
| 4.9 | **One repair, counted consecutively**, then an honest failure | Two identical failures is a catalogue or routing problem that a third attempt cannot fix. Counted consecutively rather than per turn, so a long turn that recovers is not punished for a stumble at step two. |
| 4.10 | A turn that **acted and then failed keeps its trace** | The general rule is that a failed turn appends nothing, so a half-answer is not treated as something said. Side effects are the exception: the email left, the row was written, and discarding the record lets the next turn cheerfully do it again. |
| 4.11 | A tool with no `whenNotToUse` renders a **visible placeholder**, and the registry warns | Provider descriptions rarely carry negative guidance. Fabricating a line would put words the tool's author never wrote in front of the model; dropping it silently would remove the single cheapest routing-accuracy lever without saying so. |

## 5. Context and memory

| # | Decision | Rationale |
| --- | --- | --- |
| 5.1 | **Progressive multi-stage compaction** from v1 | Tool observations routinely consume 70–80% of budget. Binary emergency compaction at 95% is the known-bad design: late activation, severe loss, compounding errors across successive compactions. |
| 5.2 | Compaction is **harness-driven**, not agent-triggered | Agent-controlled compaction is elegant and requires the model to call a tool at the right moment. Small models won't. |
| 5.3 | Context assembly order is **fixed and cache-stable** | Prompt caching is the single largest cost lever; it only works if the prefix is byte-stable across turns. |
| 5.4 | Certain blocks are **pinned and never compacted**: identity, tool catalogue, current task, last error | Compaction reliably eats initial instructions and style rules. Anything that must survive lives in the system prefix, not in history. |
| 5.5 | **Files canonical** for persona, skills, memory, artifacts; **SQLite canonical** for sessions, messages, tool calls, schedules, phase state | Files are inspectable, diffable, git-backable, and match VelaOps' existing model. Rows are for things with lifecycle and indexes. Letta's server-owns-all-state model is the opposite pole and wrong for a file-workspace product. |
| 5.6 | Memory retrieval: **`Retriever` interface from day one, SQLite FTS5 the only shipped implementation** | `[VO]` Per-agent embedding services are the most expensive line in the current architecture — `bge-large` needs 1.5–2GB resident, and `EMBED_MODEL` exists purely to survive tight hosts. Lexical + recency covers most personal-assistant recall. Prove it insufficient before paying for vectors. |
| 5.7 | No vector store, no RAG pipeline in core | Available as a plugin. Not a runtime concern. |

## 6. Skills

| # | Decision | Rationale |
| --- | --- | --- |
| 6.1 | **agentskills.io spec compliance**, SKILL.md + frontmatter | Now an open standard (Apache-2.0 code, CC-BY-4.0 docs) adopted across products, not a Claude-specific format. Compliance inherits `anthropics/skills` plus the community. |
| 6.2 | Skill selection happens **in the harness**, not by the model | Progressive disclosure assumes the model chooses to open a file. Small models don't reliably. Harness-side BM25 over descriptions, one active skill per turn by default. |
| 6.3 | Skill template **requires negative examples** (`when_not_to_use`) | Reported routing-accuracy improvement from 73% → 85% by adding negative examples to the manifest. Free. |
| 6.4 | Skills that ship **scripts** are preferred over skills that ship prose | Compiling skills to executable graphs took a frontier model from 53% → 67% pass rate. For a 3–8B model the effect is larger: a deterministic script beats instructions it must interpret. |
| 6.5 | Skill scripts are **the only Python surface** | Executed via subprocess. `uv run` when a `pyproject.toml`/`requirements.txt` is present, else `python3`. Python is never a dependency of core; a skill declaring Python fails loudly at load if the runtime is absent. |
| 6.6 | Skill scripts are exposed as tools **only while their skill is active** | Keeps the tool budget honest and the catalogue small. |

## 7. Plugins

| # | Decision | Rationale |
| --- | --- | --- |
| 7.1 | Six extension points: **channel, tool provider, model provider, store driver, skill source, loop middleware** | Covers every axis Castellan itself varies along. HTTP routes deferred to v0.2. |
| 7.2 | Middleware uses a **wrapping** shape (`wrapTurn`, `wrapModelCall`, `wrapToolCall`, `wrapContext`), not before/after events | Wrapping permits retry, substitution, and short-circuit; events only permit observation. Events are derived from the wrap points, so nothing is lost. |
| 7.3 | Plugins resolved **at boot from the manifest**. Never a runtime `npm install`. | `[VO]` OpenClaw's plugin trust gate keys on the npm install record, so `--link` and path installs crash-loop `msteams` and `slack` — and the refusal exits 0, so it looks like it worked. An entire bug class deleted by never installing at runtime. |
| 7.4 | Plugins run **in-process and are trusted code**, stated loudly in the README | vm2 has 20+ historical sandbox escapes including CVSS 9.8 in January 2026; `node:vm` is documented as not a security mechanism; worker threads are not a complete boundary. Real isolation means isolated-vm, QuickJS-WASM, or separate processes — all of which cost the thing being optimised. Sandboxing is a v2 decision needing a threat model that does not yet exist. |
| 7.5 | `permissions` block is **declarative and advisory in v1** | Recorded, surfaced in `castellan plugins` and in events, unenforced. Ships the vocabulary now so enforcement later isn't a breaking change. |
| 7.6 | Every plugin declares `castellanApi` semver range; **host refuses to load on mismatch** | `[VO]` Config silently rolling back on version skew is a debugging nightmare. Fail loud at boot. |
| 7.7 | No hot reload in v1 | Reload = restart. Restart is cheap by design. |

## 8. Channels

| # | Decision | Rationale |
| --- | --- | --- |
| 8.1 | Telegram and WhatsApp only in v1 | Scope fence. |
| 8.2 | Telegram: **raw Bot API over fetch**, webhook and long-poll both | No library, no dependency, complete control. The Bot API is small and stable. |
| 8.3 | WhatsApp: **Baileys**, in a separate `@castellan/channel-whatsapp` package | Owner's call. Isolation keeps Baileys' dependency weight and its ToS posture out of core, and leaves room for a BSP driver behind the same interface. See §8.4. |
| 8.4 | Documented risk note ships with the WhatsApp package | Baileys reverse-engineers WhatsApp Web, violating ToS, with no appeal path. Separately, Meta's terms effective 15 Jan 2026 prohibit the WhatsApp Business Solution where a general-purpose AI assistant is the primary functionality. Both facts belong in the README, not buried. |
| 8.5 | **One process hosts N agents** | Library-first shape. VelaOps runs one agent per container; that's a deployment choice, not an architectural constraint. Forcing 1:1 would make the embedded use case impossible. |
| 8.6 | Outbound goes through an **outbox table with idempotency keys** | A crash mid-turn must not double-send or silently drop a reply. |
| 8.7 | Chat channels get **complete messages plus typing indicator**; token streaming exists only on the HTTP/WS surface | Telegram and WhatsApp cannot stream tokens usefully. |

## 9. Scheduling

| # | Decision | Rationale |
| --- | --- | --- |
| 9.1 | SQLite table + **single multiplexed timer** across all agents | Durable Objects allow one alarm and multiplex schedules in SQL; the pattern is correct regardless of platform. No queue, no external scheduler. |
| 9.2 | Three schedule kinds — `cron`, `every`, `at` — **modelled natively and round-tripped losslessly** | `[VO]` OpenClaw's cron is a three-kind union hidden behind a scope-denied CLI, stored in SQLite, where `cron.list` hides disabled jobs and `cron.add` rejects an explicitly-null field. Cron is a first-class resource here. |
| 9.3 | Delivery target **required at write time**, with a specific validation error | `[VO]` "Keyless implicit isolated crons are hard-refused" is a runtime failure for a config mistake. Validate at the boundary and say exactly what's missing. |
| 9.4 | Disabled schedules listed by default | Hiding rows by default is a footgun. |
| 9.5 | Scheduled runs default to **isolated sessions**, `shared:<key>` opt-in | Predictable, and prevents a cron job from polluting a live conversation. |

## 10. Multi-agent

| # | Decision | Rationale |
| --- | --- | --- |
| 10.1 | **Supervisor + typed handoff**, in-process. No free-form agent chat. | Multi-agent systems are distributed systems; every handoff needs a typed schema and boundary validation. Free-form chat between weak models diverges fast and is undebuggable. |
| 10.2 | Sub-agent runs are **context-isolated**; parent sees the returned artifact, never the transcript | Subagents process substantially fewer tokens than in-context skills in multi-domain work precisely because isolation prevents cross-domain bloat. |
| 10.3 | Handoff result validated against a **declared JSON Schema** | Turns "did it work?" into a boolean. |
| 10.4 | A2A agent card deferred to v0.2 | A2A 1.0 with signed agent cards is the right external interop story, and it is an *edge* concern. Internal coordination doesn't need a protocol. |

## 11. Surfaces and deployment

| # | Decision | Rationale |
| --- | --- | --- |
| 11.1 | Four surfaces: **library (the contract), CLI, HTTP/SSE server, Docker image** | Library first is what distinguishes this from OpenClaw. `import { Runtime }` must be as first-class as `castellan run`. |
| 11.2 | Config is **YAML** (`agent.yaml`), with a programmatic TS builder as an equal path | Machine-writable matters — VelaOps generates it. YAML over JSON for comments. |
| 11.3 | **Detached generation is core**, not a feature | `[VO]` LL#15: generation must never be tied to the client connection; aborting on disconnect loses work. Reattach by turn ID is in the wire protocol from Phase 4. |
| 11.4 | Boot budget: **process start → `runtime.ready` under 1000 ms**, enforced in CI at 1200 ms | The headline claim. Benchmarks that aren't enforced become aspirations. |
| 11.5 | **Zero network I/O before ready** | The direct cause of OpenClaw's ~4-minute startup: hook handlers blocking initialisation on network calls. Channels connect after ready and report status via events. |
| 11.6 | Observability is **structured JSON lifecycle events**; OpenTelemetry is a plugin | Core emits, consumers persist. Core writes no rows it doesn't own. |
| 11.7 | Docker image published, `oven/bun` slim base | Deployability is a v1 requirement, not a follow-up. |
| 11.8 | CLI interactive surface is **Ink + React**, and Ink is never the *only* renderer | Every command has a plain-text path carrying the same information. The CLI is the debugging instrument for a runtime that lives in containers and CI, where there is no TTY — and a TUI that garbles piped output is worse than no TUI. |
| 11.9 | Render mode is resolved **once**, ordered and total: `--json` > `--plain` > one-shot > not-a-TTY > `NO_COLOR`/`TERM=dumb`/`CI` > rich | Same principle as 3.5. Behaviour that shifts silently with the environment cannot be reasoned about. The resolution returns *why* it chose, so "it wasn't interactive and I don't know why" has an answer. |
| 11.10 | `ink` + `react` are the CLI's only runtime dependencies, and they load **lazily** | Measured: ~65 ms to import under Bun, ~170-210 ms under Node, against ~70 ms for all of `validate --json`. A static import would make every command pay for a renderer it does not use. No input or spinner package: the editor is ~150 lines and owns the Ctrl-C semantics, which no third-party input component would respect. |

## Open items

| # | Item | Needs |
| --- | --- | --- |
| O.1 | Domain (`castellan.dev` / `.sh`) | Owner to check registration. Also the fastest way to discover someone mid-launch with the same idea. |
| O.2 | npm org registration for `@castellan` | Before first publish. Name currently free. |
| O.3 | Sandboxing model for v2 plugins | Needs a threat model. Deferred deliberately. |
| O.4 | Whether `native` dialect ever becomes default for large models | Revisit with eval data from Phase 3, not by intuition. |
| O.5 | Postgres store driver | Interface exists from Phase 2; implementation when a consumer needs it. |
