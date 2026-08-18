/**
 * Naming a conversation.
 *
 * Every run used to land in `local:default`, so an agent's store was one unbroken transcript: this
 * morning's question was conditioned on yesterday's debugging, and neither could be resumed without the
 * other. The key is what fixes that, and the two properties worth asserting are that it is *readable* —
 * it gets typed back off a pointer line — and that the symbol set does not bias the collision count.
 */

import { describe, expect, test } from "bun:test"
import {
    isGeneratedSessionKey,
    LOCAL_SESSION_PREFIX,
    SESSION_KEY_LENGTH,
    sessionKeyFrom,
} from "#lib/session-key"

function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values)
}

describe("sessionKeyFrom", () => {
    test("the prefix says which surface opened it", () => {
        // Load-bearing: Telegram writes `tg:<chat>`, so the prefix is what stops a chat id colliding with
        // a terminal session.
        expect(sessionKeyFrom(bytes(0, 0, 0, 0, 0, 0)).startsWith(`${LOCAL_SESSION_PREFIX}:`)).toBe(
            true,
        )
    })

    test("six symbols, always", () => {
        const key = sessionKeyFrom(bytes(1, 2, 3, 4, 5, 6))
        expect(key.slice(LOCAL_SESSION_PREFIX.length + 1).length).toBe(SESSION_KEY_LENGTH)
    })

    test("the same bytes give the same key", () => {
        expect(sessionKeyFrom(bytes(9, 9, 9, 9, 9, 9))).toBe(
            sessionKeyFrom(bytes(9, 9, 9, 9, 9, 9)),
        )
    })

    test("only the low five bits are read, so there is no modulo bias", () => {
        // A byte taken modulo an alphabet that does not divide 256 makes the first symbols likelier than
        // the last, which would make collisions more likely than the count in the module claims.
        for (let byte = 0; byte < 256; byte += 1) {
            const low = sessionKeyFrom(bytes(byte, 0, 0, 0, 0, 0))
            const wrapped = sessionKeyFrom(bytes(byte & 0x1f, 0, 0, 0, 0, 0))
            expect(low).toBe(wrapped)
        }
    })

    test("every symbol is reachable and none of them look alike", () => {
        const produced = new Set<string>()
        for (let byte = 0; byte < 32; byte += 1) {
            produced.add(sessionKeyFrom(bytes(byte, 0, 0, 0, 0, 0)).slice(-6, -5))
        }
        expect(produced.size).toBe(32)
        // A key is read off a screen and typed back, so `local:1i0o` is one nobody transcribes reliably.
        for (const confusable of ["i", "l", "o", "u"]) {
            expect(produced.has(confusable)).toBe(false)
        }
    })

    test("short input does not throw — it pads rather than producing a ragged key", () => {
        expect(sessionKeyFrom(bytes(1)).length).toBe(LOCAL_SESSION_PREFIX.length + 1 + 6)
    })
})

describe("isGeneratedSessionKey", () => {
    test("it recognises what this module produces", () => {
        expect(isGeneratedSessionKey(sessionKeyFrom(bytes(3, 14, 15, 9, 26, 5)))).toBe(true)
    })

    test("a hand-written key is not generated, and stays perfectly valid", () => {
        // It exists to *explain* a key, never to validate one: `--session notes` has to keep working, and
        // the listing marks it as the one somebody chose.
        expect(isGeneratedSessionKey("local:default")).toBe(false)
        expect(isGeneratedSessionKey("notes")).toBe(false)
        expect(isGeneratedSessionKey("tg:12345")).toBe(false)
    })

    test("a confusable symbol is not one of ours", () => {
        expect(isGeneratedSessionKey("local:abciii")).toBe(false)
    })
})
