/**
 * Public export surface.
 *
 * The library is the contract: `import { Runtime }` is as first-class as the CLI, and every
 * surface — CLI, server, Docker image — is a consumer of what is exported here.
 */

export type { Brand } from "./brand.ts"
export {
    BRAND,
    BRAND_OVERRIDE_ENV,
    brandFromSlug,
    DEFAULT_BRAND,
    deriveBrand,
    SLUG_PATTERN,
    titleCaseSlug,
} from "./brand.ts"
export {
    type AssembledContext,
    type AssembleInput,
    assembleContext,
    slotReport,
} from "./context/assemble.ts"
export { type ContextBlock, SLOT, type SlotName, type SlotNumber } from "./context/blocks.ts"
export { estimateMessageTokens, estimateTokens } from "./context/tokens.ts"
export {
    AbortedError,
    ConfigError,
    type ErrorDetail,
    HarnessError,
    ModelError,
} from "./errors.ts"
export { EventBus, type EventBusOptions, type EventHandler } from "./events/bus.ts"
export type {
    AnyEvent,
    ContextSlotReport,
    EventContext,
    EventDataMap,
    EventEnvelope,
    EventType,
    TurnEndReason,
} from "./events/types.ts"
export { newStepId, newTurnId } from "./loop/ids.ts"
export { runStep, type StepInput, type StepResult } from "./loop/step.ts"
export { runTurn, type TurnInput, type TurnLimits, type TurnResult } from "./loop/turn.ts"
export {
    type EnvSource,
    envReferencesIn,
    expandEnvDeep,
    mergeEnv,
    parseDotEnv,
} from "./manifest/env.ts"
export {
    defineAgent,
    type LoadedManifest,
    type LoadOptions,
    loadManifest,
    loadManifestFromObject,
} from "./manifest/load.ts"
export { resolveRefs, shallowMerge } from "./manifest/refs.ts"
export type {
    AgentManifest,
    ChannelConfig,
    ContextConfig,
    DeliveryConfig,
    LimitsConfig,
    MemoryConfig,
    ModelCapabilitiesOverride,
    ModelConfig,
    ModelRole,
    ModelRoleConfig,
    PhaseConfig,
    ScheduleConfig,
    ServerConfig,
    SkillsConfig,
    ThresholdsConfig,
    ToolsConfig,
} from "./manifest/schema.ts"
export { AgentManifestSchema, MODEL_ROLES } from "./manifest/schema.ts"
export {
    assertApiVersion,
    scanForLiteralSecrets,
    type ValidateOptions,
    validateManifest,
} from "./manifest/validate.ts"
export {
    CAPABILITY_REGISTRY,
    type CapabilityEntry,
    globToRegExp,
    type ModelCapabilities,
    matchCapabilities,
    patternSpecificity,
    resolveCapabilities,
} from "./model/capabilities.ts"
export {
    type ChatCompletionsConfig,
    createChatCompletionsProvider,
    DEFAULT_RETRY,
    type RetryPolicy,
} from "./model/chat-completions.ts"
export type {
    ChatChunk,
    ChatMessage,
    ChatRequest,
    FetchLike,
    ModelProvider,
} from "./model/provider.ts"
export {
    type ResolvedRole,
    type ResolvedRoles,
    type ResolveRolesOptions,
    requestParamsFor,
    resolveRoles,
} from "./model/roles.ts"
export { parseSSE, type SSEEvent } from "./model/sse.ts"
export { Agent, type AgentDescription, type AgentSendOptions } from "./runtime/agent.ts"
export {
    type AgentSource,
    type BootReport,
    defaultStorePath,
    Runtime,
    type RuntimeOptions,
    type StoreSource,
} from "./runtime/runtime.ts"
export {
    type TurnAttachment,
    type TurnBufferState,
    TurnStreams,
    type TurnStreamsOptions,
} from "./store/buffer.ts"
export {
    formatSessionKey,
    isSessionKey,
    parseSessionKey,
    type SessionParts,
} from "./store/session-key.ts"
export {
    type OpenOptions,
    openDatabase,
    type SqlDatabase,
    type SqlParam,
    type SqlRunResult,
    type SqlStatement,
    type SqlValue,
    setUserVersion,
    userVersion,
} from "./store/sqlite/driver.ts"
export {
    MIGRATIONS,
    type Migration,
    type MigrationReport,
    migrate,
} from "./store/sqlite/migrations.ts"
export { openMemoryStore, SqliteStore, type SqliteStoreOptions } from "./store/sqlite/store.ts"
export type {
    KVStore,
    MessagePage,
    MessageStore,
    SessionRecord,
    SessionStore,
    SessionSummary,
    Store,
    StoredMessage,
    TurnRecord,
    TurnStatus,
    TurnStore,
} from "./store/store.ts"
export { VERSION } from "./version.ts"
