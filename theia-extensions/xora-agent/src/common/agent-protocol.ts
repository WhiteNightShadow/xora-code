import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const AGENT_HOST_PATH = '/services/xora-agent';
export const AgentHostService = Symbol('AgentHostService');
export const AgentHostClient = Symbol('AgentHostClient');

export type RuntimePhase =
    | 'stopped'
    | 'starting'
    | 'initializing'
    | 'auth-required'
    | 'ready'
    | 'draining'
    | 'updating'
    | 'crashed';

/**
 * Application-wide default for handling ACP permission requests. The choice
 * is persisted by Electron main and shared by every project, session and
 * window. It never weakens workspace trust or path-boundary enforcement.
 */
export type AgentPermissionMode = 'request-approval' | 'full-access';

/** @deprecated Use `AgentPermissionMode`; retained for source compatibility. */
export type SessionPermissionMode = AgentPermissionMode;

export type ProviderProtocol =
    | 'openai-responses'
    | 'openai-chat-completions'
    | 'anthropic-messages';

/** Grok catalog id used for the managed xAI/compatible-relay profile. */
export const XAI_MANAGED_MODEL_ID = 'xora-xai-api';

/** Renderer-only choice used to switch Providers before ACP advertises models. */
export const PROVIDER_DEFAULT_MODEL_CHOICE_ID = '__xora_provider_default__';

interface ProviderProfileBase {
    id: string;
    name: string;
    managed?: boolean;
    baseUrl?: string;
    model?: string;
    contextWindow?: number;
    /** Whether the configured model endpoint can perform provider-side web search. */
    backendSearch?: boolean;
    secretRef?: string;
    /** Safe status bit for UI rendering. The credential value never crosses RPC. */
    credentialConfigured?: boolean;
}

export type ProviderProfile = ProviderProfileBase & ({
    kind: 'grok-subscription';
    protocol?: never;
} | {
    kind: 'xai-api-key';
    /**
     * Optional for compatibility with the original key-only xAI profile.
     * When present, the profile is backed by an explicit xAI-compatible API
     * endpoint (including trusted relay services).
     */
    protocol?: ProviderProtocol;
    secretRef: string;
} | {
    kind: 'custom';
    protocol: ProviderProtocol;
});

export interface AuthenticationResult {
    status: 'authenticated' | 'confirmation-required';
}

export interface AgentGoalCapability {
    available: boolean;
    command: boolean;
    updateTool: boolean;
}

export interface AgentCapabilities {
    protocolVersion: number;
    loadSession: boolean;
    /** Verified against the live ACP route; false hides non-interrupting guidance actions. */
    guidePrompt: boolean;
    /** Session-scoped capability; true only after Grok advertises both `/goal` and `update_goal`. */
    goal: AgentGoalCapability;
    /** True after a live session response advertises selectable ACP modes. */
    sessionModes: boolean;
    prompt: {
        image: boolean;
        audio: boolean;
        embeddedContext: boolean;
    };
    mcp: {
        http: boolean;
        sse: boolean;
    };
    authMethods: Array<{ id: string; name: string }>;
    defaultAuthMethodId?: string;
}

export interface AgentModelOption {
    id: string;
    name: string;
    description?: string;
    contextWindow?: number;
}

export type AgentContextCompactionStatus = 'idle' | 'running' | 'failed' | 'cancelled';

export interface AgentContextCompactionRecord {
    tokensBefore?: number;
    tokensAfter: number;
    elapsedMs?: number;
}

/**
 * Renderer-safe context state sourced only from Grok Build's context metadata.
 * It must never be populated from billing usage or character-count estimates.
 */
export interface AgentSessionContext {
    totalTokens?: number;
    contextWindow?: number;
    usagePercent?: number;
    modelId?: string;
    compactionStatus: AgentContextCompactionStatus;
    compactionCount: number;
    lastCompaction?: AgentContextCompactionRecord;
}

export interface SessionRecord {
    appSessionId: string;
    acpSessionId?: string;
    title: string;
    workspaceRoot: string;
    providerId: string;
    /** Non-secret generation binding this ACP session to one Provider identity/configuration. */
    providerRuntimeEpoch?: string;
    model?: string;
    sidecarVersion?: string;
    /** ACP modes are descriptive, session-scoped state and contain no secrets. */
    availableModes?: AgentSessionMode[];
    currentModeId?: string;
    /** Authoritative capability for this exact ACP session. */
    goalCapability?: AgentGoalCapability;
    createdAt: string;
    updatedAt: string;
    status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'read-only';
}

