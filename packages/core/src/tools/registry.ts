/**
 * The catalogue: which tools exist, resolved once at load.
 *
 * **Resolution happens at load, never per turn, and never by search.** A provider like Composio
 * exposes on the order of twenty thousand tools; letting the model search and then execute is
 * two-hop reasoning, which is precisely where small models fail. So the manifest names what it
 * wants, this resolves it once, and the catalogue is fixed for the process.
 *
 * **An unknown slug fails the load.** The observed failure it replaces: a shared cap across
 * toolkits, a silent auto-cap near twenty "important" tools that starved every write tool, and dead
 * slugs dropped without a word — an agent that boots healthy and cannot act. Here the slug and the
 * provider are named, and nothing is dropped quietly: what the budget trims is reported as a
 * warning the caller emits.
 *
 * The two budget rules read as one but are different in kind:
 *
 * - Pinning **more slugs than the cap** is a configuration error. The manifest asked for something
 *   arithmetically impossible, and only its author can decide what to give up.
 * - Resolution **expanding past the cap** — one toolkit slug yielding thirty tools — is a runtime
 *   fact. That trims, holding `reserveWrite` slots for mutating tools so a large read surface
 *   cannot starve the writes, and says what it dropped.
 */

import {
    type ErrorDetail,
    toolBudgetExceeded,
    toolSlugCollision,
    unknownTool,
    unknownToolAtRuntime,
} from "../errors.ts"
import { localProvider } from "./local.ts"
import type { Tool, ToolProvider, ToolSpec } from "./types.ts"

export interface ToolBudget {
    readonly max: number
    readonly reserveWrite: number
}

export const DEFAULT_TOOL_BUDGET: ToolBudget = { max: 24, reserveWrite: 6 }

export interface DroppedTool {
    readonly slug: string
    readonly reason: string
}

export interface RegistryOptions {
    /** Provider slugs, in priority order. Resolved against `providers`, then the local set. */
    readonly pinned?: readonly string[]
    /** Built-in slugs, resolved against the local provider only. */
    readonly local?: readonly string[]
    readonly budget?: ToolBudget
    /** Consulted in order. The local provider is always consulted first. */
    readonly providers?: readonly ToolProvider[]
}

/** `Send_Email`, `send email` and `send-email` name the same tool. Nothing looser than that. */
function normalise(slug: string): string {
    return slug.toLowerCase().replace(/[\s_.-]+/g, "")
}

export class ToolRegistry {
    readonly #bySlug: ReadonlyMap<string, Tool>
    readonly #byNormalised: ReadonlyMap<string, Tool>
    readonly #order: readonly ToolSpec[]
    readonly dropped: readonly DroppedTool[]
    readonly warnings: readonly ErrorDetail[]

    private constructor(init: {
        tools: readonly Tool[]
        dropped: readonly DroppedTool[]
        warnings: readonly ErrorDetail[]
    }) {
        const bySlug = new Map<string, Tool>()
        const byNormalised = new Map<string, Tool>()
        for (const tool of init.tools) {
            bySlug.set(tool.spec.slug, tool)
            byNormalised.set(normalise(tool.spec.slug), tool)
        }
        this.#bySlug = bySlug
        this.#byNormalised = byNormalised
        this.#order = init.tools.map((tool) => tool.spec)
        this.dropped = init.dropped
        this.warnings = init.warnings
    }

    /** An agent with no tools configured. Distinct from one whose resolution produced nothing. */
    static empty(): ToolRegistry {
        return new ToolRegistry({ tools: [], dropped: [], warnings: [] })
    }

