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
import { HistorySearch } from "#components/HistorySearch"
import { Live } from "#components/Live"
import { Prompt } from "#components/Prompt"
import { StatusBar } from "#components/StatusBar"
import { Transcript } from "#components/Transcript"
import { applyIntent, EMPTY_EDITOR, submit } from "#editor"
import { useElapsed } from "#hooks/useElapsed"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { useTurn } from "#hooks/useTurn"
import { keyContext, keyToIntent } from "#keymap"
import { SEARCH_ROWS } from "#lib/const"
import type { AppProps } from "#lib/schema"
import {
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import { lastStats } from "#transcript"

export function App({
    agent,
    bus,
    sessionKey,
    model,
    initial,
    showReasoning,
    quiet,
    onRestart,
    initialDraft,
}: AppProps) {
    const { exit } = useApp()
    const { columns } = useTerminalSize()
    const { state, busy, send, cancel, note } = useTurn({ agent, bus, sessionKey, initial })
    // A draft handed in by a `/restart` opens the prompt with the cursor at its end, which is where the
    // person left it. Only the initial value — a later prop change must not overwrite what is being
    // typed now, which is exactly what `useState`'s initialiser semantics give for free.
    const [editor, setEditor] = useState(() =>
        initialDraft === undefined || initialDraft === ""
            ? EMPTY_EDITOR
            : { ...EMPTY_EDITOR, value: initialDraft, cursor: [...initialDraft].length },
    )
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
                case "restart":
                    // The settings an agent booted with are fixed for its lifetime, so a
                    // configuration change needs a new one. Nothing is lost: the conversation lives
                    // in the store and the new agent resumes the same session key.
                    // The unsent draft rides across the restart. `/restart` rebuilds the agent to
                    // pick up a settings change; throwing away a half-written message on the way is a
                    // second, unasked-for consequence of asking for the first.
                    onRestart?.(editor.value)
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
        const intent = keyToIntent(input, key, keyContext(editor, busy))

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
            // Inserted with its newlines intact, as one message.
            //
            // This used to submit every finished line in the chunk, and that was right when the buffer
            // could not hold a newline: the alternative then was silently running the words together.
            // Now that a message is composed rather than typed on one line, sending line-by-line is the
            // bug multi-line composition exists to remove — pasting a twelve-line code block produced
            // twelve messages, each conditioned on the last, and no way to edit any of them.
            setEditor((current) =>
                applyIntent(current, { kind: "insert", text: intent.lines.join("\n") }),
            )
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
            <HistorySearch editor={editor} width={columns} maxRows={SEARCH_ROWS} />
            <Prompt editor={editor} busy={busy} />
            {/* The status line is the footer, under the input — where every reference CLI puts
                it, and where the eye rests between keystrokes. */}
            <StatusBar
                status={state.status}
                model={model}
                sessionKey={sessionKey}
                elapsedMs={elapsed}
                last={last}
                quiet={quiet}
            />
        </Box>
    )
}
