# CLAUDE.md — Castellan

Standing brief for coding agents working in this repository. Read this first, every session.

---

## What this is

**Castellan** is a lightweight, model-agnostic AI agent runtime. Apache-2.0.
`github.com/moeen-mahmud/castellan`.

It turns a stateless OpenAI-compatible `/chat/completions` endpoint into an agent that lives
in messaging channels, uses tools, remembers, runs on a schedule, and delegates to other
agents. Bun-first TypeScript.

Its first consumer is VelaOps, an agent provisioning platform, where it replaces the
OpenClaw gateway process inside each agent container. **VelaOps is a consumer, not the
owner.** Nothing VelaOps-specific belongs in this repo outside `packages/compat-openclaw`.

**The owner is Moeen** — senior engineer, sole author. Assume fluency. Skip tutorials, skip
framework explainers, go straight to the specific thing.

---

## Before you write code

1. **Read `docs/00-DECISIONS.md`.** Every decision has a rationale. If you are about to
   propose something it rejects, the rationale tells you whether you have a genuine
   improvement or are re-litigating a settled question. Many decisions are *negative* —
   things deliberately not done — and those matter most.
2. **Find the current phase in `docs/05-PLAN.md`.** Implement that phase only.
3. **Read the phase's Non-goals.** They are binding. Work that belongs to a later phase
   makes this phase unreviewable.
4. **Stop at the acceptance criteria.** Report what passes and what doesn't. Do not
   continue into the next phase.

---

## Hard rules

1. **Never run `git commit` or `git push`.** Prepare the change, explain it, stop. Moeen
   reviews and commits.
2. **`packages/core` imports nothing from sibling packages.** CI enforces this. Core depends
   on the standard library, a YAML parser, and a schema validator. Nothing else.
3. **No brand strings outside `packages/core/src/brand.ts` and `package.json` files.** No
   directory, type, interface, or variable contains "castellan". A rename must be one commit.
4. **No network I/O before `runtime.ready`.** This single rule is why this project exists —
   the runtime it replaces blocks roughly four minutes on network calls during hook
   initialisation. Anything needing the network happens after readiness and reports status
   via events.
5. **No runtime `npm install` / `bun install`.** Plugins resolve at boot from the manifest.
   Ever installing at runtime reintroduces an entire bug class.
6. **No `any`.** Use real interfaces. `Record<string, unknown>` over `Record<string, any>`.
7. **Every error gets a `hint`.** A new error type without one fails review. The expensive
   part of a failure is almost never the failure — it's that the failure didn't say what
   was wrong.
8. **Nothing fails silently and exits 0.** Ever.
9. **Tests are required for `packages/core`.** Not optional here, whatever the conventions
   elsewhere. A harness is a state machine plus a scheduler plus a tool executor; those
   break in ways manual exercise cannot reach.
10. **Secrets are env var *names* in config, never values.** A manifest with a literal key
    fails validation.

---

## Stack

| | |
| --- | --- |
| Runtime | Bun (primary), Node 22+ (soft compat, CI-tested, never a blocker) |
| Package manager | `bun` — never npm, pnpm, or yarn |
| Workspaces | Bun workspaces, monorepo |
| Build | `bun build` + `tsc --emitDeclarationOnly` |
| Modules | ESM only |
| Lint/format | Biome — not ESLint, not Prettier |
| Tests | `bun test` — not Vitest, not Jest |
| CLI rendering | Ink 7 + React 19, `.tsx`, in `packages/cli` only — lazily imported |
| Schema | Zod |
| Storage | SQLite via `bun:sqlite` / `node:sqlite` adapter |
| Release | Changesets, semver |

Commands:

```bash
bun install
bun run build
bun test
bun run lint
bun run bench:boot        # must stay under 1000ms; CI fails at 1200ms
bun run test:node         # core only, under Node's runner — proves the sqlite adapter
```

---

## Architecture in one page

```
inbound (channel | API | schedule)
  → resolve agent + session + phase
  → assemble context (fixed slot order, budgeted, cache-stable prefix)
  → step loop:
      model call → dialect.parse → coerce+validate → execute tools → observe
      → compaction ladder if over threshold
  → deliver via idempotent outbox
  → persist
```

**Non-obvious decisions you must not undo without reading the rationale:**

- **NLT is the default tool dialect**, not native function calling. Published data: +14.9pp
  accuracy, 93% fewer critical errors, −25% tokens across 14 models; +24 to +43pp on small
  models specifically. `native` is an opt-in manifest field.
