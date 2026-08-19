/**
 * Numbered migrations gated on `PRAGMA user_version`.
 *
 * Migrations are inline strings rather than `.sql` files on disk. A `.sql` file has to be found
 * at runtime, which means a path that differs between the source tree, the bundled `dist`, and
 * the Docker image — three chances for a migration to be silently skipped because the directory
 * was not copied. A missing migration is not the kind of failure worth making possible to save
 * a little syntax highlighting.
 *
 * Rules for adding one: append, never edit. An already-applied migration is history; changing
 * it means installed databases and fresh ones disagree about their own schema while both report
 * the same `user_version`.
 */

import { HarnessError } from "../../errors.ts"
import { type SqlDatabase, setUserVersion, userVersion } from "./driver.ts"

export interface Migration {
    /** 1-based and contiguous. Checked at load, because a gap would skip a migration. */
    readonly version: number
    readonly name: string
    readonly sql: string
}

export const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        name: "sessions_messages_turns_kv",
        sql: `
CREATE TABLE sessions (
    agent_id    TEXT NOT NULL,
    session_key TEXT NOT NULL,
    channel     TEXT NOT NULL,
    peer_id     TEXT NOT NULL,
    thread      TEXT,
    phase       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, session_key)
);

-- Channel and peer are indexed because Phase 4 resolves an inbound message to a session by
-- them, before it knows the composed key.
CREATE INDEX sessions_by_peer ON sessions (agent_id, channel, peer_id);

CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    session_key TEXT NOT NULL,
    turn_id     TEXT,
    role        TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (agent_id, session_key)
        REFERENCES sessions (agent_id, session_key) ON DELETE CASCADE
);

-- The covering index for history reads: the id tail makes "last N in order" an index scan.
CREATE INDEX messages_by_session ON messages (agent_id, session_key, id);

CREATE TABLE turns (
    turn_id       TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    session_key   TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (
                      status IN ('running', 'final', 'max_steps', 'stopped', 'timeout', 'error')
                  ),
    source        TEXT NOT NULL,
    input         TEXT NOT NULL,
    text          TEXT NOT NULL DEFAULT '',
    reasoning     TEXT NOT NULL DEFAULT '',
    steps         INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error_code    TEXT,
    error_message TEXT,
    error_hint    TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    duration_ms   INTEGER,
    FOREIGN KEY (agent_id, session_key)
        REFERENCES sessions (agent_id, session_key) ON DELETE CASCADE
);

CREATE INDEX turns_by_session ON turns (agent_id, session_key, started_at DESC);

-- Partial index: crash recovery at boot scans only what is actually running, so the cost of
-- reaping does not grow with turn history.
CREATE INDEX turns_running ON turns (status) WHERE status = 'running';

CREATE TABLE kv (
    scope      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);
`,
    },
    {
        version: 2,
        name: "messages_tool_calls",
        /**
         * Native tool calling needs two more facts about a message than `{role, content}` carries.
         *
         * Without them a resumed native session is broken in a way that only shows on its *second*
         * turn: the assistant message recording what the model called comes back with empty content
         * and no calls, and the `tool` message answering it comes back naming nothing. Against a
         * strict endpoint that is a 400; against a lenient one the model is handed an observation
         * with no idea what produced it, which is worse for being silent. Measured — qwen3.5:9b via
         * Ollama accepted the orphaned trace and answered from context anyway.
         *
         * Both columns are nullable and unused under NLT, where the call *is* the content.
         */
        sql: `
ALTER TABLE messages ADD COLUMN tool_calls TEXT;
ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
`,
    },
    {
        version: 3,
        name: "outbox",
        /**
         * The delivery queue. `05-PLAN.md` calls this "migration 002" — that number was written
         * before Phase 3 added one, and the list is contiguous by position, so it is 003 here.
         *
         * The load-bearing line is `UNIQUE (agent_id, dedupe_key)`. It is what makes a re-enqueue a
         * no-op rather than a second message, and the key is *derived* by the caller from facts it
         * can reproduce after a crash — see `DeliveryRecord.dedupeKey`. There is deliberately no
         * server-generated identity column serving that role: `id` exists only to order rows and to
         * name one in a later `UPDATE`.
         *
         * `session_key` carries no foreign key to `sessions`, unlike `messages` and `turns`. A
         * delivery outlives its conversation on purpose — `sessions.clear()` must not silently
         * discard replies that have not been sent yet, and `ON DELETE CASCADE` would do exactly
         * that at the moment a person is least expecting it.
         */
        sql: `
CREATE TABLE outbox (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id            TEXT NOT NULL,
    dedupe_key          TEXT NOT NULL,
    group_key           TEXT NOT NULL,
    session_key         TEXT NOT NULL,
    turn_id             TEXT,
    channel_id          TEXT NOT NULL,
    recipient           TEXT NOT NULL,
    thread              TEXT,
    chunk_index         INTEGER NOT NULL,
    chunk_total         INTEGER NOT NULL,
    body                TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (
                            status IN ('pending', 'inflight', 'sent', 'failed')
                        ),
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT NOT NULL,
    uncertain           INTEGER NOT NULL DEFAULT 0,
    provider_message_id TEXT,
    error_code          TEXT,
    error_message       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- Idempotency. Enqueueing the same logical delivery twice hits this and does nothing.
CREATE UNIQUE INDEX outbox_dedupe ON outbox (agent_id, dedupe_key);

-- The drain query: pending rows whose time has come, oldest first.
CREATE INDEX outbox_due ON outbox (agent_id, status, next_attempt_at, id);

-- Head-of-line lookup. The drain asks, per candidate row, whether an earlier chunk of the same
-- group is still unsent; without this index that question is a scan per row.
CREATE INDEX outbox_group ON outbox (agent_id, group_key, chunk_index);

-- Crash recovery at boot scans only what was in flight, so its cost does not grow with history.
CREATE INDEX outbox_inflight ON outbox (status) WHERE status = 'inflight';

CREATE INDEX outbox_by_session ON outbox (agent_id, session_key, id DESC);
`,
    },
    {
        version: 4,
        name: "runtime_leases",
        /**
         * Which process is serving which agent, right now.
         *
         * Two problems, one row, and they are the same problem seen from either end.
         *
         * **Nobody may serve an agent twice.** Telegram allows exactly one `getUpdates` poller per
         * bot token, and the poll loop is specified never to exit on its own — it catches
         * everything and backs off — so a 409 from a second poller is indistinguishable *by
         * construction* from the outage that loop exists to survive. Both processes back off, both
         * run forever, messages land with whichever wins each race, and both append to one session
         * history. Webhook mode produces no 409 at all: `setWebhook` silently moves the hook to the
         * last caller. The transport cannot detect this, so the store does.
         *
         * **Boot recovery must not reach across processes.** `turns.reapRunning` and
         * `outbox.recoverInflight` were both unfiltered, which is correct for one process on one
         * database and wrong the moment two share a file — the second one's boot would mark the
         * first's live turn failed and flip its in-flight delivery back to pending, re-sending a
         * Telegram message that had already gone. A lease says which rows are *this* process's to
         * recover.
         *
         * Scoped by ownership rather than by agent id, and the difference is not academic: an
         * agent id that no longer boots — deleted directory, edited `id:` — would never be passed
         * again, so its rows would stay `running` forever, which is precisely the ambiguity
         * `reapRunning` exists to remove. Rows with no live lease are recoverable by whoever finds
         * them.
         *
         * `PRIMARY KEY (agent_id)` is the mutual exclusion. Claiming is an upsert inside a
         * transaction that first re-reads the row, so two simultaneous starts cannot both win —
         * which is why this is a table and not a `kv` entry, since `kv` has no compare-and-set.
         *
         * `pid` is advisory and known to be imperfect: pids are reused, and a lease whose process
         * died without releasing looks identical to one whose process is merely wedged. The
         * caller decides liveness (`process.kill(pid, 0)`) and passes the verdict in; the store
         * stores facts and does not probe the operating system.
         */
        sql: `
CREATE TABLE runtime_leases (
    agent_id      TEXT PRIMARY KEY,
    runtime_id    TEXT NOT NULL,
    pid           INTEGER NOT NULL,
    -- How the process was started, so a refusal can say "in a terminal" or "as a service"
    -- instead of only naming a number the person then has to go and look up.
    mode          TEXT NOT NULL CHECK (mode IN ('daemon', 'terminal', 'embedded')),
    started_at    TEXT NOT NULL,
    heartbeat_at  TEXT NOT NULL
);
`,
    },
    {
        version: 5,
        name: "artifacts_and_message_origin",
        /**
         * What compaction displaced, and who wrote each message.
         *
         * **`artifacts`.** The compaction ladder replaces an oversized tool observation with a pointer
         * and puts the whole thing here, so nothing a compaction removed is unreachable — `artifact_read`
         * follows the pointer. The id is *derived from the content* (FNV-1a plus its length, see
         * `compaction/stages.ts`), never generated, for the same reason the outbox derives its dedupe
         * key: the duplicate that actually happens is the same work running twice, and only a derived
         * identity collides. That is what makes `INSERT OR IGNORE` correct here, and it is why a
         * message snipped on one turn and pointer-replaced on a later one resolves to one row rather
         * than two.
         *
         * `id` is printable ASCII by construction. Row seven of the table in `sqlite/driver.ts` is why
         * that matters: `node:sqlite` truncates a bound string at a NUL byte while `bun:sqlite` stores
         * it whole, so a key containing one would resolve on one runtime and silently miss on the other.
         *
         * Scoped by session and cascading with it. An artifact is a fragment of one conversation's
         * history and outliving it would leave rows nothing can ever name again — the opposite call
         * from `outbox`, which deliberately survives its session because an unsent reply still has to
         * go out.
         *
         * **`messages.origin`.** Compaction has to know which messages are tool output, and under a
         * text dialect the *role does not say*: NLT sends an observation back as a `user` message. The
         * alternative is matching the `OBSERVATION <slug> —` header with a regex, which would let a
         * person who types the word have their own message truncated, and would silently stop
         * compacting anything the day a dialect changed its framing. Nullable, because a session
         * written before this migration has no origins to read — the honest degradation is that its
         * old messages are treated as prose, so the stages that need this decline and the ladder
         * reaches for the ones that do not.
         */
        sql: `
ALTER TABLE messages ADD COLUMN origin TEXT;

CREATE TABLE artifacts (
    -- Derived from the content, printable ASCII. Unique per session, not globally: the same
    -- observation in two conversations is two facts about two histories.
    id          TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    session_key TEXT NOT NULL,
    -- The tool that produced it, where the observation named one. Shown in the pointer.
    slug        TEXT,
    content     TEXT NOT NULL,
    -- Estimated cost of the original, so a reader can be told the size before spending a step on it.
    tokens      INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, session_key, id),
    FOREIGN KEY (agent_id, session_key)
        REFERENCES sessions (agent_id, session_key) ON DELETE CASCADE
);
`,
    },
]

