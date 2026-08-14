/**
 * The system `ToolProvider`.
 *
 * Everything here is local, so `resolve()` is synchronous in everything but its signature: there is
 * no cache, no network, and no `refresh()`. That is the whole reason this can be a provider rather
 * than a set of built-ins — hard rule 4 forbids network I/O before `runtime.ready`, and a provider
 * with nothing to fetch has nothing to defer.
 *
 * ## Why these are not built into core
 *
 * Core is what an embedder runs *other people's* agents on — VelaOps provisions a container per
 * agent. A shell tool in core is a shell tool every provisioned agent has, with no way for the
 * platform to decline it. As a package it is a line in the embedder's provider table: present in
 * `castellan run`, absent wherever it should be.
 *
 * ## Trust
 *
 * Every tool here returns `untrusted` output and says so explicitly rather than relying on the
 * registry's default for provider tools. A file on disk may have been downloaded five minutes ago;
 * `curl` through `exec` is the entire internet. Declaring it is also what makes the registry's
 * `tool_trust_overridden` warning meaningful — if this package left the field off, the one thing that
 * warning exists to catch would be indistinguishable from a package that simply forgot.
 */

import type { Tool, ToolProvider, ToolProviderContext } from "@castellan/core"
import { execTool } from "./exec.ts"
import { SYSTEM_PROVIDER_ID } from "./paths.ts"
import { ShellSessions } from "./session.ts"

export interface SystemProviderOptions {
    /** The manifest's environment layered over the ambient one. Values, not names. */
    readonly env: Readonly<Record<string, string | undefined>>
}

function normalise(slug: string): string {
    return slug.toLowerCase().replace(/[\s_.-]+/g, "")
}

export class SystemProvider implements ToolProvider {
    readonly id = SYSTEM_PROVIDER_ID

    /**
     * One per provider instance, and a provider instance is one per agent. Two agents in the same
     * runtime therefore never inherit each other's working directory — which they would if this were
     * module state, and which would be a surprising way to leak one agent's activity into another's.
     */
    readonly #sessions = new ShellSessions()
    readonly #tools: readonly Tool[]

    constructor(options: SystemProviderOptions) {
        this.#tools = [execTool({ sessions: this.#sessions, env: options.env })]
    }

    /**
     * Omits what it does not recognise rather than throwing, exactly like the Composio provider: the
     * registry diffs the answer against the request and names every missing slug at once with the
     * nearest match, so failing on the first would report one typo and hide the other three.
     */
    resolve(slugs: readonly string[]): Promise<readonly Tool[]> {
        const wanted = new Set(slugs.map(normalise))
        return Promise.resolve(this.#tools.filter((tool) => wanted.has(normalise(tool.spec.slug))))
    }

    list(): Promise<readonly string[]> {
        return Promise.resolve(this.#tools.map((tool) => tool.spec.slug))
    }
}

/** Slugs a manifest may pin from this provider. */
export const SYSTEM_TOOL_SLUGS: readonly string[] = ["exec"]

export function systemFromConfig(context: ToolProviderContext): SystemProvider {
    return new SystemProvider({ env: context.env })
}
