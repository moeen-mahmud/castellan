/**
 * One line saying what the runtime is doing.
 *
 * It exists to answer a question the old REPL could not: is this slow or is it hung? A model that
 * takes twelve seconds before its first token and a model that will never answer look identical
 * without an elapsed counter, and "nothing is happening" is the least debuggable state a tool can
 * present.
 */

import { Text } from "ink"
import type { StatusBarProps } from "#lib/schema"
import { GLYPH, STATUS_COLOR, THEME } from "#lib/theme"
import type { TurnStatus } from "#lib/types"
import { formatStats } from "#transcript"

const LABEL: Record<TurnStatus, string> = {
    idle: "ready",
    thinking: "thinking",
    streaming: "replying",
    working: "running a tool",
    cancelling: "cancelling",
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`
}

/**
 * What ^C will do, said in the place a reader is already looking.
 *
 * Three states rather than two, because the chord now has three meanings and the wrong hint is worse
 * than none: mid-turn it cancels, at an idle prompt it arms, and once armed it leaves. The armed line is
 * the one that has to be loud — it is the only moment when the next keystroke discards the screen.
 */
function exitHint(status: TurnStatus, armed: boolean): string {
    if (status !== "idle") return " · ^C cancels"
    return armed ? " · ^C again to leave" : " · ^C twice to leave · /exit"
}

export function StatusBar({
    status,
    model,
    sessionKey,
    elapsedMs,
    last,
    quiet,
    armed,
}: StatusBarProps) {
    return (
        // Truncated, never wrapped. Found live at 80 columns: `ready · deepseek-v4-pro · live:two · last
        // 2330 prompt · 80 output · 2681 ms · ^C twice to leave · /exit` is longer than the terminal, so Ink
        // wrapped it onto a second row — which made the frame one row taller than `chatFrame` had counted
        // and pushed the top of the display off the alternate buffer. A status line is the one thing that
        // must never change height: everything else is laid out against it.
        <Text dimColor wrap="truncate">
            <Text color={STATUS_COLOR[status]}>
                {GLYPH.dot}
                {LABEL[status]}
            </Text>
            {status === "idle" ? "" : ` ${seconds(elapsedMs)}`}
            {` · ${model} · ${sessionKey}`}
            {last === undefined || quiet ? "" : ` · last ${formatStats(last)}`}
            {armed === true ? (
                <Text color={THEME.warning}>{exitHint(status, true)}</Text>
            ) : (
                exitHint(status, false)
            )}
        </Text>
    )
}
