/**
 * Turn and step ids.
 *
 * Client-visible, because reattach needs a handle: deriving one from the session key breaks the
 * moment two turns overlap. Time-prefixed so they sort chronologically in a log without a join.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

function randomSuffix(length: number): string {
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    let out = ""
    for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
    return out
}

function id(prefix: string, now: number): string {
    return `${prefix}_${now.toString(36)}${randomSuffix(8)}`
}

export function newTurnId(now = Date.now()): string {
    return id("t", now)
}

export function newStepId(now = Date.now()): string {
    return id("s", now)
}
