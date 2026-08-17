/**
 * `@castellan/tools-system` — the agent acting on the machine it runs on.
 *
 * A harness that cannot run a command is not a harness. This is the package that makes the runtime
 * peer to the tools it is modelled on rather than a channel-resident assistant, and it is deliberately
 * the one package whose every tool is governed by `tools.policy` and the trust gate from the first
 * line of code rather than from a later hardening pass.
 */

export {
    CONFIG_READ_SPEC,
    CONFIG_SET_SPEC,
    type ConfigOptions,
    configReadHandler,
    configSetHandler,
    configTools,
    parseValue,
    SETTABLE_PATHS,
} from "./config.ts"
export {
    execCommandEmpty,
    execPtyUnavailable,
    execSpawnFailed,
    execWorkdirMissing,
} from "./errors.ts"
export {
    DEFAULT_TIMEOUT_MS,
    EXEC_SPEC,
    type ExecOptions,
    effectiveTimeout,
    execFromContext,
    execHandler,
    execTool,
    MAX_TIMEOUT_MS,
    render,
} from "./exec.ts"
export {
    humanBytes,
    INLINE_CAP,
    type Observation,
    readOutput,
    stripLeadingEcho,
} from "./output.ts"
export { SYSTEM_PROVIDER_ID, spillDir } from "./paths.ts"
export {
    SYSTEM_READONLY_SLUGS,
    SYSTEM_TOOL_SLUGS,
    SystemProvider,
    type SystemProviderOptions,
    systemFromConfig,
} from "./provider.ts"
export {
    backgroundable,
    backgroundedCommands,
    buildWrapper,
    commandLine,
    MAX_BACKGROUNDED,
    type RunEnding,
    type RunRequest,
    type RunResult,
    readStatus,
    reapBackgrounded,
    runCommand,
} from "./run.ts"
export {
    SystemScriptRunner,
    type SystemScriptRunnerOptions,
} from "./scripts.ts"
export { ShellSessions } from "./session.ts"
