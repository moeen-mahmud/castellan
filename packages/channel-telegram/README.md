# @castellan/channel-telegram

The Telegram channel: raw Bot API over `fetch`, long-poll or webhook, no client library.

```yaml
channels:
  - type: telegram
    id: tg
    tokenEnv: TELEGRAM_BOT_TOKEN
    mode: longpoll            # or webhook
    allowFrom: ["@moeen"]     # inbound only, and closed by default
```

```ts
import { telegramChannel } from "@castellan/channel-telegram"

const runtime = await Runtime.create({
    agents: ["./agent.yaml"],
    channels: { telegram: telegramChannel },
    startChannels: true,
})
```

The `castellan` binary registers this for you. A library embedder registers what it wants.

## Fields

| Field | Default | Notes |
| --- | --- | --- |
| `tokenEnv` | `TELEGRAM_BOT_TOKEN` | Names the variable, never the value. Get a token from [@BotFather](https://t.me/BotFather) with `/newbot`. |
| `mode` | `longpoll` | `longpoll` needs no inbound connectivity. `webhook` needs a public HTTPS URL. |
| `webhookUrl` | — | Required in webhook mode. Ends in `/v1/channels/<channelId>/webhook/<agentId>`. |
| `secretTokenEnv` | — | Names a variable holding any random string. Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token`; the transport compares it in constant time and answers 401 on a mismatch. |
| `apiBaseUrl` | `https://api.telegram.org` | For a self-hosted Bot API server. |
| `allowFrom` | — | **Inbound only, and omitting it permits nobody.** Matching folds case, treats a leading `@` as optional, and checks the handle *and* the numeric peer id. `["*"]` permits anyone. |

## What this package does and does not decide

It supplies bytes in and bytes out, plus two facts about itself: `maxMessageChars: 4096`, and
`idempotentSend: false` — Telegram's `sendMessage` takes no client-supplied idempotency key, and
claiming otherwise would turn the outbox's visible `uncertain` flag into a silent duplicate.

Everything else is core's, so two channels cannot disagree about it: allowlists, session routing,
chunking, ordering, retry, and deduplication.

What it *does* decide is which failures are worth retrying, because only it knows Telegram's
taxonomy. 429 is retryable and its `retry_after` is honoured verbatim; 401, 400 and 403 are
permanent; 5xx and a connection failure are retried.

## Failure behaviour

A bad token does not block readiness. It surfaces as `agent.channel.error` with a hint, the agent
resource reports `status: "error"`, and `/v1/health` and `/v1/ready` are unaffected — an
orchestrator must not restart a process into a Telegram outage.

The long-poll loop never exits on its own. It reports the first failure and then every eighth,
backs off to a 30-second cap, and continues until `stop()`.
