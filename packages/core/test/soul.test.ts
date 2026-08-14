/**
 * The soul gate: which identity file ships, decided by the model actually configured.
 *
 * The behaviour under test is a *routing* decision — full document, hand-edited compact file, or
 * nothing — and every route is asserted, because the whole point of `onUnmet` is that each of the
 * three is a configured choice rather than a fallback nobody picked.
 */

import { HarnessError } from "../src/errors.ts"
import { planSoul, soulClass, windowRequirementMet } from "../src/workspace/soul.ts"
import { describe, expect, test } from "./_harness.ts"

const FRONTIER = { id: "deepseek-chat", window: 128_000 }
const SMALL = { id: "qwen3.5:9b", window: 32_768 }

function caught(fn: () => unknown): HarnessError {
    try {
        fn()
    } catch (error) {
        if (error instanceof HarnessError) return error
        throw error
    }
    throw new Error("expected a HarnessError, but nothing was thrown")
}

describe("soulClass", () => {
    test("size in the id decides; unsized ids are frontier", () => {
        expect(soulClass("qwen3.5:9b")).toBe("small")
        expect(soulClass("qwen3.5:72b")).toBe("frontier")
        expect(soulClass("deepseek-chat")).toBe("frontier")
        expect(soulClass("claude-opus-5")).toBe("frontier")
        // A mixture activates one expert's worth: 8x7b reads as 7.
        expect(soulClass("mixtral-8x7b")).toBe("small")
    })
})

describe("windowRequirementMet", () => {
    test("every comparator works", () => {
        expect(windowRequirementMet(">=200000", 200_000)).toBe(true)
        expect(windowRequirementMet(">=200000", 199_999)).toBe(false)
        expect(windowRequirementMet(">100", 101)).toBe(true)
        expect(windowRequirementMet("<=100", 100)).toBe(true)
        expect(windowRequirementMet("<100", 99)).toBe(true)
        expect(windowRequirementMet("==128000", 128_000)).toBe(true)
        expect(windowRequirementMet("=128000", 128_000)).toBe(true)
    })

    test("a bare number is refused — the comparator is not guessed", () => {
        const error = caught(() => windowRequirementMet("200000", 128_000))
        expect(error.code).toBe("soul_requirement_invalid")
    })
})

describe("planSoul", () => {
    const soul = (overrides: Record<string, unknown> = {}) => ({
        file: "SOUL.md",
        onUnmet: "distill" as const,
        distilled: "SOUL.compact.md",
        ...overrides,
    })

    test("requirements met: the full document ships as a static ref, no warnings", () => {
        const plan = planSoul(
            soul({ requires: { contextWindow: ">=100000", class: "frontier" as const } }),
            FRONTIER,
            "/ws",
        )
        expect(plan.ref?.name).toBe("SOUL.md")
        expect(plan.ref?.path).toBe("/ws/SOUL.md")
        expect(plan.ref?.tier).toBe("static")
        expect(plan.warnings.length).toBe(0)
    })

    test("no requires means the document always ships", () => {
        const plan = planSoul(soul({ requires: undefined }), SMALL, "/ws")
        expect(plan.ref?.name).toBe("SOUL.md")
    })

    test("unmet + distill ships the compact file and says so", () => {
        const plan = planSoul(soul({ requires: { class: "frontier" as const } }), SMALL, "/ws")
        expect(plan.ref?.name).toBe("SOUL.compact.md")
        expect(plan.ref?.field).toBe("context.soul.distilled")
        expect(plan.warnings.map((w) => w.code)).toEqual(["soul_distilled"])
    })

    test("unmet + distill with no distilled file is a load failure, not a fall-through", () => {
        const error = caught(() =>
            planSoul(
                soul({ requires: { class: "frontier" as const }, distilled: undefined }),
                SMALL,
                "/ws",
            ),
        )
        expect(error.code).toBe("soul_distilled_missing")
    })

    test("unmet + omit ships nothing and warns — silence is not an option", () => {
        const plan = planSoul(
            soul({ requires: { contextWindow: ">=200000" }, onUnmet: "omit" as const }),
            FRONTIER,
            "/ws",
        )
        expect(plan.ref).toBe(undefined)
        expect(plan.warnings.map((w) => w.code)).toEqual(["soul_omitted"])
    })

    test("unmet + fail names every failed requirement in one error", () => {
        const error = caught(() =>
            planSoul(
                soul({
                    requires: { contextWindow: ">=200000", class: "frontier" as const },
                    onUnmet: "fail" as const,
                }),
                SMALL,
                "/ws",
            ),
        )
        expect(error.code).toBe("soul_requirement_unmet")
        expect(error.message).toContain("contextWindow")
        expect(error.message).toContain("class")
    })
})
