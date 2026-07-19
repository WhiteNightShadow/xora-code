import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const AGENT_HOST_PATH = '/services/whitenight-agent';
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

export type ProviderProtocol =
    | 'openai-responses'
    | 'openai-chat-completions'
    | 'anthropic-messages';

interface ProviderProfileBase {
    id: string;
    name: string;
    managed?: boolean;
    baseUrl?: string;
    model?: string;
    contextWindow?: number;
    secretRef?: string;
}

export type ProviderProfile = ProviderProfileBase & ({
    kind: 'grok-subscription';
    protocol?: never;
} | {
    kind: 'xai-api-key';
    protocol?: never;
    secretRef: string;
} | {
    kind: 'custom';
    protocol: ProviderProtocol;
});

export interface AgentCapabilities {
    protocolVersion: number;
    loadSession: boolean;
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

export interface SessionRecord {
    appSessionId: string;
    acpSessionId?: string;
    title: string;
    workspaceRoot: string;
    providerId: string;
    model?: string;
    sidecarVersion?: string;
    createdAt: string;
    updatedAt: string;
    status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed' | 'read-only';
}

export interface RuntimeSnapshot {
    phase: RuntimePhase;
    workspaceRoot?: string;
    workspaceTrusted: boolean;
    providerId: string;
    sidecarVersion?: string;
    capabilities?: AgentCapabilities;
    models: AgentModelOption[];
    selectedModel?: string;
    sessions: SessionRecord[];
    activeSessionId?: string;
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
}

export interface PromptRequest {
    sessionId: string;
    text: string;
}

export interface PermissionDecision {
    requestId: string;
    outcome: 'allow-once' | 'allow-always' | 'reject';
    expiresAt?: string;
}

export interface AgentTextEvent {
    kind: 'text-delta';
    sessionId: string;
    role: 'assistant' | 'user' | 'system';
    text: string;
}

export interface AgentPlanEvent {
    kind: 'plan';
    sessionId: string;
    title?: string;
    entries: Array<{ id: string; text: string; status: 'pending' | 'in-progress' | 'completed' | 'failed' }>;
}

export interface ToolCallEvent {
    kind: 'tool-call';
    sessionId: string;
    toolCallId: string;
    title: string;
    toolName: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'rejected';
    input?: unknown;
    output?: string;
}

export interface PermissionRequestEvent {
    kind: 'permission-request';
    sessionId: string;
    requestId: string;
    toolCallId?: string;
    title: string;
    detail?: string;
    options: Array<'allow-once' | 'allow-always' | 'reject'>;
}

export interface DiffEvent {
    kind: 'diff';
    diffId: string;
    sessionId: string;
    path: string;
    oldPath?: string;
    oldHash?: string;
    newHash?: string;
    diff: string;
}

export type AgentHostEvent =
    | { kind: 'snapshot'; snapshot: RuntimeSnapshot }
    | { kind: 'session'; session: SessionRecord }
    | AgentTextEvent
    | AgentPlanEvent
    | ToolCallEvent
    | PermissionRequestEvent
    | DiffEvent
    | { kind: 'turn-completed'; sessionId: string; stopReason?: string }
    | { kind: 'error'; sessionId?: string; code: string; message: string; recoverable: boolean };

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
    authenticate(methodId: string): Promise<void>;
    createSession(request: CreateSessionRequest): Promise<SessionRecord>;
    loadSession(appSessionId: string): Promise<SessionRecord>;
    getSessionHistory(appSessionId: string): Promise<AgentHostEvent[]>;
    sendPrompt(request: PromptRequest): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    respondPermission(decision: PermissionDecision): Promise<void>;
    selectModel(sessionId: string, modelId: string): Promise<void>;
    revertDiff(diffId: string): Promise<void>;
    listProviders(): Promise<ProviderProfile[]>;
    selectProvider(providerId: string): Promise<RuntimeSnapshot>;
    fetchProviderModels(providerId: string): Promise<AgentModelOption[]>;
    saveProvider(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile>;
    deleteProvider(providerId: string): Promise<void>;
    getSidecarUpdateStatus(): Promise<ComponentUpdateStatus>;
    applySidecarUpdate(): Promise<ComponentUpdateResult>;
    rollbackSidecarUpdate(): Promise<ComponentUpdateResult>;
    inspect(): Promise<ManagementResult>;
    runManagementCommand(command: 'mcp-list' | 'mcp-doctor' | 'plugin-list' | 'plugin-marketplaces'): Promise<ManagementResult>;
    manage(request: ManagementRequest): Promise<ManagementResult>;
    setClient(client: AgentHostClient | undefined): void;
}
