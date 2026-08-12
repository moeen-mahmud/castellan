/**
 * How output is rendered, resolved once per process.
 *
 * This mirrors the reasoning behind decision 3.5, which forbids the tool dialect from changing with
 * the model: behaviour that shifts silently with the environment cannot be reasoned about. So the
 * resolution is total and ordered, and it returns *why* it chose — the reason is printable, which is
 * what turns "it wasn't interactive and I don't know why" into a question with an answer.
 *
 * Measured, not assumed: importing Ink and React costs ~65 ms under Bun and ~170-210 ms under Node,
 * against a ~70 ms total runtime for `validate --json`. Nothing on a non-rich path may import them,
 * which is why this returns a mode rather than a renderer.
 */

import { readEnv } from "#lib/env"
import type { ModeDecision, ModeInputs } from "#lib/schema"

/**
 * Total and ordered. Every branch is reachable and every input is consulted, so no combination of
 * flags and environment lands somewhere undocumented.
 */
export function resolveMode(inputs: ModeInputs): ModeDecision {
    if (inputs.json) return { mode: "json", because: "--json was passed" }
    if (inputs.plain) return { mode: "plain", because: "--plain was passed" }

    // A one-shot is a scripting affordance. Its output must not depend on whether a human happened
    // to be at a terminal, or `--input` would mean two different things in a shell script and in a
    // shell.
    if (inputs.oneShot) return { mode: "plain", because: "--input is always plain" }

    if (!inputs.stdoutIsTTY) return { mode: "plain", because: "stdout is not a terminal" }
    // A live transcript with no way to type into it is a worse plain renderer, not a better one.
    if (!inputs.stdinIsTTY) return { mode: "plain", because: "stdin is not a terminal" }

    if (inputs.env.noColor) return { mode: "plain", because: "NO_COLOR is set" }
    if (inputs.env.dumbTerminal) return { mode: "plain", because: "TERM is dumb" }
    // CI logs are files that happen to scroll. Cursor movement in one is noise forever.
    if (inputs.env.ci) return { mode: "plain", because: "CI is set" }

    return { mode: "rich", because: "stdout and stdin are both terminals" }
}

/**
 * Deliberately not consulted: `FORCE_COLOR`. It says how much colour a stream can carry, not
 * whether a human is watching, and honouring it here would turn a CI job that wanted coloured logs
 * into one driving a cursor around a file. Ink's own colour depth still respects it.
 */
export function resolveModeFromProcess(flags: {
    readonly json: boolean
    readonly plain: boolean
    readonly oneShot: boolean
}): ModeDecision {
    return resolveMode({
        ...flags,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
        env: readEnv(),
    })
}
