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

import type { ToolProviderFactory } from "@castellan/core"
import { composioFromConfig } from "@castellan/tools-composio"

export const TOOL_PROVIDERS: Readonly<Record<string, ToolProviderFactory>> = {
    composio: composioFromConfig,
}

/** For an error that has to say what *is* available. */
export const PROVIDER_IDS: readonly string[] = Object.keys(TOOL_PROVIDERS)
