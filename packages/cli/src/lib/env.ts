/**
 * Every environment read the CLI makes.
 *
 * Centralised for the same reason termheat centralises it: an environment variable consulted deep
 * inside a component is untestable and invisible. Everything downstream takes an `EnvFacts` value,
 * so the interesting logic — `resolveMode` especially — is a pure function of its inputs.
 */

import type { EnvFacts } from "#lib/types"

/**
 * `NO_COLOR` is honoured when present and non-empty, per no-color.org. An exported-but-empty
 * variable is a container passing through something unset, not a stated preference.
 */
function isSet(value: string | undefined): boolean {
    return value !== undefined && value !== ""
}

export function readEnv(env: Readonly<Record<string, string | undefined>> = process.env): EnvFacts {
    return {
        noColor: isSet(env.NO_COLOR),
        dumbTerminal: env.TERM === "dumb",
        // `CI=false` is set by tooling that wants to say "not CI", and taking it literally would
        // strip interactivity from a terminal that has it.
        ci: isSet(env.CI) && env.CI !== "false",
        debug: isSet(env.DEBUG),
    }
}
