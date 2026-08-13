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
    ToolError,
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
export {
    runTurn,
    type ToolRuntime,
    type TurnInput,
    type TurnLimits,
    type TurnResult,
} from "./loop/turn.ts"
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
    ToolCallRequest,
    ToolDefinition,
} from "./model/provider.ts"
export {
    type ResolvedRole,
    type ResolvedRoles,
    type ResolveRolesOptions,
    requestParamsFor,
    resolveRoles,
} from "./model/roles.ts"
export { parseSSE, type SSEEvent } from "./model/sse.ts"
export { nearest } from "./nearest.ts"
export {
    Agent,
    type AgentCreateOptions,
    type AgentDescription,
    type AgentSendOptions,
} from "./runtime/agent.ts"
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
export {
    type Coercion,
    type CoercionFailure,
    type CoercionSuccess,
    coerceArgs,
} from "./tools/coerce.ts"
export {
    type DialectId,
    type ParsedOutput,
    passThroughFilter,
    type StepOutput,
    type StreamFilter,
    type ToolDialect,
} from "./tools/dialect/dialect.ts"
export {
    nativeDialect,
    nativeWireTokens,
    parseNative,
    renderNativeDescription,
} from "./tools/dialect/native.ts"
export {
    createNltStreamFilter,
    nltDialect,
    parseNlt,
    renderNltEntry,
} from "./tools/dialect/nlt.ts"
export {
    batch,
    type ExecuteInput,
    type ExecuteOutcome,
    executeIntents,
    hashArgs,
    planIntents,
} from "./tools/execute.ts"
export {
    LOCAL_PROVIDER_ID,
    LOCAL_TOOL_SLUGS,
    localProvider,
    MEMORY_DIR,
    MEMORY_FILE,
    toolContext,
} from "./tools/local.ts"
export {
    applyBudget,
    DEFAULT_TOOL_BUDGET,
    type DroppedTool,
    type RegistryOptions,
    type ToolBudget,
    ToolRegistry,
} from "./tools/registry.ts"
export type {
    FieldError,
    JsonSchemaNode,
    JsonType,
    Tool,
    ToolContext,
    ToolHandler,
    ToolIntent,
    ToolParameters,
    ToolProvider,
    ToolProviderContext,
    ToolProviderFactory,
    ToolProviderRefresh,
    ToolResult,
    ToolSpec,
    WorkspaceWriteTarget,
} from "./tools/types.ts"
export { VERSION } from "./version.ts"
export type { Editable, Frontmatter, ParsedFile, Tier } from "./workspace/frontmatter.ts"
export { parseWorkspaceFile, strip as stripWorkspaceText } from "./workspace/frontmatter.ts"
export {
    DEFAULT_WORKSPACE_BUDGETS,
    emptyWorkspace,
    loadWorkspace,
    planWorkspace,
    type RulesConfig,
    ruleBudgetFailure,
    type Workspace,
    type WorkspaceBudgets,
    type WorkspaceFile,
    type WorkspaceFileRef,
    type WorkspacePlan,
    workspaceRefs,
    writeTarget,
} from "./workspace/load.ts"
export {
    allowedRules,
    type CountedRule,
    checkRules,
    countRules,
    type RuleCheck,
} from "./workspace/rules.ts"
