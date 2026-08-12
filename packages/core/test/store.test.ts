/**
 * Store, driver, and migration behaviour.
 *
 * This file imports `./_harness.ts` rather than `bun:test` so it runs under `bun test` *and*
 * `node --test`. That is the whole point: the adapter's job is to make two different SQLite
 * bindings behave identically, and the only way to demonstrate that is to run the same
 * assertions against both. A green run under one runner proves nothing about the other.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatSessionKey, isSessionKey, parseSessionKey } from "../src/store/session-key.ts"
import { openDatabase, userVersion } from "../src/store/sqlite/driver.ts"
import { MIGRATIONS, migrate } from "../src/store/sqlite/migrations.ts"
import { openMemoryStore, SqliteStore } from "../src/store/sqlite/store.ts"
import { describe, expect, runner, test } from "./_harness.ts"

const AGENT = "assistant"
const KEY = "local:default"

function tempDb(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "store-test-"))
    return {
        path: join(dir, "store.db"),
        cleanup: () => {
            rmSync(dir, { recursive: true, force: true })
        },
    }
}

describe("session keys", () => {
    test("splits channel, peer and thread", () => {
        expect(parseSessionKey("telegram:12345")).toEqual({ channel: "telegram", peerId: "12345" })
        expect(parseSessionKey("telegram:12345:99")).toEqual({
            channel: "telegram",
            peerId: "12345",
            thread: "99",
        })
    })

    test("a thread containing a colon round-trips", () => {
        const parts = parseSessionKey("telegram:123:topic:9")
        expect(parts.thread).toBe("topic:9")
        expect(formatSessionKey(parts)).toBe("telegram:123:topic:9")
    })

    test("refuses a key with no channel segment", () => {
        expect(() => parseSessionKey("nocolon")).toThrow("no channel segment")
        expect(isSessionKey("nocolon")).toBe(false)
    })

    test("refuses empty and non-slug segments", () => {
        expect(() => parseSessionKey("telegram:")).toThrow("empty peer segment")
        expect(() => parseSessionKey("Telegram:1")).toThrow("invalid channel segment")
        expect(() => parseSessionKey("1telegram:1")).toThrow("invalid channel segment")
        expect(() => parseSessionKey(":1")).toThrow("invalid channel segment")
    })

    test("the default session key is itself well formed", () => {
        expect(isSessionKey("local:default")).toBe(true)
    })
})

describe("driver", () => {
    test("reports which binding it is using", async () => {
        const db = await openDatabase({ path: ":memory:" })
        expect(db.runtime).toBe(runner)
        db.close()
    })

    test("foreign keys are on regardless of the binding's default", async () => {
        // bun:sqlite defaults this off and node:sqlite defaults it on. Without the explicit
        // pragma, ON DELETE CASCADE would be a no-op under Bun and work under Node.
        const db = await openDatabase({ path: ":memory:" })
        const row = db.prepare("PRAGMA foreign_keys").get<{ foreign_keys: number }>()
        expect(row?.foreign_keys).toBe(1)
        db.close()
    })

    test("get() returns undefined for a miss on both bindings", async () => {
        // Bun returns null here, Node returns undefined.
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT)")
        expect(db.prepare("SELECT * FROM t WHERE a = ?").get("nope")).toBeUndefined()
        db.close()
    })

    test("binds undefined as NULL and booleans as 0/1", async () => {
        // node:sqlite throws on both; bun:sqlite accepts both. The adapter picks one behaviour.
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT, b INTEGER, c INTEGER)")
        db.prepare("INSERT INTO t (a, b, c) VALUES (?, ?, ?)").run(undefined, true, false)
        expect(db.prepare("SELECT * FROM t").get()).toEqual({ a: null, b: 1, c: 0 })
        db.close()
    })

    test("refuses to bind a value SQLite cannot store", async () => {
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT)")
        const insert = db.prepare("INSERT INTO t (a) VALUES (?)")
        // An implicit stringify would store "[object Object]" and lose the data silently.
        expect(() => insert.run({ nested: true } as unknown as string)).toThrow("Cannot bind")
        db.close()
    })

    test("run() reports changes and lastInsertRowid as numbers", async () => {
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)")
        const result = db.prepare("INSERT INTO t (a) VALUES (?)").run("x")
        expect(result.changes).toBe(1)
        expect(result.lastInsertRowid).toBe(1)
        expect(typeof result.lastInsertRowid).toBe("number")
        db.close()
    })

    test("a transaction rolls back on throw", async () => {
        const db = await openDatabase({ path: ":memory:" })
        db.exec("CREATE TABLE t (a TEXT)")
        const insert = db.prepare("INSERT INTO t (a) VALUES (?)")
        expect(() =>
            db.transaction(() => {
                insert.run("kept?")
                throw new Error("nope")
            }),
        ).toThrow("nope")
        expect(db.prepare("SELECT COUNT(*) AS c FROM t").get<{ c: number }>()?.c).toBe(0)
        db.close()
    })
})

describe("migrations", () => {
    test("a fresh database migrates to the current version", async () => {
        const db = await openDatabase({ path: ":memory:" })
        expect(userVersion(db)).toBe(0)
        const report = migrate(db)
        expect(report.from).toBe(0)
        expect(report.to).toBe(MIGRATIONS.length)
        expect(report.applied.length).toBe(MIGRATIONS.length)
        db.close()
    })

    test("a second run applies nothing", async () => {
        const db = await openDatabase({ path: ":memory:" })
        migrate(db)
        const second = migrate(db)
        expect(second.applied).toEqual([])
        expect(second.from).toBe(MIGRATIONS.length)
        expect(second.to).toBe(MIGRATIONS.length)
        db.close()
    })

    test("reopening a file runs no migrations the second time", async () => {
        const { path, cleanup } = tempDb()
        try {
            const first = await SqliteStore.open({ path })
            expect(first.migrations.applied.length).toBe(MIGRATIONS.length)
            await first.close()

            const second = await SqliteStore.open({ path })
            expect(second.migrations.applied).toEqual([])
            expect(second.migrations.from).toBe(MIGRATIONS.length)
            await second.close()
        } finally {
            cleanup()
        }
    })

    test("refuses a database written by a newer build", async () => {
        const { path, cleanup } = tempDb()
        try {
            const db = await openDatabase({ path })
            db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`)
            db.close()
            await expect(SqliteStore.open({ path })).rejects.toThrow("only knows")
        } finally {
            cleanup()
        }
    })

    test("migration versions are contiguous", () => {
        for (const [index, migration] of MIGRATIONS.entries()) {
            expect(migration.version).toBe(index + 1)
        }
    })
})

describe("sessions", () => {
    test("ensure is idempotent", async () => {
        const store = await openMemoryStore()
        const first = await store.sessions.ensure(AGENT, KEY)
        const second = await store.sessions.ensure(AGENT, KEY)
        expect(second.createdAt).toBe(first.createdAt)
        expect(first.channel).toBe("local")
        expect(first.peerId).toBe("default")
        expect(first.thread).toBeUndefined()
        await store.close()
    })

    test("stores the parsed thread segment", async () => {
        const store = await openMemoryStore()
        const session = await store.sessions.ensure(AGENT, "telegram:123:topic:9")
        expect(session.thread).toBe("topic:9")
        await store.close()
    })

    test("a malformed key is refused at the boundary", async () => {
        const store = await openMemoryStore()
        await expect(store.sessions.ensure(AGENT, "nocolon")).rejects.toThrow("no channel segment")
        await store.close()
    })

    test("list reports message and turn counts", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [{ role: "user", content: "a" }])
        await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "test",
            input: "a",
        })
        const list = await store.sessions.list(AGENT)
        expect(list.length).toBe(1)
        expect(list[0]?.messages).toBe(1)
        expect(list[0]?.turns).toBe(1)
        await store.close()
    })

    test("sessions are scoped per agent", async () => {
        const store = await openMemoryStore()
        await store.messages.append("a", KEY, [{ role: "user", content: "for a" }])
        await store.messages.append("b", KEY, [{ role: "user", content: "for b" }])
        expect((await store.messages.history("a", KEY)).map((m) => m.content)).toEqual(["for a"])
        expect((await store.messages.history("b", KEY)).map((m) => m.content)).toEqual(["for b"])
        await store.close()
    })

    test("clear empties history but keeps the session", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [{ role: "user", content: "a" }])
        await store.sessions.clear(AGENT, KEY)
        expect(await store.messages.count(AGENT, KEY)).toBe(0)
        expect(await store.sessions.get(AGENT, KEY)).toBeDefined()
        await store.close()
    })

    test("delete cascades to messages and turns", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [{ role: "user", content: "a" }])
        await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "test",
            input: "a",
        })
        await store.sessions.delete(AGENT, KEY)
        expect(await store.messages.count(AGENT, KEY)).toBe(0)
        expect(await store.turns.get("t_1")).toBeUndefined()
        await store.close()
    })

    test("phase round-trips", async () => {
        const store = await openMemoryStore()
        await store.sessions.setPhase(AGENT, KEY, "triage")
        expect((await store.sessions.get(AGENT, KEY))?.phase).toBe("triage")
        await store.sessions.setPhase(AGENT, KEY, undefined)
        expect((await store.sessions.get(AGENT, KEY))?.phase).toBeUndefined()
        await store.close()
    })
})

describe("messages", () => {
    test("history is oldest-first and limit keeps the newest", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, KEY, [
            { role: "user", content: "1" },
            { role: "assistant", content: "2" },
            { role: "user", content: "3" },
        ])
        expect((await store.messages.history(AGENT, KEY)).map((m) => m.content)).toEqual([
            "1",
            "2",
            "3",
        ])
        expect((await store.messages.history(AGENT, KEY, 2)).map((m) => m.content)).toEqual([
            "2",
            "3",
        ])
        await store.close()
    })

    test("appending an empty list writes nothing", async () => {
        const store = await openMemoryStore()
        expect(await store.messages.append(AGENT, KEY, [])).toEqual([])
        expect(await store.sessions.get(AGENT, KEY)).toBeUndefined()
        await store.close()
    })

    test("append creates the session, so a foreign key is never the caller's problem", async () => {
        const store = await openMemoryStore()
        await store.messages.append(AGENT, "api:moeen", [{ role: "user", content: "hi" }])
        expect(await store.sessions.get(AGENT, "api:moeen")).toBeDefined()
        await store.close()
    })

    test("paging walks backwards and stops", async () => {
        const store = await openMemoryStore()
        await store.messages.append(
            AGENT,
            KEY,
            [1, 2, 3, 4, 5].map((n) => ({ role: "user" as const, content: String(n) })),
        )

        const first = await store.messages.page(AGENT, KEY, { limit: 2 })
        expect(first.messages.map((m) => m.content)).toEqual(["5", "4"])
        expect(first.nextBefore).toBeDefined()

        const second = await store.messages.page(AGENT, KEY, {
            limit: 2,
            before: first.nextBefore,
        })
        expect(second.messages.map((m) => m.content)).toEqual(["3", "2"])

        const third = await store.messages.page(AGENT, KEY, {
            limit: 2,
            before: second.nextBefore,
        })
        expect(third.messages.map((m) => m.content)).toEqual(["1"])
        expect(third.nextBefore).toBeUndefined()
        await store.close()
    })

    test("the turn id travels with the messages", async () => {
        const store = await openMemoryStore()
        const stored = await store.messages.append(
            AGENT,
            KEY,
            [{ role: "user", content: "hi" }],
            "t_7",
        )
        expect(stored[0]?.turnId).toBe("t_7")
        await store.close()
    })
})

describe("turns", () => {
    test("start writes a running row before any model call", async () => {
        const store = await openMemoryStore()
        const turn = await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "hello",
        })
        expect(turn.status).toBe("running")
        expect(turn.endedAt).toBeUndefined()
        expect(turn.input).toBe("hello")
        await store.close()
    })

    test("finish records the outcome and its error detail", async () => {
        const store = await openMemoryStore()
        await store.turns.start({
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })
        await store.turns.finish("t_1", {
            status: "error",
            text: "",
            reasoning: "",
            steps: 1,
            promptTokens: 10,
            outputTokens: 0,
            durationMs: 42,
            errorCode: "empty_reply_output_exhausted",
            errorMessage: "no text",
            errorHint: "raise reserveOutput",
        })
        const turn = await store.turns.get("t_1")
        expect(turn?.status).toBe("error")
        expect(turn?.errorCode).toBe("empty_reply_output_exhausted")
        expect(turn?.errorHint).toBe("raise reserveOutput")
        expect(turn?.durationMs).toBe(42)
        expect(turn?.endedAt).toBeDefined()
        await store.close()
    })

    test("timeout and max_steps survive as themselves", async () => {
        // The loop deliberately keeps these distinct from `error`; flattening them here would
        // discard the diagnosis one layer below where it was made.
        const store = await openMemoryStore()
        for (const status of ["timeout", "max_steps", "stopped"] as const) {
            await store.turns.start({
                turnId: status,
                agentId: AGENT,
                sessionKey: KEY,
                source: "test",
                input: "x",
            })
            await store.turns.finish(status, {
                status,
                text: "",
                reasoning: "",
                steps: 1,
                promptTokens: 0,
                outputTokens: 0,
                durationMs: 1,
            })
            expect((await store.turns.get(status))?.status).toBe(status)
        }
        await store.close()
    })

    test("reapRunning marks abandoned turns and is idempotent", async () => {
        const store = await openMemoryStore()
        await store.turns.start({
            turnId: "t_live",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })

        const reaped = await store.turns.reapRunning("test")
        expect(reaped).toEqual(["t_live"])

        const turn = await store.turns.get("t_live")
        expect(turn?.status).toBe("error")
        expect(turn?.errorCode).toBe("turn_abandoned")
        expect(turn?.errorHint).toContain("cannot be resumed")

        expect(await store.turns.reapRunning("test")).toEqual([])
        await store.close()
    })

    test("a finished turn is not reaped", async () => {
        const store = await openMemoryStore()
        await store.turns.start({
            turnId: "t_done",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        })
        await store.turns.finish("t_done", {
            status: "final",
            text: "hi",
            reasoning: "",
            steps: 1,
            promptTokens: 1,
            outputTokens: 1,
            durationMs: 1,
        })
        expect(await store.turns.reapRunning("test")).toEqual([])
        expect((await store.turns.get("t_done"))?.status).toBe("final")
        await store.close()
    })

    test("a duplicate turn id is refused rather than overwriting", async () => {
        const store = await openMemoryStore()
        const record = {
            turnId: "t_1",
            agentId: AGENT,
            sessionKey: KEY,
            source: "repl",
            input: "x",
        }
        await store.turns.start(record)
        // Both bindings surface SQLite's own text here, which is the same even though the error
        // class and `code` around it differ.
        await expect(store.turns.start(record)).rejects.toThrow("constraint failed")
        await store.close()
    })
})

describe("kv", () => {
    test("set, get, upsert, delete", async () => {
        const store = await openMemoryStore()
        expect(await store.kv.get("scope", "missing")).toBeUndefined()
        await store.kv.set("scope", "k", "one")
        expect(await store.kv.get("scope", "k")).toBe("one")
        await store.kv.set("scope", "k", "two")
        expect(await store.kv.get("scope", "k")).toBe("two")
        await store.kv.delete("scope", "k")
        expect(await store.kv.get("scope", "k")).toBeUndefined()
        await store.close()
    })

    test("scopes do not collide", async () => {
        const store = await openMemoryStore()
        await store.kv.set("a", "k", "1")
        await store.kv.set("b", "k", "2")
        expect(await store.kv.all("a")).toEqual({ k: "1" })
        expect(await store.kv.all("b")).toEqual({ k: "2" })
        await store.close()
    })
})

describe("persistence across processes", () => {
    test("history survives closing and reopening the file", async () => {
        const { path, cleanup } = tempDb()
        try {
            const first = await SqliteStore.open({ path })
            await first.messages.append(AGENT, KEY, [
                { role: "user", content: "my name is Moeen" },
                { role: "assistant", content: "noted" },
            ])
            await first.close()

            const second = await SqliteStore.open({ path })
            expect((await second.messages.history(AGENT, KEY)).map((m) => m.content)).toEqual([
                "my name is Moeen",
                "noted",
            ])
            await second.close()
        } finally {
            cleanup()
        }
    })

    test("close is idempotent", async () => {
        const store = await openMemoryStore()
        await store.close()
        await store.close()
    })
})
