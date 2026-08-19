/**
 * Identities derived from content, rather than generated.
 *
 * Three subsystems now need one and they need it for the same reason, so the reasoning lives here
 * once. The outbox derives a delivery key, compaction derives an artifact id, and memory derives a
 * passage id — and in every case a UUID would have been the obvious choice and the wrong one.
 *
 * A generated id dedupes a table against *itself*, which is a problem none of these have. The
 * duplicate that actually happens is **the same work running twice**: an enqueuer re-running after a
 * crash, the ladder escalating over a message it already snipped on an earlier turn, a memory file
 * re-indexed after an edit that did not touch that passage. Only an identity both runs can recompute
 * collides, which is what makes `INSERT OR IGNORE` and `ON CONFLICT` correct rather than hopeful.
 *
 * The output is **printable ASCII by construction**, and that is load-bearing rather than tidy. Row
 * seven of the table in `store/sqlite/driver.ts`: `node:sqlite` truncates a bound string at a NUL byte
 * while `bun:sqlite` stores it whole, so a key carrying one resolves on one runtime and silently misses
 * on the other — no error, on one driver out of two.
 *
 * FNV-1a rather than a cryptographic hash: this is a dedupe key, not a signature. Nothing here defends
 * against an adversary choosing content to collide, and nothing needs to — the worst case is two
 * memory passages sharing a row, in a corpus where identical text genuinely is one fact.
 */

/**
 * 32-bit FNV-1a, as eight lowercase hex digits.
 *
 * Written out rather than reaching for `Bun.hash`, which is absent under Node — the same constraint
 * that shapes the sqlite driver, applied to a hash. `Math.imul` is what keeps the multiply in 32-bit
 * space; the plain `*` operator loses precision above 2^53 and would make the result differ between
 * inputs that should hash apart.
 */
export function fnv1a(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}

/**
 * `<prefix>_<length base 36>_<hash>` — a content-derived id, unique enough and cheap to recompute.
 *
 * The length is in the key on purpose: it costs three or four characters and it makes a collision
 * require two strings that are both the same length *and* FNV-equal, which is a great deal less likely
 * than FNV-equal alone. It also makes an id readable at a glance — a very long passage and a one-line
 * note do not look alike.
 *
 * **The format is a compatibility surface.** `displacedId` produced exactly this shape before it was
 * moved here, and artifact rows on disk carry those ids; changing the separator or the radix would
 * orphan every one of them, with `artifact_read` reporting a missing id for content that is right
 * there. Asserted in `ids.test.ts` against a literal rather than left to review.
 */
export function derivedId(prefix: string, content: string): string {
    return `${prefix}_${content.length.toString(36)}_${fnv1a(content)}`
}
