/**
 * The SQLite `Store`.
 *
 * Statements are prepared once in the constructor and reused. That is not micro-optimisation:
 * boot has a 1000 ms budget and a turn should not be paying SQL parse cost per message, but more
 * importantly a prepare-at-construction failure surfaces at boot with the offending SQL rather
 * than mid-turn.
 *
 * Every row-mapping function builds a fresh plain object. That is load-bearing beyond taste —
 * `node:sqlite` hands back null-prototype rows and `bun:sqlite` hands back `Object.prototype`
 * ones, so mapping is also where the two runtimes stop being distinguishable.
 */

import type { ChatMessage, ToolCallRequest } from "../../model/provider.ts"
import { parseSessionKey } from "../session-key.ts"
import type {
    KVStore,
    MessagePage,
    MessageStore,
    SessionRecord,
    SessionStore,
    SessionSummary,
    Store,
    StoredMessage,
    TurnRecord,
    TurnStatus,
    TurnStore,
} from "../store.ts"
import type { OpenOptions, SqlDatabase } from "./driver.ts"
import { openDatabase } from "./driver.ts"
import { type MigrationReport, migrate } from "./migrations.ts"

const DEFAULT_PAGE = 50

interface SessionRow {
    agent_id: string
    session_key: string
    channel: string
    peer_id: string
    thread: string | null
    phase: string | null
    created_at: string
    updated_at: string
}

interface SummaryRow extends SessionRow {
    messages: number
    turns: number
    last_activity_at: string
}

interface MessageRow {
    id: number
    session_key: string
    turn_id: string | null
    role: string
    content: string
    /** JSON array of `ToolCallRequest`, or null. Native only — under NLT the call is the content. */
    tool_calls: string | null
    tool_call_id: string | null
    created_at: string
}

/**
 * The message columns every read needs, as one fragment.
 *
 * One list rather than five, because the five queries below drifting apart is how `tool_calls` came
 * to be dropped on the way back out in the first place: the column existed on the row type and two
 * of the SELECTs simply did not ask for it, so a native session's history came back orphaned with
 * nothing failing.
 */
const MESSAGE_COLUMNS =
    "id, session_key, turn_id, role, content, tool_calls, tool_call_id, created_at"

/** Parsed defensively: a row written by a future version must not crash a history read. */
function toolCallsFrom(raw: string | null): readonly ToolCallRequest[] | undefined {
    if (raw === null || raw === "") return undefined
    try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) && parsed.length > 0
            ? (parsed as ToolCallRequest[])
            : undefined
    } catch {
        return undefined
    }
}

interface TurnRow {
    turn_id: string
    agent_id: string
    session_key: string
    status: string
    source: string
    input: string
    text: string
    reasoning: string
    steps: number
    prompt_tokens: number
    output_tokens: number
    error_code: string | null
    error_message: string | null
    error_hint: string | null
    started_at: string
    ended_at: string | null
    duration_ms: number | null
}

function nowIso(): string {
    return new Date().toISOString()
}