export interface RuntimeSnapshot {
    /**
     * Monotonic sequence assigned by the Electron host. Snapshot events and
     * RPC results use different asynchronous channels, so the renderer must
     * ignore an older sequence that arrives after a newer Provider/session
     * state. Optional only for compatibility with older test/fake clients.
     */
    revision?: number;
    phase: RuntimePhase;
    workspaceRoot?: string;
    /** The selected Agent root belongs to the roots currently open in this Theia window. */
    workspaceAttached: boolean;
    /** Theia's native trust decision; runtime standby does not depend on this flag. */
    workspaceTrusted: boolean;
    providerId: string;
    /**
     * Safe, credential-free knowledge established by an explicit Grok login,
     * logout, or a successfully initialized subscription runtime. `unknown`
     * must never be rendered as "未登录" because Xora Code deliberately does
     * not inspect Grok's shared credential files.
     */
    grokSubscriptionAuthStatus: 'authenticated' | 'unauthenticated' | 'unknown';
    sidecarVersion?: string;
    capabilities?: AgentCapabilities;
    models: AgentModelOption[];
    selectedModel?: string;
    sessions: SessionRecord[];
    activeSessionId?: string;
    /** Latest authoritative Grok context state, keyed by Xora app session id. */
    sessionContexts?: Record<string, AgentSessionContext>;
    /** Application-wide permission mode; defaults to request-approval. */
    permissionMode: AgentPermissionMode;
    message?: string;
}

export interface StartRuntimeRequest {
    workspaceRoot: string;
    providerId: string;
}

/**
 * Mirrors the trust decision made by Theia for the currently open workspace.
 * Electron main still canonicalizes every root and remains the final policy
 * enforcement point for privileged operations.
 */
export interface SynchronizeWorkspaceTrustRequest {
    workspaceRoots: string[];
    trusted: boolean;
}

export interface CreateSessionRequest {
    workspaceRoot: string;
    providerId: string;
    model?: string;
    title?: string;
    additionalDirectories?: string[];
    /** Optional initial ACP mode, applied immediately after `session/new`. */
    modeId?: string;
}

export interface AgentSessionMode {
    id: string;
    name: string;
    description?: string;
}

export type AgentExecutionMode = 'standard' | 'continuous';
export type AgentTurnStatus = 'running' | 'end-turn' | 'cancelled' | 'error';
export type AgentTaskVerificationStatus =
    | 'not-required'
    | 'working'
    | 'verifying'
    | 'verified'
    | 'incomplete'
    | 'blocked'
    | 'paused';

export type PromptImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Transient renderer-to-main image payload. `data` is canonical, unprefixed
 * base64 and must never be copied into diagnostics, settings or session logs.
 */
export interface PromptImageAttachment {
    mimeType: PromptImageMimeType;
    data: string;
    name?: string;
}

/** Persistable attachment metadata. It deliberately contains no image data. */
export interface AgentAttachmentSummary {
    kind: 'image';
    mimeType: PromptImageMimeType;
    byteSize: number;
    sha256: string;
    name?: string;
}

export interface PromptRequest {
    sessionId: string;
    text: string;
    /** Explicit user choice. Xora never promotes a standard prompt automatically. */
    executionMode?: AgentExecutionMode;
    /** At most four images and 5 MiB of decoded data in total. */
    attachments?: PromptImageAttachment[];
}

/** User-authored contract locked when Grok asks to leave read-only Plan mode. */
export interface AgentTaskContract {
    objective: string;
    planEntries: Array<{ id: string; text: string }>;
    acceptanceCriteria: string[];
}

/**
 * Renderer decision for one live `x.ai/exit_plan_mode` reverse request.
 * `cancelled` means "revise this plan" and may include feedback; `abandoned`
 * exits Plan mode without implementing it.
 */
export interface PlanApprovalDecision {
    requestId: string;
    outcome: 'approved' | 'cancelled' | 'abandoned';
    feedback?: string;
    /** Required for approval so Xora can persist the frozen acceptance contract. */
    contract?: AgentTaskContract;
}

/** Adds a queued message to the running turn at Grok's next safe checkpoint. */
export interface GuidePromptRequest extends PromptRequest {
}

