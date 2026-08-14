/**
 * Removing terminal control sequences from anything a tool produced.
 *
 * ## Why this is not decision 4.27's forbidden rewrite
 *
 * 4.27 says delimiting is the *only* transformation applied to untrusted content, and that filtering
 * instruction-like phrasing does not work. That rule is about **meaning**: it forbids the runtime
 * deciding which sentences a stranger is allowed to have written. This function removes bytes that
 * carry no textual meaning at all — cursor moves, line erases, colour changes, window-title writes —
 * and it removes them uniformly, without reading a word. Nothing it deletes could ever have been part
 * of what the text *says*.
 *
 * ## Why it has to exist at all
 *
 * A shell tool returns whatever the program printed, escapes included, and an escape is not
 * decoration: `\x1b[2K\x1b[1G` erases the line and returns the cursor to its start, so text printed
 * afterwards *overwrites* what came before. A command containing that sequence can be displayed by
 * any terminal as a completely different command — which makes it an attack on the approval prompt,
 * not a rendering nit. The prompt exists to show a person what is about to run; a prompt that can be
 * made to show something else is worse than no prompt, because it is trusted.
 *
 * Stripping shows *more* of the truth, never less. `git status\x1b[2K\x1b[1G && rm -rf ~` renders as
 * `git status` on a real terminal and as `git status && rm -rf ~` here.
 *
 * ## Line endings
 *
 * `\r\n` collapses to `\n` and a lone `\r` becomes `\n`. CRLF is ordinary in files and must survive
 * as a line break; a bare carriage return is the same overwrite trick as `\x1b[1G` with fewer
 * characters, and progress bars produce it constantly. `\n` and `\t` are the only control characters
 * kept.
 */

/**
 * Every pattern below is assembled with `new RegExp` rather than written as a literal.
 *
 * Not style: a regex literal containing `\x1B` is a lint error under
 * `suspicious/noControlCharactersInRegex`, and that rule is right almost everywhere — a control
 * character in a pattern is nearly always a typo. This is the one module where matching them is the
 * entire point, so the characters are named instead of typed, which also makes the patterns readable
 * without an ASCII table.
 */
const ch = (code: number): string => String.fromCharCode(code)

const ESC = ch(0x1b)
const BEL = ch(0x07)

/** `ESC [ … final` — cursor movement, colour, erase. The overwhelming majority of what appears. */
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g")

/** `ESC ] … BEL` or `ESC ] … ST` — operating-system commands: window title, hyperlink, clipboard. */
const OSC = new RegExp(`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\|$)`, "g")

/** `ESC P/X/^/_ … ST` — device control, privacy message, application program command. */
const STRING_ESCAPE = new RegExp(`${ESC}[P^_X][\\s\\S]*?(?:${ESC}\\\\|${BEL}|$)`, "g")

/** Two-character escapes (`ESC c` full reset, `ESC 7` save cursor) and any orphaned `ESC`. */
const SHORT_ESCAPE = new RegExp(`${ESC}[@-Z\\\\-_0-9=><]?`, "g")

/** C1 controls in their 8-bit form, which some programs still emit. */
const C1 = new RegExp(`[${ch(0x80)}-${ch(0x9f)}]`, "g")

/** Everything else in C0 plus DEL. `\n` and `\t` are deliberately absent. */
const C0 = new RegExp(
    `[${ch(0)}-${ch(8)}${ch(0x0b)}${ch(0x0c)}${ch(0x0e)}-${ch(0x1f)}${ch(0x7f)}]`,
    "g",
)

/**
 * Strip escape sequences and control characters, keeping newlines and tabs.
 *
 * Order matters: the multi-character forms are removed before the catch-all, or the catch-all eats
 * the `ESC` that identified them and leaves their payload behind as text.
 */
export function stripControl(text: string): string {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(OSC, "")
        .replace(STRING_ESCAPE, "")
        .replace(CSI, "")
        .replace(SHORT_ESCAPE, "")
        .replace(C1, "")
        .replace(C0, "")
}

/** True when stripping would change the text — for saying so rather than doing it quietly. */
export function hasControl(text: string): boolean {
    return stripControl(text) !== text
}
