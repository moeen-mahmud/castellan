/**
 * Milliseconds since `active` became true, ticking while it stays true.
 *
 * This is the only clock in the CLI's view layer, and it is deliberately isolated: the transcript
 * reducer takes its durations from `turn.end`, so it needs no clock and stays deterministic. What
 * needs a clock is the "thinking for 4s" counter, whose entire job is to distinguish a slow model
 * from a hung one — the case where showing nothing is worst.
 */

import { useEffect, useState } from "react"

const TICK_MS = 100

export function useElapsed(active: boolean): number {
    const [elapsed, setElapsed] = useState(0)

    useEffect(() => {
        if (!active) {
            setElapsed(0)
            return
        }
        const startedAt = Date.now()
        setElapsed(0)
        const id = setInterval(() => setElapsed(Date.now() - startedAt), TICK_MS)
        return () => clearInterval(id)
    }, [active])

    return elapsed
}
