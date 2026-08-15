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
export { type ManifestHeader, readManifestHeader } from "./manifest/header.ts"
export {
    defineAgent,
    type LoadedManifest,
    type LoadOptions,
    loadManifest,
    loadManifestFromObject,
} from "./manifest/load.ts"
export {
    type ProviderFields,
    type ProviderPlan,
    type ProviderSelection,
    providerIds,
    resolveProviders,
} from "./manifest/providers.ts"
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
export {
    DEFAULT_PROMPT_STYLE,
    defaultPromptStyle,
    type ExtractedExamples,
    extractExamples,
    type PromptStyle,
    type PromptStyleClass,
    parameterBillions,
    promptStyleClass,
    renderPromptStyle,
    SMALL_MODEL_BILLIONS,
} from "./model/prompt-style.ts"
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
    resolveWorkspace,
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
export { renderNotEnabledBlock, renderNotEnabledText } from "./tools/dialect/not-enabled.ts"
export {
    type ApprovalRequest,
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
    type Authorization,
    type AuthorizeInput,
    authorize,
    DEFAULT_POLICY,
    decidePolicy,
    NEVER_STRIPPED,
    onceOnlyTools,
    type ParsedPolicy,
    type PolicyConfig,
    type PolicyDecision,
    type PolicyEffect,
    type PolicyMode,
    type PolicyQuery,
    parsePolicy,
    resolveWithoutApprover,
    subcommands,
} from "./tools/policy.ts"
export {
    applyBudget,
    DEFAULT_TOOL_BUDGET,
    type DroppedTool,
    type RegistryOptions,
    type ToolBudget,
    ToolRegistry,
} from "./tools/registry.ts"
export { hasControl, stripControl } from "./tools/sanitise.ts"
export {
    GATE_CODE,
    gatedResult,
    gateRefusalText,
    neutraliseMarkers,
    type OnMutate,
    refusedResult,
    renderTrusted,
    type Trust,
    untrustedFence,
    wrapUntrusted,
} from "./tools/trust.ts"
export type {
    FieldError,
    JsonSchemaNode,
    JsonType,
    Tool,
    ToolAvailability,
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
export {
    type AuthoringInput,
    BULLET_DENSITY_LIMIT,
    checkAuthoring,
    EXAMPLE_OVERLAP_LIMIT,
    EXAMPLES_MAX,
    EXAMPLES_MIN,
    PROHIBITION_LIMIT,
} from "./workspace/authoring.ts"
export type {
    Editable,
    Frontmatter,
    ParsedFile,
    ParsedKnowledgeFile,
    Tier,
} from "./workspace/frontmatter.ts"
export {
    parseKnowledgeFile,
    parseWorkspaceFile,
    strip as stripWorkspaceText,
} from "./workspace/frontmatter.ts"
export {
    activateKnowledge,
    type KnowledgeBase,
    type KnowledgeEntry,
    type KnowledgeSelector,
    keywordSelector,
    type LoadKnowledgeOptions,
    loadKnowledge,
} from "./workspace/knowledge.ts"
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
    rulesBlocksOnly,
} from "./workspace/rules.ts"
export {
    planSoul,
    type SoulClass,
    type SoulGateConfig,
    type SoulPlan,
    soulClass,
    windowRequirementMet,
} from "./workspace/soul.ts"
