/**
 * Keystrokes in, intents out. Pure, and free of any Ink import.
 *
 * The one contract worth stating explicitly, because Phase 1 established and measured it:
 * **Ctrl-C cancels the turn, not the process.** Whether a keystroke means "cancel" or "exit"
 * depends on whether a turn is in flight, so that decision belongs here — in a function that can be
 * tested against both states — rather than in a component where it can only be tested by hand.
 */

import { lineInfo } from "#editor"
import { mouseInput } from "#lib/mouse"
import type { EditorState, Intent, KeyState } from "#lib/types"

export interface KeyContext {
    /** A turn is in flight. */
    readonly busy: boolean
    /** The input buffer is empty. */
    readonly empty: boolean
    /**
     * The cursor is on the first line, so ↑ means history rather than a line up.
     *
     * Position decides, because a multi-line buffer wants both and every editor resolves it this way:
     * at the top of what you are composing there is nothing above to move to, so the arrow is free to
     * mean the other thing. `^P`/`^N` stay unconditional history for anyone who would rather not think
     * about where the cursor is.
     */
    readonly firstLine: boolean
    readonly lastLine: boolean
    /** `^R` is open, so enter accepts a match and escape closes it. */
    readonly searching: boolean
    /**
     * A first ^C has already been pressed at an idle prompt, so the next one leaves.
     *
     * Held by the caller rather than derived, because it is the one piece of keyboard state with a
     * *clock* attached — it expires — and a pure function cannot own that. What it must not do is
     * decide what an armed ^C means, which is why the flag comes in here and the decision stays below.
     */
    readonly armed: boolean
    /**
     * The transcript window is parked above the newest row, so escape means "come back down".
     *
     * Escape had nothing to do at an idle prompt and was claimed as `none` to keep control characters
     * out of the buffer. A scrolled-away view is the one state where a reader plainly wants a way out
     * of where they are, and escape is the key they will press.
     */
    readonly scrolled: boolean
}

/**
 * The context for a given editor state.
 *
 * Exported and derived in one place so no renderer computes it by hand. `empty` was already this shape
 * — editor state passed to the keymap as context — and the two line flags are the same idea; a caller
 * that got `firstLine` wrong would make the arrows misbehave in a way no test of this module would see.
 */
export function keyContext(
    editor: EditorState,
    busy: boolean,
    session: { readonly armed?: boolean; readonly scrolled?: boolean } = {},
): KeyContext {
    const { line, lines } = lineInfo(editor)
    return {
        busy,
        empty: editor.value === "",
        firstLine: line === 0,
        lastLine: line === lines - 1,
        searching: editor.search !== undefined,
        armed: session.armed ?? false,
        scrolled: session.scrolled ?? false,
    }
}

/** Ctrl-key chords arrive as `key.ctrl` plus the letter in `input`. */
function ctrlIntent(letter: string, context: KeyContext): Intent {
    switch (letter) {
        case "c":
            // While a search is open, ^C dismisses it rather than the session: the search is the
            // foreground thing, and quitting the whole session from it would lose a message somebody
            // is part-way through composing.
            if (context.searching) return { kind: "searchCancel" }
            // The whole point. Busy means a turn is generating; interrupting it must leave the
            // prompt behind, not the shell.
            if (context.busy) return { kind: "cancel" }
            // At an idle prompt it takes two, and the first one says so.
            //
            // One press used to exit, which was defensible while the session left its conversation in
            // the scrollback: ^C landed you back in a shell with the transcript still above it. On the
            // alternate screen the buffer is discarded on the way out, so the same keystroke now throws
            // the visible conversation away — and it is one press away from the chord that means
            // "cancel this turn", pressed reflexively when a reply runs long. ^D still leaves in one,
            // for anyone who wants that, and the status line names whichever is live.
            return context.armed ? { kind: "exit" } : { kind: "arm" }
        case "d":
            // Ctrl-D is end-of-input, so it only ends the session when there is nothing to submit.
            // On a line with text it is a forward delete, as in a shell.
            return context.empty ? { kind: "exit" } : { kind: "delete" }
        case "a":
            return { kind: "cursorHome" }
        case "e":
            return { kind: "cursorEnd" }
        case "b":
            return { kind: "cursorLeft" }
        case "f":
            return { kind: "cursorRight" }
        case "u":
            return { kind: "killToStart" }
        case "k":
            return { kind: "killToEnd" }
        case "w":
            return { kind: "killWord" }
        case "p":
            return { kind: "historyPrev" }
        case "n":
            return { kind: "historyNext" }
        case "r":
            return { kind: "searchOpen" }
        case "z":
            // Undo, not SIGTSTP. Ink puts stdin in raw mode, so the terminal never generates the
            // signal and the byte arrives here — which makes this a choice rather than an accident.
            // Suspending a chat you can leave with ^D is worth little; undo is worth a lot, and the
            // footer says so, which is what keeps the trade visible.
            return { kind: "undo" }
        case "y":
            return { kind: "redo" }
        default:
            return { kind: "none" }
    }
}