    static async create(options: RegistryOptions): Promise<ToolRegistry> {
        const pinned = options.pinned ?? []
        const local = options.local ?? []
        const budget = options.budget ?? DEFAULT_TOOL_BUDGET
        const providers = options.providers ?? []

        const requested = [...local, ...pinned]
        if (requested.length === 0) return ToolRegistry.empty()

        // Arithmetically impossible before anything is resolved, so it fails before any provider is
        // asked — the answer cannot change with what comes back.
        if (requested.length > budget.max) {
            throw toolBudgetExceeded(requested.length, budget.max)
        }

        const warnings: ErrorDetail[] = []
        const found = new Map<string, Tool>()
        const consulted: string[] = []

        // The local provider is consulted first and for both lists, so a remote provider cannot
        // shadow a built-in — and a genuine clash throws below rather than being resolved silently
        // in someone's favour. `local` is never sent to a remote provider: it names built-ins, and
        // asking Composio to resolve `now` invites it to answer with something else entirely.
        //
        // The third element is the trust default, and it is carried here rather than derived later
        // because **this loop is the only place that knows which provider is the built-in one**.
        // `spec.provider` is a self-report a resolved tool could set to "local", and `provider.id`
        // is chosen by whoever registered the factory — nothing stops an embedder registering one
        // under the id "local". Position is the fact; the strings are claims.
        const trustOverrides: string[] = []
        for (const [provider, slugs, fallback] of [
            [localProvider(), requested, "trusted"] as const,
            ...providers.map((provider) => [provider, pinned, "untrusted"] as const),
        ]) {
            if (slugs.length === 0) continue
            consulted.push(provider.id)
            for (const resolved of await provider.resolve(slugs)) {
                const key = normalise(resolved.spec.slug)
                const existing = found.get(key)
                if (existing !== undefined && existing.spec.provider !== resolved.spec.provider) {
                    throw toolSlugCollision(resolved.spec.slug, [
                        existing.spec.provider,
                        resolved.spec.provider,
                    ])
                }
                if (existing !== undefined) continue

                if (fallback === "untrusted" && resolved.spec.trust === "trusted") {
                    trustOverrides.push(resolved.spec.slug)
                }
                // Normalised once, here, so every consumer downstream reads a settled value and no
                // provider package can ship a trusted email body by forgetting a field.
                found.set(
                    key,
                    resolved.spec.trust === undefined
                        ? { ...resolved, spec: { ...resolved.spec, trust: fallback } }
                        : resolved,
                )
            }
        }

        const missing = requested.filter((slug) => !found.has(normalise(slug)))
        if (missing.length > 0) {
            const first = missing[0] ?? ""
            const pinnedIndex = pinned.indexOf(first)
            throw unknownTool({
                slug: first,
                providers: consulted,
                available: await listAll(providers),
                field:
                    pinnedIndex >= 0
                        ? `tools.pinned[${pinnedIndex}]`
                        : `tools.local[${local.indexOf(first)}]`,
                alsoMissing: missing.slice(1),
            })
        }

        // Manifest order is priority order: what the author listed first is what survives a trim.
        // A slug that expanded into several tools contributes the rest afterwards, in provider order.
        const claimed = new Set<Tool>()
        const ordered: Tool[] = []
        for (const slug of requested) {
            const tool = found.get(normalise(slug))
            if (tool === undefined || claimed.has(tool)) continue
            claimed.add(tool)
            ordered.push(tool)
        }
        const all = [...ordered, ...[...found.values()].filter((tool) => !claimed.has(tool))]

        // Honoured — the embedder chose to run that provider's code — but never silent. Declaring a
        // provider tool trusted opts it out of the delimiter *and* out of the write gate, which is
        // the kind of thing someone should learn at load rather than during an incident.
        if (trustOverrides.length > 0) {
            warnings.push({
                code: "tool_trust_overridden",
                message: `Declared trusted by their provider rather than defaulting to untrusted: ${trustOverrides.join(", ")}.`,
                hint: "A provider tool defaults to untrusted because a provider cannot know what its upstream API returns. Trusted output skips the data delimiter and does not gate a later mutating call, so this is reported rather than taken quietly.",
            })
        }

        const { kept, dropped } = applyBudget(all, budget)
        if (dropped.length > 0) {
            warnings.push({
                code: "tool_budget_trimmed",
                message: `Resolution produced ${all.length} tools for a cap of ${budget.max}; ${dropped.length} were dropped: ${dropped.map((entry) => entry.slug).join(", ")}.`,
                hint: `Raise tools.budget.max, or pin individual slugs instead of a whole toolkit. ${budget.reserveWrite} slots are held for mutating tools so a large read surface cannot starve them.`,
                field: "tools.budget.max",
            })
        }

        const undocumented = kept
            .filter(
                (tool) =>
                    tool.spec.whenNotToUse === undefined || tool.spec.whenNotToUse.trim() === "",
            )
            .map((tool) => tool.spec.slug)
        if (undocumented.length > 0) {
            warnings.push({
                code: "tool_missing_negative_guidance",
                message: `No "do not use when" guidance for: ${undocumented.join(", ")}.`,
                hint: "The catalogue renders a placeholder rather than inventing one. Negative examples are the cheapest routing-accuracy improvement available, so it is worth writing them by hand for the tools an agent gets wrong.",
            })
        }

        return new ToolRegistry({ tools: kept, dropped, warnings })
    }

