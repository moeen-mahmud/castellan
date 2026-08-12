/**
 * Help text, rendered from the command table.
 *
 * Generated rather than written, so a flag the parser honours cannot be missing from the help and
 * a flag the help promises cannot be missing from the parser. A test asserts exactly that.
 */

import { BRAND } from "@castellan/core"
import { COMMANDS, flagsFor, GLOBAL_FLAGS } from "#lib/commands"
import type { CommandSpec, FlagSpec } from "#lib/schema"

const FLAG_COLUMN = 24
const ENV_COLUMN = 22

function usageLine(command: CommandSpec): string {
    const args = command.args
        .map((arg) => {
            const body = arg.variadic === true ? `${arg.name}...` : arg.name
            return arg.required ? `<${body}>` : `[${body}]`
        })
        .join(" ")
    return `${BRAND.slug} ${command.name}${args === "" ? "" : ` ${args}`}`
}

function flagLine(flag: FlagSpec): string {
    const long =
        flag.placeholder === undefined ? `--${flag.name}` : `--${flag.name} <${flag.placeholder}>`
    const forms = flag.short === undefined ? long : `-${flag.short}, ${long}`
    const trailer = flag.defaultHelp === undefined ? "" : ` (default ${flag.defaultHelp})`
    return `  ${forms.padEnd(FLAG_COLUMN)}${flag.help}${trailer}`
}

const SESSION_KEY_NOTE = `Session keys are {channel}:{peerId}[:{thread}] — a bare word is refused, because outbound
delivery reads the channel back out of the key.`

/** Help for one command, or for the whole tool when `command` is absent. */
export function helpText(command?: CommandSpec): string {
    if (command !== undefined) {
        const lines = [
            command.summary,
            "",
            "usage:",
            `  ${usageLine(command)} [flags]`,
            "",
            "flags:",
            ...flagsFor(command).map(flagLine),
        ]
        if (command.flags.some((flag) => flag.name === "session")) lines.push("", SESSION_KEY_NOTE)
        return `${lines.join("\n")}\n`
    }

    const width = Math.max(...COMMANDS.map((command) => usageLine(command).length)) + 2
    return `${[
        `${BRAND.name} — a lightweight, model-agnostic agent runtime`,
        "",
        "usage:",
        ...COMMANDS.map((command) => `  ${usageLine(command).padEnd(width)}${command.summary}`),
        `  ${BRAND.slug} --version`,
        `  ${BRAND.slug} --help`,
        "",
        `Per-command flags: ${BRAND.slug} <command> --help`,
        "",
        "global flags:",
        ...GLOBAL_FLAGS.map(flagLine),
        "",
        SESSION_KEY_NOTE,
        "",
        "environment:",
        `  ${`${BRAND.envPrefix}BRAND`.padEnd(ENV_COLUMN)}rebrand every derived path, env prefix, and apiVersion`,
        `  ${"NO_COLOR".padEnd(ENV_COLUMN)}set to anything to force plain output`,
        `  ${"DEBUG".padEnd(ENV_COLUMN)}print stack traces on failure`,
    ].join("\n")}\n`
}