- **Dialect is config, never auto-detected.** Behaviour must not change silently when the
  model changes.
- **Tools are pinned at load, not searched at runtime.** Search-then-execute is two-hop
  reasoning, exactly where small models fail.
- **Phase-scoped tool visibility is in core.** Constraining the tool space per phase took
  local models from 2/10 to 10/10 on a benchmark subset with no model change. Too central
  to be a plugin.
- **Compaction is progressive (five stages), harness-driven.** Binary emergency compaction
  at 95% is the known-bad design.
- **Skill selection happens in the harness, not by the model.** Progressive disclosure
  assumes the model chooses to read a file; small models don't.
- **Memory is FTS5, not embeddings.** Prove lexical insufficient before paying for vectors.
- **Composio is called directly, never through MCP.** MCP is a fine integration protocol and
  a poor internal architecture.
- **A remote provider resolves from disk at boot and refreshes after readiness.** Measured: boot 27 ms,
  refresh 1,474 ms. Awaiting the refresh inside boot makes boot sixty times slower and reintroduces the
  exact cost this project exists to remove. A cold agent is warmed once with `tools --warm`.
- **Plugins are trusted in-process code**, documented as such. `permissions` is advisory
  vocabulary in v1.
- **Workspace files are tiered, not a flat list.** Static (cached, read-only) before breakpoint A,
  volatile after it, reminder past the history. Frontmatter and HTML comments are stripped before
  injection. Phase 3.5 — the runtime still reads flat `context.files` until then.
- **Vendor prompting guidance is encoded as a capability, never a constant.** Published advice is
  written for frontier models and a good fraction of it inverts at 3–8B — Anthropic now says to
  *remove* emphatic phrasing because models overtrigger on it; a 7B model needs it. That lives in
  `capabilities.promptStyle`.

Full detail: `docs/01-ARCHITECTURE.md`.

---

## Where things live

```
packages/core/       the loop, context, tools, skills, memory, store, schedule, plugins
packages/cli/        `castellan` binary — lib/ plumbing, components/ Ink, pure reducers at top level
packages/server/     HTTP/SSE/WS surface
packages/channel-*/  Telegram, WhatsApp
packages/tools-*/    Composio, MCP
packages/compat-openclaw/   VelaOps bridge — quarantined, deletable
docs/                design + plan (read these)
evals/               fixtures/ the shared catalogue and tasks; tools/ committed results.
                     Every performance claim has a number here
scripts/             bench-boot, rename-brand
```

---

## Specs are binding

| Doc | Governs |
| --- | --- |
| `docs/02-SPEC-MANIFEST.md` | `agent.yaml`. Adding a field means updating this doc in the same PR. |
| `docs/03-SPEC-PLUGIN-API.md` | Plugin contracts. First-party plugins use only public API — no back doors. |
| `docs/04-SPEC-WIRE.md` | HTTP surface and event schema. Event types are append-only within `v: 1`. |
| `docs/07-SPEC-WORKSPACE.md` | Workspace file tiers, budgets, and `promptStyle` rendering. Supersedes `context.files`. |

If a first-party package needs something the plugin API can't express, **the API is wrong
and gets fixed**. Do not add a private escape hatch.

---

## Verification

- `bun test` for core logic
- `bun run bench:boot` for every phase, not just the last
- Real endpoints for the model layer: OpenAI, an Anthropic-compat base URL, and local Ollama.
  Three providers unchanged is the bar.
- A real Telegram bot for channel work
- Committed eval fixtures for anything claiming small-model improvement

Never claim a performance property without a number in `evals/` and a script to reproduce it.

---

## Style

- Direct and technical. No preamble, no summarising the request back.
- Reference code as `path/to/file.ts:123`.
- Lead with the root cause in one or two sentences, then the change.
- Prefer a recommendation over a menu. If you must present options, rank them.
- Long explanations are fine when the mechanism is subtle — the loop, compaction, cache
  breakpoints, cancellation. Not for CRUD or config.
- State uncertainty plainly. If you don't know whether something still holds in the current
  code, say so and name the file to check rather than asserting.

---

## Things that are easy to get wrong

- The **cache-stable prefix** is load-bearing. Reordering context slots 0 and 1, or making
  their content vary per turn, silently destroys prompt caching and the cost goes up with no
  error anywhere.
- **Pinned blocks must survive every compaction stage including S5.** Anything that must
  always hold lives in slots 0/1, never in history.
- **Thinking blocks must be replayed with tool results** when `capabilities.thinking !== "none"`,
  or multi-step reasoning silently degrades with no error.
