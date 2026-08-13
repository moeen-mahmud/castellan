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
