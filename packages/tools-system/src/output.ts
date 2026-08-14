/**
 * Turning a file of command output into something worth putting in a context window.
 *
 * ## Two tiers, not truncation
 *
 * Small output goes inline. Large output stays on disk and the model is handed a preview plus the
 * path, which turns "this did not fit" from a loss into a retrieval — the model can read the rest if
 * it needs to, with `file_read` or with `exec` itself.
 *
 * That distinction is the entire point, and it is why `INLINE_CAP` is set *below* the harness's own
 * observation budget rather than at it. The executor truncates anything over
 * `runtime.observationMaxTokens` by cutting the middle out, with a marker — honest, but the cut bytes
 * are gone for good and nothing can go back for them. Spilling first means the blunt cut never fires,
 * because what reaches it is already small. A cap set *at* the harness budget would let the two
 * mechanisms race, and the wrong one would usually win.
 *
 * ## Head, and tail only on failure
 *
 * A successful command's interesting part is the beginning: what it found, what it listed. A failed
 * one's interesting part is at both ends — the beginning says what it was doing and the end says what
 * went wrong, and a compiler that prints two hundred warnings before the error it died on is the
 * ordinary case rather than the exotic one.
 */

import { open } from "node:fs/promises"
import { stripControl } from "@castellan/core"

/**
 * Above this, output is left on disk. Roughly 1,500 tokens — deliberately under the 2,000-token
 * default of `runtime.observationMaxTokens`, so the retrievable cut always beats the lossy one.
 */
export const INLINE_CAP = 6_000

const HEAD_PREVIEW = 3_000
const TAIL_PREVIEW = 1_500

export interface Observation {
    /** The whole output when it fits, the first `HEAD_PREVIEW` bytes when it does not. */
    readonly head: string
    /** The last `TAIL_PREVIEW` bytes. Empty unless the output spilled. */
    readonly tail: string
    /** Size on disk, before any preview was taken. Reported, so a cut is a number and not a guess. */
    readonly bytes: number
    readonly spilled: boolean
}

/** Bytes to text, tolerating a multi-byte character split across a preview boundary. */
const decoder = new TextDecoder("utf-8")

async function readRange(path: string, offset: number, length: number): Promise<string> {
    const handle = await open(path, "r")
    try {
        const buffer = new Uint8Array(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return decoder.decode(buffer.subarray(0, bytesRead))
    } finally {
        await handle.close()
    }
}

/**
 * Read a command's output file into a previewable shape.
 *
 * Escapes are stripped here rather than left to the trust renderer, even though that renderer would
 * catch them too. This is where the byte counts are computed, and a preview measured before stripping
 * and displayed after would report a size the model cannot reconcile with what it sees.
 */
export async function readOutput(path: string): Promise<Observation> {
    const handle = await open(path, "r")
    let bytes: number
    try {
        bytes = (await handle.stat()).size
    } finally {
        await handle.close()
    }

    if (bytes <= INLINE_CAP) {
        return {
            head: stripControl(await readRange(path, 0, bytes)),
            tail: "",
            bytes,
            spilled: false,
        }
    }

    return {
        head: stripControl(await readRange(path, 0, HEAD_PREVIEW)),
        tail: stripControl(await readRange(path, bytes - TAIL_PREVIEW, TAIL_PREVIEW)),
        bytes,
        spilled: true,
    }
}

/**
 * Remove the terminal's echo of our own end-of-input.
 *
 * A pty echoes what it receives, and stdin is closed at spawn — so on macOS every single `pty: true`
 * observation begins with a literal `^D`, which is the tty repeating the EOF back at us before the
 * command has printed anything. It is the two characters caret and D, not the control byte, so
 * `stripControl` never sees it.
 *
 * Closing stdin is the deliberate choice it looks like: a command that asks a question gets EOF and
 * fails immediately, rather than hanging until the deadline holding a terminal nobody is watching.
 * This is the one artefact that choice produces, and it is removed only at the very start of the
 * output, where it is unambiguously ours — a `^D` in the middle of a transcript is the command's.
 */
export function stripLeadingEcho(text: string): string {
    return text.replace(/^(?:\^[A-Z?]\s*)+/, "")
}

/** `12.3 KB`. Only ever shown next to a path the model can act on. */
export function humanBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
