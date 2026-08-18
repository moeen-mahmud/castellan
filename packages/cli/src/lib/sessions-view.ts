/**
 * A stored conversation as a row somebody can pick.
 *
 * Pure, and separate from `sessions.ts` for the reason every layout module here is: the *content* of a
 * row — what identifies a conversation, what makes one worth returning to — is the only interesting part,
 * and it is only observable as strings. The picker renders these; `sessions --plain` keeps its own table,
 * because a listing read by a script and a list navigated with arrows want different shapes.
 *
 * What identifies a conversation is the open question here and the answer is deliberate: the key, because
 * that is what you type back, plus **when it was last touched** and **how much is in it**. Not the first
 * message, tempting as that is — it would need a store read per row, and a session whose first message was
 * "hey" is not distinguished by it.
 */

import { ago } from "#lib/render"
import { clip } from "#lib/rows"
import { isGeneratedSessionKey } from "#lib/session-key"

/** The narrow slice of a `SessionSummary` this needs. Structural, so no core type is imported. */
export interface SessionRowSource {
    readonly sessionKey: string
    readonly messages: number
    readonly turns: number
    readonly lastActivityAt: string
    readonly phase?: string | undefined
}

export interface SessionRow {
    readonly key: string
    readonly label: string
    readonly hint: string
}

/** The key column, wide enough for a generated key and clamped so a hand-written one cannot push the row. */
const KEY_MIN = 14
const KEY_MAX = 28

export function sessionRows(
    sessions: readonly SessionRowSource[],
    options: { readonly now: number; readonly columns: number },
): readonly SessionRow[] {
    const longest = sessions.reduce((widest, row) => Math.max(widest, row.sessionKey.length), 0)
    const keyColumn = Math.max(KEY_MIN, Math.min(KEY_MAX, longest))
    // The gutter the list draws, the key column, and two of gap.
    const room = Math.max(12, options.columns - (2 + keyColumn + 2))

    return sessions.map((row) => {
        const parts = [
            `${row.messages} message${row.messages === 1 ? "" : "s"}`,
            `${row.turns} turn${row.turns === 1 ? "" : "s"}`,
            ago(row.lastActivityAt, options.now),
        ]
        // A phase is only shown when there is one: an agent with no phases would otherwise spend a column
        // on the word "none" in every row.
        if (row.phase !== undefined && row.phase !== "") parts.push(row.phase)
        // A key the person chose is worth marking, because it is the one they will recognise — everything
        // else in this list is six characters they have never read before.
        if (!isGeneratedSessionKey(row.sessionKey)) parts.push("named")
        return {
            key: row.sessionKey,
            label: clip(row.sessionKey, keyColumn).padEnd(keyColumn),
            hint: clip(parts.join(" · "), room),
        }
    })
}
