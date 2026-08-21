/**
 * A yes/no question on the plain path.
 *
 * One question, one place. The wizard has its own confirm *screen* under Ink and the picker has a
 * selection; what was missing was the shape a single command needs before doing something outside its
 * own workspace — and the only current caller, `terminal-setup`, is the only command that does that.
 *
 * **Not a TTY means no.** A piped or CI run cannot answer, so the safe answer is the one that changes
 * nothing — and the caller reports that nothing was written rather than treating it as a failure.
 * Defaulting to yes here would make a redirected invocation edit somebody's editor keybindings, which is
 * the kind of surprise that is only discovered later.
 *
 * Deliberately not a general prompt library. A second kind of question can have a second function; a
 * configurable one would grow options nobody needs and hide the TTY rule above inside them. There are
 * three now — `askExactly` is a different bar, and `askSecret` is a different *channel*, because a
 * value that must not be echoed cannot go through readline at all.
 */

import { createInterface } from "node:readline"

export interface ConfirmOptions {
    /** Injected by tests. The process streams otherwise. */
    readonly input?: NodeJS.ReadableStream & { isTTY?: boolean }
    readonly output?: NodeJS.WritableStream
}

export async function askYesNo(question: string, options: ConfirmOptions = {}): Promise<boolean> {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    if (input.isTTY !== true) return false

    const rl = createInterface({ input, output })
    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(`\n${question} [y/N] `, resolve)
        })
        return /^y(es)?$/i.test(answer.trim())
    } finally {
        // Always closed: a readline left open holds the event loop and the process never exits.
        rl.close()
    }
}

/**
 * A question answered only by typing something back exactly.
 *
 * The bar for an irreversible, multi-part deletion. `askYesNo` is one keypress, which is right for
 * "shall I edit your keybindings" and too cheap for "delete this agent, its conversations and its
 * memory" — a stray `y` against the wrong listing is a mistake with nothing to undo it, and the whole
 * point of showing the listing first is that somebody reads it. Typing the name is what proves they did.
 *
 * Compared after trimming and nothing else. Case is **not** folded: an agent's ref is the name of a
 * directory, so `Milo` and `milo` are two different agents on a case-sensitive filesystem, and
 * accepting either here would accept the wrong one somewhere else.
 *
 * Not a TTY means no, for the reason `askYesNo` has it: a piped or CI run cannot answer, and the safe
 * answer is the one that changes nothing. The caller reports that nothing was deleted, and `--yes` is
 * how a script says it meant it.
 */
export async function askExactly(
    question: string,
    expected: string,
    options: ConfirmOptions = {},
): Promise<boolean> {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    if (input.isTTY !== true) return false

    const rl = createInterface({ input, output })
    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(`\n${question} `, resolve)
        })
        return answer.trim() === expected
    } finally {
        rl.close()
    }
}

/**
 * A value typed at a prompt and never echoed. `undefined` means cancelled or unavailable.
 *
 * ## Why this is not readline
 *
 * readline echoes what it reads, and the documented way to stop it is to overwrite a private method on
 * the interface — which needs a cast this codebase does not allow. Reading the bytes is a dozen more
 * lines and it is the honest version: raw mode on, one `*` written per character, raw mode off in a
 * `finally` so a thrown error cannot leave the terminal unable to echo anything the person types next.
 *
 * ## Why a secret never comes from an argument
 *
 * The alternative was `--value`, and it puts the secret in two places nobody intends: the shell's
 * history file, and `ps` output, where every local process can read it for the lifetime of the call.
 * That is the same exposure `renderPlist` throws to prevent — launchd echoes a job's environment in
 * plaintext, so a plist carries no secret — and the reasoning does not change because the process is
 * short-lived. Not a TTY returns `undefined` rather than reading a pipe, so a CI run is *told* that
 * nothing was written instead of a secret arriving from somewhere the caller did not audit.
 *
 * ^C cancels and ^D on an empty line cancels; both return `undefined`, and the caller reports that
 * nothing changed. Backspace is honoured because a mistyped key in a value you cannot see is otherwise
 * unrecoverable without starting the command again.
 */
/**
 * The narrow surface `askSecret` touches, rather than a widened `ConfirmOptions.input`.
 *
 * `process.stdin`'s declared `on` is a union of overloads, and intersecting that with an object type
 * makes it uncallable — the compiler cannot pick a signature. Declaring only what is used and asserting
 * the real stream against it once keeps the check where it is useful: anything else this function
 * reached for would be a type error here rather than a runtime surprise.
 */
export interface SecretInput {
    readonly isTTY?: boolean
    setRawMode?: (mode: boolean) => unknown
    resume?: () => unknown
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown
    removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown
}

export interface SecretOptions {
    readonly input?: SecretInput
    readonly output?: NodeJS.WritableStream
}

export async function askSecret(
    question: string,
    options: SecretOptions = {},
): Promise<string | undefined> {
    const input = options.input ?? (process.stdin as unknown as SecretInput)
    const output = options.output ?? process.stdout
    if (input.isTTY !== true) return undefined

    output.write(`\n${question} `)
    const raw = typeof input.setRawMode === "function"
    if (raw) input.setRawMode?.(true)
    input.resume?.()

    try {
        return await new Promise<string | undefined>((resolve) => {
            let value = ""
            // Escape-sequence state. Dropping only the escape *byte* left `[A` in the value for an
            // arrow key — two characters of junk in a string nobody can see, which is worse than three
            // because it looks like nothing happened. CSI runs until a byte in 0x40–0x7e ends it.
            let escaped = false
            let csi = false
            const finish = (result: string | undefined) => {
                input.removeListener("data", onData)
                output.write("\n")
                resolve(result)
            }
            const onData = (chunk: Buffer | string) => {
                const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
                for (const char of text) {
                    const code = char.charCodeAt(0)
                    if (csi) {
                        // The final byte of a CSI sequence, and the end of it.
                        if (code >= 0x40 && code <= 0x7e) csi = false
                        continue
                    }
                    if (escaped) {
                        escaped = false
                        // `[` opens CSI and `O` opens SS3, which is how some terminals send arrows.
                        if (char === "[" || char === "O") csi = true
                        continue
                    }
                    if (code === 27) {
                        escaped = true
                        continue
                    }
                    if (code === 13 || code === 10) return finish(value)
                    // ^C always cancels; ^D cancels only an empty line, so it cannot silently
                    // truncate a value somebody was halfway through typing.
                    if (code === 3) return finish(undefined)
                    if (code === 4) return finish(value === "" ? undefined : value)
                    if (code === 127 || code === 8) {
                        if (value.length > 0) {
                            value = value.slice(0, -1)
                            output.write("\b \b")
                        }
                        continue
                    }
                    // Any remaining control byte is a chord, and a secret has none in it.
                    if (code < 32) continue
                    value += char
                    output.write("*")
                }
            }
            input.on("data", onData)
        })
    } finally {
        // Always restored. A thrown error that left raw mode on would leave the shell that follows
        // unable to echo anything at all, which reads as a hung terminal rather than a failed command.
        if (raw) input.setRawMode?.(false)
    }
}