    get size(): number {
        return this.#order.length
    }

    /** In catalogue order, which is manifest order. Feeds slot 1 and must stay stable. */
    specs(): readonly ToolSpec[] {
        return this.#order
    }

    has(slug: string): boolean {
        return this.#bySlug.has(slug) || this.#byNormalised.has(normalise(slug))
    }

    /**
     * Throws on an unknown slug rather than returning undefined.
     *
     * Silently dropping an unrecognised call is how a config error becomes a runtime mystery: the
     * model calls a tool, nothing happens, no observation comes back, and it tries again forever.
     */
    resolve(slug: string): Tool {
        const exact = this.#bySlug.get(slug)
        if (exact !== undefined) return exact
        const loose = this.#byNormalised.get(normalise(slug))
        if (loose !== undefined) return loose
        throw unknownToolAtRuntime(
            slug,
            this.#order.map((spec) => spec.slug),
        )
    }
}

/**
 * Trim to the cap, holding slots for mutating tools.
 *
 * The reservation is a floor, not a ceiling: with nothing but write tools resolved, they take the
 * whole budget. Its only job is to stop a read surface from crowding them out.
 */
export function applyBudget(
    tools: readonly Tool[],
    budget: ToolBudget,
): { kept: readonly Tool[]; dropped: readonly DroppedTool[] } {
    if (tools.length <= budget.max) return { kept: tools, dropped: [] }

    const reads = tools.filter((tool) => !tool.spec.mutating)
    const writes = tools.filter((tool) => tool.spec.mutating)

    const held = Math.min(writes.length, budget.reserveWrite)
    const keptReads = reads.slice(0, Math.max(0, budget.max - held))
    const keptWrites = writes.slice(0, Math.max(0, budget.max - keptReads.length))

    const keptSet = new Set([...keptReads, ...keptWrites])
    return {
        // Original order, so the catalogue does not reshuffle when one tool falls off the end.
        kept: tools.filter((tool) => keptSet.has(tool)),
        dropped: tools
            .filter((tool) => !keptSet.has(tool))
            .map((tool) => ({
                slug: tool.spec.slug,
                reason: tool.spec.mutating
                    ? `over tools.budget.max (${budget.max}) after the write reservation was filled`
                    : `over tools.budget.max (${budget.max}), with ${held} slots held for mutating tools`,
            })),
    }
}

/** Everything resolvable, for the "did you mean" line. Best-effort: `list` is optional. */
async function listAll(providers: readonly ToolProvider[]): Promise<readonly string[]> {
    const out: string[] = []
    for (const provider of [localProvider(), ...providers]) {
        if (provider.list === undefined) continue
        out.push(...(await provider.list()))
    }
    return out
}
