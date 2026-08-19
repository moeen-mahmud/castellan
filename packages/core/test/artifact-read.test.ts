/**
 * `artifact_read`, against a real store.
 *
 * The model-driven half of this cannot be tested here and should not be: a live deepseek session was
 * asked to follow a marker and never emitted a readable call, which measures the model and the dialect
 * rather than the retrieval. The same split the injection eval documents — the eval measures the model
 * and cannot measure the gate, so the gate is proven deterministically. This is the gate.
 */

import { UNCALIBRATED } from "../src/context/budget.ts"
import { displacedId } from "../src/context/compaction/stages.ts"
import { HarnessError } from "../src/errors.ts"
import { openMemoryStore } from "../src/store/sqlite/store.ts"
import { localProvider, toolContext } from "../src/tools/local.ts"
import type { Tool } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

const AGENT = "test"
const SESSION = "local:abc123"

async function artifactRead(): Promise<Tool> {
    const tools = await localProvider().resolve(["artifact_read"])
    const tool = tools[0]
    if (tool === undefined) throw new Error("artifact_read is not in the local provider")
    return tool
}

/** A store with one session and one displaced observation in it. */
async function storeWith(content: string) {
    const store = await openMemoryStore()
    await store.sessions.ensure(AGENT, SESSION)
    const id = displacedId(content)
    await store.artifacts.put(
        AGENT,
        SESSION,
        [{ id, slug: "exec", content, tokens: 1058 }],
        new Date().toISOString(),
    )
    return { store, id }
}

function contextFor(store: Awaited<ReturnType<typeof openMemoryStore>>) {
    return toolContext({
        readArtifact: async (id) => {
            const found = await store.artifacts.get(AGENT, SESSION, id)
            if (found === undefined) return undefined
            return {
                content: found.content,
                tokens: found.tokens,
                ...(found.slug === undefined ? {} : { slug: found.slug }),
            }
        },
    })
}

describe("reading a displaced observation back", () => {
    test("returns it whole when it fits, naming the tool and the size", async () => {
        const { store, id } = await storeWith("OBSERVATION exec — ok\n1 2 3 4 5")
        const tool = await artifactRead()
        const observation = await tool.handler({ id }, contextFor(store))
        expect(observation).toContain("Compacted exec observation, 1058 tokens")
        expect(observation).toContain("1 2 3 4 5")
        expect(observation).not.toContain("cut here")
        await store.close()
    })

    test("a large one is paged, and says the exact offset to continue from", async () => {
        // The lesson `config_read` paid for: an observation over `observationMaxTokens` is middle-cut
        // by the executor, and a middle-cut reference document makes a model read it again. A tool
        // whose whole job is retrieving something large has to page.
        const big = `OBSERVATION exec — ok\n${"x".repeat(9000)}`
        const { store, id } = await storeWith(big)
        const tool = await artifactRead()
        const context = contextFor(store)

        // Followed to the end, the way a model would: each page states the offset for the next, and
        // the last one carries no marker. Three pages here, not two — an assumption of two was the
        // first version of this test and 9,022 characters do not fit in it.
        const body = (text: string) => {
            const after = text.slice(text.indexOf("\n") + 1)
            const cut = after.indexOf("\n\n[cut here")
            return cut === -1 ? after : after.slice(0, cut)
        }
        let page = await tool.handler({ id }, context)
        let collected = body(page)
        let pages = 1
        while (page.includes("cut here")) {
            const match = /from: (\d+)\)/.exec(page)
            if (match === null) throw new Error("a cut page must state the offset to continue from")
            page = await tool.handler({ id, from: Number(match[1]) }, context)
            collected += body(page)
            pages += 1
            if (pages > 10) throw new Error("paging did not terminate")
        }
        expect(pages).toBe(3)
        // Every character accounted for, with no gap and no repetition — which is what makes this a
        // retrieval rather than a truncation with extra steps.
        expect(collected).toBe(big)
        await store.close()
    })

    test("an id from another conversation is not readable from this one", async () => {
        const { store, id } = await storeWith("OBSERVATION exec — ok\nsecret")
        const tool = await artifactRead()
        const isolated = toolContext({
            // Scoped by the seam, which is the only place that can be true or false. A tool handed the
            // store itself could read another session's history.
            readArtifact: async (wanted) => {
                const found = await store.artifacts.get(AGENT, "local:other", wanted)
                return found === undefined ? undefined : { content: found.content, tokens: 1 }
            },
        })
        await expect(Promise.resolve(tool.handler({ id }, isolated))).rejects.toThrow(
            "No compacted observation",
        )
        await store.close()
    })

    test("a runtime with no store says so rather than reporting an empty artifact", async () => {
        const tool = await artifactRead()
        // `toolContext()` with no seam is what `previewContext` and a bare test have. Returning ""
        // here would tell the model the observation was empty, which is a different and wrong fact.
        await expect(
            Promise.resolve(tool.handler({ id: "obs_x_y" }, toolContext())),
        ).rejects.toThrow("no artifact store")
    })

    test("both refusals carry a hint", async () => {
        const tool = await artifactRead()
        for (const [args, context] of [
            [{ id: "obs_x_y" }, toolContext()],
            [{ id: "obs_missing" }, contextFor((await storeWith("x")).store)],
        ] as const) {
            try {
                await tool.handler(args, context)
                throw new Error("expected a refusal")
            } catch (error) {
                if (!(error instanceof HarnessError)) throw error
                expect(error.hint.length).toBeGreaterThan(20)
            }
        }
    })
})

describe("the store keeps a derived identity", () => {
    test("writing the same observation twice is one row", async () => {
        const content = "OBSERVATION exec — ok\nthe same bytes"
        const { store, id } = await storeWith(content)
        await store.artifacts.put(
            AGENT,
            SESSION,
            [{ id, slug: "exec", content, tokens: 1058 }],
            new Date().toISOString(),
        )
        // Verified live: three byte-identical `seq 1 900` observations across three turns produced one
        // artifact row, because the id is derived from the content and the insert ignores a collision.
        expect((await store.artifacts.list(AGENT, SESSION)).length).toBe(1)
        expect(UNCALIBRATED.samples).toBe(0)
        await store.close()
    })
})
