/**
 * Which tool providers this binary can supply.
 *
 * One table, consumed by every command that boots a runtime, because the alternative is each command
 * registering its own set — and then `validate` accepts a manifest that `run` refuses, or the reverse.
 * A provider missing from one call site is exactly the class of drift the command table exists to stop.
 *
 * `packages/core` cannot import a provider (hard rule 2), so the binary is where the wiring lives.
 * Phase 9 moves this to the plugin loader and reads it from `plugins` in the manifest; the shape is
 * already the shape a loader would produce.
 *
 * No Ink and no React here — this sits on the shared path that `validate --json` runs through, where
 * a rendering import costs more than the whole command.
 */

import { telegramChannel } from "@castellan/channel-telegram"
import type { ChannelFactory, ScriptRunner, ToolProviderFactory } from "@castellan/core"
import { composioFromConfig } from "@castellan/tools-composio"
import { SystemScriptRunner, systemFromConfig } from "@castellan/tools-system"
import { webFromConfig } from "@castellan/tools-web"

export const TOOL_PROVIDERS: Readonly<Record<string, ToolProviderFactory>> = {
    composio: composioFromConfig,
    // Registered, not implied. Naming `system` here means the binary *can* supply shell access; a
    // manifest still has to select the provider and pin `exec` before an agent has any. Availability
    // and grant are separate on purpose — the same separation that keeps `tools.local` opt-in.
    system: systemFromConfig,
    // Two read-only tools whose entire risk surface is which address they can be pointed at. Listed
    // beside the others rather than folded into `system`: an agent that reads the web and an agent
    // that runs commands are different grants, and a manifest should be able to make one and not the
    // other.
    web: webFromConfig,
}

/**
 * How a skill's script runs, from the one package allowed to start a process.
 *
 * Supplied by every command that builds a runtime, and unconditionally — unlike a tool provider, which a
 * manifest has to select. There is no grant here to be careful with: a script only becomes callable once
 * a skill ships one *and* that skill activates, and both of those are the workspace's decision. Omitting
 * it would mean a skill's `scripts/` is silently never discovered, which reads to whoever wrote the skill
 * as the runtime being broken.
 *
 * `env` is `process.env` rather than the manifest's, because this is constructed before any manifest is
 * loaded. It is used for the `PATH` walk in `has()`; the *run* inherits the process environment the same
 * way `exec` does.
 */
export function scriptRunner(): ScriptRunner {
    return new SystemScriptRunner({ env: process.env })
}

/** For an error that has to say what *is* available. */
export const PROVIDER_IDS: readonly string[] = Object.keys(TOOL_PROVIDERS)

/**
 * Which channel types this binary can supply, keyed by the `type` a manifest names.
 *
 * Registered by every command that loads a manifest, not only by `serve`. A `channels:` entry has to
 * validate the same way everywhere or `validate` would refuse a manifest `serve` runs happily —
 * the asymmetry the tool-provider table already exists to prevent.
 */
export const CHANNELS: Readonly<Record<string, ChannelFactory>> = {
    telegram: telegramChannel,
}

export const CHANNEL_IDS: readonly string[] = Object.keys(CHANNELS)
