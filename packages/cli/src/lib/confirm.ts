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
 * two now, and `askExactly` is the second — same TTY rule, a different bar.
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