- **`allowFrom` is inbound-only.** It confers nothing on outbound delivery. Conflating these
  produces a confusing "chat not found" class of failure.
- **A tool result is not automatically trustworthy.** `ToolSpec.trust` separates text the runtime wrote
  from text a stranger wrote, and a provider-resolved tool defaults to `untrusted`. The delimiters
  around untrusted content are advisory — a model can be talked past them. The write gate
  (`tools.untrusted.onMutate`, default `refuse`) is the part that holds. Do not "improve" this by
  filtering instruction-like phrasing out of untrusted text: it does not work, and an unreliable
  filter invites the belief that the problem is handled.
- **`tools.search` searches the provider's tool catalogue, not the web.** Two different things, and
  they have already been confused once. Web search is `web_search`.
- **`resolve()` must throw on unknown tool slugs.** Silently dropping them is how write tools
  get starved and how a config error becomes a runtime mystery.
- **`mutating` defaults to true for a provider tool with no annotation, and that is the safe direction.**
  It is what serialises a call and suppresses its retry — so a write mislabelled as a read runs in
  parallel *and* is retried, and the side effect happens twice. 37 of 100 Composio tools carry no hint,
  so this default decides a third of the catalogue.
- **A cache-miss and a mistyped slug are different failures.** The registry's generic version blames the
  slugs: on a cold agent it read "no provider resolved GMAIL_FETCH_EMAILS … Available: now,
  memory_write". Only the provider knows the cache is empty, so only it can say so.
- **The outbox must be idempotent.** A crash mid-delivery must not double-send.
- **Ink redraws its whole dynamic tree every frame.** Finished transcript items belong in
  `<Static>`, which writes once and never touches the node again — so they must be append-only
  and immutable, and mutating one is a change that silently never appears. The live pane is
  capped in terminal *rows*, not lines.
- **Nothing on a shared CLI path may import Ink or React.** They cost ~170-210 ms under Node,
  more than the entire runtime of `validate --json`. A structural test enforces it.
- **`--plain` at a terminal must produce exactly what a pipe produces.** That is why the
  terminal restore fires only when the rich path has dirtied the terminal.
- **Turns are detached from the client connection.** Never cancel on disconnect. Persist
  partial content only on explicit stop.
- **Frontmatter and HTML comments must never reach the model.** The workspace templates carry their
  authoring guidance in comments on the assumption the loader strips them. If it doesn't, every
  agent pays several hundred tokens per turn, forever, for documentation it can't use — and nothing
  reports it. Asserted on the assembled prefix, not trusted.
- **A workspace budget failure names the file and stops.** Never truncate to fit: that produces an
  agent running on partial instructions with no error anywhere, which is the same silent-degradation
  shape as a dropped tool call.
- **Slot number equals prompt position** in `SLOT` (`context/blocks.ts`). The two are kept equal so
  the table in `01-ARCHITECTURE.md` can be read in order; inserting a slot means renumbering, which
  is cheap because every reference is by name (`SLOT.input`, never `8`).
- **A `ChatMessage` is no longer just `{role, content}`.** Under the `native` dialect it carries
  `toolCalls` or `toolCallId`, and every layer that copies a message must copy those too — the wire
  mapper in `chat-completions.ts`, the `message` field on `ContextBlock`, and the store's
  `tool_calls`/`tool_call_id` columns. Each of the three dropped them at some point during Phase 3,
  and none of the three failed loudly: the endpoint accepts the request and the model simply never
  sees the call it made.
- **Both dialects must put the same guidance in front of the model.** `native`'s
  `function.description` carries `whenToUse` and `whenNotToUse`, not just the summary. Trimming it to
  the summary makes `evals/tools` measure the guidance and report it as a property of the dialect.
- **A placeholder in a prompt example is an instruction to a small model.** The NLT preamble said
  "exactly like this" and showed `field: value`; qwen3.5:9b wrote `field: title` / `value: <the value>`
  and NLT scored 27% against native's 92% — its reasoning about which tool and which arguments was
  correct every time. Examples in `PREAMBLE` are concrete, use a tool that exists in no catalogue, and
  are asserted by parsing the rendered catalogue with `parseNlt` itself. This cuts the other way too:
  because NLT's protocol is prose the model imitates and native's is a schema the API enforces, *any*
  defect in the preamble shows up as a dialect difference. Before believing an NLT-vs-native number,
  read what the model actually wrote — `results.json` keeps it on every non-`correct` attempt.