export function keyToIntent(input: string, key: KeyState, context: KeyContext): Intent {
    // The mouse, before anything else, and unconditionally.
    //
    // Ink has no idea what a mouse report is and hands it over as text: with tracking on, one wheel notch
    // reached the insert branch and typed the report into the message. So every report is claimed here —
    // the wheel becomes a scroll and everything else becomes nothing at all, because a click that falls
    // through is the same bug with a different button.
    const mouse = mouseInput(input)
    if (mouse !== undefined) {
        if (mouse.rows === 0) return { kind: "none" }
        return { kind: "scroll", move: mouse.rows < 0 ? "up" : "down", times: Math.abs(mouse.rows) }
    }

    if (key.ctrl) return ctrlIntent(input.toLowerCase(), context)

    // ─── option chords ───────────────────────────────────────────────────────────────────
    //
    // Every one of these is measured against Ink's parser rather than assumed, because a terminal has
    // more than one way to send them and the parser reporting *a* key says nothing about which:
    //
    //   ⌥←  Apple Terminal `ESC b`      → input "b" + meta      iTerm2 `CSI 1;3D` → leftArrow + meta
    //   ⌥→  Apple Terminal `ESC f`      → input "f" + meta      iTerm2 `CSI 1;3C` → rightArrow + meta
    //   ⌥⌫  `ESC DEL`                   → backspace + meta
    //   ⌥d  `ESC d`                     → input "d" + meta
    //   ⌥r  `ESC r`                     → input "r" + meta
    //   ⌥⏎  `ESC CR`                    → return + meta
    //   ⇧⏎  kitty protocol `CSI 13;2u`  → return + shift        (only once the terminal is taught)
    //
    // Both spellings of each are honoured, so the same binding works in both families of terminal.
    if (key.meta) {
        if (key.return) return { kind: "newline" }
        // ⌥↑/⌥↓ walk the conversation a row at a time, and ⌥PgUp/⌥PgDn go to its ends. Bare ↑/↓ cannot
        // do this: they already mean line movement inside a message and history at its edges, and a
        // third meaning on one key is how a keyboard stops being predictable.
        if (key.pageUp) return { kind: "scroll", move: "top" }
        if (key.pageDown) return { kind: "scroll", move: "bottom" }
        if (key.upArrow) return { kind: "scroll", move: "up" }
        if (key.downArrow) return { kind: "scroll", move: "down" }
        if (key.leftArrow || input === "b") return { kind: "wordLeft" }
        if (key.rightArrow || input === "f") return { kind: "wordRight" }
        if (key.backspace) return { kind: "killWord" }
        if (input === "d") return { kind: "killWordForward" }
        // Reasoning is folded to a few rows by default, and this is how the rest of it is read. Same
        // shape as ⌥d — a letter with meta — so it works wherever the chords above already do.
        if (input === "r") return { kind: "reasoning" }
        // An unclaimed option chord does nothing. Falling through would reach the insert branch and
        // type the bare letter, so ⌥s would silently put an "s" in the message. Composed characters
        // (é, ∆) are unaffected: macOS sends those as the character itself, with no meta flag.
        return { kind: "none" }
    }

    // Shift+enter is a newline where the terminal can express it — `terminal-setup` is what teaches
    // iTerm2, VS Code, Ghostty and Kitty to send the sequence Ink already understands. Where it
    // cannot, this is never true and ⏎ submits, which is why ⌥⏎ is the documented chord.
    if (key.return && key.shift) return { kind: "newline" }

    // Paging the conversation, unmodified.
    //
    // Deliberately not ^U/^D, which the plan named: both are already taken by the editor — ^U deletes to
    // the start of the line and ^D leaves an empty one — and they are documented, shell-standard, and
    // reached by muscle memory. A scroll key that silently deleted half a message would be a worse bug
    // than no scroll key.
    if (key.pageUp) return { kind: "scroll", move: "pageUp" }
    if (key.pageDown) return { kind: "scroll", move: "pageDown" }

    if (key.return) return context.searching ? { kind: "searchAccept" } : { kind: "submit" }
    if (key.backspace) return { kind: "backspace" }
    if (key.delete) return { kind: "delete" }
    if (key.leftArrow) return { kind: "cursorLeft" }
    if (key.rightArrow) return { kind: "cursorRight" }
    // History at the edges of the buffer, line movement inside it. While searching both walk the match
    // list, which the reducer routes — the arrows mean "previous" and "next" either way.
    if (key.upArrow) {
        return context.searching || context.firstLine ? { kind: "historyPrev" } : { kind: "lineUp" }
    }
    if (key.downArrow) {
        return context.searching || context.lastLine
            ? { kind: "historyNext" }
            : { kind: "lineDown" }
    }

    // Escape closes a search; otherwise it is claimed deliberately and does nothing, rather than
    // falling through to the insert branch where it would put a control character into the buffer and
    // be sent to a model. Tab is claimed for the same reason.
    if (key.escape) {
        if (context.searching) return { kind: "searchCancel" }
        return context.scrolled ? { kind: "scroll", move: "bottom" } : { kind: "none" }
    }
    if (key.tab) return { kind: "none" }

    // A paste arrives as one large `input` with no key flags, so insert has to accept many
    // characters at once rather than assuming a single keypress.
    if (input === "") return { kind: "none" }

    // Newlines inside that chunk are line breaks, not control noise. Stripping them — which the
    // printable filter below would do — silently joins the last word of one line to the first word
    // of the next and submits nothing, so a pasted multi-line prompt arrives mangled with no error.
    if (/[\r\n]/.test(input)) {
        const lines = input.split(/\r\n|[\r\n]/).map(printableOnly)
        // A trailing newline means the final line is finished too; without one, the tail is still
        // being typed.
        const complete = lines.at(-1) === "" && lines.length > 1
        return { kind: "paste", lines: complete ? lines.slice(0, -1) : lines, complete }
    }

    const printable = printableOnly(input)
    return printable === "" ? { kind: "none" } : { kind: "insert", text: printable }
}

