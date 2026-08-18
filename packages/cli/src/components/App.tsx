/**
 * The chat surface — a full-screen session on the alternate buffer.
 *
 * Thin on purpose. Everything worth testing lives in pure modules — `keymap.ts` decides what a keystroke
 * means, `editor.ts` applies it to the line, `transcript.ts` turns bus events into rows, `lib/scroll.ts`
 * moves the window, `lib/chat-frame.ts` decides how many rows each part of the frame may have — so this
 * file is composition plus the decisions that need Ink itself: when to unmount, what to do about a
 * submission arriving mid-turn, and which surface currently owns the keyboard.
 *
 * ## What Phase 5.5 changed here
 *
 * The conversation is no longer in `<Static>`. It is a buffer of rows with a window over it, because
 * `<Static>` writes to the scrollback and the alternate screen discards its buffer on the way out — the
 * two cannot both be true. That has two consequences worth stating before editing:
 *
 * - **The frame has a hard height.** Everything visible must add up to at most the terminal's rows, or
 *   Ink's own output scrolls the buffer and the layout comes apart. `chatFrame` owns that arithmetic; no
 *   row count is invented in this file.
 * - **^C at an idle prompt takes two presses.** With the buffer discarded on exit, a single reflexive ^C
 *   during a long reply would throw the visible conversation away. `keymap.ts` owns the decision; the
 *   timer that expires it lives here, because a pure function cannot hold a clock.
 *
 * The Ctrl-C contract from Phase 1 is otherwise unchanged: during a turn it cancels the turn and the
 * prompt comes back.
 */

