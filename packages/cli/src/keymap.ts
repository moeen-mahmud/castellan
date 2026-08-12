/**
 * Keystrokes in, intents out. Pure, and free of any Ink import.
 *
 * The one contract worth stating explicitly, because Phase 1 established and measured it:
 * **Ctrl-C cancels the turn, not the process.** Whether a keystroke means "cancel" or "exit"
 * depends on whether a turn is in flight, so that decision belongs here — in a function that can be
 * tested against both states — rather than in a component where it can only be tested by hand.
 */

import type { Intent, KeyState } from "#lib/types"

export interface KeyContext {
    /** A turn is in flight. */
    readonly busy: boolean
    /** The input line is empty. */
    readonly empty: boolean
}

/** Ctrl-key chords arrive as `key.ctrl` plus the letter in `input`. */
function ctrlIntent(letter: string, context: KeyContext): Intent {
    switch (letter) {
        case "c":
            // The whole point. Busy means a turn is generating; interrupting it must leave the
            // prompt behind, not the shell.
            return context.busy ? { kind: "cancel" } : { kind: "exit" }
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
        default:
            return { kind: "none" }
    }
}

export function keyToIntent(input: string, key: KeyState, context: KeyContext): Intent {
    if (key.ctrl) return ctrlIntent(input.toLowerCase(), context)

    if (key.return) return { kind: "submit" }
    if (key.backspace) return { kind: "backspace" }
    if (key.delete) return { kind: "delete" }
    if (key.leftArrow) return { kind: "cursorLeft" }
    if (key.rightArrow) return { kind: "cursorRight" }
    if (key.upArrow) return { kind: "historyPrev" }
    if (key.downArrow) return { kind: "historyNext" }

    // Escape and Tab are claimed deliberately and do nothing, rather than falling through to the
    // insert branch where they would put a control character into the buffer and be sent to a model.
    if (key.escape || key.tab) return { kind: "none" }

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
