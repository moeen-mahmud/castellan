/**
 * Indexing conversations: the reconciliation boundary, and staleness.
 *
 * ## The one invariant that would fail silently
 *
 * `reconcile` **drops any source in its namespace that it was not handed**. That is a feature — it is
 * what makes a deleted archive file disappear from retrieval rather than being served from an index
 * forever — and it is why files and conversations are reconciled by two functions instead of one.
 * Recall syncs the files on every turn; conversations are synced at turn end. If the two shared a
 * domain, every turn's file sync would delete every indexed conversation, and the only symptom would be
 * memory that works right after a rebuild and stops working a turn later. Nothing would throw.
 *
 * So the first two tests here are not arithmetic: they assert that each pass leaves the other's rows
 * alone, in both directions.
 *
 * The rest covers what makes indexing cheap enough to run at every turn end — a session whose activity
 * stamp and message count are unchanged is not read at all — and the guard that stops a memory *file*
 * from squatting the conversation namespace, where it would be dropped by whichever pass ran second and
 * re-added by the other, alternating forever.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderConversation, sessionSource } from "../src/memory/conversation.ts"
import {
    enumerateFiles,
    enumerateSessions,
    fts5Retriever,
    type IndexableSession,
    syncFiles,
    syncSessions,
} from "../src/memory/fts5.ts"
import { openMemoryStore } from "../src/store/sqlite/store.ts"
import type { Store, StoredMessage } from "../src/store/store.ts"
import { describe, expect, test } from "./_harness.ts"

const AGENT = "eval"
const NOW = new Date("2026-08-19T12:00:00Z")

function conversation(key: string, lines: readonly string[], stamp: number): IndexableSession {
    let id = 0
    const messages: StoredMessage[] = lines.map((content) => {
        id += 1
        return {
            id,
            sessionKey: key,
            role: id % 2 === 1 ? "user" : "assistant",
            content,
            createdAt: "2026-08-19T10:00:00.000Z",
        }
    })
    return {
        sessionKey: key,
        source: sessionSource(key),
        mtimeMs: stamp,
        size: messages.length,
        read: async () => renderConversation(messages, "2026-08-19T10:00:00.000Z"),
    }
}

async function sources(store: Store): Promise<readonly string[]> {
    return (await store.memory.sources(AGENT)).map((state) => state.source).sort()
}

describe("the two reconciliation domains", () => {
    test("syncing the files leaves indexed conversations alone", async () => {
        const store = await openMemoryStore()
        await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [conversation("local:aaa111", ["what is the gate?", "manual approval."], 1)],
            now: NOW,
        })
        // The per-turn call. It knows nothing about conversations and must not touch them.
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                {
                    source: "2026-08.md",
                    read: () => "- a note about the deploy pipeline",
                    mtimeMs: 1,
                    size: 34,
                },
            ],
            now: NOW,
        })

        expect(await sources(store)).toEqual(["2026-08.md", "session:local:aaa111"])
        await store.close()
    })

    test("syncing the conversations leaves indexed files alone", async () => {
        const store = await openMemoryStore()
        await syncFiles({
            store: store.memory,
            agentId: AGENT,
            files: [
                { source: "2026-08.md", read: () => "- a note", mtimeMs: 1, size: 8 },
                { source: "MEMORY.md", read: () => "- another note", mtimeMs: 1, size: 14 },
            ],
            now: NOW,
        })
        await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [conversation("local:aaa111", ["hello", "hi"], 1)],
            now: NOW,
        })

        expect(await sources(store)).toEqual(["2026-08.md", "MEMORY.md", "session:local:aaa111"])
        await store.close()
    })

    test("a conversation absent from the list is dropped, so a deleted session stops being retrieved", async () => {
        const store = await openMemoryStore()
        const both = [
            conversation("local:aaa111", ["question one", "answer one"], 1),
            conversation("local:bbb222", ["question two", "answer two"], 1),
        ]
        await syncSessions({ store: store.memory, agentId: AGENT, sessions: both, now: NOW })
        expect((await sources(store)).length).toBe(2)

        await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [both[0] as IndexableSession],
            now: NOW,
        })
        expect(await sources(store)).toEqual(["session:local:aaa111"])
        await store.close()
    })
})

describe("staleness", () => {
    test("an unchanged conversation is not read at all", async () => {
        const store = await openMemoryStore()
        let reads = 0
        const one = conversation("local:aaa111", ["a question", "an answer"], 500)
        const counted: IndexableSession = {
            ...one,
            read: async () => {
                reads += 1
                return await one.read()
            },
        }

        const first = await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [counted],
            now: NOW,
        })
        expect(first.indexed).toEqual(["session:local:aaa111"])
        expect(reads).toBe(1)

        // Same activity stamp, same message count: this is the steady state at every turn end for
        // every session except the one that just moved, and it must cost nothing.
        const second = await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [counted],
            now: NOW,
        })
        expect(second.skipped).toEqual(["session:local:aaa111"])
        expect(second.indexed).toEqual([])
        expect(reads).toBe(1)
        await store.close()
    })

    test("one more message re-reads the conversation", async () => {
        const store = await openMemoryStore()
        await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [conversation("local:aaa111", ["a question", "an answer"], 500)],
            now: NOW,
        })
        const grown = await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: [
                conversation("local:aaa111", ["a question", "an answer", "and another"], 900),
            ],
            now: NOW,
        })

        expect(grown.indexed).toEqual(["session:local:aaa111"])
        expect(grown.passages).toBe(2)
        await store.close()
    })
})

describe("enumerateFiles", () => {
    test("a memory file cannot squat the conversation namespace", () => {
        // Left alone, this file would be reconciled by the file pass and dropped by the session pass,
        // then re-added, on alternate turns — retrieval that works every other question.
        const dir = mkdtempSync(join(tmpdir(), "memory-ns-"))
        try {
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, "2026-08.md"), "- a real note")
            writeFileSync(join(dir, "session:local:aaa111.md"), "- a squatter")

            const names = enumerateFiles({ dir }).map((file) => file.source)
            expect(names).toEqual(["2026-08.md"])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("enumerateSessions", () => {
    test("it reads every session in the store, newest activity first or not", async () => {
        const store = await openMemoryStore()
        await store.sessions.ensure(AGENT, "local:aaa111")
        await store.messages.append(AGENT, "local:aaa111", [
            { role: "user", content: "what is the deploy gate?" },
            { role: "assistant", content: "It waits for a manual approval." },
        ])
        await store.sessions.ensure(AGENT, "local:bbb222")
        await store.messages.append(AGENT, "local:bbb222", [{ role: "user", content: "unrelated" }])

        const listed = await enumerateSessions({
            sessions: store.sessions,
            messages: store.messages,
            agentId: AGENT,
        })
        expect(listed.map((s) => s.source).sort()).toEqual([
            "session:local:aaa111",
            "session:local:bbb222",
        ])

        const first = listed.find((s) => s.sessionKey === "local:aaa111")
        const text = await first?.read()
        expect(text?.includes("what is the deploy gate?")).toBe(true)
        expect(text?.includes("It waits for a manual approval.")).toBe(true)
        await store.close()
    })

    test("a conversation is retrievable once indexed, and its own session can be excluded", async () => {
        const store = await openMemoryStore()
        await store.sessions.ensure(AGENT, "local:aaa111")
        await store.messages.append(AGENT, "local:aaa111", [
            { role: "user", content: "how does the deploy approval work?" },
            { role: "assistant", content: "A reviewer approves it before production." },
        ])
        await syncSessions({
            store: store.memory,
            agentId: AGENT,
            sessions: await enumerateSessions({
                sessions: store.sessions,
                messages: store.messages,
                agentId: AGENT,
            }),
            now: NOW,
        })

        const retrieve = fts5Retriever({ store: store.memory, agentId: AGENT })
        const hits = await retrieve({ input: "deploy approval reviewer", now: NOW, limit: 5 })
        expect(hits.length).toBe(1)
        expect(hits[0]?.passage.source).toBe("session:local:aaa111")

        // The live conversation is excluded at retrieval rather than left out of the index: it is
        // already in the prompt as history, and `memory search` must still be able to find it.
        const excluded = await retrieve({
            input: "deploy approval reviewer",
            now: NOW,
            limit: 5,
            exclude: [sessionSource("local:aaa111")],
        })
        expect(excluded).toEqual([])
        await store.close()
    })
})
