/**
 * The dialect seam: how tools are described to a model, and how its output is read back.
 *
 * Which dialect runs is **configuration, never detection**. Reading the model id and picking a
 * dialect would mean behaviour changing silently when someone edits `model.main.id` — one code
 * path in production is worth more than the convenience, and a per-provider difference nobody can
 * reproduce is the bug class this avoids.
 *
 * NLT is the default, on published evidence rather than taste: across 14 models and 8,560 trials,
 * +14.9pp accuracy, 93% fewer critical errors, −25% tokens, and +24 to +43pp on small models
 * specifically. Frontier models show smaller or reversed gains, which is what `native` is for.
 */

import type { ContextBlock } from "../../context/blocks.ts"
import type { ChatMessage } from "../../model/provider.ts"
import type { FieldError, ToolIntent, ToolResult, ToolSpec } from "../types.ts"

export type DialectId = "nlt" | "native"

export interface ParsedOutput {
    /** In the order the model wrote them. Empty means the step's text is the final reply. */
    readonly intents: readonly ToolIntent[]
    /** Everything outside the invocation blocks — what the user sees. */
    readonly text: string
}

export interface ToolDialect {
    readonly id: DialectId
    /**
     * Slot 1 of the context, pinned and inside cache breakpoint A. Must be byte-stable for a
     * given catalogue: anything varying per turn here silently destroys prompt caching.
     */
    renderCatalogue(specs: readonly ToolSpec[]): readonly ContextBlock[]
    parse(output: string): ParsedOutput
    /** One message carrying every result from a step, in call order. */
    renderObservation(results: readonly ToolResult[]): ChatMessage
    /** The single repair prompt. There is never a second one. */
    renderRepair(errors: readonly FieldError[]): ChatMessage
}
