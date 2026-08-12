import { beforeEach, describe, expect, test } from "bun:test"
import { finish, markTerminalDirty, onExit, resetForTests, restoreTerminal } from "#lib/exit"
import type { TerminalHandles } from "#lib/schema"

interface Fake extends TerminalHandles {
    readonly written: string[]
    readonly rawModeCalls: boolean[]
}

function fakeTerminal(options: { outIsTTY: boolean; inIsTTY: boolean }): Fake {
    const written: string[] = []
    const rawModeCalls: boolean[] = []
    return {
        written,
        rawModeCalls,
        out: {
            isTTY: options.outIsTTY,
            write(chunk: string) {
                written.push(chunk)
                return true
            },
        },
        in: {
            isTTY: options.inIsTTY,
            setRawMode(mode: boolean) {
                rawModeCalls.push(mode)
            },
        },
    }
}

beforeEach(() => {
    resetForTests()
})

describe("restoreTerminal", () => {
    test("shows the cursor and resets styling at a terminal", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).toContain("[?25h")
        expect(terminal.written.join("")).toContain("[0m")
    })

    test("takes stdin out of raw mode — the state that breaks the shell", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.rawModeCalls).toEqual([false])
    })

    test("writes no escape sequences when stdout is not a terminal", () => {
        // Emitting a cursor sequence into a pipe would corrupt the very output the plain mode
        // exists to keep clean.
        const terminal = fakeTerminal({ outIsTTY: false, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written).toEqual([])
    })

    test("leaves raw mode alone when stdin is not a terminal", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: false })
        restoreTerminal(terminal)
        expect(terminal.rawModeCalls).toEqual([])
    })

    test("does nothing when the terminal was never touched", () => {
        // The plain path never hides the cursor or sets raw mode, so there is nothing to undo — and
        // emitting a reset anyway would put escape sequences at the end of output that is otherwise
        // pure text, breaking the property plain mode exists for.
        resetForTests({ dirty: false })
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written).toEqual([])
        expect(terminal.rawModeCalls).toEqual([])
    })

    test("runs once the rich path has declared the terminal dirty", () => {
        resetForTests({ dirty: false })
        markTerminalDirty()
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        expect(terminal.written.join("")).toContain("[?25h")
    })

    test("is idempotent — it runs explicitly and again from the exit hook", () => {
        const terminal = fakeTerminal({ outIsTTY: true, inIsTTY: true })
        restoreTerminal(terminal)
        restoreTerminal(terminal)
        restoreTerminal(terminal)
        expect(terminal.written).toHaveLength(1)
        expect(terminal.rawModeCalls).toEqual([false])
    })
})

describe("teardowns", () => {
    test("run in reverse registration order", () => {
        const order: string[] = []
        onExit(() => void order.push("runtime"))
        onExit(() => void order.push("ink"))
        restoreTerminal(fakeTerminal({ outIsTTY: false, inIsTTY: false }))
        return finish(0).then(() => {
            // Ink unmounts before the runtime it was rendering closes.
            expect(order).toEqual(["ink", "runtime"])
        })
    })

    test("an async teardown is awaited", async () => {
        const order: string[] = []
        onExit(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            order.push("slow")
        })
        onExit(() => void order.push("fast"))
        await finish(0)
        expect(order).toEqual(["fast", "slow"])
    })

    test("a throwing teardown does not stop the rest", async () => {
        const order: string[] = []
        onExit(() => void order.push("first"))
        onExit(() => {
            throw new Error("cleanup blew up")
        })
        onExit(() => void order.push("third"))
        await finish(0)
        // The terminal restore is itself a teardown-adjacent step; one bad hook must not strand it.
        expect(order).toEqual(["third", "first"])
    })

    test("each teardown runs once, even if finish is reached twice", async () => {
        let count = 0
        onExit(() => {
            count += 1
        })
        await finish(0)
        await finish(0)
        expect(count).toBe(1)
    })
})

describe("exit codes", () => {
    test("finish sets the code rather than exiting, so piped output can drain", async () => {
        const previous = process.exitCode
        try {
            await finish(0)
            expect(process.exitCode).toBe(0)
        } finally {
            process.exitCode = previous
        }
    })

    test("a non-zero code survives the trip through finish", async () => {
        const previous = process.exitCode
        try {
            await finish(3)
            expect(process.exitCode).toBe(3)
        } finally {
            // Restore, or this test would fail the suite it belongs to.
            process.exitCode = previous
        }
    })
})
