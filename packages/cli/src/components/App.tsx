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

import { BRAND, VERSION } from "@dispach/core"
import { Box, Text, useApp, useInput } from "ink"
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react"
import { BRAND_INDENT, Brandmark } from "#components/Brandmark"
import { CommandOutput } from "#components/CommandOutput"
import { HistorySearch } from "#components/HistorySearch"
import { Live } from "#components/Live"
import { Palette } from "#components/Palette"
import { Prompt } from "#components/Prompt"
import type { SessionPickerProps } from "#components/SessionPicker"
import type { SkillBrowserProps } from "#components/SkillBrowser"
import { Spinner } from "#components/Spinner"
import { StatusBar } from "#components/StatusBar"
import { Transcript } from "#components/Transcript"
import { applyIntent, EMPTY_EDITOR, submit } from "#editor"
import { useElapsed } from "#hooks/useElapsed"
import { useTerminalSize } from "#hooks/useTerminalSize"
import { useTurn } from "#hooks/useTurn"
import { keyContext, keyToIntent } from "#keymap"
import { chatFrame, transcriptRowsAfterBrand } from "#lib/chat-frame"
import {
    EXIT_ARM_MS,
    FALLBACK_COLUMNS,
    LANDING_LIST_ROWS,
    SEARCH_ROWS,
    SESSION_PICKER_ROWS,
} from "#lib/const"
import { paletteEntries, paletteFor, paletteSelection } from "#lib/palette"
import type { AppProps } from "#lib/schema"
import { screenColumns, titleLine } from "#lib/screen"
import { FOLLOWING, scroll, slice } from "#lib/scroll"
import {
    NEW_SESSION_HINT,
    resolveSessionCommand,
    sessionHelpText,
    toolsReport,
    toolsView,
    unknownCommandText,
} from "#lib/session-commands"
import type { SessionRowSource } from "#lib/sessions-view"
import { runSubcommand } from "#lib/subcommand"
import { THEME } from "#lib/theme"
import { wordmark } from "#lib/wordmark"
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
    /**
     * The conversation switcher. `undefined` while the store is being read.
     *
     * Loaded when the pane opens rather than kept current, because the list changes only when a turn ends
     * and re-reading it on every frame would put a database query in the render path.
     */
    | { readonly kind: "sessions"; readonly stored: readonly SessionRowSource[] | undefined }

