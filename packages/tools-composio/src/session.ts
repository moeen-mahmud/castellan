/**
 * Where a router session id lives between runs.
 *
 * A session is Composio's runtime context for one person: which accounts are connected, what has
 * been discovered, what the workbench holds. Creating one is a network round trip, so doing it per
 * turn would put a request in front of every search for no gain — and would throw away the
 * discovery state that makes a second search in the same workflow cheaper.
 *
 * Its own file rather than a field on `tools.cache.json`, for one specific reason: that cache
 * carries a `version` and is *discarded whole* when the number changes, which is right for schemas
 * whose shape moved and wrong for an opaque id that is still perfectly valid. Bumping the schema
 * version should not silently orphan a session on Composio's side.
 *
 * Keyed by `userId`. Two agents sharing a directory is not a case that exists — the directory is the
 * agent — but two *users* on one agent is, and their sessions must not be confused: a session is
 * precisely the thing that decides whose Gmail a call reaches.
 */

import { BRAND } from "@castellan/core"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

const SESSION_FILE = "composio.session.json"

interface SessionFile {
    readonly sessions: Readonly<Record<string, string>>
}

export function sessionPath(dir: string): string {
    return isAbsolute(dir)
        ? join(dir, BRAND.stateDir, SESSION_FILE)
        : join(resolve(dir), BRAND.stateDir, SESSION_FILE)
}

/**
 * The stored session id for this user, or undefined.
 *
 * Never throws, for the same reason `readCache` never does: every way this can fail — absent,
 * truncated, hand-edited — has one correct response, which is to open a new session. A parse error
 * naming a file nobody wrote would be the worst available outcome.
 */
export function readSession(dir: string, userId: string): string | undefined {
    let raw: string
    try {
        raw = readFileSync(sessionPath(dir), "utf8")
    } catch {
        return undefined
    }
    try {
        const parsed: unknown = JSON.parse(raw)
        const sessions = (parsed as Partial<SessionFile> | null)?.sessions
        if (typeof sessions !== "object" || sessions === null) return undefined
        const id = (sessions as Record<string, unknown>)[userId]
        return typeof id === "string" && id !== "" ? id : undefined
    } catch {
        return undefined
    }
}

/** Record this user's session id, leaving any other user's untouched. */
export function writeSession(dir: string, userId: string, sessionId: string): string {
    const path = sessionPath(dir)
    mkdirSync(dirname(path), { recursive: true })

    let existing: Record<string, string> = {}
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
        const sessions = (parsed as Partial<SessionFile> | null)?.sessions
        if (typeof sessions === "object" && sessions !== null) {
            for (const [key, value] of Object.entries(sessions)) {
                if (typeof value === "string") existing[key] = value
            }
        }
    } catch {
        existing = {}
    }

    const file: SessionFile = { sessions: { ...existing, [userId]: sessionId } }
    // Temp-then-rename, as the schema cache does: a reader sees one complete file or the other,
    // never half of either.
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
    renameSync(temp, path)
    return path
}