// Nullable columns are spread in conditionally rather than assigned `undefined`, because
// `exactOptionalPropertyTypes` distinguishes an absent optional property from one present with
// the value `undefined` — and the wire surface serializes those two differently.
function toSession(row: SessionRow): SessionRecord {
    return {
        agentId: row.agent_id,
        sessionKey: row.session_key,
        channel: row.channel,
        peerId: row.peer_id,
        ...(row.thread === null ? {} : { thread: row.thread }),
        ...(row.phase === null ? {} : { phase: row.phase }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

function toSummary(row: SummaryRow): SessionSummary {
    return {
        ...toSession(row),
        messages: row.messages,
        turns: row.turns,
        lastActivityAt: row.last_activity_at,
    }
}

function toMessage(row: MessageRow): StoredMessage {
    const calls = toolCallsFrom(row.tool_calls)
    return {
        id: row.id,
        sessionKey: row.session_key,
        ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(calls === undefined ? {} : { toolCalls: calls }),
        ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
        createdAt: row.created_at,
    }
}

/**
 * A row as the model layer wants it: exactly a `ChatMessage`, with no store bookkeeping.
 *
 * Separate from `toMessage` because the two have different jobs — that one is the API surface for
 * reading a session, this one feeds a prompt — but both must carry the tool fields, and having them
 * in one file makes it hard for only one to be updated.
 */
function toChatMessage(row: MessageRow): ChatMessage {
    const calls = toolCallsFrom(row.tool_calls)
    return {
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(calls === undefined ? {} : { toolCalls: calls }),
        ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    }
}

function toTurn(row: TurnRow): TurnRecord {
    return {
        turnId: row.turn_id,
        agentId: row.agent_id,
        sessionKey: row.session_key,
        status: row.status as TurnStatus,
        source: row.source,
        input: row.input,
        text: row.text,
        reasoning: row.reasoning,
        steps: row.steps,
        promptTokens: row.prompt_tokens,
        outputTokens: row.output_tokens,
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
        ...(row.error_hint === null ? {} : { errorHint: row.error_hint }),
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    }
}

export interface SqliteStoreOptions extends OpenOptions {}

export class SqliteStore implements Store {
    readonly sessions: SessionStore
    readonly messages: MessageStore
    readonly turns: TurnStore
    readonly kv: KVStore
    readonly location: string
    /** What `migrate` did at open. Reported by boot rather than logged and forgotten. */
    readonly migrations: MigrationReport

    #db: SqlDatabase
    #closed = false

    private constructor(db: SqlDatabase, migrations: MigrationReport) {
        this.#db = db
        this.location = db.location
        this.migrations = migrations

        const q = {
            sessionGet: db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND session_key = ?"),
            sessionInsert: db.prepare(
                `INSERT INTO sessions (agent_id, session_key, channel, peer_id, thread, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (agent_id, session_key) DO NOTHING`,
            ),
            sessionTouch: db.prepare(
                "UPDATE sessions SET updated_at = ? WHERE agent_id = ? AND session_key = ?",
            ),
            sessionList: db.prepare(
                `SELECT s.*,
                        (SELECT COUNT(*) FROM messages m
                          WHERE m.agent_id = s.agent_id AND m.session_key = s.session_key) AS messages,
                        (SELECT COUNT(*) FROM turns t
                          WHERE t.agent_id = s.agent_id AND t.session_key = s.session_key) AS turns,
                        MAX(
                            s.updated_at,
                            COALESCE((SELECT MAX(created_at) FROM messages m
                                       WHERE m.agent_id = s.agent_id AND m.session_key = s.session_key), '')
                        ) AS last_activity_at
                   FROM sessions s
                  WHERE s.agent_id = ?
                  ORDER BY last_activity_at DESC`,
            ),
            sessionSetPhase: db.prepare(
                "UPDATE sessions SET phase = ?, updated_at = ? WHERE agent_id = ? AND session_key = ?",
            ),
            sessionDelete: db.prepare(
                "DELETE FROM sessions WHERE agent_id = ? AND session_key = ?",
            ),
            messagesDelete: db.prepare(
                "DELETE FROM messages WHERE agent_id = ? AND session_key = ?",
            ),
            turnsDelete: db.prepare("DELETE FROM turns WHERE agent_id = ? AND session_key = ?"),

            messageInsert: db.prepare(
                `INSERT INTO messages
                     (agent_id, session_key, turn_id, role, content, tool_calls, tool_call_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ),
            messageById: db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`),
            historyAll: db.prepare(
                `SELECT ${MESSAGE_COLUMNS} FROM messages
                  WHERE agent_id = ? AND session_key = ? ORDER BY id ASC`,
            ),
            historyTail: db.prepare(
                `SELECT * FROM (
                     SELECT ${MESSAGE_COLUMNS} FROM messages
                      WHERE agent_id = ? AND session_key = ?
                      ORDER BY id DESC LIMIT ?
                 ) ORDER BY id ASC`,
            ),
            pageFirst: db.prepare(
                `SELECT ${MESSAGE_COLUMNS} FROM messages
                  WHERE agent_id = ? AND session_key = ?
                  ORDER BY id DESC LIMIT ?`,
            ),
            pageBefore: db.prepare(
                `SELECT ${MESSAGE_COLUMNS} FROM messages
                  WHERE agent_id = ? AND session_key = ? AND id < ?
                  ORDER BY id DESC LIMIT ?`,
            ),
            messageCount: db.prepare(
                "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND session_key = ?",
            ),
            messageOldest: db.prepare(
                "SELECT MIN(id) AS m FROM messages WHERE agent_id = ? AND session_key = ?",
            ),

            turnInsert: db.prepare(
                `INSERT INTO turns (turn_id, agent_id, session_key, status, source, input, started_at)
                 VALUES (?, ?, ?, 'running', ?, ?, ?)`,
            ),
            turnFinish: db.prepare(
                `UPDATE turns
                    SET status = ?, text = ?, reasoning = ?, steps = ?,
                        prompt_tokens = ?, output_tokens = ?, duration_ms = ?,
                        error_code = ?, error_message = ?, error_hint = ?, ended_at = ?
                  WHERE turn_id = ?`,
            ),
            turnGet: db.prepare("SELECT * FROM turns WHERE turn_id = ?"),
            turnList: db.prepare(
                `SELECT * FROM turns WHERE agent_id = ? AND session_key = ?
                  ORDER BY started_at DESC, rowid DESC LIMIT ?`,
            ),
            turnsRunning: db.prepare("SELECT turn_id FROM turns WHERE status = 'running'"),
            turnsReap: db.prepare(
                `UPDATE turns
                    SET status = 'error', ended_at = ?,
                        error_code = 'turn_abandoned', error_message = ?, error_hint = ?
                  WHERE status = 'running'`,
            ),

            kvGet: db.prepare("SELECT value FROM kv WHERE scope = ? AND key = ?"),
            kvSet: db.prepare(
                `INSERT INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            ),
            kvDelete: db.prepare("DELETE FROM kv WHERE scope = ? AND key = ?"),
            kvAll: db.prepare("SELECT key, value FROM kv WHERE scope = ? ORDER BY key"),
        }

        const ensureSession = (agentId: string, sessionKey: string): SessionRecord => {
            const existing = q.sessionGet.get<SessionRow>(agentId, sessionKey)
            if (existing !== undefined) return toSession(existing)

            const parts = parseSessionKey(sessionKey)
            const ts = nowIso()
            q.sessionInsert.run(
                agentId,
                sessionKey,
                parts.channel,
                parts.peerId,
                parts.thread,
                ts,
                ts,
            )
            const created = q.sessionGet.get<SessionRow>(agentId, sessionKey)
            if (created === undefined) {
                // ON CONFLICT DO NOTHING plus an immediately absent row means the insert was
                // rejected for a reason the conflict clause does not cover. Better to say so than
                // to hand back a record that is not in the database.
                throw new Error(
                    `Session ${agentId}/${sessionKey} could not be created. ` +
                        "hint: this indicates the sessions table is not writable — check disk space and file permissions on the database.",
                )
            }
            return toSession(created)
        }

        this.sessions = {
            ensure: async (agentId, sessionKey) => ensureSession(agentId, sessionKey),
            get: async (agentId, sessionKey) => {
                const row = q.sessionGet.get<SessionRow>(agentId, sessionKey)
                return row === undefined ? undefined : toSession(row)
            },
            list: async (agentId) => q.sessionList.all<SummaryRow>(agentId).map(toSummary),
            setPhase: async (agentId, sessionKey, phase) => {
                ensureSession(agentId, sessionKey)
                q.sessionSetPhase.run(phase, nowIso(), agentId, sessionKey)
            },
            clear: async (agentId, sessionKey) => {
                // Rows only, never files: memory markdown is canonical on disk and clearing a
                // conversation must not delete what the agent learned.
                db.transaction(() => {
                    q.messagesDelete.run(agentId, sessionKey)
                    q.turnsDelete.run(agentId, sessionKey)
                    q.sessionTouch.run(nowIso(), agentId, sessionKey)
                })
            },
            delete: async (agentId, sessionKey) => {
                q.sessionDelete.run(agentId, sessionKey)
            },
        }

        this.messages = {
            append: async (agentId, sessionKey, messages, turnId) => {
                if (messages.length === 0) return []
                return db.transaction(() => {
                    // Ensuring inside the transaction is what keeps the foreign key from being a
                    // failure mode callers have to know about.
                    ensureSession(agentId, sessionKey)
                    const ts = nowIso()
                    const stored: StoredMessage[] = []
                    for (const message of messages) {
                        const result = q.messageInsert.run(
                            agentId,
                            sessionKey,
                            turnId,
                            message.role,
                            message.content,
                            // Serialised rather than normalised into their own table: they are read
                            // and written only as a whole message, never queried across.
                            message.toolCalls === undefined || message.toolCalls.length === 0
                                ? null
                                : JSON.stringify(message.toolCalls),
                            message.toolCallId ?? null,
                            ts,
                        )
                        const row = q.messageById.get<MessageRow>(result.lastInsertRowid)
                        if (row !== undefined) stored.push(toMessage(row))
                    }
                    q.sessionTouch.run(ts, agentId, sessionKey)
                    return stored
                })
            },
            history: async (agentId, sessionKey, limit) => {
                const rows =
                    limit === undefined
                        ? q.historyAll.all<MessageRow>(agentId, sessionKey)
                        : q.historyTail.all<MessageRow>(agentId, sessionKey, limit)
                // Via `toChatMessage` rather than `{role, content}`: a native assistant turn carries
                // the calls it made and a `tool` message names the call it answers, and a history read
                // that drops either hands the next turn an orphaned trace.
                return rows.map(toChatMessage)
            },
            page: async (agentId, sessionKey, options) => {
                const limit = options?.limit ?? DEFAULT_PAGE
                const rows =
                    options?.before === undefined
                        ? q.pageFirst.all<MessageRow>(agentId, sessionKey, limit)
                        : q.pageBefore.all<MessageRow>(agentId, sessionKey, options.before, limit)

                const messages = rows.map(toMessage)
                const last = messages.at(-1)
                if (last === undefined) return { messages }

                const oldest = q.messageOldest.get<{ m: number | null }>(agentId, sessionKey)
                const page: MessagePage =
                    oldest?.m === null || oldest === undefined || last.id <= oldest.m
                        ? { messages }
                        : { messages, nextBefore: last.id }
                return page
            },
            count: async (agentId, sessionKey) =>
                q.messageCount.get<{ c: number }>(agentId, sessionKey)?.c ?? 0,
        }

        this.turns = {
            start: async (record) => {
                const ts = nowIso()
                db.transaction(() => {
                    ensureSession(record.agentId, record.sessionKey)
                    q.turnInsert.run(
                        record.turnId,
                        record.agentId,
                        record.sessionKey,
                        record.source,
                        record.input,
                        ts,
                    )
                })
                const row = q.turnGet.get<TurnRow>(record.turnId)
                if (row === undefined) {
                    throw new Error(
                        `Turn ${record.turnId} was not persisted. ` +
                            "hint: a duplicate turn id is the likely cause — turn ids come from newTurnId() and must be unique.",
                    )
                }
                return toTurn(row)
            },
            finish: async (turnId, outcome) => {
                q.turnFinish.run(
                    outcome.status,
                    outcome.text,
                    outcome.reasoning,
                    outcome.steps,
                    outcome.promptTokens,
                    outcome.outputTokens,
                    outcome.durationMs,
                    outcome.errorCode,
                    outcome.errorMessage,
                    outcome.errorHint,
                    nowIso(),
                    turnId,
                )
            },
            get: async (turnId) => {
                const row = q.turnGet.get<TurnRow>(turnId)
                return row === undefined ? undefined : toTurn(row)
            },
            list: async (agentId, sessionKey, options) =>
                q.turnList
                    .all<TurnRow>(agentId, sessionKey, options?.limit ?? DEFAULT_PAGE)
                    .map(toTurn),
            reapRunning: async (reason) => {
                const ids = q.turnsRunning.all<{ turn_id: string }>().map((row) => row.turn_id)
                if (ids.length === 0) return []
                q.turnsReap.run(
                    nowIso(),
                    `The process holding this turn exited before it finished (${reason}).`,
                    "A turn cannot be resumed by a different process — the model stream it was reading is gone. Send the input again. This row was left running by an earlier crash and is marked failed at boot rather than left ambiguous.",
                )
                return ids
            },
        }

        this.kv = {
            get: async (scope, key) => q.kvGet.get<{ value: string }>(scope, key)?.value,
            set: async (scope, key, value) => {
                q.kvSet.run(scope, key, value, nowIso())
            },
            delete: async (scope, key) => {
                q.kvDelete.run(scope, key)
            },
            all: async (scope) => {
                const out: Record<string, string> = {}
                for (const row of q.kvAll.all<{ key: string; value: string }>(scope)) {
                    out[row.key] = row.value
                }
                return out
            },
        }
    }

    /** Which module backs this store: `bun:sqlite` or `node:sqlite`. */
    get driver(): "bun" | "node" {
        return this.#db.runtime
    }

    static async open(options: SqliteStoreOptions): Promise<SqliteStore> {
        const db = await openDatabase(options)
        try {
            const report = migrate(db)
            return new SqliteStore(db, report)
        } catch (error) {
            // A half-opened database with no store to close it is a leaked file handle, and on
            // Windows a leaked handle is an unopenable file next time.
            db.close()
            throw error
        }
    }

    async close(): Promise<void> {
        if (this.#closed) return
        this.#closed = true
        this.#db.close()
    }
}

/**
 * An anonymous, migrated in-memory database.
 *
 * This is the whole "in-memory store" — there is no second hand-written implementation of
 * `Store`. A separate one would be a second thing to keep in sync with the interface, and the
 * bug it would hide is the interesting kind: tests passing against a mock whose semantics have
 * drifted from the driver everything actually runs on.
 */
export function openMemoryStore(): Promise<SqliteStore> {
    return SqliteStore.open({ path: ":memory:" })
}