export function App({
    agent,
    bus,
    sessionKey,
    model,
    agentName,
    warnings,
    freshSession,
    initial,
    showReasoning,
    quiet,
    onRestart,
    onSwitch,
    sessions,
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
    /**
     * The session switcher's implementation, loaded when the pane first opens.
     *
     * Dynamically for the same reason `Browser` is, and it was caught by the boundaries test rather than
     * remembered: `run.ts` mounts this component too, for a bare `--session` before any chat exists. One
     * static importer and one dynamic one makes bun's `--splitting` emit its exports **twice**, and the
     * built binary then dies at parse time with `Duplicate export of 'SessionPicker'` while every test —
     * which imports source — passes. Both edges dynamic, no duplicate.
     */
    const [Sessions, setSessions] = useState<ComponentType<SessionPickerProps> | undefined>(
        undefined,
    )
    /** Where the conversation window sits. Starts and returns to following the newest row. */
    const [view, setView] = useState(FOLLOWING)
    /** A first ^C has landed. Expires, which is why it is here and not in the keymap. */
    const [armed, setArmed] = useState(false)
    /** `/exit` asked; the next keystroke answers. `undefined` means nothing is being confirmed. */
    const [confirming, setConfirming] = useState(false)
    /**
     * Reasoning shown whole rather than folded to a count. Session-wide, and `⌥r` toggles it.
     *
     * Folded is the default because a real turn produced a twenty-three-row block for a one-sentence
     * answer, which filled the terminal and left the reply itself somewhere above the fold.
     */
    const [expandReasoning, setExpandReasoning] = useState(false)
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
        () => transcriptRows(state.items, { showReasoning, quiet, columns, expandReasoning }),
        [state.items, showReasoning, quiet, columns, expandReasoning],
    )

    /**
     * The landing state: a new conversation with nothing sent into it yet.
     *
     * It is a *state of the one frame*, not a screen of its own, and that is the whole design. As a separate
     * screen it was swapped out the moment anything reached the transcript — which `/help`, `/tools` and
     * `/restart` all do — so the landing screen "disappeared" for almost every command. And anything added to
     * the other layout was silently missing from it: the palette drew nothing there for a day, and `/exit`'s
     * "press y" prompt was invisible, because both live in the layout that was not on screen. One frame
     * removes that class of bug rather than fixing instances of it.
     *
     * `freshSession` is the host's answer to "is this conversation new". It used to be load-bearing for a
     * second reason — the chat did not render stored messages, so an empty transcript was equally true of a
     * resumed session — and that is no longer the case: `seedHistory` paints the conversation, so the `user`
     * clause below is now true on its own for anything resumed. Both are kept because they answer different
     * questions, and the remaining job of `freshSession` is the genuinely new session, where there is no
     * history for the second clause to find. The second half is what the owner chose: slash commands, notes
     * and the banner all keep the brand mark, because they are setup rather than conversation. It goes when
     * you actually start talking, and does not come back.
     */
    const landing = freshSession === true && !state.items.some((item) => item.role === "user")

    // A longer list while landing: there is no conversation to hide behind it, and the screen somebody opens
    // before they know the commands should show all of them rather than six and a counter.
    const listRows = landing ? LANDING_LIST_ROWS : SEARCH_ROWS
    const frame = chatFrame({
        rows: size.rows,
        columns,
        editor,
        live: state.live,
        showReasoning,
        palette,
        paletteMaxRows: listRows,
        searchMaxRows: listRows,
        confirming,
        landing,
        hint: landing,
    })
    /**
     * The brand mark, rendered here so the conversation is charged what it actually draws.
     *
     * `frame.brand` is an allowance and `wordmark` usually takes far less of it — charging the allowance
     * wasted eleven rows on a thirty-row terminal, and the banner ended up scrolled to a mid-wrap fragment of
     * a store path with a third of the screen blank. Computed once and handed to `Brandmark` as lines, so
     * there is no second derivation that could disagree about how tall the frame is.
     */
    const mark =
        frame.brand > 0
            ? wordmark(BRAND.name, { columns: columns - BRAND_INDENT, rows: frame.brand })
            : undefined
    const window = slice(
        view,
        rows.length,
        transcriptRowsAfterBrand(frame, mark?.lines.length ?? 0),
    )

    // The armed ^C expires on its own. A prompt that stayed armed indefinitely would turn a ^C pressed
    // minutes ago into the reason a later one ended the session.
    useEffect(() => {
        if (!armed) return
        const timer = setTimeout(() => setArmed(false), EXIT_ARM_MS)
        return () => clearTimeout(timer)
    }, [armed])

    /**
     * A submitted line: a slash command, or a message for the model.
     *
     * `draft` is what is *left in the buffer* afterwards, and it has to be passed in rather than read from
     * `editor` here. This closure captures the editor as it was when the frame rendered — before the submit
     * cleared it — so reading `editor.value` returned the command that was just consumed. `/restart` then
     * carried `/restart` across as the draft, which re-opened the palette on top of the new banner: the
     * screen came back identical to before enter was pressed, with the message hidden behind the list, and
     * the restart looked like it had done nothing at all.
     *
     * For a typed command the residual is always empty — `COMMAND_SHAPE` matches the whole trimmed line, so
     * a command cannot share the buffer with a draft. It stays a parameter because a restart offered by a
     * *pane* could, and that is what the carry-across exists for.
     */
    const onSubmit = (text: string, draft: string): void => {
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
                    onRestart?.(draft)
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
                if (
                    entry.word === "/sessions" &&
                    sessions !== undefined &&
                    onSwitch !== undefined
                ) {
                    // Opened before the read finishes, with the spinner the pane draws for an undefined
                    // list — the same reason the catalogue mounts before it fetches: a keystroke followed
                    // by nothing is indistinguishable from a keystroke that did nothing.
                    setPane({ kind: "sessions", stored: undefined })
                    void import("#components/SessionPicker").then((module) =>
                        // Wrapped in a function, or `useState` would call the component as an updater.
                        setSessions(() => module.SessionPicker),
                    )
                    void sessions()
                        .then((stored) => setPane({ kind: "sessions", stored }))
                        .catch((error: unknown) => {
                            setPane({ kind: "none" })
                            note(
                                `could not read the stored conversations: ${error instanceof Error ? error.message : String(error)}`,
                            )
                        })
                    return true
                }
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
        [openCommand, catalogue, sessions, onSwitch, note],
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
                    // The buffer was cleared in the same handler, so nothing is left behind.
                    if (chosen.kind === "session") onSubmit(chosen.word, "")
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
                // `times` is the wheel: one chunk can carry several notches, and applying one of them makes
                // a flick of the wheel move a single row. Folded rather than given its own move, so the
                // clamping at both ends stays in one function.
                const times = Math.max(1, intent.times ?? 1)
                setView((current) => {
                    let next = current
                    for (let step = 0; step < times; step += 1) {
                        next = scroll(next, intent.move, rows.length, frame.transcript)
                    }
                    return next
                })
                return
            }
            if (intent.kind === "reasoning") {
                // Unfolding changes how tall the conversation is, so the window has to be told to follow
                // the newest row again — leaving it parked would put the reader at a row that has moved.
                setExpandReasoning((current) => !current)
                setView(FOLLOWING)
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
                if (committed.text !== "") onSubmit(committed.text, committed.state.value)
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

    if (pane.kind === "sessions") {
        return (
            <Box flexDirection="column" width={columns} height={size.rows}>
                <Text color={THEME.accent} bold wrap="truncate">
                    {titleLine(
                        { title: `${BRAND.name} ${VERSION}`, summary: "pick a conversation" },
                        columns,
                    )}
                </Text>
                <Box flexGrow={1} />
                {pane.stored === undefined || Sessions === undefined ? (
                    <Box marginLeft={2}>
                        <Spinner label="reading the stored conversations" />
                    </Box>
                ) : (
                    <Sessions
                        sessions={pane.stored}
                        now={Date.now()}
                        columns={columns}
                        maxRows={SESSION_PICKER_ROWS}
                        current={sessionKey}
                        onDone={(picked) => {
                            if (picked === undefined || picked === sessionKey) {
                                // Esc, or the one already open. Either way nothing is worth a rebuild.
                                setPane({ kind: "none" })
                                return
                            }
                            onSwitch?.(picked, editor.value)
                            exit()
                        }}
                    />
                )}
                <Box flexGrow={1} />
            </Box>
        )
    }

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
            {/*
             * Above the one-line header, and only while landing. Nothing appears or disappears when it goes —
             * the line below it is the same line either way, which is what makes the collapse read as the same
             * screen with less on it rather than as a different screen.
             */}
            {mark === undefined ? null : (
                <>
                    <Brandmark lines={mark.lines} />
                    <Text> </Text>
                </>
            )}
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

            {/*
             * Absorbs the slack, so the composer sits on the bottom edge from the first frame.
             *
             * Without it the input box is drawn immediately under whatever content exists, which means it
             * walks down the screen as the first few messages arrive and only settles once the transcript
             * fills the window. The place you type should not move; a spacer costs nothing when the
             * transcript is full, because there is no slack left to absorb.
             *
             * Not while landing, though. There the transcript holds a five-line banner in a fourteen-row
             * window, so the spacer put twelve blank rows between the banner and the input — a third of a
             * thirty-row terminal, reading as a half-empty screen rather than a prompt waiting for you. The
             * slack goes *below* the composer instead, which is the spacer at the other end.
             */}
            {landing ? null : <Box flexGrow={1} />}

            {state.live === undefined ? null : (
                <Live live={state.live} showReasoning={showReasoning} columns={columns} />
            )}
            {palette === undefined ? null : (
                <Palette
                    palette={palette}
                    index={paletteIndex}
                    width={columns}
                    maxRows={listRows}
                />
            )}
            <HistorySearch editor={editor} width={columns} maxRows={listRows} />
            {/*
             * Rendered once, in the one frame, which is the fix rather than a feature: this lived only in the
             * transcript layout, so `/exit` typed on the landing screen asked for a confirmation nobody could
             * see — the session simply appeared to ignore the command until a second keystroke ended it.
             */}
            {confirming ? (
                <Text color={THEME.warning} wrap="truncate">
                    {"  leave this session? press y to confirm · any other key stays"}
                </Text>
            ) : null}
            <Prompt
                editor={editor}
                busy={busy}
                columns={columns}
                {...(landing ? { roomy: true, placeholder: "Ask anything…" } : {})}
            />
            {/*
             * The keys worth knowing before there is a conversation to learn them from. It stands down once
             * one exists: the status line already carries `^C`, and a permanent hint is a row of conversation.
             */}
            {landing ? (
                <Text dimColor wrap="truncate">
                    {"  "}
                    {NEW_SESSION_HINT}
                </Text>
            ) : null}
            {/* The other end of the spacer above: on the landing screen the slack belongs under the
                composer, so the input sits with the banner and the status line stays on the bottom edge. */}
            {landing ? <Box flexGrow={1} /> : null}
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
                {...(state.pressure === undefined ? {} : { pressure: state.pressure })}
                {...(state.phase === undefined ? {} : { phase: state.phase })}
            />
        </Box>
    )
}
