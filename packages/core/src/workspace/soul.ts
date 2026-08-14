/**
 * Capability-gated long-form identity. Governed by docs/07-SPEC-WORKSPACE.md.
 *
 * A model-constitution-sized document assumes the model can derive rules the author never wrote.
 * Derivation is exactly what small models cannot do, and a document that size consumes a
 * prohibitive share of a small window while they fail to do it — so the runtime supports the
 * document, gated on the model in front of it.
 *
 * The gate produces a *ref*, not text: whichever file wins — the full document, the hand-edited
 * compact one, or nothing — loads through `loadWorkspace` like any other static file, with the
 * same stripping, the same rendering, and the same budgets. A second loading path for souls would
 * be the code nobody tests.
 *
 * Distillation is never automatic. `onUnmet: distill` ships a file a person edited, because a
 * summariser drops exactly the parts that produce voice.
 */

import { isAbsolute, resolve } from "node:path"
import type { ErrorDetail } from "../errors.ts"
import { soulDistilledMissing, soulRequirementInvalid, soulRequirementUnmet } from "../errors.ts"
import { parameterBillions, SMALL_MODEL_BILLIONS } from "../model/prompt-style.ts"
import type { WorkspaceFileRef } from "./load.ts"

/**
 * The class `requires.class` compares against, derived from the model id.
 *
 * Derived rather than tabulated for the same reason `promptStyle` is: a registry pattern like
 * `qwen3.5*` matches a 9B and a 72B, and those sit on opposite sides of this line. Size predicts
 * whether a model can carry a constitution, and size is in the id. A model whose id names no size
 * is treated as frontier — every hosted frontier model omits it, and a small model mislabelled
 * frontier fails visibly (a worse agent), while the reverse silently withholds a document the
 * model could carry.
 */
export type SoulClass = "frontier" | "small"

export function soulClass(modelId: string): SoulClass {
    const billions = parameterBillions(modelId)
    if (billions === undefined) return "frontier"
    return billions < SMALL_MODEL_BILLIONS ? "small" : "frontier"
}

/** The slice of `context.soul` this module reads. Matches `SoulSchema`. */
export interface SoulGateConfig {
    readonly file: string
    readonly requires?:
        | {
              readonly contextWindow?: string | undefined
              readonly class?: SoulClass | undefined
          }
        | undefined
    readonly onUnmet: "distill" | "omit" | "fail"
    readonly distilled?: string | undefined
}

export interface SoulPlan {
    /** Absent when the gate resolved to shipping nothing (`onUnmet: omit`). */
    readonly ref?: WorkspaceFileRef
    /** Non-fatal findings, surfaced as `agent.warning`. */
    readonly warnings: readonly ErrorDetail[]
}

const WINDOW_REQUIREMENT = /^(>=|<=|==?|>|<)\s*(\d+)$/

/**
 * Check one comparison expression against the resolved window.
 *
 * Exported for `validate`, which wants the parse failure in its aggregated report rather than as
 * a thrown load error — a manifest with a malformed requirement *and* a budget bust should report
 * both.
 */
export function windowRequirementMet(expr: string, window: number): boolean {
    const match = WINDOW_REQUIREMENT.exec(expr.trim())
    if (match === null) throw soulRequirementInvalid(expr)
    const value = Number(match[2])
    switch (match[1]) {
        case ">=":
            return window >= value
        case ">":
            return window > value
        case "<=":
            return window <= value
        case "<":
            return window < value
        default:
            return window === value
    }
}

/**
 * Decide which identity file ships, for the model actually configured.
 *
 * Both `Agent.create` and `validate` call this — a gate only `run` applies is a gate `validate`
 * disagrees with, and the whole point of `onUnmet: fail` is to be told at validation time rather
 * than in production.
 */
export function planSoul(
    soul: SoulGateConfig,
    model: { readonly id: string; readonly window: number },
    workspaceDir: string,
): SoulPlan {
    const reasons: string[] = []

    const required = soul.requires ?? {}
    if (
        required.contextWindow !== undefined &&
        !windowRequirementMet(required.contextWindow, model.window)
    ) {
        reasons.push(
            `requires.contextWindow ${required.contextWindow}, but ${model.id} resolves to ${model.window}`,
        )
    }
    if (required.class !== undefined && soulClass(model.id) !== required.class) {
        reasons.push(
            `requires.class ${required.class}, but ${model.id} derives as ${soulClass(model.id)}`,
        )
    }

    // Same resolution as every other workspace file: against the workspace directory, so the soul
    // and the identity it replaces live side by side.
    const refTo = (name: string, field: string): WorkspaceFileRef => ({
        name,
        path: isAbsolute(name) ? name : resolve(workspaceDir, name),
        tier: "static",
        field,
    })

    if (reasons.length === 0) {
        return { ref: refTo(soul.file, "context.soul.file"), warnings: [] }
    }

    if (soul.onUnmet === "fail") {
        throw soulRequirementUnmet({ file: soul.file, reasons })
    }

    if (soul.onUnmet === "omit") {
        return {
            warnings: [
                {
                    code: "soul_omitted",
                    message: `${soul.file} was omitted: ${reasons.join("; ")}.`,
                    hint: "onUnmet: omit ships nothing when the requirements fail. If the agent should still carry a compact identity on this model, name one in context.soul.distilled and set onUnmet: distill.",
                    field: "context.soul",
                },
            ],
        }
    }

    // distill: ship the hand-edited compact file. Its absence is an error even though the author
    // could add it later — a manifest that only works on models it was not written for is a latent
    // failure, and latent failures are found in production by someone else.
    if (soul.distilled === undefined) {
        throw soulDistilledMissing(soul.file)
    }
    return {
        ref: refTo(soul.distilled, "context.soul.distilled"),
        warnings: [
            {
                code: "soul_distilled",
                message: `${soul.file} was replaced by ${soul.distilled}: ${reasons.join("; ")}.`,
                hint: "onUnmet: distill ships the hand-edited compact file to models that cannot carry the full document. This is the configured behaviour, reported so nobody wonders which identity the agent is running on.",
                field: "context.soul",
            },
        ],
    }
}
