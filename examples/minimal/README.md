# minimal

One model, one identity file, no tools and no channels. The smallest thing that answers.

```bash
cp .env.example .env      # then fill in MODEL_* for one of the presets
castellan validate ./agent.yaml
castellan run ./agent.yaml
```

From a clone, before the CLI is installed:

```bash
bun run build
node packages/cli/dist/index.js run examples/minimal/agent.yaml
```

## The point of this example

The manifest never changes between providers. Only the environment does:

| Endpoint | `MODEL_BASE_URL` | `MODEL_ID` | Key |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | required |
| Anthropic compat | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` | required |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` / `deepseek-reasoner` | required |
| Ollama, local | `http://localhost:11434/v1` | `qwen3.5:9b` | none — delete `apiKeyEnv` |

A model that reasons — `deepseek-reasoner`, `qwen3.5`, most recent open-weight releases — bills its
thinking against the output budget, and thinks *more* the more constrained the request. Measured on
`qwen3.5:9b`: six simultaneous instructions produced 2,000 tokens of deliberation in 104 s and an
**empty reply**; `reasoningEffort: none` answered correctly in 2.1 s. Set it under the model role
when the work is short and well specified:

```yaml
model:
  main:
    id: ${MODEL_ID}
    baseUrl: ${MODEL_BASE_URL}
    reasoningEffort: none   # none | minimal | low | medium | high
```

Not every endpoint honours it, and one that does not says nothing — verify rather than assume.

`baseUrl` ends at the version segment. The runtime appends `/chat/completions` itself, and
including it in `baseUrl` is refused at load rather than producing a 404 later.

## Things worth trying

```bash
# one turn, no REPL — useful in scripts and CI
castellan run ./agent.yaml --input "what can you do?"

# machine-readable validation, including resolved capabilities
castellan validate ./agent.yaml --json

# a reasoning model, with its chain of thought streamed separately from the reply
MODEL_ID=deepseek-reasoner MODEL_BASE_URL=https://api.deepseek.com/v1 \
  castellan run ./agent.yaml --show-reasoning --input "which is heavier, 1kg of steel or 1kg of feathers?"

# a deliberately awkward local endpoint: split SSE frames, heartbeats, no trailing blank line
bun scripts/mock-endpoint.ts
MODEL_ID=mock MODEL_BASE_URL=http://localhost:8787/v1 MODEL_API_KEY=x \
  castellan run ./agent.yaml --input "hello"
```

Ctrl-C during a reply cancels that turn and returns the prompt; Ctrl-C at an idle prompt exits.
The partial reply is kept, because an explicit stop is a decision rather than an accident.

## What is not here yet

No tools, storage, channels, skills, memory, or compaction — those arrive in Phases 2–7. A
manifest that configures them is **refused at load** rather than silently ignored, so this
example only sets what this build actually honours.
