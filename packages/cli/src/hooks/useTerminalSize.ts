/**
 * Terminal width, kept current across resizes.
 *
 * `columns` can genuinely be 0 — measured, under a pty allocated by `script -q`, which is how a real
 * TTY gets driven in a test harness. Anything dividing by the width has to survive that, so the
 * fallback is applied here rather than at each call site.
 */

import { useStdout } from "ink"
import { useEffect, useState } from "react"
import { FALLBACK_COLUMNS, FALLBACK_ROWS } from "#lib/const"

interface Size {
    readonly columns: number
    readonly rows: number
}

/**
 * Module-level and pure, so the resize listener has a stable identity. A reader defined inside the
 * hook would be a new function every render, which means either a stale listener or re-subscribing
 * on every frame.
 */
function readSize(stdout: { columns?: number; rows?: number } | undefined): Size {
    const columns = stdout?.columns
    const rows = stdout?.rows
    return {
        columns: columns === undefined || columns <= 0 ? FALLBACK_COLUMNS : columns,
        rows: rows === undefined || rows <= 0 ? FALLBACK_ROWS : rows,
    }
}

export function useTerminalSize(): Size {
    const { stdout } = useStdout()
    const [size, setSize] = useState(() => readSize(stdout))

    useEffect(() => {
        if (stdout === undefined) return
        const onResize = () => setSize(readSize(stdout))
        stdout.on("resize", onResize)
        return () => void stdout.off("resize", onResize)
    }, [stdout])

    return size
}
