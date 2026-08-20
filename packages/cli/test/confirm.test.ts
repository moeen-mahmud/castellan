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
import { askExactly, askYesNo } from "#lib/confirm"

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