import { BRAND, VERSION } from "@castellan/core"
import { Box, Text, useApp, useInput } from "ink"
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react"
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
import { chatFrame } from "#lib/chat-frame"
import { EXIT_ARM_MS, FALLBACK_COLUMNS, SEARCH_ROWS } from "#lib/const"
import { paletteEntries, paletteFor, paletteSelection } from "#lib/palette"
import type { AppProps } from "#lib/schema"
import { screenColumns, titleLine } from "#lib/screen"
import { FOLLOWING, scroll, slice } from "#lib/scroll"
import {
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import { runSubcommand } from "#lib/subcommand"
import { THEME } from "#lib/theme"
import { lastStats, transcriptRows } from "#transcript"

/**
 * What is layered over the conversation.
 *
 * `output` is a command's captured text; `skills` is the one bespoke view a session hosts so far. Both
 * take the keyboard while open and both *replace* the transcript rather than sitting under it — sharing
 * the screen pushed the conversation off the top of a full-screen frame, which on a surface with no
 * scrollback means gone. Closing either returns to the prompt with the draft untouched, which is what
 * makes a pane an interlude rather than a detour.
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
    agentName,
    warnings,
    initial,
    showReasoning,
    quiet,
    onRestart,
    initialDraft,
    manifestPath,
    catalogue,
}: AppProps) {
    const { exit } = useApp()
    const size = useTerminalSize()
    const columns = screenColumns(size.columns, FALLBACK_COLUMNS)
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
    /** Where the conversation window sits. Starts and returns to following the newest row. */
    const [view, setView] = useState(FOLLOWING)
    /** A first ^C has landed. Expires, which is why it is here and not in the keymap. */
    const [armed, setArmed] = useState(false)
    /** `/exit` asked; the next keystroke answers. `undefined` means nothing is being confirmed. */
    const [confirming, setConfirming] = useState(false)
    // Derived from the buffer rather than stored, so the only palette state is where the cursor is.
    const palette = pane.kind === "none" ? paletteFor(editor.value) : undefined
    const [paletteIndex, setPaletteIndex] = useState(0)

    const elapsed = useElapsed(busy)
    const last = useMemo(() => lastStats(state.items), [state.items])

    /**
     * The conversation, wrapped to the width and flattened to rows.
     *
     * Memoised on the three things it depends on. Without that it would re-flatten and re-wrap the whole
     * history on every streamed token, which is the cost `<Static>` used to remove for free.
     */
    const rows = useMemo(
        () => transcriptRows(state.items, { showReasoning, quiet, columns }),
        [state.items, showReasoning, quiet, columns],
    )

    const frame = chatFrame({
        rows: size.rows,
        columns,
        editor,
        live: state.live,
        showReasoning,
        palette,
        paletteMaxRows: SEARCH_ROWS,
        searchMaxRows: SEARCH_ROWS,
        confirming,
    })
    const window = slice(view, rows.length, frame.transcript)

    // The armed ^C expires on its own. A prompt that stayed armed indefinitely would turn a ^C pressed
    // minutes ago into the reason a later one ended the session.
    useEffect(() => {
        if (!armed) return
        const timer = setTimeout(() => setArmed(false), EXIT_ARM_MS)
        return () => clearTimeout(timer)
    }, [armed])

    const onSubmit = (text: string): void => {
        // Both renderers dispatch through the same table, so `--plain` and the rich path cannot
        // answer the same typed command differently.
        const command = resolveSessionCommand(text)
        if (command !== undefined) {
            switch (command.kind) {
                case "exit":
                    // Asked, not done. `/exit` is typed deliberately, but so is every other slash command,
                    // and the one that discards the visible conversation is worth one keystroke of
                    // confirmation on a surface where leaving takes the screen with it.
                    setConfirming(true)
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
            const step = key.pageDown || key.pageUp ? frame.pane : 1
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
            // A pending confirmation owns the keyboard for exactly one keystroke. Anything other than a
            // yes is a no — including a stray arrow, because the safe answer to an unclear one is to stay.
            if (confirming) {
                setConfirming(false)
                if (input.toLowerCase() === "y" || key.return) exit()
                return
            }

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

            const intent = keyToIntent(
                input,
                key,
                keyContext(editor, busy, { armed, scrolled: !view.pinned }),
            )

            // Any keystroke that is not the second ^C disarms. Without this the warning would stay true
            // while somebody typed a whole message, and the ^C they pressed at the end of it — meaning
            // "cancel that" — would end the session instead.
            if (armed && intent.kind !== "exit") setArmed(false)

            if (intent.kind === "arm") {
                setArmed(true)
                return
            }
            if (intent.kind === "scroll") {
                setView((current) => scroll(current, intent.move, rows.length, frame.transcript))
                return
            }
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
                // Sending is an implicit "take me back to the newest row": a reply arriving into a window
                // parked ten screens up would be generated where nobody can see it.
                setView(FOLLOWING)
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

    const header = titleLine(
        {
            title: `${BRAND.name} ${VERSION}`,
            summary: "",
            agent: { name: agentName, model },
            ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
        },
        columns,
    )

    return (
        // Fixed height, because the alternate screen has no scrollback to absorb an overshoot: one row too
        // many and Ink's own output scrolls the buffer, which leaves the status line halfway up the display.
        <Box flexDirection="column" width={columns} height={size.rows}>
            <Text color={THEME.accent} bold wrap="truncate">
                {header}
            </Text>

            {pane.kind === "output" ? (
                <Box flexDirection="column">
                    <CommandOutput
                        lines={pane.lines}
                        label={pane.label}
                        offset={pane.offset}
                        maxRows={frame.pane}
                        {...(pane.code === undefined ? {} : { code: pane.code })}
                    />
                    <Text dimColor wrap="truncate">
                        {"  "}↑↓ scroll · esc back to the prompt
                    </Text>
                </Box>
            ) : (
                <Transcript rows={rows} slice={window} />
            )}

            {state.live === undefined ? null : (
                <Live live={state.live} showReasoning={showReasoning} columns={columns} />
            )}
            {palette === undefined ? null : (
                <Palette
                    palette={palette}
                    index={paletteIndex}
                    width={columns}
                    maxRows={SEARCH_ROWS}
                />
            )}
            <HistorySearch editor={editor} width={columns} maxRows={SEARCH_ROWS} />
            {confirming ? (
                <Text color={THEME.warning} wrap="truncate">
                    {"  leave this session? y to confirm · any other key stays"}
                </Text>
            ) : null}
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
                armed={armed}
            />
        </Box>
    )
}
