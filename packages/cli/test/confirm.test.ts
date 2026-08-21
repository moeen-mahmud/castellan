/**
 * The two prompts, and the rule they share.
 *
 * **Not a TTY means no.** It is the load-bearing line in both: a piped or CI run cannot answer, so the
 * safe answer is the one that changes nothing. Defaulting the other way would make a redirected
 * invocation edit somebody's editor keybindings — and, since `remove` became the second caller, delete
 * an agent's conversations and memory. That is worth a test rather than a docstring, and neither
 * function had one before `askExactly` existed.
 *
 * `askExactly` is the harder bar on purpose. `y` against the wrong listing is one keystroke from an
 * irreversible deletion, and the listing above the prompt is only worth printing if something makes
 * somebody read it.
 */

import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { askExactly, askSecret, askYesNo, type SecretInput } from "#lib/confirm"

/** A stdin that answers once, claiming to be a terminal unless told otherwise. */
function tty(answer: string, isTTY = true) {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean }
    input.isTTY = isTTY
    // Written after the readline interface has attached; `question` resolves on the newline.
    setImmediate(() => input.write(`${answer}\n`))
    return { input, output: new PassThrough() }
}

describe("askYesNo", () => {
    test("y and yes agree, in any case", async () => {
        for (const answer of ["y", "Y", "yes", "YES", " yes "]) {
            expect(await askYesNo("go?", tty(answer))).toBe(true)
        }
    })

    test("anything else is no, including an empty answer", async () => {
        for (const answer of ["", "n", "no", "sure", "ya"]) {
            expect(await askYesNo("go?", tty(answer))).toBe(false)
        }
    })

    test("not a TTY is no without asking", async () => {
        expect(await askYesNo("go?", tty("yes", false))).toBe(false)
    })
})

describe("askExactly", () => {
    test("the exact word passes", async () => {
        expect(await askExactly("name?", "milo", tty("milo"))).toBe(true)
        expect(await askExactly("name?", "milo", tty("  milo  "))).toBe(true)
    })

    test("case is not folded, because a ref is a directory name", async () => {
        // On a case-sensitive filesystem `Milo` and `milo` are two different agents, and accepting
        // either here would accept the wrong one somewhere else.
        expect(await askExactly("name?", "milo", tty("Milo"))).toBe(false)
        expect(await askExactly("name?", "milo", tty("MILO"))).toBe(false)
    })

    test("a near miss fails, which is the entire point", async () => {
        for (const answer of ["mil", "milo2", "milo milo", "y", "yes", ""]) {
            expect(await askExactly("name?", "milo", tty(answer))).toBe(false)
        }
    })

    test("not a TTY is no without asking", async () => {
        expect(await askExactly("name?", "milo", tty("milo", false))).toBe(false)
    })

    test("a word that is not a name works the same way", async () => {
        // `--all` and `--prune` ask for their own word rather than a ref, so a half-remembered `--all`
        // cannot be confirmed by typing the name of the one agent somebody had in mind.
        expect(await askExactly("confirm?", "all", tty("all"))).toBe(true)
        expect(await askExactly("confirm?", "all", tty("milo"))).toBe(false)
        expect(await askExactly("confirm?", "prune", tty("prune"))).toBe(true)
    })
})

/**
 * A stdin that hands over bytes on demand, with raw mode observable.
 *
 * Real enough to catch what matters: that raw mode is entered *and left* (a thrown error leaving it on
 * makes the shell that follows unable to echo anything, which reads as a hung terminal), and that no
 * character of the value reaches the output.
 */
function keyboard(chunks: readonly string[], isTTY = true) {
    const listeners: ((chunk: string) => void)[] = []
    const raw: boolean[] = []
    const written: string[] = []
    const input: SecretInput = {
        isTTY,
        setRawMode: (mode) => raw.push(mode),
        resume: () => undefined,
        on: (_event, listener) => {
            listeners.push(listener as (chunk: string) => void)
            // Delivered after the caller has subscribed, which is the order a real stream uses.
            queueMicrotask(() => {
                for (const chunk of chunks) for (const fn of [...listeners]) fn(chunk)
            })
            return undefined
        },
        removeListener: (_event, listener) => {
            const at = listeners.indexOf(listener as (chunk: string) => void)
            if (at !== -1) listeners.splice(at, 1)
            return undefined
        },
    }
    const output = {
        write: (text: string) => {
            written.push(text)
            return true
        },
    } as unknown as NodeJS.WritableStream
    return { input, output, raw, written: () => written.join("") }
}

describe("askSecret", () => {
    test("reads a value and never echoes a character of it", async () => {
        const io = keyboard(["sk-live", "\r"])
        expect(await askSecret("key:", { input: io.input, output: io.output })).toBe("sk-live")
        expect(io.written()).not.toContain("sk-live")
        expect(io.written()).toContain("*******")
    })

    test("raw mode is entered and left", async () => {
        // Left, above all. A run that returned with raw mode still on would leave the next shell unable
        // to echo anything the person types, which looks like a hung terminal rather than a bug here.
        const io = keyboard(["x", "\n"])
        await askSecret("key:", { input: io.input, output: io.output })
        expect(io.raw).toEqual([true, false])
    })

    test("backspace removes a character", async () => {
        // A mistyped key in a value you cannot see is otherwise unrecoverable without starting again.
        const io = keyboard(["abc", "\u007f", "d", "\r"])
        expect(await askSecret("key:", { input: io.input, output: io.output })).toBe("abd")
    })

    test("^C cancels, and ^D cancels only an empty line", async () => {
        const cancelled = keyboard(["ab", "\u0003"])
        expect(
            await askSecret("key:", { input: cancelled.input, output: cancelled.output }),
        ).toBeUndefined()

        const empty = keyboard(["\u0004"])
        expect(
            await askSecret("key:", { input: empty.input, output: empty.output }),
        ).toBeUndefined()

        // ^D after typing submits rather than throwing the value away.
        const typed = keyboard(["ab", "\u0004"])
        expect(await askSecret("key:", { input: typed.input, output: typed.output })).toBe("ab")
    })

    test("a whole escape sequence is dropped, not just its escape byte", async () => {
        // Dropping the byte alone left `[A` in the value — two characters of junk in a string nobody can
        // see, which is worse than three because it looks like nothing happened.
        const arrow = keyboard(["a", "\u001b[A", "b", "\r"])
        expect(await askSecret("key:", { input: arrow.input, output: arrow.output })).toBe("ab")

        // Split across chunks, which is how a real terminal often delivers it.
        const split = keyboard(["a", "\u001b", "[", "B", "b", "\r"])
        expect(await askSecret("key:", { input: split.input, output: split.output })).toBe("ab")

        // SS3, which is how some terminals send arrows instead.
        const ss3 = keyboard(["a", "\u001bOA", "b", "\r"])
        expect(await askSecret("key:", { input: ss3.input, output: ss3.output })).toBe("ab")
    })

    test("not a TTY returns undefined and reads nothing", async () => {
        // The caller reports that nothing was written. Reading a pipe would take a secret from a source
        // nobody audited, and put it wherever that pipe came from.
        const io = keyboard(["sk-live", "\r"], false)
        expect(await askSecret("key:", { input: io.input, output: io.output })).toBeUndefined()
        expect(io.written()).toBe("")
    })
})
