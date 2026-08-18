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
 * configurable one would grow options nobody needs and hide the TTY rule above inside them.
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
