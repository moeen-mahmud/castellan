/**
 * The NLT parser and catalogue.
 *
 * This is the file that earns the dialect. Every tolerance below is a shape a real model produced —
 * a bullet in front of the keyword, a forgotten `END`, a code fence wrapped round the whole thing —
 * and each one refused would have cost a repair step on punctuation rather than on meaning. The
 * cases that assert what is *not* tolerated matter just as much: a `>>>` inside a heredoc is
 * content, and prose after a blank line is the reply rather than an argument.
 */

import { nltDialect, parseNlt, renderNltEntry } from "../src/tools/dialect/nlt.ts"
import type { ToolResult, ToolSpec } from "../src/tools/types.ts"
import { describe, expect, test } from "./_harness.ts"

const SPEC: ToolSpec = {
    slug: "send_email",
    provider: "test",
    summary: "Sends an email from the owner's mailbox.",
    whenToUse: "the person asks you to email or reply to someone",
    whenNotToUse: "they only want a draft, or have not named a recipient",
    mutating: true,
    tags: ["write"],
    parameters: {
        type: "object",
        properties: {
            to: { type: "string", description: "recipient address" },
            subject: { type: "string" },
            body: { type: "string", description: "plain text" },
            copies: { type: "integer", default: 1 },
            urgent: { type: "boolean" },
            labels: { type: "array", items: { type: "string" } },
            mode: { type: "string", enum: ["draft", "send"] },
        },
        required: ["to", "subject", "body"],
    },
}

describe("the parser finds blocks", () => {
    test("a reply with no block is all text", () => {
        const parsed = parseNlt("Nothing to do here — the answer is 4.")
        expect(parsed.intents).toEqual([])
        expect(parsed.text).toBe("Nothing to do here — the answer is 4.")
    })

    test("one block, one field", () => {
        const parsed = parseNlt("ACTION: now\ntimezone: UTC\nEND")
        expect(parsed.intents).toEqual([{ callId: "c1", slug: "now", args: { timezone: "UTC" } }])
        expect(parsed.text).toBe("")
    })

    test("several fields keep their written names", () => {
        const parsed = parseNlt("ACTION: send_email\nTo: a@b.com\nSubject: Hi\nEND")
        expect(parsed.intents[0]?.args).toEqual({ To: "a@b.com", Subject: "Hi" })
    })

    test("two blocks run in the order written, with deterministic call ids", () => {
        const parsed = parseNlt("ACTION: now\nEND\nACTION: memory_write\ntext: hello\nEND")
        expect(parsed.intents.map((intent) => `${intent.callId}:${intent.slug}`)).toEqual([
            "c1:now",
            "c2:memory_write",
        ])
    })

    test("text before and after a block is the reply", () => {
        const parsed = parseNlt("Let me check.\nACTION: now\nEND\nThat is the time.")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.text).toBe("Let me check.\nThat is the time.")
    })

    test("a missing END is closed by the end of the output", () => {
        const parsed = parseNlt("ACTION: now\ntimezone: UTC")
        expect(parsed.intents).toEqual([{ callId: "c1", slug: "now", args: { timezone: "UTC" } }])
    })

    test("a missing END is closed by the next ACTION", () => {
        const parsed = parseNlt("ACTION: now\ntimezone: UTC\nACTION: memory_write\ntext: x")
        expect(parsed.intents.map((intent) => intent.slug)).toEqual(["now", "memory_write"])
        expect(parsed.intents[0]?.args).toEqual({ timezone: "UTC" })
    })

    test("an ACTION line with no tool name is ignored rather than guessed at", () => {
        const parsed = parseNlt("ACTION:\nnothing here")
        expect(parsed.intents).toEqual([])
    })

    test("CRLF is one line break, not two", () => {
        const parsed = parseNlt("ACTION: now\r\ntimezone: UTC\r\nEND\r\n")
        expect(parsed.intents[0]?.args).toEqual({ timezone: "UTC" })
    })
})

