/**
 * `@dispach/channel-telegram` — the Telegram channel, registered by type name.
 *
 * ```ts
 * Runtime.create({ agents: ["./agent.yaml"], channels: { telegram: telegramChannel } })
 * ```
 *
 * The manifest entry:
 *
 * ```yaml
 * channels:
 *   - type: telegram
 *     id: tg
 *     tokenEnv: TELEGRAM_BOT_TOKEN
 *     mode: longpoll            # or webhook
 *     allowFrom: ["@moeen"]     # inbound only, and closed by default
 * ```
 */

import { type ChannelFactory, ConfigError } from "@dispach/core"
import { TelegramApi } from "./api.ts"
import { type TelegramMode, TelegramTransport } from "./transport.ts"

export { TelegramApi, TelegramApiError } from "./api.ts"
export type {
    TelegramChat,
    TelegramMe,
    TelegramMessage,
    TelegramResponse,
    TelegramUpdate,
    TelegramUser
} from "./api.ts"
export { TelegramTransport, toInbound } from "./transport.ts"
export type { TelegramMode, TelegramTransportOptions } from "./transport.ts"

/**
 * Construct a Telegram transport from a manifest entry.
 *
 * **The token is read here, at boot, and a missing one is a hard failure.** That is deliberately
 * different from a *wrong* token, which is a network fact and must not block readiness (decision
 * 8.9's neighbour): an unset environment variable is a configuration mistake, knowable without a
 * packet, and hard rule 10's whole point is that the manifest names the variable so the failure can
 * name it too.
 */
export const telegramChannel: ChannelFactory = (context) => {
    const config = context.config
    const tokenEnv = stringField(config, "tokenEnv") ?? "TELEGRAM_BOT_TOKEN"
    const token = context.env[tokenEnv]

    if (token === undefined || token === "") {
        throw new ConfigError({
            code: "telegram_token_missing",
            message: `Channel "${context.id}" needs ${tokenEnv}, which is not set.`,
            hint: `Export ${tokenEnv}, or add it to the .env beside the manifest. Get a token from @BotFather with /newbot. This fails at load rather than at the first poll, because an unset variable is a configuration mistake and does not need a network round trip to discover.`,
            field: `channels[${context.id}].tokenEnv`,
        })
    }

    const mode = stringField(config, "mode") ?? "longpoll"
    if (mode !== "longpoll" && mode !== "webhook") {
        throw new ConfigError({
            code: "telegram_mode_invalid",
            message: `Channel "${context.id}" declares mode "${mode}".`,
            hint: "mode is longpoll or webhook. Long-poll needs no inbound connectivity and is the right default for a laptop or a private network; webhook needs a public HTTPS URL and is lower latency.",
            field: `channels[${context.id}].mode`,
        })
    }

    const secretEnv = stringField(config, "secretTokenEnv")
    const secretToken = secretEnv === undefined ? undefined : context.env[secretEnv]
    if (secretEnv !== undefined && (secretToken === undefined || secretToken === "")) {
        throw new ConfigError({
            code: "telegram_secret_missing",
            message: `Channel "${context.id}" names secretTokenEnv ${secretEnv}, which is not set.`,
            hint: `Export ${secretEnv} with any random string, or remove secretTokenEnv. Naming a variable and leaving it empty would start a webhook that verifies nothing, which is worse than one that never claimed to.`,
            field: `channels[${context.id}].secretTokenEnv`,
        })
    }

    const baseUrl = stringField(config, "apiBaseUrl")
    const webhookUrl = stringField(config, "webhookUrl")

    return new TelegramTransport({
        id: context.id,
        token,
        mode: mode as TelegramMode,
        ...(webhookUrl === undefined ? {} : { webhookUrl }),
        ...(secretToken === undefined || secretToken === "" ? {} : { secretToken }),
        ...(baseUrl === undefined ? {} : { api: new TelegramApi({ token, baseUrl }) }),
    })
}

function stringField(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = config[key]
    return typeof value === "string" && value !== "" ? value : undefined
}
