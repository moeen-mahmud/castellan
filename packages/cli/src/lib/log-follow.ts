/**
 * Following a log file that something else is writing.
 *
 * `daemon logs --follow` printed a tail and then a hint telling you to run `tail -f` yourself, which is
 * a flag documenting its own absence. Two things make the real implementation worth a module rather than
 * a few lines inline.
 *
 * **A service log is truncated, not rotated.** `daemon logs --truncate` empties the file in place,
 * because launchd holds the descriptor and deleting it leaves output flowing into a deleted inode — disk
 * consumed, `ls` showing nothing. So a follower has to notice the file getting *shorter* and start again
 * from the beginning; an offset carried blindly across a truncation reads garbage or, more often,
 * silently nothing ever again.
 *
 * **The decision is arithmetic and the reading is not.** `nextRead` is a pure function over two numbers
 * and holds everything worth asserting; `followLogs` is the loop, with its clock and its streams passed
 * in so a test can drive it against a temp directory in milliseconds.
 *
 * Polled rather than watched. `fs.watch` on macOS reports appends by another process unreliably, and a
 * follower that misses the line you are waiting for is worse than one that arrives 300 ms late — the
 * whole reason somebody is watching a log is that they do not trust what they are being told.
 */

export interface ReadStep {
    /** Byte offset to read from. */
    readonly from: number
    /** Byte offset to read to. Equal to `from` when there is nothing new. */
    readonly to: number
    /** The file got shorter, so this is a fresh start rather than a continuation. */
    readonly truncated: boolean
}

/**
 * What to read next, given where we stopped and how big the file is now.
 *
 * A file that shrank was emptied under us: read it from the start and say so, because the alternative —
 * carrying the old offset — means never printing another line and never explaining why.
 *
 * The blind spot, stated rather than wished away: a rewrite to *exactly* the same byte count reads as
 * "nothing new", because size is the only signal. Every size-based follower has this, `tail -f`
 * included, and the case that actually happens is caught — `--truncate` writes an empty file, and zero
 * is shorter than anything. A test asserts the blind spot so nobody discovers it as a mystery.
 */
export function nextRead(offset: number, size: number): ReadStep {
    if (size < offset) return { from: 0, to: size, truncated: true }
    return { from: offset, to: size, truncated: false }
}

export interface FollowSource {
    readonly path: string
    /** Printed above a chunk when the source changes — `stderr`, `stdout`. */
    readonly label: string
}

export interface FollowIO {
    /** Bytes currently in the file, or `undefined` if it does not exist yet. */
    sizeOf(path: string): number | undefined
    read(path: string, from: number, to: number): string
    write(text: string): void
    /** Resolves after `ms`, or immediately once the follow has been asked to stop. */
    wait(ms: number): Promise<void>
    /** Checked between polls. The caller owns whatever sets it — a signal, a keypress, a test. */
    stopped(): boolean
}

/**
 * Follow every source until asked to stop.
 *
 * Starting offsets come from the caller, which is what lets `daemon logs` print its tail with the
 * existing code and then continue from exactly where that ended — rather than reprinting it, or skipping
 * whatever arrived between the two.
 *
 * A label is printed only when the source changes. Following one file is the common case and a banner on
 * every chunk of it is noise; following two, the switch is the only thing that needs saying.
 */
export async function followLogs(
    sources: readonly FollowSource[],
    io: FollowIO,
    options: { readonly offsets: Readonly<Record<string, number>>; readonly intervalMs: number },
): Promise<void> {
    const offsets = new Map(
        sources.map((source) => [source.path, options.offsets[source.path] ?? 0]),
    )
    let lastLabel: string | undefined

    while (!io.stopped()) {
        for (const source of sources) {
            const size = io.sizeOf(source.path)
            // Not written yet. Left at whatever offset it had rather than reset, so a file that appears
            // later is followed from its start without a truncation notice.
            if (size === undefined) continue
            const step = nextRead(offsets.get(source.path) ?? 0, size)
            offsets.set(source.path, step.to)
            if (step.truncated) {
                io.write(`\n── ${source.label} was emptied ──\n`)
                lastLabel = source.label
            }
            if (step.to <= step.from) continue
            const chunk = io.read(source.path, step.from, step.to)
            if (chunk === "") continue
            if (sources.length > 1 && source.label !== lastLabel) {
                io.write(`\n── ${source.label} ──\n`)
                lastLabel = source.label
            }
            io.write(chunk)
        }
        await io.wait(options.intervalMs)
    }
}