describe("the parser tolerates how models write", () => {
    test.each([
        ["action: now", "lower case keyword"],
        ["Action: now", "title case keyword"],
        ["ACTION: now", "upper case keyword"],
        ["ACTION:now", "no space after the colon"],
        ["  ACTION: now  ", "leading and trailing space"],
        ["- ACTION: now", "a dash bullet"],
        ["* ACTION: now", "a star bullet"],
        ["1. ACTION: now", "a numbered list"],
        ["ACTION: `now`", "backticks round the tool name"],
        ['ACTION: "now"', "quotes round the tool name"],
        ["ACTION: now.", "a trailing full stop"],
    ])("%s is a call (%s)", (line) => {
        const parsed = parseNlt(`${line}\nEND`)
        expect(parsed.intents.map((intent) => intent.slug)).toEqual(["now"])
    })

    test("a bulleted field is a field", () => {
        const parsed = parseNlt("ACTION: send_email\n- to: a@b.com\n* subject: Hi\nEND")
        expect(parsed.intents[0]?.args).toEqual({ to: "a@b.com", subject: "Hi" })
    })

    test("a value containing a colon keeps all of it", () => {
        const parsed = parseNlt("ACTION: send_email\nsubject: Re: your message\nEND")
        expect(parsed.intents[0]?.args).toEqual({ subject: "Re: your message" })
    })

    test("blank lines between fields are ignored", () => {
        const parsed = parseNlt("ACTION: send_email\nto: a@b.com\n\nsubject: Hi\nEND")
        expect(parsed.intents[0]?.args).toEqual({ to: "a@b.com", subject: "Hi" })
    })

    test("a repeated key becomes a list of what was written", () => {
        // Not an error: this is how a model writes a list when it has forgotten the heredoc.
        const parsed = parseNlt("ACTION: send_email\nlabels: work\nlabels: urgent\nEND")
        expect(parsed.intents[0]?.args).toEqual({ labels: ["work", "urgent"] })
    })

    test("a bare line straight after a field continues that field", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: first\nsecond\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "first\nsecond" })
    })

    test("prose after a blank line is the reply, not the last field", () => {
        // The failure this prevents: an unterminated block swallowing the sentence meant for the
        // person and sending it to a tool as an argument.
        const parsed = parseNlt("ACTION: send_email\nto: a@b.com\n\nI have sent that for you.")
        expect(parsed.intents[0]?.args).toEqual({ to: "a@b.com" })
        expect(parsed.text).toBe("I have sent that for you.")
    })

    test("a wrapping code fence is not part of the reply", () => {
        const parsed = parseNlt("Sure.\n```\nACTION: now\nEND\n```")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.text).toBe("Sure.")
    })

    test("a tagged fence wrapping the block is dropped too", () => {
        const parsed = parseNlt("```text\nACTION: now\nEND\n```")
        expect(parsed.intents.length).toBe(1)
        expect(parsed.text).toBe("")
    })

    test("a fence in the reply itself survives", () => {
        // The reply is what the person reads. Eating their code block to be tidy is worse than
        // carrying a stray fence.
        const parsed = parseNlt("Here is the snippet:\n```ts\nconst x = 1\n```")
        expect(parsed.intents).toEqual([])
        expect(parsed.text).toBe("Here is the snippet:\n```ts\nconst x = 1\n```")
    })
})

describe("heredocs", () => {
    test("carry several lines verbatim", () => {
        const parsed = parseNlt(
            "ACTION: send_email\nbody: <<<\nLine one.\n  indented\n\nLast.\n>>>\nEND",
        )
        expect(parsed.intents[0]?.args).toEqual({ body: "Line one.\n  indented\n\nLast." })
    })

    test("a line merely containing the terminator is content", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\na >>> b\n>>>\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "a >>> b" })
    })

    test("a key line inside a heredoc is content, not a field", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nsubject: not a field\n>>>\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "subject: not a field" })
    })

    test("a forgotten terminator is closed by END rather than swallowing the output", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nhello\nEND\nAll done.")
        expect(parsed.intents[0]?.args).toEqual({ body: "hello" })
        expect(parsed.text).toBe("All done.")
    })

    test("a forgotten terminator is closed by the next ACTION", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nhello\nACTION: now\nEND")
        expect(parsed.intents.map((intent) => intent.slug)).toEqual(["send_email", "now"])
        expect(parsed.intents[0]?.args).toEqual({ body: "hello" })
    })

    test("an empty heredoc is an empty value, not a missing one", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\n>>>\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "" })
    })

    test("fields after a heredoc are still fields", () => {
        const parsed = parseNlt("ACTION: send_email\nbody: <<<\nhi\n>>>\nto: a@b.com\nEND")
        expect(parsed.intents[0]?.args).toEqual({ body: "hi", to: "a@b.com" })
    })
})