/**
 * Drop C0 controls and DEL. A bracketed-paste marker or a stray escape sequence reaching the buffer
 * would be invisible on screen and sent to the model as if it had been typed.
 */
function printableOnly(text: string): string {
    return [...text]
        .filter((char) => {
            const code = char.codePointAt(0) ?? 0
            return code >= 0x20 && code !== 0x7f
        })
        .join("")
}

// ─── screen keymaps ──────────────────────────────────────────────────────────────────────
//
// The wizard and picker differ from the chat input in what Esc means — a *context*, not a new
// module, which is why they live here beside `keyToIntent` rather than in per-screen files: one
// keyboard home, closed by the same drift tests.

import type { SelectMove } from "#lib/select"

export type ListIntent =
    | { readonly kind: "move"; readonly move: SelectMove }
    | { readonly kind: "choose" }
    | { readonly kind: "back" }
    | { readonly kind: "exit" }
    | { readonly kind: "none" }

/**
 * A checklist adds two verbs a single-select list does not have: tick a row, and finish.
 *
 * Space ticks and enter finishes, which is the convention every multi-select in a terminal uses — and
 * getting it the other way round is the mistake that makes a picker feel broken, because enter on a
 * highlighted row is such a strong habit that people submit with one thing ticked and never see the rest.
 * `a` and `n` are all/none, worth having when the list is fifty rows long.
 */
export type CheckIntent =
    | { readonly kind: "move"; readonly move: SelectMove }
    | { readonly kind: "toggle" }
    | { readonly kind: "all" }
    | { readonly kind: "none-selected" }
    | { readonly kind: "confirm" }
    | { readonly kind: "cancel" }
    | { readonly kind: "none" }

