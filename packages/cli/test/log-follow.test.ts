/**
 * Following a log somebody else is writing.
 *
 * `--follow` was a declared option that printed a hint telling you to run `tail -f` yourself. The two
 * things worth asserting are the ones that make it more than a loop: it must notice a file being
 * *emptied* (which is how `--truncate` works, because launchd holds the descriptor and deleting the file
 * leaves output flowing into a deleted inode), and it must not reprint the tail the caller already showed.
 */

import { describe, expect, test } from "bun:test"
import { type FollowIO, followLogs, nextRead } from "#lib/log-follow"

describe("nextRead", () => {
    test("nothing new is an empty read rather than a rewind", () => {
        expect(nextRead(120, 120)).toEqual({ from: 120, to: 120, truncated: false })
    })

    test("growth is read from where we stopped", () => {
        expect(nextRead(120, 200)).toEqual({ from: 120, to: 200, truncated: false })
    })

    test("a shorter file was emptied under us, so it starts again", () => {
        // Carrying the offset across a truncation means never printing another line and never saying
        // why — the failure is silent and permanent, which is the worst shape available for a log.
        expect(nextRead(120, 10)).toEqual({ from: 0, to: 10, truncated: true })
    })

    test("emptied to nothing is still a truncation", () => {
        expect(nextRead(120, 0)).toEqual({ from: 0, to: 0, truncated: true })
    })
})

/** A filesystem and a clock as plain values, so the loop runs in microseconds. */
function harness(files: Record<string, string | undefined>) {
    const written: string[] = []
    let ticks = 0
    const stopAfter = 4
    const io: FollowIO = {
        sizeOf: (path) => {
            const body = files[path]
            return body === undefined ? undefined : Buffer.byteLength(body)
        },
        read: (path, from, to) =>
            Buffer.from(files[path] ?? "")
                .subarray(from, to)
                .toString(),
        write: (text) => void written.push(text),
        wait: async () => {
            ticks += 1
        },
        stopped: () => ticks >= stopAfter,
    }
    return { io, written, files }
}

describe("followLogs", () => {
    test("it starts from the caller's offsets, so the tail is not reprinted", async () => {
        const h = harness({ "/err": "old line\nnew line\n" })
        await followLogs([{ path: "/err", label: "stderr" }], h.io, {
            offsets: { "/err": "old line\n".length },
            intervalMs: 0,
        })
        expect(h.written.join("")).toBe("new line\n")
    })

    test("one source gets no banner; two get one only when the source changes", async () => {
        const one = harness({ "/err": "a\n" })
        await followLogs([{ path: "/err", label: "stderr" }], one.io, {
            offsets: {},
            intervalMs: 0,
        })
        expect(one.written.join("")).toBe("a\n")

        const both = harness({ "/err": "boom\n", "/out": "refused\n" })
        await followLogs(
            [
                { path: "/err", label: "stderr" },
                { path: "/out", label: "stdout" },
            ],
            both.io,
            { offsets: {}, intervalMs: 0 },
        )
        const text = both.written.join("")
        expect(text).toBe("\n── stderr ──\nboom\n\n── stdout ──\nrefused\n")
        // Said once, not once per poll: nothing new arrives on later ticks, so nothing is announced.
        expect(text.split("── stderr ──").length - 1).toBe(1)
    })

    test("a file emptied mid-follow says so and resumes from the start", async () => {
        const h = harness({ "/err": "first\n" })
        let polls = 0
        const io: FollowIO = {
            ...h.io,
            wait: async () => {
                polls += 1
                // `daemon logs --truncate` while somebody is watching.
                if (polls === 1) h.files["/err"] = "new\n"
            },
            stopped: () => polls >= 2,
        }
        await followLogs([{ path: "/err", label: "stderr" }], io, {
            offsets: {},
            intervalMs: 0,
        })
        expect(h.written.join("")).toBe("first\n\n── stderr was emptied ──\nnew\n")
    })

    test("a replacement of exactly the same length is invisible, and that is documented", async () => {
        // The known blind spot of every size-based follower, `tail -f` included. Asserted rather than
        // wished away: a truncation is detected by the file getting *shorter*, so a rewrite to the same
        // byte count reads as "nothing new". In practice `--truncate` writes an empty file and the next
        // poll sees length zero, which is shorter than anything.
        const h = harness({ "/err": "first\n" })
        let polls = 0
        const io: FollowIO = {
            ...h.io,
            wait: async () => {
                polls += 1
                if (polls === 1) h.files["/err"] = "other\n"
            },
            stopped: () => polls >= 2,
        }
        await followLogs([{ path: "/err", label: "stderr" }], io, {
            offsets: {},
            intervalMs: 0,
        })
        expect(h.written.join("")).toBe("first\n")
    })

    test("a file that does not exist yet is followed from its start when it appears", async () => {
        // A service installed and never started has no log. Resetting the offset would print a
        // truncation notice for a file that was simply not there.
        const h = harness({ "/err": undefined })
        let polls = 0
        const io: FollowIO = {
            ...h.io,
            wait: async () => {
                polls += 1
                if (polls === 1) h.files["/err"] = "started\n"
            },
            stopped: () => polls >= 2,
        }
        await followLogs([{ path: "/err", label: "stderr" }], io, {
            offsets: {},
            intervalMs: 0,
        })
        expect(h.written.join("")).toBe("started\n")
    })
})