describe("the catalogue", () => {
    test("renders prose with a negative example", () => {
        const entry = renderNltEntry(SPEC)
        expect(entry).toContain("### send_email")
        expect(entry).toContain("Use when: the person asks")
        expect(entry).toContain("Do NOT use when: they only want a draft")
    })

    test("marks a mutating tool on its own line, never beside the name", () => {
        // Anything appended to the header is something a model will copy into `ACTION:` verbatim.
        const entry = renderNltEntry(SPEC)
        expect(entry).toContain("### send_email\n")
        expect(entry).toContain("Changes state: yes")
    })

    test("says so plainly when a provider supplied no negative guidance", () => {
        const { whenNotToUse: _omitted, ...bare } = SPEC
        const entry = renderNltEntry(bare)
        expect(entry).toContain("Do NOT use when: no guidance was supplied")
    })

    test("names required fields, types other than string, enums and defaults", () => {
        const entry = renderNltEntry(SPEC)
        expect(entry).toContain("to")
        expect(entry).toMatch(/to\s+\(required\) recipient address/)
        expect(entry).toMatch(/copies\s+\(optional, integer\) defaults to 1/)
        expect(entry).toMatch(/mode\s+\(optional\) one of: draft \| send/)
        expect(entry).toMatch(/labels\s+\(optional, list of string\)/)
    })

    test("a tool with no fields says so, rather than leaving an empty heading", () => {
        const entry = renderNltEntry({
            ...SPEC,
            slug: "ping",
            parameters: { type: "object", properties: {} },
        })
        expect(entry).toContain("Fields: none")
    })

    test("goes in slot 1, pinned, and teaches the format", () => {
        const blocks = nltDialect.renderCatalogue([SPEC])
        expect(blocks.length).toBe(1)
        expect(blocks[0]?.slot).toBe(1)
        expect(blocks[0]?.pinned).toBe(true)
        expect(blocks[0]?.content).toContain("ACTION: tool_name")
        expect(blocks[0]?.content).toContain("### send_email")
    })

    test("an empty catalogue renders nothing at all", () => {
        // Not an empty block: slot 1 with a "you have no tools" preamble is tokens spent on every
        // turn to say nothing, and it invites a model to invent one.
        expect(nltDialect.renderCatalogue([])).toEqual([])
    })

    test("is byte-identical when rendered twice — slot 1 is the cached prefix", () => {
        const first = nltDialect.renderCatalogue([SPEC])[0]?.content
        const second = nltDialect.renderCatalogue([SPEC])[0]?.content
        expect(first).toBe(second)
    })
})

describe("observations and repairs", () => {
    const result = (over: Partial<ToolResult> = {}): ToolResult => ({
        callId: "c1",
        slug: "now",
        ok: true,
        output: "2026-08-13T00:00:00.000Z",
        latencyMs: 1,
        bytes: 24,
        truncated: false,
        ...over,
    })

    test("one message carries every result from the step, in order", () => {
        const message = nltDialect.renderObservation([
            result(),
            result({ callId: "c2", slug: "memory_write", ok: false, output: "nope" }),
        ])
        expect(message.role).toBe("user")
        expect(message.content).toContain("OBSERVATION now — ok")
        expect(message.content).toContain("OBSERVATION memory_write — failed")
        expect(message.content.indexOf("now")).toBeLessThan(message.content.indexOf("memory_write"))
    })

    test("a tool that returned nothing says so, rather than looking like a blank success", () => {
        const message = nltDialect.renderObservation([result({ output: "   " })])
        expect(message.content).toContain("(no output)")
    })

    test("a repair quotes each field error and says it is the only retry", () => {
        const message = nltDialect.renderRepair([
            { field: "to", message: "is required but was not given.", hint: "Add a line `to: …`." },
        ])
        expect(message.content).toContain("to: is required but was not given.")
        expect(message.content).toContain("only retry")
    })
})