export interface GuidePromptResult {
    /** `not-running` leaves the renderer-owned FIFO item untouched. */
    status: 'accepted' | 'not-running';
    interjectionId?: string;
}

export interface PermissionDecision {
    requestId: string;
    outcome: 'allow-once' | 'allow-always' | 'reject';
    expiresAt?: string;
}

export interface AgentTextEvent {
    kind: 'text-delta';
    sessionId: string;
    /** Stable identifier for one user prompt and its complete Agent turn. */
    turnId?: string;
    role: 'assistant' | 'user' | 'system';
    text: string;
    /** This user message guides an already-running turn without cancelling it. */
    guidance?: boolean;
    /** Stable non-secret id for one accepted Grok interjection. */
    messageId?: string;
    /** Safe metadata only. Raw attachment data is never persisted. */
    attachments?: AgentAttachmentSummary[];
}

/**
 * One provider-authored ACP thought stream. This is deliberately independent
 * from assistant text so a renderer can present it as optional, low-emphasis
 * detail without merging it into the final answer.
 */
export interface AgentThoughtEvent {
    kind: 'thought-delta';
    sessionId: string;
    turnId?: string;
    /** Stable for one ACP thought message (or one contiguous legacy stream). */
    thoughtId: string;
    text: string;
    /** ISO wall-clock anchor used only for the live elapsed label. */
    startedAt?: string;
    /** A terminal marker emitted by Xora at the next semantic boundary. */
    completed?: boolean;
    /** Monotonic duration frozen by Electron when this thought completes. */
    elapsedMs?: number;
}

export interface ExportSessionResult {
    status: 'exported' | 'cancelled';
    /** Safe basename only; the renderer never receives the selected directory. */
    fileName?: string;
}

