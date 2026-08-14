# Castellan

A lightweight, model-agnostic AI agent runtime.

Castellan turns a stateless OpenAI-compatible `/chat/completions` endpoint into an agent that
lives in messaging channels, uses tools, remembers, runs on a schedule, and delegates to
other agents. Bun-first TypeScript, Apache-2.0.

> A castellan holds and governs a keep on behalf of its lord — commands the garrison,
> controls the gate, keeps the place running when nobody is watching.

## Status

**Pre-release, under construction.** Phase 0 of thirteen (`docs/05-PLAN.md`). The scaffold
builds, lints, and tests; there is no runtime behaviour yet. Not published to npm during
v0.1 development.

## Scope

An agent harness is a runtime layer with four necessary and sufficient elements:

1. **An agent loop** — model call, tool execution, observation, repeat
2. **A tool interface** — resolution, validation, execution
3. **Context management** — assembly, budgeting, progressive compaction
4. **Control mechanisms** — phases, limits, cancellation, scheduling

Anything outside those four is a plugin, not core. Castellan is not an orchestration graph,
a workflow engine, a RAG pipeline, a vector database, or a model gateway.

## Design commitments

The ones that would otherwise look like mistakes:

- **Natural-language tool calling is the default dialect**, not native function calling.
  Published replication across 14 models: +14.9pp accuracy, 93% fewer critical errors, −25%
  tokens; +24 to +43pp on small models specifically. `native` is an explicit opt-in.
- **The tool dialect is config and never auto-detected.** Behaviour must not change silently
  when the model changes.
- **Tools are pinned at load, not searched at runtime.** Search-then-execute is two-hop
  reasoning, which is where small models fail.
- **Compaction is progressive and harness-driven** — five stages from 60% context pressure,
  not one lossy summarise at 95%.
- **Memory is SQLite FTS5, not embeddings.** No model weights, no embedding service, no
  network in the memory path.
- **Zero network I/O before readiness.** Channels connect after `runtime.ready` and report
  status via events.
- **Generation is detached from the client connection.** A browser refresh never kills a
  turn; reattach by turn id is in the wire protocol.

Full rationale for every decision, including the negative ones, is in `docs/00-DECISIONS.md`.

## Quickstart

```bash
castellan init          # an interactive wizard: your name, the agent's name, an endpoint
castellan run milo      # agents live in ~/.castellan/agents — run them by name, from anywhere
castellan run           # or just this: picks from your agents, or walks you through creating one
```

`init` writes a complete starter agent — a reference-style manifest, a SOUL.md identity pair, an
AGENTS.md operations file, the tiered workspace, `.env` — and validates it with the real loader before exiting. It never asks
for your API key; set it in the generated `.env`. Every question has a flag
(`init --user Ada --name Scout --preset ollama --yes`) for scripted use.

## Development

```bash
bun install
bun run build        # bun build + tsc --emitDeclarationOnly
bun test
bun run lint         # biome
bun run typecheck
bun run check:deps   # core imports nothing from a sibling package
```

Requires Bun. Node 22+ is supported as a soft goal, tested in CI, never a merge blocker.

## Boot budget

Process start → `runtime.ready` in under **1000 ms**, enforced in CI at 1200 ms.

_Measured number and reproduction steps land in Phase 11, alongside `scripts/bench-boot.ts`._

## Rebranding

The product name lives in exactly one source file, `packages/core/src/brand.ts`, from which
the env var prefix, state directory, npm scope, and manifest `apiVersion` are all derived:

```bash
bun scripts/rename-brand.ts acme --dry
```

## Plugin security posture

Stated plainly, because the alternative is someone assuming otherwise:

> Castellan plugins run in-process with full privileges. The `permissions` block is
> documentation, not a sandbox. Install plugins you trust, the same way you treat any npm
> dependency. Real isolation requires separate processes or V8 isolates, both of which cost
> the startup time and simplicity this project exists to preserve. If you need to run
> untrusted plugin code, run the whole agent in a container and treat that as the boundary.

## Documentation

| Doc | Contents |
| --- | --- |
| `docs/00-DECISIONS.md` | Every locked decision, with rationale |
| `docs/01-ARCHITECTURE.md` | Module map, loop, context assembly, compaction, boot budget |
| `docs/02-SPEC-MANIFEST.md` | `agent.yaml` — the configuration contract |
| `docs/03-SPEC-PLUGIN-API.md` | Plugin and middleware contracts |
| `docs/04-SPEC-WIRE.md` | HTTP/SSE surface and lifecycle event schema |
| `docs/05-PLAN.md` | Thirteen phases with acceptance criteria |

## License

Apache-2.0. Copyright 2026 Moeen Mahmud.
