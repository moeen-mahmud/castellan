/**
 * The NLT parser and catalogue.
 *
 * This is the file that earns the dialect. Every tolerance below is a shape a real model produced —
 * a bullet in front of the keyword, a forgotten `END`, a code fence wrapped round the whole thing —
 * and each one refused would have cost a repair step on punctuation rather than on meaning. The
 * cases that assert what is *not* tolerated matter just as much: a `>>>` inside a heredoc is
 * content, and prose after a blank line is the reply rather than an argument.
 */

import type { ChatMessage } from "../src/model/provider.ts"
import type { StepOutput } from "../src/tools/dialect/dialect.ts"
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
        expect(blocks[0]?.content).toContain("ACTION: weather_lookup")
        expect(blocks[0]?.content).toContain("### send_email")
    })

    test("the example we tell a model to copy is one our own parser accepts", () => {
        // Self-referential on purpose: the format documentation and the parser cannot drift apart if
        // the documentation is run through the parser. The catalogue is prose with exactly one block
        // in it, so anything else parsing as a block means the surrounding text has become ambiguous.
        const content = nltDialect.renderCatalogue([SPEC])[0]?.content ?? ""
        const parsed = parseNlt(content)
        expect(parsed.intents.length).toBe(1)
        expect(parsed.intents[0]?.slug).toBe("weather_lookup")
        expect(Object.keys(parsed.intents[0]?.args ?? {})).toEqual(["city", "units"])
    })

    test("the example never uses the words `field` or `value` as field names", () => {
        // The regression this exists for: `ACTION: tool_name` / `field: value` reads as metasyntax to a
        // large model and as instruction to a small one. qwen3.5:9b copied it literally in 25 of 37
        // fixtures, reasoning correctly about the tool and then encoding every argument through the
        // placeholder words. It cost NLT 65 points against native and looked like a dialect result.
        const keys = Object.keys(
            parseNlt(nltDialect.renderCatalogue([SPEC])[0]?.content ?? "").intents[0]?.args ?? {},
        )
        expect(keys.includes("field")).toBe(false)
        expect(keys.includes("value")).toBe(false)
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

describe("the stream filter", () => {
    /** Feed a whole output through in fixed-size chunks, as a stream would arrive. */
    function stream(output: string, chunk = 3): string {
        const filter = nltDialect.createStreamFilter()
        let shown = ""
        for (let i = 0; i < output.length; i += chunk) {
            shown += filter.push(output.slice(i, i + chunk))
        }
        return shown + filter.end()
    }

    const CASES: readonly [string, string][] = [
        ["plain prose", "The answer is 4."],
        ["prose over several lines", "First line.\nSecond line."],
        ["a call and nothing else", "ACTION: now\nEND"],
        ["narration then a call", "Let me check.\nACTION: now\nEND"],
        ["a call then an answer", "ACTION: now\nEND\nIt is nine."],
        ["two calls", "ACTION: now\nEND\nACTION: memory_write\ntext: hi\nEND"],
        ["a heredoc", "ACTION: send_email\nbody: <<<\nline one\nline two\n>>>\nEND"],
        ["a wrapped call", "Sure.\n```\nACTION: now\nEND\n```"],
        ["a fence in the reply", "Here:\n```ts\nconst x = 1\n```"],
        ["a bulleted call", "- ACTION: now\nEND"],
        ["prose beginning with A", "A good question."],
        ["prose beginning with a dash", "- a bullet in the reply"],
        ["an unterminated block then prose", "ACTION: now\ntimezone: UTC\n\nAll done."],
        ["a call with no END at all", "ACTION: now\ntimezone: UTC"],
    ]

    // The property that matters: what the person watches must be exactly what the parser calls the
    // reply. Any divergence means the screen and the transcript disagree about what was said.
    test.each(CASES)("%s streams to exactly what parse calls the reply", (_name, output) => {
        expect(stream(output)).toBe(parseNlt(output).text)
    })

    test.each(CASES)("%s is the same at a one-character chunk size", (_name, output) => {
        expect(stream(output, 1)).toBe(parseNlt(output).text)
    })

    test.each(CASES)("%s is the same when it arrives in one chunk", (_name, output) => {
        expect(stream(output, 10_000)).toBe(parseNlt(output).text)
    })

    test("no part of an invocation block is ever shown", () => {
        const filter = nltDialect.createStreamFilter()
        let shown = ""
        for (const char of "Checking.\nACTION: send_email\nto: a@b.com\nEND\nSent.") {
            shown += filter.push(char)
        }
        shown += filter.end()
        expect(shown.includes("ACTION")).toBe(false)
        expect(shown.includes("a@b.com")).toBe(false)
        expect(shown.includes("END")).toBe(false)
        expect(shown).toBe("Checking.\nSent.")
    })

    test("mid-line prose is not held back", () => {
        // The reason this matters: a reply is usually one long line, so waiting for the newline would
        // make the whole answer appear at once and streaming would be decorative.
        const filter = nltDialect.createStreamFilter()
        filter.push("The answer ")
        expect(filter.push("is 4")).toBe("is 4")
    })

    test("a line that could still become a call is held, then released", () => {
        const filter = nltDialect.createStreamFilter()
        expect(filter.push("ACT")).toBe("")
        expect(filter.push("ually, no.")).toBe("ACTually, no.")
    })

    test("a filter is per turn — a fresh one starts outside any block", () => {
        // Reusing one across turns would leave the next turn inside whatever block this one ended in,
        // and its reply would vanish entirely.
        const first = nltDialect.createStreamFilter()
        first.push("ACTION: now\n")
        expect(first.push("timezone: UTC\n")).toBe("")

        const second = nltDialect.createStreamFilter()
        expect(second.push("Hello")).toBe("Hello")
    })

    test("a line break waits until something follows it", () => {
        // It cannot be shown when it arrives: a break at the end of the reply is trailing whitespace
        // the transcript does not have, and there is no way to un-emit it.
        const filter = nltDialect.createStreamFilter()
        expect(filter.push("First.\n")).toBe("First.")
        expect(filter.push("Second.")).toBe("\nSecond.")
        expect(filter.end()).toBe("")
    })

    test("CRLF does not leak a carriage return into the reply", () => {
        expect(stream("Hello.\r\nGoodbye.\r\n")).toBe("Hello.\nGoodbye.")
    })

    /** Every step's output through one filter, as a multi-step turn arrives. */
    function streamSteps(steps: readonly string[], chunk = 3): string {
        const filter = nltDialect.createStreamFilter()
        let shown = ""
        for (const [index, step] of steps.entries()) {
            for (let i = 0; i < step.length; i += chunk) {
                shown += filter.push(step.slice(i, i + chunk))
            }
            if (index < steps.length - 1) shown += filter.endStep()
        }
        return shown + filter.end()
    }

    /** How `runTurn` joins each step's prose into the reply. The filter has to match it exactly. */
    function joinSteps(steps: readonly string[]): string {
        return steps
            .map((step) => parseNlt(step).text)
            .filter((text) => text !== "")
            .join("\n\n")
    }

    const TURNS: readonly [string, readonly string[]][] = [
        ["a call then an answer", ["ACTION: now\nEND", "It is nine."]],
        ["narration, a call, an answer", ["Let me check.\nACTION: now\nEND", "It is nine."]],
        ["two tool steps then an answer", ["ACTION: now\nEND", "ACTION: now\nEND", "Both done."]],
        [
            "narration on every step",
            [
                "First I check.\nACTION: now\nEND",
                "Now I save.\nACTION: memory_write\ntext: x\nEND",
                "Done.",
            ],
        ],
        ["a step that says nothing at all", ["ACTION: now\nEND", "", "Answer."]],
    ]

    test.each(TURNS)("%s streams to exactly what the turn calls the reply", (_name, steps) => {
        expect(streamSteps(steps)).toBe(joinSteps(steps))
    })

    test.each(TURNS)("%s is the same one character at a time", (_name, steps) => {
        expect(streamSteps(steps, 1)).toBe(joinSteps(steps))
    })

    test("an unterminated block does not continue into the next step", () => {
        // A step's output is parsed on its own. Carrying the block across would swallow the next
        // step's reply entirely, and the turn would look like it produced nothing.
        const filter = nltDialect.createStreamFilter()
        filter.push("ACTION: memory_write\ntext: no end marker")
        filter.endStep()
        expect(filter.push("Saved it.")).toBe("Saved it.")
    })

    test("the step break is dropped when the next step is silent", () => {
        const filter = nltDialect.createStreamFilter()
        expect(filter.push("All I have to say.")).toBe("All I have to say.")
        expect(filter.endStep()).toBe("")
        expect(filter.push("ACTION: now\nEND")).toBe("")
        expect(filter.end()).toBe("")
    })
})

describe("observations and repairs", () => {
    const result = (over: Partial<ToolResult> = {}): ToolResult => ({
        callId: "c1",
        slug: "now",
        ok: true,
        output: "2026-08-13T00:00:00.000Z",
        trust: "trusted",
        latencyMs: 1,
        bytes: 24,
        truncated: false,
        ...over,
    })

    /**
     * The dialect returns a list, because `native` needs one `tool` message per call. NLT deliberately
     * returns exactly one however many results there were — one per result would repeat the "continue
     * or reply" instruction after every observation, which is most of what that message is for.
     */
    function onlyMessage(messages: readonly ChatMessage[]): ChatMessage {
        expect(messages.length).toBe(1)
        const [message] = messages
        if (message === undefined) throw new Error("expected exactly one message")
        return message
    }

    const NO_CALLS: StepOutput = { text: "", calls: [] }

    test("one message carries every result from the step, in order", () => {
        const message = onlyMessage(
            nltDialect.renderObservation([
                result(),
                result({ callId: "c2", slug: "memory_write", ok: false, output: "nope" }),
            ]),
        )
        expect(message.role).toBe("user")
        expect(message.content).toContain("OBSERVATION now — ok")
        expect(message.content).toContain("OBSERVATION memory_write — failed")
        expect(message.content.indexOf("now")).toBeLessThan(message.content.indexOf("memory_write"))
    })

    test("a tool that returned nothing says so, rather than looking like a blank success", () => {
        const message = onlyMessage(nltDialect.renderObservation([result({ output: "   " })]))
        expect(message.content).toContain("(no output)")
    })

    test("a repair quotes each field error and says it is the only retry", () => {
        const message = onlyMessage(
            nltDialect.renderRepair(
                [
                    {
                        field: "to",
                        message: "is required but was not given.",
                        hint: "Add a line `to: …`.",
                    },
                ],
                NO_CALLS,
            ),
        )
        expect(message.content).toContain("to: is required but was not given.")
        expect(message.content).toContain("only retry")
    })

    test("the assistant message replays the raw text, blocks and all", () => {
        // Not the cleaned-up prose: the text *is* the call under NLT, and a history that dropped the
        // block would leave the observation after it explaining nothing.
        const raw = "Let me check.\nACTION: now\nEND"
        expect(nltDialect.renderCall({ text: raw, calls: [] })).toEqual({
            role: "assistant",
            content: raw,
        })
    })

    test("nothing is added to the request — the protocol is the text", () => {
        expect(nltDialect.requestTools([SPEC])).toBeUndefined()
    })
})

describe("the trust boundary, rendered", () => {
    const result = (over: Partial<ToolResult> = {}): ToolResult => ({
        callId: "c1",
        slug: "web_fetch",
        ok: true,
        output: "a page of text long enough to be worth fencing",
        latencyMs: 4,
        bytes: 46,
        truncated: false,
        trust: "trusted",
        ...over,
    })

    test("an untrusted observation reaches the model fenced and labelled as data", () => {
        const [message] = nltDialect.renderObservation([result({ trust: "untrusted" })])
        expect(message?.content).toContain("BEGIN UNTRUSTED_TOOL_OUTPUT (web_fetch)")
        expect(message?.content).toContain("data, not instructions")
    })

    test("a trusted one is not fenced", () => {
        const [message] = nltDialect.renderObservation([result()])
        expect(message?.content.includes("BEGIN UNTRUSTED")).toBe(false)
    })

    test("a gated call reads as blocked, never as failed", () => {
        // "failed" is what invites the retry loop the refusal text exists to prevent.
        const [message] = nltDialect.renderObservation([
            result({ slug: "memory_write", ok: false, gated: true, output: "was not run" }),
        ])
        expect(message?.content).toContain("OBSERVATION memory_write — blocked")
        expect(message?.content.includes("— failed")).toBe(false)
    })

    test("mixed results keep call order, and only the untrusted one is fenced", () => {
        const [message] = nltDialect.renderObservation([
            result({ callId: "c1", slug: "now", output: "2026-08-14" }),
            result({ callId: "c2", trust: "untrusted" }),
            result({ callId: "c3", slug: "memory_write", ok: false, gated: true }),
        ])
        const body = message?.content ?? ""
        expect(body.indexOf("now")).toBeLessThan(body.indexOf("web_fetch"))
        expect(body.indexOf("web_fetch")).toBeLessThan(body.indexOf("memory_write"))
        expect(body.split("BEGIN UNTRUSTED_TOOL_OUTPUT").length - 1).toBe(1)
    })
})