export interface AgentPlanEvent {
    kind: 'plan';
    sessionId: string;
    turnId?: string;
    title?: string;
    /** Renderer-owned terminal state derived from the authoritative turn result. */
    outcome?: 'completed' | 'cancelled' | 'failed';
    entries: Array<{ id: string; text: string; status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled' }>;
    /** Binds resumable Plan state to the Provider configuration that produced it. */
    providerRuntimeEpoch?: string;
}

export interface AgentGoalStateEvent {
    kind: 'goal-state';
    sessionId: string;
    turnId?: string;
    goalId: string;
    /** Present on Grok state transitions; omitted on Xora-only lifecycle projections. */
    objective?: string;
    status:
        | 'active'
        | 'user-paused'
        | 'back-off-paused'
        | 'no-progress-paused'
        | 'infra-paused'
        | 'blocked'
        | 'budget-limited'
        | 'complete'
        | 'cleared'
        | 'unknown';
    phase: 'idle' | 'planning' | 'executing' | 'unknown';
    agentTurnStatus: AgentTurnStatus;
    verificationStatus: AgentTaskVerificationStatus;
    tokenBudget?: number;
    tokensUsed: number;
    elapsedMs: number;
    workerRounds: number;
    verificationRounds: number;
    classifierRuns?: number;
    classifierMaxRuns?: number;
    classifierVerdict?: 'achieved' | 'not-achieved' | 'inconclusive' | 'unknown';
    planning: boolean;
    verifying: boolean;
    pauseMessage?: string;
    lastEvent?: string;
    /** Binds restored UI state to the credentials/configuration that produced it. */
    providerRuntimeEpoch?: string;
}

/** Persisted when the user approves a read-only Plan; it is not a chat bubble. */
export interface AgentTaskContractEvent {
    kind: 'task-contract';
    sessionId: string;
    turnId?: string;
    objective: string;
    planEntries: Array<{ id: string; text: string }>;
    acceptanceCriteria: string[];
    /** Bound by the first authoritative goal_updated after Plan handoff. */
    goalId?: string;
    approvedAt: string;
    lifecycle: 'approved' | 'goal-starting' | 'goal-active' | 'verified' | 'interrupted';
    updatedAt: string;
    providerRuntimeEpoch?: string;
}

/** A live Grok reverse request. It remains pending until the renderer responds. */
export interface AgentPlanApprovalRequestEvent {
    kind: 'plan-approval-request';
    sessionId: string;
    turnId?: string;
    requestId: string;
    toolCallId: string;
    planContent?: string;
    suggestedContract: AgentTaskContract;
    requestedAt: string;
}

export type SupervisionShadowReason = 'open-plan' | 'tool-failure' | 'missing-test-evidence';

/** Local-only, redacted eligibility counters. This event is never product telemetry. */
export interface SupervisionShadowEvent {
    kind: 'supervision-shadow';
    sessionId: string;
    turnId?: string;
    eligible: boolean;
    reasons: SupervisionShadowReason[];
    openPlanCount: number;
    failedToolCount: number;
    testEvidenceCount: number;
}

/** Stable, renderer-safe semantics derived from ACP tool metadata. */
export type AgentToolAction =
    | 'file-read'
    | 'file-create'
    | 'file-write'
    | 'file-delete'
    | 'file-move'
    | 'project-search'
    | 'web-search'
    | 'web-fetch'
    | 'terminal'
    | 'test'
    | 'browser'
    | 'plan'
    | 'subagent'
    | 'other';

export type AgentToolSource = 'builtin' | 'skill' | 'mcp' | 'plugin';

export interface AgentToolPresentation {
    action: AgentToolAction;
    source: AgentToolSource;
    /** Short, non-sensitive basename, domain, query, or operation label. */
    targetLabel?: string;
    /** Skill, MCP server, or plugin name. */
    sourceLabel?: string;
    /** MCP tool name or another concise provider-supplied operation name. */
    operationLabel?: string;
    readOnly?: boolean;
}

export interface AgentToolLocation {
    path: string;
    line?: number;
}

export interface ToolCallEvent {
    kind: 'tool-call';
    sessionId: string;
    turnId?: string;
    toolCallId: string;
    title: string;
    toolName: string;
    /** Canonical Grok/ACP semantic kind. Kept separate from the wire tool name. */
    toolKind?: string;
    /** Canonical provider namespace, for example `grok_build` or `mcp`. */
    toolNamespace?: string;
    /** Normalized by the Electron backend; raw ACP metadata never reaches the renderer. */
    presentation?: AgentToolPresentation;
    locations?: AgentToolLocation[];
    status: 'pending' | 'running' | 'completed' | 'failed' | 'rejected';
    /** Wall-clock anchor for renderer-only live elapsed updates. */
    startedAt?: string;
    /** Monotonic duration frozen by Electron when the operation terminates. */
    elapsedMs?: number;
    input?: unknown;
    output?: string;
}

export interface PermissionRequestEvent {
    kind: 'permission-request';
    sessionId: string;
    turnId?: string;
    requestId: string;
    toolCallId?: string;
    toolName?: string;
    presentation?: AgentToolPresentation;
    title: string;
    detail?: string;
    options: Array<'allow-once' | 'allow-always' | 'reject'>;
}

export interface DiffEvent {
    kind: 'diff';
    diffId: string;
    sessionId: string;
    turnId?: string;
    toolCallId?: string;
    path: string;
    /** Immutable content-addressed snapshot captured before the Agent edit. */
    oldPath?: string;
    /** Immutable content-addressed snapshot captured after the Agent edit. */
    newPath?: string;
    oldHash?: string;
    newHash?: string;
    diff: string;
}

export type AgentHostEvent =
    | { kind: 'snapshot'; snapshot: RuntimeSnapshot }
    | { kind: 'session'; session: SessionRecord }
    | AgentTextEvent
    | AgentThoughtEvent
    | AgentPlanEvent
    | AgentPlanApprovalRequestEvent
    | AgentGoalStateEvent
    | AgentTaskContractEvent
    | SupervisionShadowEvent
    | ToolCallEvent
    | PermissionRequestEvent
    | DiffEvent
    | { kind: 'context-usage'; sessionId: string; turnId?: string; context: AgentSessionContext }
    | {
        kind: 'turn-completed';
        sessionId: string;
        turnId?: string;
        stopReason?: string;
        /** Monotonic ACP prompt duration measured by Electron main. */
        elapsedMs?: number;
    }
    | { kind: 'error'; sessionId?: string; turnId?: string; code: string; message: string; recoverable: boolean };

export interface ManagementResult {
    ok: boolean;
    data?: unknown;
    error?: string;
}

export interface ComponentUpdateStatus {
    enabled: boolean;
    configured: boolean;
    channel: 'stable' | 'beta' | 'nightly';
    manifestUrl?: string;
    message: string;
}

export interface ComponentUpdateResult {
    status: 'up-to-date' | 'installed';
    version: string;
    previousVersion?: string;
}

export interface ManagementRequest {
    area: 'skills' | 'mcp' | 'plugins' | 'marketplaces';
    action: 'refresh' | 'enable' | 'disable' | 'add' | 'remove' | 'doctor' | 'install' | 'update' | 'uninstall';
    name?: string;
    source?: string;
    scope?: 'user' | 'project';
    transport?: 'stdio' | 'http' | 'sse';
    args?: string[];
    /** Name expected by a stdio MCP server; HTTP/SSE names are derived in Electron main. */
    environmentName?: string;
    /** Transient renderer-to-main value. Never persisted in settings, logs or argv. */
    secretValue?: string;
    confirmedTrust?: boolean;
}

export interface AgentHostClient {
    onAgentEvent(event: AgentHostEvent): void;
}

export interface AgentHostService extends RpcServer<AgentHostClient> {
    getSnapshot(): Promise<RuntimeSnapshot>;
    setWorkspaceRoot(workspaceRoot: string | undefined): Promise<RuntimeSnapshot>;
    synchronizeWorkspaceTrust(request: SynchronizeWorkspaceTrustRequest): Promise<RuntimeSnapshot>;
    startRuntime(request: StartRuntimeRequest): Promise<RuntimeSnapshot>;
    stopRuntime(): Promise<void>;
    authenticate(methodId: string, sharedStateConfirmed?: boolean): Promise<AuthenticationResult>;
    createSession(request: CreateSessionRequest): Promise<SessionRecord>;
    loadSession(appSessionId: string): Promise<SessionRecord>;
    getSessionHistory(appSessionId: string): Promise<AgentHostEvent[]>;
    /** Exports one completed, redacted conversation through Electron's native save dialog. */
    exportSession(appSessionId: string): Promise<ExportSessionResult>;
    /** Renames a local session title without touching ACP history content. */
    renameSession(appSessionId: string, title: string): Promise<SessionRecord>;
    /** Deletes a local session index entry and its redacted history files. */
    deleteSession(appSessionId: string): Promise<void>;
    sendPrompt(request: PromptRequest): Promise<void>;
    /** Responds to Grok's in-flight Plan approval reverse request. */
    respondPlanApproval(decision: PlanApprovalDecision): Promise<void>;
    /** Guides a running turn without cancelling it. */
    guidePrompt(request: GuidePromptRequest): Promise<GuidePromptResult>;
    cancel(sessionId: string): Promise<void>;
    /** Persists one permission mode for all projects, sessions and windows. */
    setPermissionMode(mode: AgentPermissionMode): Promise<RuntimeSnapshot>;
    respondPermission(decision: PermissionDecision): Promise<void>;
    selectModel(sessionId: string, modelId: string): Promise<void>;
    /** Changes the next-turn ACP mode for one hydrated session. */
    setSessionMode(appSessionId: string, modeId: string): Promise<SessionRecord>;
    /** Sets the user-level default for new sessions across projects and windows. */
    selectDefaultModel(providerId: string, modelId: string): Promise<RuntimeSnapshot>;
    revertDiff(diffId: string): Promise<void>;
    listProviders(): Promise<ProviderProfile[]>;
    selectProvider(providerId: string): Promise<RuntimeSnapshot>;
    fetchProviderModels(providerId: string): Promise<AgentModelOption[]>;
    /**
     * Probe an unsaved endpoint (add-provider form) without writing providers.json.
     * The API key is transient and must never be logged or persisted by this call.
     */
    probeProviderModels(request: {
        protocol: ProviderProtocol;
        baseUrl: string;
        apiKey: string;
    }): Promise<AgentModelOption[]>;
    saveProvider(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile>;
    clearProviderCredential(providerId: string): Promise<void>;
    deleteProvider(providerId: string): Promise<void>;
    loginGrokSubscription(): Promise<ManagementResult>;
    logoutGrokSubscription(): Promise<ManagementResult>;
    getSidecarUpdateStatus(): Promise<ComponentUpdateStatus>;
    applySidecarUpdate(): Promise<ComponentUpdateResult>;
    rollbackSidecarUpdate(): Promise<ComponentUpdateResult>;
    inspect(): Promise<ManagementResult>;
    runManagementCommand(command: 'mcp-list' | 'mcp-doctor' | 'plugin-list' | 'plugin-marketplaces'): Promise<ManagementResult>;
    manage(request: ManagementRequest): Promise<ManagementResult>;
    setClient(client: AgentHostClient | undefined): void;
}
