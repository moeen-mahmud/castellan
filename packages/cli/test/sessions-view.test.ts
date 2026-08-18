/**
 * What identifies a stored conversation in a list.
 *
 * The interesting decision is what is *not* there: the first message. It is the obvious label and it costs
 * a store read per row, and a conversation that opened with "hey" is not distinguished by it. What is left
 * is the key you type back, how much is in it, and when you last touched it.
 */

import { describe, expect, test } from "bun:test"
import { sessionRows } from "#lib/sessions-view"

const NOW = Date.parse("2026-08-18T12:00:00Z")

const SESSIONS = [
    { sessionKey: "local:a7f3c2", messages: 4, turns: 2, lastActivityAt: "2026-08-18T11:58:00Z" },
    { sessionKey: "notes", messages: 1, turns: 1, lastActivityAt: "2026-08-16T09:00:00Z" },
]

describe("sessionRows", () => {
    test("the key is the label, padded into a column so the hints line up", () => {
        const rows = sessionRows(SESSIONS, { now: NOW, columns: 80 })
        expect(rows[0]?.label.trimEnd()).toBe("local:a7f3c2")
        expect(rows[0]?.label.length).toBe(rows[1]?.label.length)
    })

    test("counts are singular or plural, because a row is read as a sentence", () => {
        const rows = sessionRows(SESSIONS, { now: NOW, columns: 80 })
        expect(rows[0]?.hint).toContain("4 messages")
        expect(rows[1]?.hint).toContain("1 message ")
        expect(rows[1]?.hint).toContain("1 turn ")
    })

    test("a key somebody chose is marked and a generated one is not", () => {
        const rows = sessionRows(SESSIONS, { now: NOW, columns: 80 })
        expect(rows[0]?.hint).not.toContain("named")
        expect(rows[1]?.hint).toContain("named")
    })

    test("a phase is shown only when there is one", () => {
        // Otherwise every row spends a column on the word "none".
        const withPhase = sessionRows([{ ...SESSIONS[0], phase: "triage" }] as never, {
            now: NOW,
            columns: 80,
        })
        expect(withPhase[0]?.hint).toContain("triage")
        expect(sessionRows(SESSIONS, { now: NOW, columns: 80 })[0]?.hint).not.toContain("undefined")
    })

    test("no row exceeds the width it was laid out for", () => {
        for (const columns of [40, 60, 80, 100, 140]) {
            for (const row of sessionRows(SESSIONS, { now: NOW, columns })) {
                expect([...row.label].length + [...row.hint].length).toBeLessThanOrEqual(columns)
            }
        }
    })

    test("a long hand-written key is clipped rather than pushing the row", () => {
        const long = [
            { ...SESSIONS[0], sessionKey: "a-very-long-hand-written-session-name-indeed" },
        ]
        const rows = sessionRows(long as never, { now: NOW, columns: 80 })
        expect(rows[0]?.label.trimEnd().endsWith("…")).toBe(true)
    })
})