export interface MigrationReport {
    readonly from: number
    readonly to: number
    readonly applied: readonly string[]
}

/**
 * Apply every migration above the database's current `user_version`.
 *
 * The whole run is one transaction per migration, and `user_version` is bumped inside it. A
 * crash therefore leaves the database at the last fully-applied version rather than halfway
 * through one — which is the only reason "migrations are idempotent" can be true of a process
 * that can be killed.
 */
export function migrate(db: SqlDatabase): MigrationReport {
    assertContiguous(MIGRATIONS)

    const from = userVersion(db)
    const target = MIGRATIONS.length
    const applied: string[] = []

    if (from > target) {
        throw new HarnessError({
            code: "store_version_ahead",
            message: `The database is at schema version ${from}, but this build only knows ${target}.`,
            hint: "This database was written by a newer build. Downgrading is not supported — a newer schema can hold rows an older build would misread. Use the newer build, or point at a different database file.",
        })
    }

    for (const migration of MIGRATIONS) {
        if (migration.version <= from) continue
        db.transaction(() => {
            db.exec(migration.sql)
            setUserVersion(db, migration.version)
        })
        applied.push(`${migration.version}_${migration.name}`)
    }

    return { from, to: userVersion(db), applied }
}

function assertContiguous(migrations: readonly Migration[]): void {
    for (const [index, migration] of migrations.entries()) {
        if (migration.version !== index + 1) {
            throw new HarnessError({
                code: "store_migrations_not_contiguous",
                message: `Migration ${index + 1} in the list declares version ${migration.version}.`,
                hint: "Migration versions are 1-based and contiguous, in list order. A gap means user_version would jump past a migration and skip it forever.",
            })
        }
    }
}