export function keyToCheckIntent(input: string, key: KeyState): CheckIntent {
    if (key.ctrl) {
        return input.toLowerCase() === "c" || input.toLowerCase() === "d"
            ? { kind: "cancel" }
            : { kind: "none" }
    }
    if (key.return) return { kind: "confirm" }
    if (key.escape) return { kind: "cancel" }
    // Ink reports the space bar as the input string " " with no flag of its own.
    if (input === " ") return { kind: "toggle" }
    if (input === "a") return { kind: "all" }
    if (input === "n") return { kind: "none-selected" }

    const list = keyToListIntent(input, key)
    // Movement is shared so the two lists cannot drift apart; `choose` cannot arrive, because `key.return`
    // is handled above, and the remaining kinds are not this screen's.
    return list.kind === "move" ? list : { kind: "none" }
}

/**
 * List navigation: arrows or j/k, g/G for ends, enter chooses, esc backs out, ^C/^D leave.
 *
 * A digit jumps the cursor — visibly and reversibly — and deliberately does not choose: a stray
 * number must never launch an agent.
 */
export function keyToListIntent(input: string, key: KeyState): ListIntent {
    if (key.ctrl) {
        return input.toLowerCase() === "c" || input.toLowerCase() === "d"
            ? { kind: "exit" }
            : { kind: "none" }
    }
    if (key.return) return { kind: "choose" }
    if (key.escape) return { kind: "back" }
    if (key.upArrow) return { kind: "move", move: { kind: "up" } }
    if (key.downArrow) return { kind: "move", move: { kind: "down" } }

    switch (input) {
        case "k":
            return { kind: "move", move: { kind: "up" } }
        case "j":
            return { kind: "move", move: { kind: "down" } }
        case "g":
            return { kind: "move", move: { kind: "first" } }
        case "G":
            return { kind: "move", move: { kind: "last" } }
        default:
            break
    }
    if (/^[1-9]$/.test(input)) {
        return { kind: "move", move: { kind: "jump", index: Number(input) - 1 } }
    }
    return { kind: "none" }
}

export type WizardKeyIntent =
    | { readonly kind: "back" }
    | { readonly kind: "abort" }
    | { readonly kind: "commit" }
    | { readonly kind: "list"; readonly intent: ListIntent }
    | { readonly kind: "edit"; readonly intent: Intent }

/**
 * The wizard's chrome keys are checked before delegation — Esc means "back a question" here,
 * which is exactly why chat's `keyToIntent` (which claims Esc as none) is not reused raw.
 *
 * Text steps then get the full chat editor treatment (^A/^E, ^W, code-point cursor); select steps
 * get the list navigation. A pasted blob collapses to its first line — a wizard answer is one
 * line — and history chords mean nothing inside a question.
 */
export function keyToWizardIntent(
    input: string,
    key: KeyState,
    context: { readonly select: boolean; readonly empty: boolean },
): WizardKeyIntent {
    if (key.ctrl && input.toLowerCase() === "c") return { kind: "abort" }
    if (key.escape) return { kind: "back" }
    if (key.return) return { kind: "commit" }

    if (context.select) {
        return { kind: "list", intent: keyToListIntent(input, key) }
    }

    // A wizard answer is one line — a pasted blob collapses to its first — so the cursor is always on
    // both the first and the last line, and ↑/↓ mean history rather than line movement. There is no
    // search here either.
    const intent = keyToIntent(input, key, {
        busy: false,
        empty: context.empty,
        firstLine: true,
        lastLine: true,
        searching: false,
        // A question is not a conversation: there is nothing to scroll and nothing to arm, and Esc is
        // claimed above as "back a question" before this is ever reached.
        armed: false,
        scrolled: false,
    })
    switch (intent.kind) {
        case "submit":
            return { kind: "commit" }
        case "exit":
            // ^D on an empty question line reads as "get me out", same as ^C.
            return { kind: "abort" }
        case "arm":
        case "scroll":
            // Unreachable in practice — ^C is claimed as `abort` above and there is nothing to scroll —
            // and listed rather than left to the default, so adding a session-only intent cannot
            // silently become an edit the wizard applies to a field.
            return { kind: "edit", intent: { kind: "none" } }
        case "historyPrev":
        case "historyNext":
            return { kind: "edit", intent: { kind: "none" } }
        case "paste":
            return {
                kind: "edit",
                intent: { kind: "insert", text: intent.lines[0] ?? "" },
            }
        default:
            return { kind: "edit", intent }
    }
}
