/**
 * Every failure this package can produce, each with a hint.
 *
 * Built on core's `ConfigError` / `ToolError` rather than a local error type, so a Composio failure
 * is reported and rendered exactly like a manifest or a local-tool failure. The package is a provider,
 * not a second error vocabulary.
 */

import { BRAND, ConfigError, ToolError } from "@castellan/core"

export function composioKeyMissing(envVar: string): ConfigError {
    return new ConfigError({
        code: "composio_key_missing",
        message: `The Composio provider needs an API key, and ${envVar} is not set.`,
        hint: `Set ${envVar} in the environment, or in a .env beside the manifest. Change which variable is read with tools.providers.composio.apiKeyEnv — the manifest holds the variable's name, never the key itself.`,
        field: "tools.providers.composio.apiKeyEnv",
    })
}

export function composioSchemaUnsupported(
    slug: string,
    path: string,
    keyword: string,
): ConfigError {
    return new ConfigError({
        code: "composio_schema_unsupported",
        message: `The Composio tool "${slug}" declares "${keyword}" at ${path}, which this runtime's schema subset cannot express.`,
        hint: "Refused rather than dropped: that keyword decides which argument documents are valid, so ignoring it would hand the model a schema the endpoint disagrees with. Unpin this tool, or pin a sibling action with a flatter schema. Value constraints such as minimum and format are not affected — those are carried in the field's description.",
        field: "tools.pinned",
    })
}

export function composioCacheMiss(slugs: readonly string[], cachePath: string): ConfigError {
    return new ConfigError({
        code: "composio_cache_miss",
        message: `${slugs.length === 1 ? "A pinned Composio tool is" : `${slugs.length} pinned Composio tools are`} not in the resolution cache: ${slugs.join(", ")}.`,
        hint: `Boot resolves tools from ${cachePath} and makes no network call, because nothing may touch the network before runtime.ready. Run \`${BRAND.slug} tools <manifest> --warm\` once to populate it, then start again.`,
        field: "tools.pinned",
    })
}

export function composioRequestFailed(status: number, detail: string): ToolError {
    return new ToolError({
        code: "composio_request_failed",
        message: `Composio answered ${status}: ${detail}`,
        hint:
            status === 401 || status === 403
                ? "The API key was rejected. Check the value of the variable named by tools.providers.composio.apiKeyEnv — a key that works in the dashboard can still be scoped to a different project."
                : status === 404
                  ? "The tool slug does not exist at this API version. Slugs are case-sensitive and shaped like GMAIL_SEND_EMAIL; check it against the toolkit listing."
                  : "Transient at this status. The runtime retries the refresh after readiness and keeps serving the cached catalogue meanwhile, so an agent already running is unaffected.",
    })
}

export function composioExecuteFailed(slug: string, status: number, detail: string): ToolError {
    return new ToolError({
        code: "composio_execute_failed",
        message: `Composio could not run "${slug}" (${status}): ${detail}`,
        hint: "This is the tool's own failure, not a routing one — the arguments reached Composio and it refused them. A value constraint is the usual cause: this runtime carries minimum, format and pattern in the field description for the model to read, but does not enforce them locally, so an out-of-range value arrives here rather than as a repairable field error.",
    })
}

export function composioNotConnected(slug: string, toolkit: string): ToolError {
    return new ToolError({
        code: "composio_not_connected",
        message: `"${slug}" needs a connected ${toolkit} account and none was found.`,
        hint: `Connect ${toolkit} for this user in Composio, then set tools.providers.composio.userId to the same identifier. The tool resolves at load whether or not an account exists, because resolution reads a schema and execution needs the account — so this surfaces on first use rather than at boot.`,
    })
}

/**
 * A meta tool was called on an agent whose Composio key is absent.
 *
 * Distinct from `composioKeyMissing`, which is about refreshing or executing a *known* tool. This one
 * fires at the moment someone asks the agent to find an app, which is where the sentence has to
 * explain the whole route rather than name a variable.
 */
export function composioSessionKeyMissing(envVar: string): ToolError {
    return new ToolError({
        code: "composio_session_key_missing",
        message: `Searching your apps needs a Composio key, and ${envVar} is not set.`,
        hint: `Put the key in the .env beside this agent's manifest as ${envVar}=…, then restart. Get one from the Composio dashboard — the free tier is enough to connect an account and search the catalogue.`,
    })
}

/**
 * The search returned nothing for a use case.
 *
 * A failed call rather than an empty observation on purpose: "no results" phrased as data reads to a
 * model as a tool that worked, and it then reports the app does not exist. Composio covers roughly a
 * thousand toolkits, so the far likelier reading is that the phrasing was wrong.
 */
export function composioNoMatch(useCase: string): ToolError {
    return new ToolError({
        code: "composio_no_match",
        message: `No tool matched "${useCase}".`,
        hint: 'Describe the action and its object in plain English — "send an email", "create a calendar event", "post a message to a channel" — rather than naming a product or a tool slug. Composio matches on the use case, not on its own names.',
    })
}
