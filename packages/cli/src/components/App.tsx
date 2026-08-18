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

import { BRAND, VERSION } from "@castellan/core"
import { Box, Text, useApp, useInput } from "ink"
import { type ComponentType, useCallback, useMemo, useState } from "react"
import { CommandOutput } from "#components/CommandOutput"
import { HistorySearch } from "#components/HistorySearch"
import { Live } from "#components/Live"
import { Palette } from "#components/Palette"
import { Prompt } from "#components/Prompt"
import type { SkillBrowserProps } from "#components/SkillBrowser"
import { StatusBar } from "#components/StatusBar"
import { Transcript } from "#components/Transcript"
import { applyIntent, EMPTY_EDITOR, submit } from "#editor"
import { useElapsed } from "#hooks/useElapsed"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { useTurn } from "#hooks/useTurn"
import { keyContext, keyToIntent } from "#keymap"
import { PANE_ROWS, SEARCH_ROWS } from "#lib/const"
import { paletteEntries, paletteFor, paletteSelection } from "#lib/palette"
import type { AppProps } from "#lib/schema"
import {
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import { runSubcommand } from "#lib/subcommand"
import { lastStats } from "#transcript"

/**
 * What is layered over the conversation.
 *
 * `output` is a command's captured text; `skills` is the one bespoke view a session hosts so far. Both
 * take the keyboard while open, and closing either returns to the prompt with the draft untouched — which
 * is the property that makes a pane an interlude rather than a detour.
 */
type Pane =
    | { readonly kind: "none" }
    | {
          readonly kind: "output"
          readonly label: string
          readonly lines: readonly string[] | undefined
          readonly code?: number
          readonly offset: number
      }
    | { readonly kind: "skills" }

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
    manifestPath,
    catalogue,
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

    /**
     * What is on top of the conversation, if anything.
     *
     * A pane is *focused* while it is open, so the prompt's `useInput` stands down — Ink fires every
     * active hook, and two surfaces reading one keystroke is the bug the focus rule exists to prevent.
     */
    const [pane, setPane] = useState<Pane>({ kind: "none" })
    /**
     * The skills view's implementation, loaded when it is first opened.
     *
     * Dynamically, and that is not an optimisation. `browse.ts` also imports this component dynamically,
     * and bun's `--splitting` emits a module's exports **twice** when one importer is static and another is
     * dynamic — producing a bundle that dies at parse time with `Duplicate export of 'SkillBrowser'`, which
     * no test that imports source can see. The props come in as a type, which is erased and creates no
     * edge. `boundaries.test.ts` bans the mixing outright.
     */
    const [Browser, setBrowser] = useState<ComponentType<SkillBrowserProps> | undefined>(undefined)
    // Derived from the buffer rather than stored, so the only palette state is where the cursor is.
    const palette = pane.kind === "none" ? paletteFor(editor.value) : undefined
    const [paletteIndex, setPaletteIndex] = useState(0)

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

    /**
     * Run a command and show what it printed.
     *
     * The pane opens *before* the command starts, with a spinner, for the same reason the skills browser
     * mounts before it fetches: a command that takes a second with nothing on screen is indistinguishable
     * from a keystroke that did nothing.
     */
    const openCommand = useCallback(
        (name: string, rest: string) => {
            setPane({ kind: "output", label: `/${name}`, lines: undefined, offset: 0 })
            void runSubcommand({ name, rest, manifestPath: manifestPath ?? "" })
                .then((result) =>
                    setPane({
                        kind: "output",
                        label: `/${name}`,
                        lines: result.lines,
                        code: result.code,
                        offset: 0,
                    }),
                )
                .catch((error: unknown) =>
                    setPane({
                        kind: "output",
                        label: `/${name}`,
                        lines: [error instanceof Error ? error.message : String(error)],
                        code: 1,
                        offset: 0,
                    }),
                )
        },
        [manifestPath],
    )

    /** A slash command, from the palette or from a typed line. Shared so the two cannot diverge. */
    const dispatch = useCallback(
        (word: string, rest: string) => {
            const entry = paletteEntries().find((candidate) => candidate.word === word)
            if (entry === undefined) return false
            if (entry.kind === "view") {
                if (entry.word === "/skills" && catalogue !== undefined) {
                    setPane({ kind: "skills" })
                    void import("#components/SkillBrowser").then((module) =>
                        // Wrapped in a function, or `useState` would call the component as an updater.
                        setBrowser(() => module.SkillBrowser),
                    )
                    return true
                }
                // A view named in the table with nothing built yet falls back to its own output, which is
                // still the command doing its job — better than a palette entry that does nothing.
                openCommand(entry.word.slice(1), rest)
                return true
            }
            if (entry.kind === "output") {
                openCommand(entry.word.slice(1), rest)
                return true
            }
            return false
        },
        [openCommand, catalogue],
    )

    // ── the pane has the keyboard while it is open ────────────────────────────────────────
    useInput(
        (input, key) => {
            if (pane.kind !== "output") return
            if (key.escape || input === "q") {
                setPane({ kind: "none" })
                return
            }
            const total = pane.lines?.length ?? 0
            const step = key.pageDown || key.pageUp ? PANE_ROWS : 1
            const delta =
                key.downArrow || key.pageDown ? step : key.upArrow || key.pageUp ? -step : 0
            if (delta !== 0) {
                setPane({
                    ...pane,
                    offset: Math.max(0, Math.min(pane.offset + delta, Math.max(0, total - 1))),
                })
            }
        },
        { isActive: pane.kind === "output" },
    )

    useInput(
        (input, key) => {
            // The palette owns the keys it needs while it is open, and hands everything else to the editor —
            // so typing continues to narrow the list rather than being swallowed by it.
            if (palette !== undefined) {
                if (key.escape) {
                    setEditor((current) => applyIntent(current, { kind: "killToStart" }))
                    setPaletteIndex(0)
                    return
                }
                if (key.upArrow || key.downArrow) {
                    setPaletteIndex((at) =>
                        Math.max(
                            0,
                            Math.min(at + (key.downArrow ? 1 : -1), palette.matches.length - 1),
                        ),
                    )
                    return
                }
                if (key.tab) {
                    const chosen = paletteSelection(palette, paletteIndex)
                    if (chosen !== undefined) {
                        setEditor((current) =>
                            applyIntent(
                                { ...current, value: "", cursor: 0 },
                                {
                                    kind: "insert",
                                    text: chosen.word,
                                },
                            ),
                        )
                    }
                    return
                }
                const selected = paletteSelection(palette, paletteIndex)
                // Only intercepted when something is selected. With no match, enter falls through to the
                // ordinary submit path, which reports `/skils is not a command` and suggests the nearest
                // one — swallowing it here made a mistyped command do nothing at all, which is worse.
                if (key.return && selected !== undefined) {
                    const chosen = selected
                    setPaletteIndex(0)
                    setEditor((current) => ({ ...current, value: "", cursor: 0 }))
                    // A session verb goes through the same submit path a typed line takes, so `/help` and
                    // `/reset` behave identically whether they were completed or typed out.
                    if (chosen.kind === "session") onSubmit(chosen.word)
                    else dispatch(chosen.word, "")
                    return
                }
            }

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
            // The match list changes underneath the cursor on every keystroke, so keeping its position
            // would silently highlight a different entry than the one on screen — the same reason the
            // history search resets its index.
            if (palette !== undefined) setPaletteIndex(0)
            setEditor((current) => applyIntent(current, intent))
        },
        { isActive: pane.kind === "none" },
    )

    if (pane.kind === "skills" && catalogue !== undefined && Browser !== undefined) {
        return (
            <Browser
                title={`${BRAND.name} ${VERSION}`}
                agents={[]}
                target={manifestPath ?? ""}
                load={catalogue.load}
                install={catalogue.install}
                onDone={() => setPane({ kind: "none" })}
            />
        )
    }

    return (
        <Box flexDirection="column">
            <Transcript items={state.items} showReasoning={showReasoning} quiet={quiet} />
            {state.live === undefined ? null : (
                <Live live={state.live} showReasoning={showReasoning} columns={columns} />
            )}
            {pane.kind === "output" ? (
                <Box flexDirection="column" marginTop={1}>
                    <CommandOutput
                        lines={pane.lines}
                        label={pane.label}
                        offset={pane.offset}
                        maxRows={PANE_ROWS}
                        {...(pane.code === undefined ? {} : { code: pane.code })}
                    />
                    <Text dimColor wrap="truncate">
                        {"  "}↑↓ scroll · esc back to the prompt
                    </Text>
                </Box>
            ) : null}
            {palette === undefined ? null : (
                <Palette
                    palette={palette}
                    index={paletteIndex}
                    width={columns}
                    maxRows={SEARCH_ROWS}
                />
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
