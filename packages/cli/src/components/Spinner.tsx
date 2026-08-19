/**
 * A braille spinner with a label. Ten glyphs from the theme, not a dependency (decision 11.10).
 *
 * The one kit component with its own state — the frame index — because animation is presentation,
 * not application state. Callers pair it with `useElapsed` when a count-up matters (the picker's
 * boot transition); it is deliberately not used in the init wizard, whose write-and-validate
 * completes in single-digit milliseconds and would only flash.
 */

import { Text } from "ink"
import { useEffect, useState } from "react"
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, THEME } from "#lib/theme"

export interface SpinnerProps {
    readonly label: string
}

export function Spinner({ label }: SpinnerProps) {
    const [frame, setFrame] = useState(0)
    useEffect(() => {
        const timer = setInterval(
            () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
            SPINNER_INTERVAL_MS,
        )
        return () => clearInterval(timer)
    }, [])

    return (
        <Text>
            <Text color={THEME.accent}>{SPINNER_FRAMES[frame]}</Text> {label}
        </Text>
    )
}
