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
import type { TurnStatus } from "#lib/types"
import { formatStats } from "#transcript"

const LABEL: Record<TurnStatus, string> = {
    idle: "ready",
    thinking: "thinking",
    streaming: "replying",
    cancelling: "cancelling",
}

const COLOUR: Record<TurnStatus, string> = {
    idle: "green",
    thinking: "yellow",
    streaming: "cyan",
    cancelling: "magenta",
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`
}

export function StatusBar({ status, model, sessionKey, elapsedMs, last, quiet }: StatusBarProps) {
    return (
        <Text dimColor>
            <Text color={COLOUR[status]}>● {LABEL[status]}</Text>
            {status === "idle" ? "" : ` ${seconds(elapsedMs)}`}
            {` · ${model} · ${sessionKey}`}
            {last === undefined || quiet ? "" : ` · last ${formatStats(last)}`}
            {status === "idle" ? " · ^C exits" : " · ^C cancels"}
        </Text>
    )
}
