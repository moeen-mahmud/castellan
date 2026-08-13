/**
 * The chat surface.
 *
 * Thin on purpose. Everything worth testing already lives in pure modules — `keymap.ts` decides what
 * a keystroke means, `editor.ts` applies it to the line, `transcript.ts` turns bus events into view
 * state — so this file is composition plus the three decisions that need Ink itself: when to unmount,
 * what to do about a submission arriving mid-turn, and how the pieces stack on screen.
 *
 * The Ctrl-C contract from Phase 1 holds unchanged: during a turn it cancels the turn and the prompt
 * comes back; at an idle prompt it exits. `keymap.ts` owns that decision so it can be tested in both
 * states rather than only by hand.
 */

import { Box, useApp, useInput } from "ink"
import { useMemo, useState } from "react"
import { Live } from "#components/Live"
import { Prompt } from "#components/Prompt"
import { StatusBar } from "#components/StatusBar"
import { Transcript } from "#components/Transcript"
import { applyIntent, EMPTY_EDITOR, submit } from "#editor"
import { useElapsed } from "#hooks/useElapsed"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { useTurn } from "#hooks/useTurn"
import { keyToIntent } from "#keymap"
import type { AppProps } from "#lib/schema"
import {
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import { lastStats } from "#transcript"

export function App({ agent, bus, sessionKey, model, initial, showReasoning, quiet }: AppProps) {
    const { exit } = useApp()
    const { columns } = useTerminalSize()
    const { state, busy, send, cancel, note } = useTurn({ agent, bus, sessionKey, initial })
    const [editor, setEditor] = useState(EMPTY_EDITOR)
    const elapsed = useElapsed(busy)
    const last = useMemo(() => lastStats(state.items), [state.items])

    const onSubmit = (text: string): void => {
        // Both renderers dispatch through the same table, so `--plain` and the rich path cannot
        // answer the same typed command differently.
        const command = resolveSessionCommand(text)
        if (command !== undefined) {
            switch (command.kind) {
                case "exit":
                    exit()
                    return
                case "help":
                    note(sessionHelpText())
                    return
                case "tools":
                    note(toolsReport(toolsView(agent)))
                    return
                case "reset":
                    // Fire-and-report rather than awaited: a component cannot block, and the note is
                    // the acknowledgement. A failure surfaces as a rejected promise, so it is caught.
                    agent
                        .clearSession(sessionKey)
                        .then(() => note("session cleared — memory files on disk are untouched"))
                        .catch((error: unknown) =>
                            note(
                                `could not clear the session: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                        )
                    return
                case "unknown":
                    note(unknownCommandText(command))
                    return
            }
        }
        if (busy) {
            // Two turns on one session would interleave in the history the next turn is conditioned
            // on. Refusing is honest; queueing silently would make the reply order unpredictable.
            note("a turn is still running — ^C cancels it, then send again")
            return
        }
        send(text)
    }

    useInput((input, key) => {
        const intent = keyToIntent(input, key, { busy, empty: editor.value === "" })

        if (intent.kind === "exit") {
            exit()
            return
        }
        if (intent.kind === "cancel") {
            cancel()
            return
        }
        if (intent.kind === "submit") {
            const committed = submit(editor)
            setEditor(committed.state)
            if (committed.text !== "") onSubmit(committed.text)
            return
        }
        if (intent.kind === "paste") {
            // Every finished line is sent in order; an unterminated tail stays on the input line so
            // it can be edited. Threading one local state through the loop keeps history correct —
            // each pasted line is recorded exactly as if it had been typed.
            const finished = intent.complete ? intent.lines : intent.lines.slice(0, -1)
            const tail = intent.complete ? "" : (intent.lines.at(-1) ?? "")
            let next = editor
            for (const line of finished) {
                const committed = submit(applyIntent(next, { kind: "insert", text: line }))
                next = committed.state
                if (committed.text !== "") onSubmit(committed.text)
            }
            setEditor(tail === "" ? next : applyIntent(next, { kind: "insert", text: tail }))
            return
        }
        setEditor((current) => applyIntent(current, intent))
    })

    return (
        <Box flexDirection="column">
            <Transcript items={state.items} showReasoning={showReasoning} quiet={quiet} />
            {state.live === undefined ? null : (
                <Live live={state.live} showReasoning={showReasoning} columns={columns} />
            )}
            <StatusBar
                status={state.status}
                model={model}
                sessionKey={sessionKey}
                elapsedMs={elapsed}
                last={last}
                quiet={quiet}
            />
            <Prompt editor={editor} busy={busy} />
        </Box>
    )
}
