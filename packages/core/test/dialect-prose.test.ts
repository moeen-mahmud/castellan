/**
 * `proseOf` — what a person saw of an assistant message, given the dialect that wrote it.
 *
 * The format is not written down here twice. A fixture that guesses the ACTION shape is the mistake
 * this repo has already made once: a helper built `ACTION` with a `tool:` field, the block parsed as
 * prose, and the resulting turn had one request and no tool call — indistinguishable from a model that
 * declined to call anything. So every block below is asserted to be a real call by `parseNlt` first.
 */

import type { ChatMessage } from "../src/model/provider.ts"
import { parseNlt } from "../src/tools/dialect/nlt.ts"
import { proseOf } from "../src/tools/dialect/prose.ts"
// `_harness` rather than `bun:test`: core's tests run under Node's runner too, which is what proves
// the sqlite adapter. A direct `bun:test` import fails there with an unsupported URL scheme, so it
// quietly opts the file out of half the guarantee.
import { describe, expect, test } from "./_harness.ts"

function assistant(content: string): ChatMessage {
    return { role: "assistant", content, origin: "call" }
}

/** A real NLT call, per the preamble in `nlt.ts`. Verified as one before it is used. */
const CALL = ["ACTION: file_read", "path: notes.md", "END"].join("\n")

describe("proseOf", () => {
    test("the fixture really is a call, not prose that looks like one", () => {
        const parsed = parseNlt(CALL)
        expect(parsed.intents.length).toBe(1)
        expect(parsed.intents[0]?.slug).toBe("file_read")
    })

    test("keeps the narration and drops the block", () => {
        // The defect: a live session shows "Let me look that up." as it streams, and a resumed one
        // showed nothing for this turn at all, because the whole row was excluded by origin.
        const message = assistant(`Let me look that up.\n\n${CALL}`)
        expect(proseOf(message, "nlt")).toBe("Let me look that up.")
    })

    test("a step that called a tool and said nothing yields the empty string", () => {
        // Which is what lets the caller drop it rather than painting a blank message.
        expect(proseOf(assistant(CALL), "nlt")).toBe("")
    })

    test("prose after the block is kept too, not just prose before it", () => {
        const message = assistant(`Checking.\n\n${CALL}\n\nThat should do it.`)
        expect(proseOf(message, "nlt")).toContain("Checking.")
        expect(proseOf(message, "nlt")).toContain("That should do it.")
        expect(proseOf(message, "nlt")).not.toContain("ACTION")
    })

    test("an ordinary reply is returned unchanged", () => {
        expect(proseOf({ role: "assistant", content: "  The answer is 4.  " }, "nlt")).toBe(
            "The answer is 4.",
        )
    })

    test("native content is already prose and is not parsed", () => {
        // Native puts the call in `toolCalls`, so text that merely *looks* like an ACTION block under
        // native is content the model wrote for the person to read — stripping it would be the runtime
        // editing a reply, which is what decision 4.19 forbids.
        const message: ChatMessage = { role: "assistant", content: CALL, origin: "call" }
        expect(proseOf(message, "native")).toBe(CALL)
    })

    test("a non-assistant message is never touched by either dialect", () => {
        // An observation is a `user` message under NLT whose body a stranger may have written. Parsing
        // it would be looking for calls in untrusted text.
        const observation: ChatMessage = {
            role: "user",
            content: `OBSERVATION file_read — ok\n${CALL}`,
            origin: "observation",
        }
        expect(proseOf(observation, "nlt")).toBe(observation.content)
    })
})
