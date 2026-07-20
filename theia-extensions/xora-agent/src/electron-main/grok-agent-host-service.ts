import { AcpCancelledError, AcpClient, createNodeWritableSink, RequestHandle } from '@xora-code/acp-client';
import { app, dialog } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    AgentCapabilities,
    AgentPermissionMode,
    AuthenticationResult,
    AgentHostClient,
    AgentHostEvent,
    AgentHostService,
    AgentSessionContext,
    AgentTextEvent,
    AgentToolAction,
    AgentToolLocation,
    AgentToolPresentation,
    AgentModelOption,
    CreateSessionRequest,
    ComponentUpdateResult,
    ComponentUpdateStatus,
    ManagementRequest,
    ManagementResult,
    PermissionDecision,
    PermissionRequestEvent,
    PromptRequest,
    ProviderProfile,
    RuntimeSnapshot,
    SessionRecord,
    StartRuntimeRequest,
    SynchronizeWorkspaceTrustRequest,
    ToolCallEvent
} from '../common/agent-protocol';
import { ProviderRegistry, XAI_MANAGED_MODEL_ID } from './provider-registry';
import { validatePromptImageAttachments } from './prompt-image-attachments';
import { providerModelsEndpoint, requestProviderJson } from './provider-network';
import { mergeMcpManagementResults } from './mcp-management';
import { AgentSessionRepository, deepRedact } from './session-repository';
import { GrokSidecarSupervisor } from './sidecar-supervisor';
import { SidecarUpdateCoordinator } from './sidecar-update-coordinator';
import { PermissionSubject, WorkspaceSecurityStore } from './workspace-security';
import {
    contextTotalTokens,
    parseAcpSessionContextEnvelope,
    parseAutoCompaction,
    parsePromptContextFallback,
    parseXaiSessionContextEnvelope
} from './context-telemetry';

interface PendingPermission {
    appSessionId: string;
    subject: PermissionSubject;
    options: Array<{ optionId: string; kind?: string; name?: string }>;
    resolve: (value: unknown) => void;
}

interface ModelState {
    currentModelId?: string;
    availableModels?: Array<Record<string, unknown>>;
}

interface RevertableDiff {
    targetPath: string;
    beforePath: string;
    expectedNewHash: string;
}

interface PendingAssistantTextDelta {
    event: AgentTextEvent;
    persist: boolean;
    timer: NodeJS.Timeout;
}

interface InitializeResponse {
    protocolVersion?: number;
    agentCapabilities?: Record<string, unknown>;
    authMethods?: Array<Record<string, unknown>>;
    agentInfo?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    models?: unknown;
}

interface GrokCommandOptions {
    cwd?: string;
    injectedEnvironment?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Authentication commands must not return browser URLs, codes or tokens to the renderer. */
    exposeOutput?: boolean;
    failureMessage?: string;
    /** Only audited read-only commands may run beside the ACP sidecar. */
    allowWhileRuntime?: boolean;
}

const MAX_EMITTED_DIFF_KEYS = 2048;
// A fixed window bounds first-token latency while collapsing the tiny ACP
// chunks that otherwise cause one Electron IPC, JSONL append, React render and
// Markdown parse per token. Do not debounce this timer: a continuous stream
// must still reach the renderer at a steady cadence.
const ASSISTANT_TEXT_BATCH_INTERVAL_MS = 28;
// Keep the desktop handshake aligned with the release smoke contract. Grok
// may refresh its remote model catalogue during a cold start, so 30 seconds
// was too aggressive under ordinary network variance.
const ACP_INITIALIZE_TIMEOUT_MS = 45_000;

/** One instance is created for each Electron renderer connection/window. */
export class GrokAgentHostService implements AgentHostService {
    protected client: AgentHostClient | undefined;
    protected readonly supervisor = new GrokSidecarSupervisor();
    protected readonly sessions = new AgentSessionRepository();
    protected readonly pendingPermissions = new Map<string, PendingPermission>();
    protected readonly activePrompts = new Map<string, RequestHandle<Record<string, unknown>>>();
    protected readonly revertableDiffs = new Map<string, RevertableDiff>();
    /** Bounded per-window guard for repeated running/completed ACP diff updates. */
    protected readonly emittedDiffKeys = new Set<string>();
    protected readonly knownSessionIds = new Set<string>();
    protected readonly acpSessionLookup = new Map<string, string>();
    /** Sessions already hydrated inside the current sidecar process. */
    protected readonly loadedSessionIds = new Set<string>();
    /** Assistant-only stream batches waiting to cross renderer IPC and JSONL. */
    protected readonly pendingAssistantTextDeltas = new Map<string, PendingAssistantTextDelta>();
    /** Sessions whose current turn already delivered its latency-critical first assistant chunk. */
    protected assistantStreamsStarted = new Set<string>();
    /** Nested/concurrent restores are counted so replay stays suppressed until all finish. */
    protected readonly restoringSessionCounts = new Map<string, number>();
    /** Latest Grok-owned context state, isolated by Xora app session id. */
    protected sessionContexts = new Map<string, AgentSessionContext>();
    /** Drops stale extension delivery without trusting opaque event ids. */
    protected contextEventHighwaters = new Map<string, number>();
    protected acp: AcpClient | undefined;
    protected consumeTask: Promise<void> | undefined;
    protected managementChild: ChildProcess | undefined;
    protected workspaceRoot: string | undefined;
    protected providerId = 'grok-subscription';
    protected grokSubscriptionAuthStatus: RuntimeSnapshot['grokSubscriptionAuthStatus'] = 'unknown';
    protected activeSessionId: string | undefined;
    protected phase: RuntimeSnapshot['phase'] = 'stopped';
    protected capabilities: AgentCapabilities | undefined;
    protected models: AgentModelOption[] = [];
    protected selectedModel: string | undefined;
    protected sidecarVersion: string | undefined;
    protected supportsAdditionalDirectories = false;
    protected intentionalStop = false;
    protected runtimeGeneration = 0;
    /** The most recent user activation intent wins, regardless of response order. */
    protected sessionLoadGeneration = 0;
    protected currentSecrets: string[] = [];
    /** Last explicit MCP health check, isolated to its canonical workspace. */
    protected mcpDoctorSnapshot: { workspaceRoot: string; result: ManagementResult } | undefined;
    /** Persistent trust alone never enables a newly connected window. */
    protected readonly theiaTrustedRoots = new Set<string>();
    /** Canonical roots currently attached to this Theia window, independent of trust. */
    protected readonly attachedWorkspaceRoots = new Set<string>();
    protected lifecycleTail: Promise<void> = Promise.resolve();
    protected disposed = false;

    constructor(
        protected readonly providers: ProviderRegistry,
        protected readonly security: WorkspaceSecurityStore,
        protected readonly onAuthenticationChanged: () => void,
        protected readonly onProviderDefaultsChanged: () => void,
        protected readonly onPermissionModeChanged: () => void,
        protected readonly onSubscriptionAuthStatusChanged: (status: 'authenticated' | 'unauthenticated') => void,
        protected readonly updates: SidecarUpdateCoordinator,
        protected readonly canApplyUpdate: () => boolean
    ) {
        this.providerId = this.providers.selectedProviderId();
        this.selectedModel = this.defaultModelId(this.providerId);
        this.grokSubscriptionAuthStatus = this.providers.subscriptionAuthStatus();
        for (const session of this.sessions.list()) {
            this.knownSessionIds.add(session.appSessionId);
            if (session.acpSessionId) this.acpSessionLookup.set(session.acpSessionId, session.appSessionId);
        }
    }

    setClient(client: AgentHostClient | undefined): void {
        // Deliver and persist any final stream fragment before disconnecting or
        // replacing the renderer that owns this per-window service.
        if (this.client && this.client !== client) {
            this.flushAssistantTextDeltas();
        }
        this.client = client;
        if (client) {
            this.emitSnapshot();
        }
    }

    get runtimeActive(): boolean {
        return this.supervisor.running || !!this.acp || (!!this.managementChild && this.managementChild.exitCode === null);
    }

    async getSnapshot(): Promise<RuntimeSnapshot> {
        return this.snapshot();
    }

    async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<RuntimeSnapshot> {
        const canonical = workspaceRoot ? this.security.canonicalRoot(workspaceRoot) : undefined;
        const workspaceChanged = this.workspaceRoot !== canonical;
        if (workspaceChanged) {
            this.flushAssistantTextDeltas();
            ++this.sessionLoadGeneration;
            this.mcpDoctorSnapshot = undefined;
            // Selecting a root is deliberately not a trust assertion. The
            // browser must follow with Theia's resolved workspace decision.
            this.theiaTrustedRoots.clear();
            this.attachedWorkspaceRoots.clear();
            if (this.runtimeActive) {
                // A root switch invalidates cwd, Trust and injected MCP
                // credentials. Close promptly instead of holding the new
                // project behind the normal application-shutdown grace time.
                ++this.sessionLoadGeneration;
                await this.withLifecycle(() => this.stopRuntimeLocked(500));
            }
        }
        this.workspaceRoot = canonical;
        const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
        if (!active || active.workspaceRoot !== canonical) {
            this.activeSessionId = undefined;
        }
        if (workspaceChanged) {
            // Provider credentials and the preferred model are user-level.
            // A new project adopts those defaults, while trust, MCP secrets
            // and sessions remain isolated by their canonical workspace root.
            this.providerId = this.providers.selectedProviderId();
            this.selectedModel = this.defaultModelId(this.providerId);
            this.grokSubscriptionAuthStatus = this.providers.subscriptionAuthStatus();
        }
        this.emitSnapshot();
        return this.snapshot();
    }

    async synchronizeWorkspaceTrust(request: SynchronizeWorkspaceTrustRequest): Promise<RuntimeSnapshot> {
        if (request.workspaceRoots.length > 256) {
            throw new Error('Workspace trust synchronization contains too many roots.');
        }
        const canonicalRoots = [...new Set(request.workspaceRoots.map(root => this.security.canonicalRoot(root)))];
        if ((!this.workspaceRoot && canonicalRoots.length > 0)
            || (this.workspaceRoot && !canonicalRoots.includes(this.workspaceRoot))) {
            throw new Error('The selected Agent root must belong to the open Theia workspace.');
        }
        this.attachedWorkspaceRoots.clear();
        for (const root of canonicalRoots) this.attachedWorkspaceRoots.add(root);

        if (request.trusted) {
            this.security.synchronizeTrust(canonicalRoots, true);
            this.theiaTrustedRoots.clear();
            for (const root of canonicalRoots) this.theiaTrustedRoots.add(root);
            this.emitSnapshot();
            return this.snapshot();
        }

        // Revoke the in-memory grant before touching persistent state so every
        // new privileged call fails as soon as Theia publishes the change.
        // Runtime standby remains available: trust governs executable tools,
        // not whether the ACP transport may initialize and wait for input.
        this.theiaTrustedRoots.clear();
        for (const permission of this.pendingPermissions.values()) {
            permission.resolve({ outcome: { outcome: 'cancelled' } });
        }
        this.pendingPermissions.clear();
        let persistenceError: unknown;
        try {
            this.security.synchronizeTrust(canonicalRoots, false);
        } catch (error) {
            persistenceError = error;
        }
        this.emitSnapshot();
        if (persistenceError) throw persistenceError;
        return this.snapshot();
    }

    async startRuntime(request: StartRuntimeRequest): Promise<RuntimeSnapshot> {
        return this.withLifecycle(() => this.startRuntimeLocked(request));
    }

    protected async startRuntimeLocked(request: StartRuntimeRequest): Promise<RuntimeSnapshot> {
        if (this.disposed) throw new Error('This Agent host window has been disposed.');
        const root = this.security.canonicalRoot(request.workspaceRoot);
        if (root !== this.workspaceRoot) {
            throw new Error('Select this Agent root before starting its runtime.');
        }
        if (!this.attachedWorkspaceRoots.has(root)) {
            throw new Error('The selected Agent root is not attached to the current Theia workspace.');
        }
        const provider = this.providers.get(request.providerId);
        if (!provider) {
            throw new Error('The selected Provider no longer exists.');
        }
        if (this.acp && this.workspaceRoot === root && this.providerId === provider.id && this.phase === 'ready') {
            return this.snapshot();
        }
        if (this.acp || this.supervisor.running) {
            await this.stopRuntimeLocked();
        }

        const generation = ++this.runtimeGeneration;
        this.loadedSessionIds.clear();
        this.workspaceRoot = root;
        this.providerId = provider.id;
        this.selectedModel = this.defaultModelId(provider.id);
        this.phase = 'starting';
        this.intentionalStop = false;
        this.emitSnapshot();

        try {
            let projectMcpEnvironment: NodeJS.ProcessEnv = {};
            try {
                if (this.isWorkspaceTrusted(root)) {
                    projectMcpEnvironment = this.providers.mcpEnvironment(root);
                }
            } catch {
                // Trust-state failures are fail-closed for project MCP, but
                // they do not prevent the transport from waiting for input.
            }
            const environment = {
                ...projectMcpEnvironment,
                ...this.providers.environment(provider.id)
            };
            this.currentSecrets = [...new Set(Object.values(environment).filter((value): value is string => typeof value === 'string' && value.length > 0))];
            const launch = this.supervisor.launch(root, environment);
            this.sidecarVersion = launch.version;
            const acp = new AcpClient({
                write: createNodeWritableSink(launch.process.stdin),
                defaultTimeoutMs: 30_000,
                maxLineBytes: 8 * 1024 * 1024,
                maxPendingRequests: 128
            });
            this.acp = acp;
            this.bindAcp(acp);
            launch.process.once('error', error => this.runtimeFailed(error, generation));
            launch.process.once('exit', (code, signal) => {
                if (!this.intentionalStop) {
                    this.runtimeFailed(new Error(`Grok sidecar exited (${signal ?? code ?? 'unknown'}).`), generation);
                }
            });
            this.consumeTask = acp.consume(launch.process.stdout).catch(error => {
                if (!this.intentionalStop) {
                    this.runtimeFailed(error, generation);
                }
            });

            this.phase = 'initializing';
            this.emitSnapshot();
            const initialized = await acp.request<InitializeResponse>('initialize', {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false
                },
                clientInfo: { name: 'Xora Code', title: 'Xora Code', version: '0.1.0' },
                _meta: {
                    startupHints: {
                        nonInteractive: true,
                        skipGitStatus: true,
                        skipProjectLayout: true
                    },
                    clientType: 'xora-code-desktop',
                    clientVersion: '0.1.0'
                }
            }, { timeoutMs: ACP_INITIALIZE_TIMEOUT_MS });
            if (generation !== this.runtimeGeneration) {
                throw new AcpCancelledError('initialize', 'initialize', 'Runtime generation changed.');
            }
            this.acceptInitialize(initialized);

            // Grok Build 0.2.102 selects its resolved default auth method as
            // part of initialize. Re-authenticating here is redundant and, for
            // a global XAI_API_KEY, can also write shared ~/.grok state. Only
            // fall back to an explicit authenticate request when initialize
            // could not select a usable method.
            const initializedMethod = this.capabilities?.defaultAuthMethodId;
            const initializedMethodMatchesProvider = provider.kind === 'grok-subscription'
                ? initializedMethod !== 'xai.api_key'
                : provider.kind === 'xai-api-key' && !provider.model
                    ? initializedMethod === 'xai.api_key'
                    : true;
            if (initializedMethod && initializedMethodMatchesProvider
                && this.capabilities?.authMethods.some(item => item.id === initializedMethod)) {
                this.phase = 'ready';
                if (provider.kind === 'grok-subscription') {
                    this.publishSubscriptionAuthStatus('authenticated');
                }
                this.emitSnapshot();
                return this.snapshot();
            }
            const advertisedDefaultMethod = this.capabilities?.authMethods
                .find(item => item.id === this.capabilities?.defaultAuthMethodId)?.id;
            const desiredMethod = provider.kind === 'grok-subscription'
                ? advertisedDefaultMethod && advertisedDefaultMethod !== 'xai.api_key'
                    ? advertisedDefaultMethod
                    : 'grok.com'
                : 'xai.api_key';
            const method = this.capabilities?.authMethods.find(item => item.id === desiredMethod)?.id;
            if (method) {
                this.phase = 'auth-required';
                if (provider.kind === 'grok-subscription') {
                    this.publishSubscriptionAuthStatus('unauthenticated');
                    this.emitSnapshot('当前 Grok 订阅需要完成一次认证。');
                } else if (provider.kind === 'xai-api-key') {
                    this.emitSnapshot('当前 xAI API 服务需要完成一次认证。');
                } else {
                    this.emitSnapshot(`“${provider.name}”需要完成一次认证。`);
                }
            } else if ((this.capabilities?.authMethods.length ?? 0) > 0) {
                this.phase = 'auth-required';
                this.emitSnapshot('Choose one of the authentication methods advertised by Grok Build.');
            } else {
                this.phase = 'ready';
                if (provider.kind === 'grok-subscription') {
                    this.publishSubscriptionAuthStatus('authenticated');
                }
                this.emitSnapshot();
            }
            return this.snapshot();
        } catch (error) {
            if (generation !== this.runtimeGeneration) throw error;
            this.intentionalStop = true;
            this.acp?.close(error);
            this.acp = undefined;
            await this.supervisor.stop(0);
            await this.consumeTask?.catch(() => undefined);
            this.consumeTask = undefined;
            this.phase = 'crashed';
            this.emitError('RUNTIME_START_FAILED', error, true);
            this.emitSnapshot(this.redactError(error));
            this.currentSecrets = [];
            throw error;
        }
    }

    async stopRuntime(): Promise<void> {
        ++this.sessionLoadGeneration;
        return this.withLifecycle(() => this.stopRuntimeLocked());
    }

    protected async stopRuntimeLocked(graceMs = 3000): Promise<void> {
        this.flushAssistantTextDeltas();
        this.assistantStreamState().clear();
        ++this.runtimeGeneration;
        this.loadedSessionIds.clear();
        this.intentionalStop = true;
        this.phase = 'draining';
        this.emitSnapshot();
        for (const permission of this.pendingPermissions.values()) {
            permission.resolve({ outcome: { outcome: 'cancelled' } });
        }
        this.pendingPermissions.clear();
        for (const prompt of this.activePrompts.values()) {
            // RequestHandle.cancel rejects the local pending promise before it
            // attempts the best-effort ACP notification, so shutdown never
            // waits on a blocked sidecar stdin.
            void prompt.cancel('Runtime stopped').catch(() => undefined);
        }
        this.activePrompts.clear();
        this.acp?.close(new Error('Xora Code stopped the sidecar.'));
        this.acp = undefined;
        if (this.managementChild) {
            this.supervisor.terminateProcessTree(this.managementChild, true);
            this.managementChild = undefined;
        }
        await this.supervisor.stop(graceMs);
        await this.consumeTask?.catch(() => undefined);
        this.consumeTask = undefined;
        this.sessions.flushEvents();
        this.phase = 'stopped';
        this.capabilities = undefined;
        this.models = [];
        this.selectedModel = this.defaultModelId(this.providerId);
        this.sidecarVersion = undefined;
        this.currentSecrets = [];
        this.emitSnapshot();
    }

    async authenticate(methodId: string, sharedStateConfirmed = false): Promise<AuthenticationResult> {
        if (this.phase !== 'auth-required') {
            throw new Error('The current runtime is not waiting for authentication.');
        }
        const acp = this.requireAcp();
        if (!this.capabilities?.authMethods.some(method => method.id === methodId)) {
            throw new Error('The sidecar did not advertise this authentication method.');
        }
        const provider = this.providers.get(this.providerId);
        const compatible = provider?.kind === 'grok-subscription'
            ? methodId !== 'xai.api_key'
                && (methodId === 'grok.com' || methodId === this.capabilities.defaultAuthMethodId)
            : methodId === 'xai.api_key';
        if (!compatible) {
            throw new Error('The authentication method is incompatible with the selected Provider.');
        }
        const confirmationRequired = this.providers.authenticationConfirmationRequired(this.providerId);
        if (confirmationRequired && !sharedStateConfirmed) {
            return { status: 'confirmation-required' };
        }
        await acp.request('authenticate', { methodId }, { timeoutMs: 5 * 60_000 });
        if (confirmationRequired) {
            this.providers.rememberAuthenticationConfirmation(this.providerId);
        }
        this.phase = 'ready';
        if (provider?.kind === 'grok-subscription') {
            this.publishSubscriptionAuthStatus('authenticated');
        }
        this.emitSnapshot();
        return { status: 'authenticated' };
    }

    async createSession(request: CreateSessionRequest): Promise<SessionRecord> {
        // A new ACP session is an ordering boundary even if the previous turn's
        // final text arrived less than one batching window ago.
        this.flushAssistantTextDeltas();
        this.assistantStreamState().clear();
        const activationGeneration = ++this.sessionLoadGeneration;
        const acp = this.requireReady();
        const root = this.security.canonicalRoot(request.workspaceRoot);
        if (root !== this.workspaceRoot || request.providerId !== this.providerId) {
            throw new Error('Restart the runtime for the selected workspace and Provider first.');
        }
        const provider = this.providers.get(request.providerId);
        const requestedModel = request.model && (this.models.length === 0 || this.models.some(model => model.id === request.model))
            ? request.model
            : undefined;
        const runtimeSelectedModel = this.selectedModel
            && (this.models.length === 0 || this.models.some(model => model.id === this.selectedModel))
            ? this.selectedModel
            : undefined;
        const effectiveModel = provider?.kind === 'custom'
            ? provider.id
            : provider?.kind === 'xai-api-key' && provider.model
                ? XAI_MANAGED_MODEL_ID
                : requestedModel ?? runtimeSelectedModel;
        const meta: Record<string, unknown> = {};
        if (effectiveModel) meta.modelId = effectiveModel;
        const params: Record<string, unknown> = {
            cwd: root,
            mcpServers: [],
            ...(Object.keys(meta).length ? { _meta: meta } : {})
        };
        if (this.supportsAdditionalDirectories && request.additionalDirectories?.length) {
            const trustedAdditionalDirectories = request.additionalDirectories
                .map(directory => this.security.canonicalRoot(directory))
                .filter(directory => directory !== root && this.isWorkspaceTrusted(directory));
            if (trustedAdditionalDirectories.length) {
                meta.additionalDirectories = [...new Set(trustedAdditionalDirectories)];
                params._meta = meta;
            }
        }
        const result = await acp.request<Record<string, unknown>>('session/new', params, { timeoutMs: 30_000 });
        if (typeof result.sessionId !== 'string' || !result.sessionId) {
            throw new Error('Grok returned an invalid ACP session ID.');
        }
        if (activationGeneration === this.sessionLoadGeneration) {
            this.acceptModelState(modelStateFrom(result));
        }
        const record = this.sessions.create({
            acpSessionId: result.sessionId,
            title: request.title?.trim() || 'New Agent session',
            workspaceRoot: root,
            providerId: request.providerId,
            model: effectiveModel,
            sidecarVersion: this.sidecarVersion
        });
        this.knownSessionIds.add(record.appSessionId);
        this.acpSessionLookup.set(record.acpSessionId!, record.appSessionId);
        this.loadedSessionIds.add(record.appSessionId);
        if (activationGeneration === this.sessionLoadGeneration) {
            this.activeSessionId = record.appSessionId;
        }
        this.emit({ kind: 'session', session: record });
        if (activationGeneration === this.sessionLoadGeneration) {
            this.emitSnapshot();
        }
        return record;
    }

    async loadSession(appSessionId: string): Promise<SessionRecord> {
        this.flushAssistantTextDeltas();
        this.assistantStreamState().clear();
        const activationGeneration = ++this.sessionLoadGeneration;
        const record = this.sessions.get(appSessionId);
        if (!record?.acpSessionId) {
            throw new Error('This history has no recoverable ACP session.');
        }
        this.knownSessionIds.add(appSessionId);
        this.acpSessionLookup.set(record.acpSessionId, appSessionId);
        const matchingRuntime = (): boolean => !!this.acp
            && this.phase === 'ready'
            && this.workspaceRoot === record.workspaceRoot
            && this.providerId === record.providerId;
        if (matchingRuntime() && this.activeSessionId === appSessionId && this.loadedSessionIds.has(appSessionId)) {
            return record;
        }
        if (!this.acp || this.workspaceRoot !== record.workspaceRoot || this.providerId !== record.providerId) {
            await this.startRuntime({ workspaceRoot: record.workspaceRoot, providerId: record.providerId });
        }
        if (activationGeneration !== this.sessionLoadGeneration) {
            return this.sessions.get(appSessionId) ?? record;
        }
        let restoreRuntimeGeneration: number | undefined;
        try {
            if (this.phase === 'auth-required') {
                throw new Error('AUTHENTICATION_REQUIRED');
            }
            if (matchingRuntime() && this.loadedSessionIds.has(appSessionId)) {
                this.activeSessionId = appSessionId;
                if (record.model) this.selectedModel = record.model;
                this.emitSnapshot();
                return this.sessions.get(appSessionId) ?? record;
            }
            restoreRuntimeGeneration = this.runtimeGeneration;
            this.beginSessionRestore(appSessionId);
            try {
                const result = await this.requireReady().request<Record<string, unknown>>('session/load', {
                    sessionId: record.acpSessionId,
                    cwd: record.workspaceRoot,
                    mcpServers: [],
                    ...(record.model ? { _meta: { modelId: record.model } } : {})
                }, { timeoutMs: 60_000 });
                if (restoreRuntimeGeneration === this.runtimeGeneration) {
                    this.loadedSessionIds.add(appSessionId);
                }
                if (activationGeneration !== this.sessionLoadGeneration || restoreRuntimeGeneration !== this.runtimeGeneration) {
                    return this.sessions.get(appSessionId) ?? record;
                }
                this.acceptModelState(modelStateFrom(result));
                const loaded = this.sessions.update(appSessionId, { status: 'idle', sidecarVersion: this.sidecarVersion });
                this.activeSessionId = appSessionId;
                this.emit({ kind: 'session', session: loaded });
                this.emitSnapshot();
                return loaded;
            } finally {
                this.endSessionRestore(appSessionId);
            }
        } catch (error) {
            if (activationGeneration !== this.sessionLoadGeneration
                || (restoreRuntimeGeneration !== undefined && restoreRuntimeGeneration !== this.runtimeGeneration)) {
                return this.sessions.get(appSessionId) ?? record;
            }
            if (this.phase === 'auth-required' || this.redactError(error) === 'AUTHENTICATION_REQUIRED') {
                throw error;
            }
            const readOnly = this.sessions.update(appSessionId, { status: 'read-only' });
            this.emit({ kind: 'session', session: readOnly });
            this.emitError('SESSION_RESTORE_FAILED', new Error('The ACP session could not be restored. History remains read-only; start a new session.'), true, appSessionId);
            throw error;
        }
    }

    async getSessionHistory(appSessionId: string): Promise<AgentHostEvent[]> {
        if (!this.knownSessionIds.has(appSessionId) && !this.sessions.get(appSessionId)) {
            throw new Error('Unknown Xora Code session.');
        }
        this.knownSessionIds.add(appSessionId);
        this.flushAssistantTextDeltas(appSessionId);
        const history = deepRedact(this.sessions.readEvents(appSessionId), this.currentSecrets);
        for (const event of history) {
            if (event.kind === 'context-usage' && event.sessionId === appSessionId) {
                this.contextStates().set(appSessionId, event.context);
            }
        }
        return history;
    }

    async sendPrompt(request: PromptRequest): Promise<void> {
        const acp = this.requireReady();
        const record = this.sessions.get(request.sessionId);
        if (!record?.acpSessionId || record.status === 'read-only') {
            throw new Error('The selected session cannot accept prompts.');
        }
        if (record.workspaceRoot !== this.workspaceRoot || record.providerId !== this.providerId) {
            throw new Error('The active runtime does not match this session.');
        }
        if (this.activeSessionId !== request.sessionId) {
            throw new Error('The selected conversation is no longer the active Agent session.');
        }
        if (!this.loadedSessionIds.has(request.sessionId)) {
            throw new Error('Restore the selected conversation before sending another task.');
        }
        if (this.activePrompts.has(request.sessionId)) {
            throw new Error('This session already has a running task.');
        }
        if (typeof request.text !== 'string') throw new Error('Prompt text must be a string.');
        if (request.attachments !== undefined && !Array.isArray(request.attachments)) {
            throw new Error('Image attachments must be an array.');
        }
        if (request.attachments?.length && this.capabilities?.prompt.image !== true) {
            // ACP capabilities are affirmative: missing, stale or false means
            // images must not cross the sidecar boundary.
            throw new Error('The active Agent does not support image prompts.');
        }
        const images = validatePromptImageAttachments(request.attachments);
        if (!request.text.length && !images.blocks.length) throw new Error('A prompt cannot be empty.');
        // Reset before the user event so this turn's first assistant fragment
        // crosses Electron IPC and JSONL immediately. Later fragments retain
        // the fixed batching window that prevents renderer churn.
        this.flushAssistantTextDeltas(request.sessionId);
        this.assistantStreamState().delete(request.sessionId);
        this.emit({
            kind: 'text-delta',
            sessionId: request.sessionId,
            role: 'user',
            text: request.text,
            ...(images.summaries.length ? { attachments: images.summaries } : {})
        });
        const running = this.sessions.update(request.sessionId, { status: 'running' });
        this.emit({ kind: 'session', session: running });
        try {
            const prompt = [
                ...(request.text.length ? [{ type: 'text' as const, text: request.text }] : []),
                ...images.blocks
            ];
            const handle = acp.startRequest<Record<string, unknown>>('session/prompt', {
                sessionId: record.acpSessionId,
                prompt
            }, {
                timeoutMs: 0,
                cancellation: { method: 'session/cancel', params: { sessionId: record.acpSessionId } }
            });
            this.activePrompts.set(request.sessionId, handle);
            const result = await handle.promise;
            this.acceptPromptContextFallback(request.sessionId, record.acpSessionId, result);
            const stopReason = typeof result.stopReason === 'string' ? result.stopReason : undefined;
            const status = stopReason === 'cancelled' ? 'cancelled' : 'completed';
            const finished = this.sessions.update(request.sessionId, { status });
            this.emit({ kind: 'session', session: finished });
            this.emit({ kind: 'turn-completed', sessionId: request.sessionId, stopReason });
        } catch (error) {
            if ((error instanceof AcpCancelledError || asRecord(error)?.kind === 'cancelled') && this.phase !== 'crashed') {
                const cancelled = this.sessions.update(request.sessionId, { status: 'cancelled' });
                this.emit({ kind: 'session', session: cancelled });
                this.emit({ kind: 'turn-completed', sessionId: request.sessionId, stopReason: 'cancelled' });
                return;
            }
            const failed = this.sessions.update(request.sessionId, { status: 'failed' });
            this.emit({ kind: 'session', session: failed });
            this.emitError('PROMPT_FAILED', error, true, request.sessionId);
            throw error;
        } finally {
            this.flushAssistantTextDeltas(request.sessionId);
            this.assistantStreamState().delete(request.sessionId);
            this.activePrompts.delete(request.sessionId);
            this.sessions.flushEvents(request.sessionId);
        }
    }

    async cancel(appSessionId: string): Promise<void> {
        const record = this.sessions.get(appSessionId);
        if (!record?.acpSessionId) {
            return;
        }
        for (const [requestId, permission] of this.pendingPermissions) {
            if (permission.appSessionId === appSessionId) {
                permission.resolve({ outcome: { outcome: 'cancelled' } });
                this.pendingPermissions.delete(requestId);
            }
        }
        const handle = this.activePrompts.get(appSessionId);
        if (handle) {
            void handle.cancel('Cancelled by user.').catch(() => undefined);
            return;
        }
        if (this.acp && record.status === 'running') {
            await this.acp.notify('session/cancel', { sessionId: record.acpSessionId });
        }
        if (record.status === 'running') {
            const cancelled = this.sessions.update(appSessionId, { status: 'cancelled' });
            this.emit({ kind: 'session', session: cancelled });
        }
    }

    async setPermissionMode(mode: AgentPermissionMode): Promise<RuntimeSnapshot> {
        // The renderer requests a user preference only. Electron main owns the
        // durable value and remains the sole authority that can auto-resolve an
        // ACP permission request after checking trust, session and path bounds.
        this.security.setAgentPermissionMode(mode);
        this.onPermissionModeChanged();
        this.emitSnapshot();
        return this.snapshot();
    }

    async respondPermission(decision: PermissionDecision): Promise<void> {
        const pending = this.pendingPermissions.get(decision.requestId);
        if (!pending) {
            throw new Error('This permission request is no longer active.');
        }
        if (!['allow-once', 'allow-always', 'reject'].includes(decision.outcome)) {
            this.pendingPermissions.delete(decision.requestId);
            pending.resolve({ outcome: { outcome: 'cancelled' } });
            throw new Error('Invalid permission decision.');
        }
        const requestedKind = decision.outcome === 'allow-once'
            ? 'allow_once'
            : decision.outcome === 'allow-always' ? 'allow_once' : 'reject_once';
        const option = pending.options.find(candidate => normalizeOptionKind(candidate) === requestedKind)
            ?? (decision.outcome === 'reject' ? undefined : pending.options.find(candidate => normalizeOptionKind(candidate) === 'allow_once'));
        if (decision.outcome === 'allow-always') {
            if (!option || normalizeOptionKind(option) !== 'allow_once') {
                throw new Error('Xora Code requires a sidecar allow-once option to enforce desktop policy.');
            }
            if (!pending.subject.path && !pending.subject.command && !pending.subject.mcpServer) {
                throw new Error('A broad tool-only permission cannot be persisted. Use Allow once.');
            }
            this.security.rememberPermission(this.workspaceRoot!, this.sidecarVersion!, pending.subject, decision.expiresAt);
        }
        this.pendingPermissions.delete(decision.requestId);
        if (!option) {
            pending.resolve({ outcome: { outcome: 'cancelled' } });
        } else {
            pending.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
        }
    }

    async selectModel(appSessionId: string, modelId: string): Promise<void> {
        const record = this.sessions.get(appSessionId);
        if (!record?.acpSessionId) {
            throw new Error('Select a live session before choosing a model.');
        }
        if (!this.models.some(model => model.id === modelId)) {
            throw new Error('The selected model is not advertised by the ACP runtime.');
        }
        await this.requireReady().request('session/set_model', {
            sessionId: record.acpSessionId,
            modelId
        });
        this.selectedModel = modelId;
        const updated = this.sessions.update(appSessionId, { model: modelId });
        try {
            this.providers.selectPreferredModel(this.providerId, modelId);
            this.onProviderDefaultsChanged();
        } catch { /* the live session selection succeeded; retry persistence on the next choice */ }
        this.emit({ kind: 'session', session: updated });
        this.emitSnapshot();
    }

    async selectDefaultModel(providerId: string, modelId: string): Promise<RuntimeSnapshot> {
        if (providerId !== this.providerId) {
            throw new Error('请先切换到对应的模型服务。');
        }
        if (this.activePrompts.size > 0) {
            throw new Error('请等待当前任务结束后再修改默认模型。');
        }
        if (this.models.length > 0 && !this.models.some(model => model.id === modelId)) {
            throw new Error('所选模型不在当前运行时提供的模型列表中。');
        }
        this.providers.selectPreferredModel(providerId, modelId);
        if (!this.activeSessionId) this.selectedModel = modelId;
        this.onProviderDefaultsChanged();
        this.emitSnapshot();
        return this.snapshot();
    }

    async revertDiff(diffId: string): Promise<void> {
        const candidate = this.revertableDiffs.get(diffId);
        if (!candidate || !this.workspaceRoot) {
            throw new Error('This Agent change is no longer available for safe revert.');
        }
        const target = this.safeWorkspaceFile(candidate.targetPath);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('The changed path is not a regular workspace file.');
        }
        const current = fs.readFileSync(target);
        const currentHash = crypto.createHash('sha256').update(current).digest('hex');
        if (currentHash !== candidate.expectedNewHash) {
            throw new Error('The file changed after the Agent edit. A conflict Diff was opened; nothing was overwritten.');
        }
        const before = fs.readFileSync(candidate.beforePath);
        const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.xora-revert`;
        const descriptor = fs.openSync(temporary, 'wx', stat.mode & 0o777);
        try {
            fs.writeFileSync(descriptor, before);
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, target);
        this.revertableDiffs.delete(diffId);
    }

    async listProviders(): Promise<ProviderProfile[]> {
        return this.providers.list();
    }

    async selectProvider(providerId: string): Promise<RuntimeSnapshot> {
        return this.withLifecycle(async () => {
            if (!this.providers.get(providerId)) {
                throw new Error('Unknown Provider profile.');
            }
            // Check after entering the lifecycle queue. A turn may have begun
            // while this switch was waiting behind runtime initialization.
            if (this.activePrompts.size > 0) {
                throw new Error('Cancel or finish the current task before switching credentials.');
            }
            ++this.sessionLoadGeneration;
            if (this.runtimeActive || this.phase !== 'stopped') {
                await this.stopRuntimeLocked();
            }
            this.providers.selectProvider(providerId);
            this.providerId = providerId;
            this.activeSessionId = undefined;
            this.models = [];
            this.selectedModel = this.defaultModelId(providerId);
            this.onProviderDefaultsChanged();
            this.emitSnapshot();
            return this.snapshot();
        });
    }

    async fetchProviderModels(providerId: string): Promise<AgentModelOption[]> {
        const provider = this.providers.get(providerId);
        if (!provider || provider.kind === 'grok-subscription' || !provider.baseUrl) {
            throw new Error('此模型服务没有可查询的 API 地址。');
        }
        const endpoint = providerModelsEndpoint(provider.baseUrl);
        const credential = this.providers.credential(providerId);
        if (!credential) {
            throw new Error('This Provider has no available credential.');
        }
        const headers: Record<string, string> = { accept: 'application/json' };
        if (provider.protocol === 'anthropic-messages') {
            headers['x-api-key'] = credential;
            headers['anthropic-version'] = '2023-06-01';
        } else {
            headers.authorization = `Bearer ${credential}`;
        }
        const payload = await requestProviderJson(endpoint, headers);
        const record = asRecord(payload);
        const candidates = Array.isArray(record?.data)
            ? record!.data
            : Array.isArray(record?.models) ? record!.models : [];
        return candidates.flatMap(candidate => {
            const model = asRecord(candidate);
            const id = asString(model?.id) ?? asString(model?.modelId);
            if (!id) return [];
            return [{
                id,
                name: asString(model?.display_name) ?? asString(model?.name) ?? id,
                contextWindow: asNumber(model?.context_window) ?? asNumber(model?.contextWindow)
            }];
        }).sort((left, right) => left.name.localeCompare(right.name));
    }

    async saveProvider(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile> {
        return this.withLifecycle(async () => {
            const previous = this.providers.get(profile.id);
            const runtimeConfigurationChanged = !!previous
                && (previous.protocol !== profile.protocol
                    || previous.baseUrl !== profile.baseUrl
                    || previous.model !== profile.model
                    || previous.contextWindow !== profile.contextWindow);
            const invalidatesExistingRuntime = !!previous && (apiKey !== undefined || runtimeConfigurationChanged);
            if (invalidatesExistingRuntime && profile.id === this.providerId && (this.runtimeActive || this.phase !== 'stopped')) {
                await this.stopRuntimeLocked();
            }
            const saved = this.providers.save(profile, apiKey);
            if (profile.id === this.providerId && !this.activeSessionId) {
                this.selectedModel = this.defaultModelId(profile.id);
            }
            this.onProviderDefaultsChanged();
            if (invalidatesExistingRuntime) this.onAuthenticationChanged();
            return saved;
        });
    }

    async clearProviderCredential(providerId: string): Promise<void> {
        return this.withLifecycle(async () => {
            if (providerId === this.providerId && (this.runtimeActive || this.phase !== 'stopped')) {
                await this.stopRuntimeLocked();
            }
            this.providers.clearCredential(providerId);
            this.onAuthenticationChanged();
            this.emitSnapshot('Provider credential cleared. Enter a new API key before starting this Provider again.');
        });
    }

    async deleteProvider(providerId: string): Promise<void> {
        if (providerId === this.providerId && this.supervisor.running) {
            throw new Error('Stop the current runtime before deleting its Provider.');
        }
        this.providers.delete(providerId);
        if (providerId === this.providerId) {
            this.providerId = this.providers.selectedProviderId();
            this.activeSessionId = undefined;
            this.models = [];
            this.selectedModel = this.defaultModelId(this.providerId);
            this.onProviderDefaultsChanged();
            this.emitSnapshot('当前模型服务已被删除，已切换回 Grok 订阅。');
        }
    }

    async loginGrokSubscription(): Promise<ManagementResult> {
        return this.withLifecycle(async () => {
            const confirmation = await dialog.showMessageBox({
                type: 'info',
                title: '登录 Grok 订阅',
                message: '是否使用浏览器登录 Grok 订阅？',
                detail: 'Grok Build 将更新共享的 ~/.grok 登录状态，这会影响外部 Grok CLI 和其他 Xora Code 窗口。Xora Code 不会读取 OAuth token、Cookie 或认证文件。',
                buttons: ['继续登录', '取消'],
                defaultId: 0,
                cancelId: 1,
                noLink: true
            });
            if (confirmation.response !== 0) {
                return { ok: false, error: '已取消 Grok 订阅登录。' };
            }
            if (this.runtimeActive || this.phase !== 'stopped') {
                await this.stopRuntimeLocked();
            }
            try {
                const result = await this.runCli(['login', '--oauth'], false, {
                    cwd: this.authenticationWorkingDirectory(),
                    injectedEnvironment: {},
                    timeoutMs: 5 * 60_000,
                    exposeOutput: false,
                    failureMessage: 'Grok 登录未完成，请重试或检查浏览器中的登录流程。'
                });
                if (result.ok) {
                    this.providers.selectProvider('grok-subscription');
                    this.providers.rememberAuthenticationConfirmation('grok-subscription');
                    this.providerId = 'grok-subscription';
                    this.activeSessionId = undefined;
                    this.models = [];
                    this.selectedModel = this.defaultModelId(this.providerId);
                    this.publishSubscriptionAuthStatus('authenticated');
                    this.onProviderDefaultsChanged();
                    this.onAuthenticationChanged();
                    this.emitSnapshot('Grok 订阅登录完成。');
                }
                return result;
            } catch (error) {
                return { ok: false, error: this.redactError(error) };
            }
        });
    }

    async logoutGrokSubscription(): Promise<ManagementResult> {
        return this.withLifecycle(async () => {
            const confirmation = await dialog.showMessageBox({
                type: 'warning',
                title: '退出 Grok 订阅',
                message: '是否退出共享的 Grok 订阅登录？',
                detail: '这会清除 ~/.grok 中由 Grok Build 管理的缓存凭据，并影响外部 Grok CLI 和其他 Xora Code 窗口。Xora Code 不会直接读取或删除认证文件。',
                buttons: ['退出登录', '取消'],
                defaultId: 1,
                cancelId: 1,
                noLink: true
            });
            if (confirmation.response !== 0) {
                return { ok: false, error: '已取消退出登录。' };
            }
            if (this.runtimeActive || this.phase !== 'stopped') {
                await this.stopRuntimeLocked();
            }
            try {
                const result = await this.runCli(['logout'], false, {
                    cwd: this.authenticationWorkingDirectory(),
                    injectedEnvironment: {},
                    timeoutMs: 30_000,
                    exposeOutput: false,
                    failureMessage: 'Grok 退出登录失败，请稍后重试。'
                });
                if (result.ok) {
                    this.providers.clearAuthenticationConfirmation('grok-subscription');
                    this.publishSubscriptionAuthStatus('unauthenticated');
                    this.onAuthenticationChanged();
                    this.emitSnapshot('已退出共享的 Grok 订阅登录。');
                }
                return result;
            } catch (error) {
                return { ok: false, error: this.redactError(error) };
            }
        });
    }

    async getSidecarUpdateStatus(): Promise<ComponentUpdateStatus> {
        return this.updates.status();
    }

    async applySidecarUpdate(): Promise<ComponentUpdateResult> {
        if (!this.canApplyUpdate()) throw new Error('Finish or stop Agent runtimes in every window before activating a sidecar update.');
        this.phase = 'updating';
        this.emitSnapshot('Verifying and staging a signed Grok component update…');
        try {
            const result = await this.updates.applyLatest();
            return {
                status: result.status,
                version: result.release.version,
                ...(result.status === 'installed' && result.previous ? { previousVersion: result.previous.version } : {})
            };
        } finally {
            this.phase = 'stopped';
            this.emitSnapshot('A newly activated sidecar is used only by new runtimes.');
        }
    }

    async rollbackSidecarUpdate(): Promise<ComponentUpdateResult> {
        if (!this.canApplyUpdate()) throw new Error('Finish or stop Agent runtimes in every window before rolling back the sidecar.');
        this.phase = 'updating';
        this.emitSnapshot('Rolling back to the previously verified Grok component…');
        try {
            const release = await this.updates.rollback();
            return { status: 'installed', version: release.version };
        } finally {
            this.phase = 'stopped';
            this.emitSnapshot('Rollback activation completed; new runtimes use the selected component.');
        }
    }

    async inspect(): Promise<ManagementResult> {
        if (!this.workspaceRoot || !this.isWorkspaceTrusted(this.workspaceRoot)) {
            return { ok: false, error: '请先打开并信任当前项目，再读取 Agent 集成配置。' };
        }
        return this.runCli(['inspect', '--json'], true, { allowWhileRuntime: true });
    }

    async runManagementCommand(command: 'mcp-list' | 'mcp-doctor' | 'plugin-list' | 'plugin-marketplaces'): Promise<ManagementResult> {
        if (!this.workspaceRoot || !this.isWorkspaceTrusted(this.workspaceRoot)) {
            return { ok: false, error: '请先打开并信任当前项目，再读取或诊断 Agent 集成。' };
        }
        if (command === 'mcp-list' || command === 'mcp-doctor') {
            return this.mcpOverview(command === 'mcp-doctor');
        }
        const commands: Record<typeof command, string[]> = {
            'plugin-list': ['plugin', 'list', '--json'],
            'plugin-marketplaces': ['plugin', 'marketplace', 'list', '--json']
        };
        return this.runCli(commands[command]);
    }

    async manage(request: ManagementRequest): Promise<ManagementResult> {
        if (!this.workspaceRoot || !this.isWorkspaceTrusted(this.workspaceRoot)) {
            return { ok: false, error: '请先打开并信任当前项目，再修改可执行的 Agent 集成。' };
        }
        try {
            if (request.area === 'skills') {
                const value = request.source ?? request.name;
                if (!value || !['enable', 'disable', 'add', 'remove'].includes(request.action)) {
                    throw new Error('A skill name or scan path is required.');
                }
                this.providers.updateSkills(request.action as 'enable' | 'disable' | 'add' | 'remove', value);
                return { ok: true, data: { changed: true, area: 'skills', action: request.action, value } };
            }
            if (request.area === 'mcp' && request.action === 'doctor') {
                return this.mcpOverview(true);
            }
            if ((request.area === 'plugins' && request.action === 'install') ||
                (request.area === 'marketplaces' && request.action === 'add')) {
                const confirmation = await dialog.showMessageBox({
                    type: 'warning',
                    title: 'Trust executable Agent integration?',
                    message: `Install ${request.source ?? request.name ?? 'this source'}?`,
                    detail: 'Plugins and marketplaces can execute code with your user permissions. The source must be pinned to an exact commit and independently reviewed.',
                    buttons: ['Install and Trust', 'Cancel'],
                    defaultId: 1,
                    cancelId: 1,
                    noLink: true
                });
                if (confirmation.response !== 0) return { ok: false, error: 'Installation cancelled.' };
            }
            const result = await this.runCli(this.managementArgs(request), false);
            if (!result.ok || request.area !== 'mcp' || !request.name || !this.workspaceRoot) return result;
            this.mcpDoctorSnapshot = undefined;
            if (request.action === 'remove') {
                this.providers.deleteMcpCredential(this.workspaceRoot, request.name);
                return result;
            }
            if (request.action === 'add' && request.secretValue) {
                const remote = request.transport === 'http' || request.transport === 'sse';
                const environmentName = remote
                    ? `XORA_CODE_MCP_${request.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_TOKEN`
                    : request.environmentName?.trim();
                if (!environmentName) throw new Error('A secret environment name is required for a stdio MCP server.');
                this.providers.saveMcpCredential(this.workspaceRoot, request.name, environmentName, request.secretValue);
                if (remote) {
                    this.providers.configureMcpBearerReference(this.workspaceRoot, request.scope === 'user' ? 'user' : 'project', request.name, environmentName);
                }
            }
            return result;
        } catch (error) {
            return { ok: false, error: errorMessage(error) };
        }
    }

    async dispose(): Promise<void> {
        this.flushAssistantTextDeltas();
        this.assistantStreamState().clear();
        this.client = undefined;
        this.disposed = true;
        if (this.managementChild) {
            this.supervisor.terminateProcessTree(this.managementChild, true);
            this.managementChild = undefined;
        }
        await this.stopRuntime();
        this.sessions.dispose();
    }

    disposeSync(): void {
        this.flushAssistantTextDeltas();
        this.assistantStreamState().clear();
        this.client = undefined;
        this.disposed = true;
        ++this.runtimeGeneration;
        ++this.sessionLoadGeneration;
        this.loadedSessionIds.clear();
        this.intentionalStop = true;
        this.acp?.close(new Error('Xora Code is shutting down.'));
        this.acp = undefined;
        if (this.managementChild) {
            this.supervisor.terminateProcessTree(this.managementChild, true);
            this.managementChild = undefined;
        }
        this.supervisor.stopSync();
        this.sessions.dispose();
        this.currentSecrets = [];
    }

    notifyAuthenticationChanged(): void {
        this.grokSubscriptionAuthStatus = this.providers.subscriptionAuthStatus();
        if (!this.runtimeActive && this.phase === 'stopped') {
            this.emitSnapshot('Agent 登录或凭据已在其他窗口中更新。');
            return;
        }
        void this.stopRuntime()
            .then(() => this.emitSnapshot('Agent 登录或凭据已在其他窗口中更新；当前运行已安全停止。'))
            .catch(error => this.emitError('AUTH_STATE_REFRESH_FAILED', error, true));
    }

    notifyProviderDefaultsChanged(): void {
        if (!this.runtimeActive && !this.activeSessionId) {
            this.providerId = this.providers.selectedProviderId();
            this.selectedModel = this.defaultModelId(this.providerId);
        }
        this.emitSnapshot('其他窗口更新了默认模型服务或模型。');
    }

    notifyPermissionModeChanged(): void {
        this.emitSnapshot('其他窗口更新了 Agent 权限模式。');
    }

    notifySubscriptionAuthStatusChanged(status: 'authenticated' | 'unauthenticated'): void {
        this.grokSubscriptionAuthStatus = status;
        this.emitSnapshot();
    }

    notifySharedGrokStateChanged(authenticationChanged = true): void {
        if (authenticationChanged) {
            this.grokSubscriptionAuthStatus = 'unknown';
        }
        this.emitSnapshot('共享的 Grok 配置或登录状态已变化；刷新管理页面后会重新读取。');
    }

    protected publishSubscriptionAuthStatus(status: 'authenticated' | 'unauthenticated'): void {
        this.grokSubscriptionAuthStatus = status;
        // Persisting this credential-free UI hint must never make a valid ACP
        // initialization fail because another window briefly owns the lock.
        try { this.providers.rememberSubscriptionAuthStatus(status); } catch { /* runtime result remains authoritative */ }
        this.onSubscriptionAuthStatusChanged(status);
    }

    protected bindAcp(acp: AcpClient): void {
        acp.onNotification('session/update', params => this.acceptSessionUpdate(params));
        acp.onNotification('_x.ai/model_state_updated', params => {
            const record = asRecord(params);
            this.acceptModelState(asRecord(record?.modelState) as ModelState | undefined);
        });
        acp.onNotification('*', (params, method) => {
            if (method === 'session/update' || method === '_x.ai/model_state_updated') {
                return;
            }
            if (method === 'x.ai/session_notification'
                || method === '_x.ai/session_notification'
                || method === 'x.ai/session/update'
                || method === '_x.ai/session/update') {
                this.acceptXaiSessionContext(params, method);
                return;
            }
            // Unknown extensions are intentionally tolerated and omitted from
            // user history. Persisting them made every restore grow the JSONL
            // and exposed protocol diagnostics as noisy system chat messages.
            void params;
        });
        acp.onRequest('session/request_permission', params => this.handlePermissionRequest(params));
        acp.onError(error => this.emitError('ACP_PROTOCOL_WARNING', error, true));
    }

    protected acceptInitialize(response: InitializeResponse): void {
        const agentCapabilities = asRecord(response.agentCapabilities);
        const prompt = asRecord(agentCapabilities?.promptCapabilities);
        const mcp = asRecord(agentCapabilities?.mcpCapabilities);
        const session = asRecord(agentCapabilities?.sessionCapabilities);
        const authMethods = (response.authMethods ?? []).flatMap(method => {
            const id = asString(method.id);
            if (!id) {
                return [];
            }
            return [{ id, name: asString(method.name) ?? id }];
        });
        this.capabilities = {
            protocolVersion: typeof response.protocolVersion === 'number' ? response.protocolVersion : 1,
            loadSession: agentCapabilities?.loadSession === true,
            prompt: {
                image: prompt?.image === true,
                audio: prompt?.audio === true,
                embeddedContext: prompt?.embeddedContext === true
            },
            mcp: { http: mcp?.http === true, sse: mcp?.sse === true },
            authMethods,
            defaultAuthMethodId: asString(response._meta?.defaultAuthMethodId)
        };
        this.supportsAdditionalDirectories = session?.additionalDirectories === true;
        const version = asString(response.agentInfo?.version) ?? asString(response._meta?.agentVersion);
        if (version) {
            this.sidecarVersion = version;
        }
        this.acceptModelState(modelStateFrom(response));
    }

    protected acceptModelState(state: ModelState | undefined): void {
        if (!state) {
            return;
        }
        if (Array.isArray(state.availableModels)) {
            this.models = state.availableModels.flatMap(candidate => {
                const id = asString(candidate.modelId) ?? asString(candidate.id);
                if (!id) {
                    return [];
                }
                return [{
                    id,
                    name: asString(candidate.name) ?? id,
                    description: asString(candidate.description),
                    contextWindow: asNumber(candidate.contextWindow)
                }];
            });
        }
        if (typeof state.currentModelId === 'string') {
            this.selectedModel = state.currentModelId;
            const preferred = this.providers.preferredModelId(this.providerId);
            const preferredIsStale = !!preferred && this.models.length > 0
                && !this.models.some(model => model.id === preferred);
            if (!preferred || preferredIsStale) {
                try {
                    this.providers.selectPreferredModel(this.providerId, state.currentModelId);
                    this.onProviderDefaultsChanged();
                } catch { /* model state remains usable in this runtime */ }
            }
        }
        this.emitSnapshot();
    }

    protected beginSessionRestore(appSessionId: string): void {
        this.restoringSessionCounts.set(appSessionId, (this.restoringSessionCounts.get(appSessionId) ?? 0) + 1);
    }

    protected endSessionRestore(appSessionId: string): void {
        const remaining = (this.restoringSessionCounts.get(appSessionId) ?? 1) - 1;
        if (remaining > 0) {
            this.restoringSessionCounts.set(appSessionId, remaining);
        } else {
            this.restoringSessionCounts.delete(appSessionId);
        }
    }

    protected isSessionRestoring(appSessionId: string | undefined): boolean {
        return !!appSessionId && (this.restoringSessionCounts.get(appSessionId) ?? 0) > 0;
    }

    protected acceptSessionUpdate(params: unknown): void {
        const envelope = parseAcpSessionContextEnvelope(params);
        const acpSessionId = envelope?.sessionId;
        const update = envelope?.update;
        const type = asString(update?.sessionUpdate);
        const appSessionId = envelope ? this.strictAppSessionForAcp(envelope.sessionId) : undefined;
        if (!appSessionId || !type || !update) {
            return;
        }
        // ACP session/load replays existing updates. The local redacted JSONL
        // already owns visible history, so rebroadcasting or persisting this
        // stream would duplicate the conversation on every switch.
        if (envelope.replay || this.isSessionRestoring(appSessionId)) {
            return;
        }
        if (!this.acceptContextEventSequence(appSessionId, envelope.eventSequence)) return;
        this.acceptContextTotal(appSessionId, envelope.meta);
        if (type === 'agent_message_chunk') {
            const content = asRecord(update.content);
            const text = asString(content?.text);
            if (text) {
                this.emit({ kind: 'text-delta', sessionId: appSessionId, role: 'assistant', text });
            }
            return;
        }
        if (type === 'plan') {
            const entries = Array.isArray(update.entries) ? update.entries : [];
            this.emit({
                kind: 'plan',
                sessionId: appSessionId,
                entries: entries.flatMap((candidate, index) => {
                    const item = asRecord(candidate);
                    const text = asString(item?.content) ?? asString(item?.text);
                    if (!text) {
                        return [];
                    }
                    const status = asString(item?.status);
                    return [{
                        id: asString(item?.id) ?? `plan-${index}`,
                        text,
                        status: status === 'in_progress' ? 'in-progress' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'pending'
                    }];
                })
            });
            return;
        }
        if (type === 'tool_call' || type === 'tool_call_update') {
            this.acceptToolUpdate(appSessionId, update, type);
        }
    }

    protected acceptXaiSessionContext(params: unknown, method: string): void {
        const envelope = parseXaiSessionContextEnvelope(method, params);
        if (!envelope || envelope.replay) return;
        const appSessionId = this.strictAppSessionForAcp(envelope.sessionId);
        if (!appSessionId || this.isSessionRestoring(appSessionId)) return;
        if (!this.acceptContextEventSequence(appSessionId, envelope.eventSequence)) return;

        const compaction = parseAutoCompaction(envelope.update);
        if (!compaction) {
            this.acceptContextTotal(appSessionId, envelope.meta);
            return;
        }
        const previous = this.contextStates().get(appSessionId) ?? this.emptyContextState();
        if (compaction.kind === 'started') {
            this.publishContextState(appSessionId, {
                ...previous,
                totalTokens: compaction.tokensUsed,
                contextWindow: compaction.contextWindow,
                usagePercent: contextPercentage(compaction.tokensUsed, compaction.contextWindow) ?? compaction.percentage,
                compactionStatus: 'running'
            });
            return;
        }
        if (compaction.kind === 'completed') {
            this.publishContextState(appSessionId, {
                ...previous,
                totalTokens: compaction.tokensAfter,
                usagePercent: contextPercentage(compaction.tokensAfter, previous.contextWindow),
                compactionStatus: 'idle',
                compactionCount: previous.compactionCount + 1,
                lastCompaction: {
                    tokensBefore: compaction.tokensBefore,
                    tokensAfter: compaction.tokensAfter,
                    elapsedMs: compaction.elapsedMs
                }
            });
            return;
        }
        const totalTokens = contextTotalTokens(envelope.meta) ?? previous.totalTokens;
        this.publishContextState(appSessionId, {
            ...previous,
            totalTokens,
            usagePercent: contextPercentage(totalTokens, previous.contextWindow),
            compactionStatus: compaction.kind === 'failed' ? 'failed' : 'cancelled'
        });
    }

    protected acceptPromptContextFallback(appSessionId: string, acpSessionId: string, result: unknown): void {
        const fallback = parsePromptContextFallback(result);
        if (!fallback) return;
        // The in-flight request supplies the mapping. If Grok echoes a session
        // id, it must match exactly; never trust result metadata to select an
        // app session. `usage` is billing and is intentionally not read here.
        if (fallback.sessionId && fallback.sessionId !== acpSessionId) return;
        const session = this.sessions.get(appSessionId);
        if (!session || session.acpSessionId !== acpSessionId) return;
        if (fallback.totalTokens === undefined && !fallback.modelId) return;
        const previous = this.contextStates().get(appSessionId) ?? this.emptyContextState();
        const contextWindow = this.modelContextWindow(fallback.modelId ?? previous.modelId ?? session.model)
            ?? previous.contextWindow;
        const totalTokens = fallback.totalTokens ?? previous.totalTokens;
        this.publishContextState(appSessionId, {
            ...previous,
            totalTokens,
            contextWindow,
            usagePercent: contextPercentage(totalTokens, contextWindow),
            modelId: fallback.modelId ?? previous.modelId ?? session.model
        });
    }

    protected acceptContextTotal(appSessionId: string, meta: Record<string, unknown>): void {
        const totalTokens = contextTotalTokens(meta);
        if (totalTokens === undefined) return;
        const session = this.sessions.get(appSessionId);
        if (!session) return;
        const previous = this.contextStates().get(appSessionId) ?? this.emptyContextState();
        const modelId = previous.modelId ?? session.model ?? this.selectedModel;
        const contextWindow = previous.contextWindow ?? this.modelContextWindow(modelId);
        this.publishContextState(appSessionId, {
            ...previous,
            totalTokens,
            contextWindow,
            usagePercent: contextPercentage(totalTokens, contextWindow),
            modelId
        });
    }

    protected publishContextState(appSessionId: string, context: AgentSessionContext): void {
        const previous = this.contextStates().get(appSessionId);
        if (previous && sameContextState(previous, context)) return;
        this.contextStates().set(appSessionId, context);
        this.emit({ kind: 'context-usage', sessionId: appSessionId, context });
    }

    protected emptyContextState(): AgentSessionContext {
        return { compactionStatus: 'idle', compactionCount: 0 };
    }

    protected contextStates(): Map<string, AgentSessionContext> {
        return this.sessionContexts ?? (this.sessionContexts = new Map());
    }

    protected acceptContextEventSequence(appSessionId: string, sequence: number | undefined): boolean {
        if (sequence === undefined) return true;
        const highwaters = this.contextEventHighwaters ?? (this.contextEventHighwaters = new Map());
        const previous = highwaters.get(appSessionId);
        if (previous !== undefined && sequence <= previous) return false;
        highwaters.set(appSessionId, sequence);
        return true;
    }

    protected strictAppSessionForAcp(acpSessionId: string): string | undefined {
        const appSessionId = this.appSessionForAcp(acpSessionId);
        const record = appSessionId ? this.sessions.get(appSessionId) : undefined;
        return record?.acpSessionId === acpSessionId ? appSessionId : undefined;
    }

    protected modelContextWindow(modelId: string | undefined): number | undefined {
        return modelId ? this.models.find(model => model.id === modelId)?.contextWindow : undefined;
    }

    protected acceptToolUpdate(appSessionId: string, update: Record<string, unknown>, type: string): void {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) {
            return;
        }
        // Redact exact credentials before deriving or truncating any renderer
        // label/output. Truncating first could turn a long secret into an
        // unmatched prefix that later event-level redaction cannot remove.
        const safeUpdate = asRecord(deepRedact(update, this.currentSecrets)) ?? {};
        const status = normalizeToolStatus(asString(safeUpdate.status), type);
        const identity = normalizeToolIdentity(safeUpdate, type);
        const locations = normalizeToolLocations(safeUpdate.locations);
        const output = textFromToolContent(safeUpdate.content) ?? stringifySmall(safeUpdate.rawOutput);
        const event: ToolCallEvent = {
            kind: 'tool-call',
            sessionId: appSessionId,
            toolCallId,
            title: asString(safeUpdate.title) ?? toolCallId,
            toolName: identity.name,
            toolKind: identity.kind,
            toolNamespace: identity.namespace,
            presentation: normalizeToolPresentation(identity, safeUpdate, locations),
            locations,
            status,
            input: boundedToolInput(safeUpdate.rawInput),
            output
        };
        this.emit(event);
        if (Array.isArray(update.content)) {
            for (const candidate of update.content) {
                const content = asRecord(candidate);
                if (content?.type === 'diff') {
                    const changedPath = asString(content.path);
                    if (changedPath) {
                        const oldText = asString(content.oldText) ?? '';
                        const newText = asString(content.newText) ?? '';
                        const targetCandidate = path.isAbsolute(changedPath)
                            ? changedPath
                            : path.resolve(this.workspaceRoot!, changedPath);
                        const targetPath = this.safeWorkspaceFile(targetCandidate);
                        const oldHash = crypto.createHash('sha256').update(oldText).digest('hex');
                        const newHash = crypto.createHash('sha256').update(newText).digest('hex');
                        const diffKey = JSON.stringify([
                            appSessionId,
                            toolCallId,
                            path.normalize(targetPath),
                            oldHash,
                            newHash
                        ]);
                        if (this.emittedDiffKeys.has(diffKey)) {
                            continue;
                        }
                        const before = this.sessions.saveBeforeImage(appSessionId, changedPath, oldText);
                        const diffId = crypto.randomUUID();
                        this.revertableDiffs.set(diffId, { targetPath, beforePath: before.path, expectedNewHash: newHash });
                        this.rememberEmittedDiff(diffKey);
                        this.emit({
                            kind: 'diff',
                            diffId,
                            sessionId: appSessionId,
                            toolCallId,
                            path: changedPath,
                            oldPath: before.path,
                            oldHash: before.hash,
                            newHash,
                            diff: unifiedDiff(changedPath, oldText, newText)
                        });
                    }
                }
            }
        }
    }

    protected rememberEmittedDiff(key: string): void {
        this.emittedDiffKeys.add(key);
        while (this.emittedDiffKeys.size > MAX_EMITTED_DIFF_KEYS) {
            const oldest = this.emittedDiffKeys.values().next().value;
            if (oldest === undefined) break;
            this.emittedDiffKeys.delete(oldest);
        }
    }

    protected async handlePermissionRequest(params: unknown): Promise<unknown> {
        const request = asRecord(params);
        const acpSessionId = asString(request?.sessionId);
        const appSessionId = this.appSessionForAcp(acpSessionId);
        const tool = asRecord(request?.toolCall);
        const options = (Array.isArray(request?.options) ? request!.options : []).flatMap(candidate => {
            const option = asRecord(candidate);
            const optionId = asString(option?.optionId);
            return optionId ? [{ optionId, kind: asString(option?.kind), name: asString(option?.name) }] : [];
        });
        if (!appSessionId || !this.workspaceRoot || !this.sidecarVersion || !tool || options.length === 0) {
            return { outcome: { outcome: 'cancelled' } };
        }
        if (this.isSessionRestoring(appSessionId)) {
            return { outcome: { outcome: 'cancelled' } };
        }
        const session = this.sessions.get(appSessionId);
        let workspaceTrusted = false;
        if (session) {
            try { workspaceTrusted = this.isWorkspaceTrusted(session.workspaceRoot); } catch { /* fail closed */ }
        }
        if (!session
            || session.acpSessionId !== acpSessionId
            || this.activeSessionId !== appSessionId
            || session.workspaceRoot !== this.workspaceRoot
            || session.providerId !== this.providerId
            || !this.loadedSessionIds.has(appSessionId)
            || !workspaceTrusted) {
            return { outcome: { outcome: 'cancelled' } };
        }
        const safeTool = asRecord(deepRedact(tool, this.currentSecrets)) ?? {};
        const locations = normalizeToolLocations(safeTool.locations);
        const policyLocations = normalizeToolLocations(tool.locations);
        const location = Array.isArray(tool.locations) ? asRecord(tool.locations[0]) : undefined;
        const rawInput = asRecord(tool.rawInput);
        const identity = normalizeToolIdentity(tool, 'tool_call');
        const policyPresentation = normalizeToolPresentation(identity, tool, policyLocations);
        const safeIdentity = normalizeToolIdentity(safeTool, 'tool_call');
        const presentation = normalizeToolPresentation(safeIdentity, safeTool, locations);
        const subject: PermissionSubject = {
            toolName: identity.name,
            path: asString(location?.path) ?? asString(rawInput?.path),
            command: asString(rawInput?.command),
            mcpServer: policyPresentation.source === 'mcp'
                ? policyPresentation.sourceLabel
                : asString(rawInput?.server) ?? asString(rawInput?.mcpServer)
        };
        if (!this.permissionPathsStayInWorkspace(tool, rawInput)) {
            this.emitError('PERMISSION_BOUNDARY_REJECTED', new Error('The Agent requested access outside the trusted workspace.'), true, appSessionId);
            return { outcome: { outcome: 'cancelled' } };
        }
        if (this.security.agentPermissionMode() === 'full-access') {
            // Always select allow-once: choosing an ACP allow-always option
            // could create sidecar-owned state that escapes this app session.
            const allowOnce = options.find(option => normalizeOptionKind(option) === 'allow_once');
            return allowOnce
                ? { outcome: { outcome: 'selected', optionId: allowOnce.optionId } }
                : { outcome: { outcome: 'cancelled' } };
        }
        const persistent = this.security.hasPersistentPermission(this.workspaceRoot, this.sidecarVersion, subject);
        if (persistent) {
            const allow = options.find(option => normalizeOptionKind(option) === 'allow_once')
                ?? options.find(option => normalizeOptionKind(option) === 'allow_always');
            return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } };
        }

        const requestId = crypto.randomUUID();
        const event: PermissionRequestEvent = {
            kind: 'permission-request',
            sessionId: appSessionId,
            requestId,
            toolCallId: asString(safeTool.toolCallId),
            toolName: safeIdentity.name,
            presentation,
            title: asString(safeTool.title) ?? `Allow ${safeIdentity.name}?`,
            detail: stringifySmall(safeTool.rawInput),
            options: [
                ...(options.some(option => normalizeOptionKind(option) === 'allow_once') ? ['allow-once' as const] : []),
                ...(options.some(option => normalizeOptionKind(option) === 'allow_once') &&
                    !!(subject.path || subject.command || subject.mcpServer) ? ['allow-always' as const] : []),
                'reject' as const
            ]
        };
        this.emit(event);
        return new Promise(resolve => {
            this.pendingPermissions.set(requestId, { appSessionId, subject, options, resolve });
        });
    }

    protected snapshot(message?: string): RuntimeSnapshot {
        let workspaceTrusted = false;
        if (this.workspaceRoot) {
            try { workspaceTrusted = this.isWorkspaceTrusted(this.workspaceRoot); } catch { /* fail closed */ }
        }
        return {
            phase: this.phase,
            workspaceRoot: this.workspaceRoot,
            workspaceAttached: !!this.workspaceRoot && this.attachedWorkspaceRoots.has(this.workspaceRoot),
            workspaceTrusted,
            providerId: this.providerId,
            grokSubscriptionAuthStatus: this.grokSubscriptionAuthStatus,
            sidecarVersion: this.sidecarVersion,
            capabilities: this.capabilities,
            models: this.models.map(model => ({ ...model })),
            selectedModel: this.selectedModel,
            sessions: this.sessions.list(),
            activeSessionId: this.activeSessionId,
            sessionContexts: Object.fromEntries(
                [...this.contextStates().entries()].map(([sessionId, context]) => [sessionId, { ...context }])
            ),
            permissionMode: this.security.agentPermissionMode(),
            message
        };
    }

    protected defaultModelId(providerId: string): string | undefined {
        const configured = this.providers.preferredModelId(providerId);
        if (configured) return configured;
        // One-time upgrade path for builds that stored a model only on the
        // session record. The repository is already sorted newest-first and
        // no workspace trust or project configuration crosses this boundary.
        const recent = this.sessions.list().find(session => session.providerId === providerId && !!session.model)?.model;
        if (!recent) return undefined;
        try { this.providers.selectPreferredModel(providerId, recent); } catch { /* keep the in-memory fallback */ }
        return recent;
    }

    protected emitSnapshot(message?: string): void {
        this.emit({ kind: 'snapshot', snapshot: this.snapshot(message) }, false);
    }

    protected emit(event: AgentHostEvent, persist = true): void {
        if (event.kind === 'text-delta' && event.role === 'assistant') {
            this.enqueueAssistantTextDelta(event, persist);
            return;
        }

        // ACP may put a plan/tool/session/turn/error immediately after the last
        // text fragment. Flush the fragment synchronously so batching can never
        // reorder semantic boundaries in either renderer IPC or local history.
        if (event.kind === 'session') {
            this.flushAssistantTextDeltas(event.session.appSessionId);
        } else if ('sessionId' in event && typeof event.sessionId === 'string') {
            this.flushAssistantTextDeltas(event.sessionId);
        } else if (event.kind === 'error' || event.kind === 'snapshot') {
            // Sessionless errors and global runtime snapshots can affect any
            // conversation, so preserve their position against every batch.
            this.flushAssistantTextDeltas();
        }
        this.emitImmediately(event, persist);
    }

    protected enqueueAssistantTextDelta(event: AgentTextEvent, persist: boolean): void {
        // Optimize perceived latency without giving up stream batching. The
        // first visible fragment is synchronous; subsequent tiny ACP chunks
        // are coalesced into the existing 28 ms fixed window.
        const startedStreams = this.assistantStreamState();
        if (!startedStreams.has(event.sessionId)) {
            startedStreams.add(event.sessionId);
            this.emitImmediately(event, persist);
            return;
        }
        const pending = this.pendingAssistantTextDeltas.get(event.sessionId);
        if (pending && pending.persist === persist) {
            pending.event.text += event.text;
            if (event.attachments?.length) {
                pending.event.attachments = [...(pending.event.attachments ?? []), ...event.attachments];
            }
            return;
        }
        if (pending) {
            this.flushAssistantTextDeltas(event.sessionId);
        }
        const timer = setTimeout(() => this.flushAssistantTextDeltas(event.sessionId), ASSISTANT_TEXT_BATCH_INTERVAL_MS);
        timer.unref?.();
        this.pendingAssistantTextDeltas.set(event.sessionId, {
            event: {
                ...event,
                ...(event.attachments ? { attachments: [...event.attachments] } : {})
            },
            persist,
            timer
        });
    }

    protected flushAssistantTextDeltas(sessionId?: string): void {
        // Some migration/test harnesses intentionally instantiate the service
        // prototype without running its constructor. Treat an absent batch map
        // as empty so lifecycle cleanup remains backwards compatible.
        const pendingDeltas = this.pendingAssistantTextDeltas;
        if (!pendingDeltas) return;
        const sessionIds = sessionId ? [sessionId] : [...pendingDeltas.keys()];
        for (const pendingSessionId of sessionIds) {
            const pending = pendingDeltas.get(pendingSessionId);
            if (!pending) continue;
            pendingDeltas.delete(pendingSessionId);
            clearTimeout(pending.timer);
            this.emitImmediately(pending.event, pending.persist);
        }
    }

    /** Keeps prototype-only migration and test harnesses backwards compatible. */
    protected assistantStreamState(): Set<string> {
        return this.assistantStreamsStarted ?? (this.assistantStreamsStarted = new Set<string>());
    }

    protected emitImmediately(event: AgentHostEvent, persist: boolean): void {
        const safeEvent = deepRedact(event, this.currentSecrets);
        try { this.client?.onAgentEvent(safeEvent); } catch { /* disconnected renderer */ }
        if (persist && 'sessionId' in safeEvent && typeof safeEvent.sessionId === 'string' && this.knownSessionIds.has(safeEvent.sessionId)) {
            this.sessions.appendEvent(safeEvent.sessionId, safeEvent);
        }
    }

    protected emitError(code: string, error: unknown, recoverable: boolean, sessionId?: string): void {
        this.emit({ kind: 'error', sessionId, code, message: this.redactError(error), recoverable });
    }

    protected runtimeFailed(error: unknown, generation = this.runtimeGeneration): void {
        if (generation !== this.runtimeGeneration || this.phase === 'crashed' || this.intentionalStop) {
            return;
        }
        this.flushAssistantTextDeltas();
        this.assistantStreamState().clear();
        ++this.sessionLoadGeneration;
        this.phase = 'crashed';
        this.loadedSessionIds.clear();
        this.acp?.close(error);
        this.acp = undefined;
        void this.supervisor.stop(0);
        for (const [appSessionId, prompt] of this.activePrompts) {
            void prompt.cancel(error).catch(() => undefined);
            try {
                const failed = this.sessions.update(appSessionId, { status: 'failed' });
                this.emit({ kind: 'session', session: failed });
            } catch { /* session may have been removed externally */ }
        }
        this.activePrompts.clear();
        for (const permission of this.pendingPermissions.values()) {
            permission.resolve({ outcome: { outcome: 'cancelled' } });
        }
        this.pendingPermissions.clear();
        this.sessions.flushEvents();
        this.emitError('SIDECAR_CRASHED', error, true);
        this.emitSnapshot('The sidecar stopped. Xora Code will never replay the last prompt automatically.');
    }

    protected appSessionForAcp(acpSessionId: string | undefined): string | undefined {
        if (!acpSessionId) {
            return undefined;
        }
        const cached = this.acpSessionLookup.get(acpSessionId);
        if (cached) return cached;
        const found = this.sessions.list().find(session => session.acpSessionId === acpSessionId)?.appSessionId;
        if (found) this.acpSessionLookup.set(acpSessionId, found);
        return found;
    }

    protected requireAcp(): AcpClient {
        if (!this.acp) {
            throw new Error('The Grok sidecar is not running.');
        }
        return this.acp;
    }

    protected requireReady(): AcpClient {
        if (this.phase !== 'ready') {
            throw new Error(`The Agent runtime is not ready (${this.phase}).`);
        }
        return this.requireAcp();
    }

    protected safeWorkspaceFile(candidate: string): string {
        if (!this.workspaceRoot || !this.isWorkspaceTrusted(this.workspaceRoot)) {
            throw new Error('No trusted workspace is active.');
        }
        const absolute = path.resolve(candidate);
        const resolved = fs.existsSync(absolute) ? fs.realpathSync.native(absolute) : absolute;
        const relative = path.relative(this.workspaceRoot, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('Agent changes must resolve to a file inside the trusted workspace.');
        }
        return resolved;
    }

    /** Validates every filesystem location declared by an ACP permission request. */
    protected permissionPathsStayInWorkspace(tool: Record<string, unknown>, rawInput: Record<string, unknown> | undefined): boolean {
        if (!this.workspaceRoot) return false;
        try {
            if (!this.isWorkspaceTrusted(this.workspaceRoot)) return false;
        } catch {
            return false;
        }
        const declared = new Set<string>();
        if (Array.isArray(tool.locations)) {
            for (const candidate of tool.locations) {
                const location = asRecord(candidate);
                const value = asString(location?.path);
                if (value) declared.add(value);
            }
        }
        for (const name of ['path', 'cwd', 'workingDirectory', 'working_directory'] as const) {
            const value = asString(rawInput?.[name]);
            if (value) declared.add(value);
        }
        if (Array.isArray(rawInput?.paths)) {
            for (const candidate of rawInput!.paths as unknown[]) {
                const value = asString(candidate);
                if (value) declared.add(value);
            }
        }
        for (const candidate of declared) {
            if (!this.isPathInsideWorkspace(candidate)) return false;
        }
        return true;
    }

    protected isPathInsideWorkspace(candidate: string): boolean {
        if (!this.workspaceRoot || candidate.includes('\0')) return false;
        // Reject URI-like operands. ACP filesystem locations must be paths;
        // treating a URI as a relative path would accidentally allow it.
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) && !path.isAbsolute(candidate)) return false;
        const absolute = path.isAbsolute(candidate)
            ? path.normalize(candidate)
            : path.resolve(this.workspaceRoot, candidate);
        let existing = absolute;
        const missing: string[] = [];
        while (!fs.existsSync(existing)) {
            const parent = path.dirname(existing);
            if (parent === existing) return false;
            missing.unshift(path.basename(existing));
            existing = parent;
        }
        let resolved: string;
        try {
            resolved = path.resolve(fs.realpathSync.native(existing), ...missing);
        } catch {
            return false;
        }
        const relative = path.relative(this.workspaceRoot, resolved);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    protected isWorkspaceTrusted(root: string): boolean {
        const canonical = this.security.canonicalRoot(root);
        return this.theiaTrustedRoots.has(canonical) && this.security.isTrusted(canonical);
    }

    protected interruptRuntimeForTrustRevocation(): void {
        this.flushAssistantTextDeltas();
        this.assistantStreamState().clear();
        ++this.runtimeGeneration;
        ++this.sessionLoadGeneration;
        this.loadedSessionIds.clear();
        this.intentionalStop = true;
        this.phase = 'draining';
        for (const permission of this.pendingPermissions.values()) {
            permission.resolve({ outcome: { outcome: 'cancelled' } });
        }
        this.pendingPermissions.clear();
        for (const prompt of this.activePrompts.values()) {
            void prompt.cancel('Workspace trust was revoked').catch(() => undefined);
        }
        this.activePrompts.clear();
        this.acp?.close(new Error('Theia revoked workspace trust.'));
        this.acp = undefined;
        if (this.managementChild) {
            this.supervisor.terminateProcessTree(this.managementChild, true);
            this.managementChild = undefined;
        }
        this.supervisor.stopSync();
        this.emitSnapshot('Theia revoked workspace trust; executable Agent activity was interrupted.');
    }

    protected redactError(error: unknown): string {
        return deepRedact(error instanceof Error ? error.message : String(error), this.currentSecrets);
    }

    protected async withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.lifecycleTail;
        let release!: () => void;
        this.lifecycleTail = new Promise<void>(resolve => { release = resolve; });
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
        }
    }

    protected managementArgs(request: ManagementRequest): string[] {
        const name = request.name ? safeCliOperand(request.name, 'name') : undefined;
        const source = request.source ? safeCliOperand(request.source, 'source') : undefined;
        const scope = request.scope === 'user' ? 'user' : 'project';
        const transport = request.transport === 'http' || request.transport === 'sse' ? request.transport : 'stdio';
        if (request.area === 'mcp') {
            if (request.action === 'doctor') return ['mcp', 'doctor', '--json'];
            if (request.action === 'remove' && name) return ['mcp', 'remove', '--scope', scope, name];
            if (request.action === 'add' && name && source) {
                const prefix = ['mcp', 'add', '--scope', scope];
                if (transport === 'stdio') {
                    return [...prefix, name, '--', source, ...(request.args ?? []).map(argument => safeCliArgument(argument))];
                }
                return [...prefix, '--transport', transport, name, source];
            }
        }
        if (request.area === 'plugins') {
            if (request.action === 'install' && source) {
                if (!/@[0-9a-f]{40}$/i.test(source)) {
                    throw new Error('Remote plugins must be pinned to an exact commit SHA.');
                }
                if (!request.confirmedTrust) {
                    throw new Error('Plugin trust must be confirmed before installation.');
                }
                return ['plugin', 'install', source, '--trust'];
            }
            if (request.action === 'update' && name) return ['plugin', 'update', name];
            if (request.action === 'uninstall' && name) return ['plugin', 'uninstall', name, '--confirm'];
            if ((request.action === 'enable' || request.action === 'disable') && name) return ['plugin', request.action, name];
        }
        if (request.area === 'marketplaces' && request.action === 'add' && source) {
            if (!/@[0-9a-f]{40}$/i.test(source) || !request.confirmedTrust) {
                throw new Error('Marketplace sources require an exact commit SHA and explicit trust confirmation.');
            }
            return ['plugin', 'marketplace', 'add', source];
        }
        throw new Error('Unsupported or incomplete management operation.');
    }

    protected authenticationWorkingDirectory(): string {
        const userData = app.getPath('userData');
        fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
        const realUserData = fs.realpathSync.native(userData);
        const target = path.join(realUserData, 'grok-auth-workdir');
        try {
            fs.mkdirSync(target, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const stat = fs.lstatSync(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('The Grok authentication working directory is unsafe.');
        }
        const realTarget = fs.realpathSync.native(target);
        const relative = path.relative(realUserData, realTarget);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('The Grok authentication working directory escapes application data.');
        }
        if (process.platform !== 'win32') fs.chmodSync(realTarget, 0o700);
        return realTarget;
    }

    /**
     * `inspect` is authoritative because it includes compatible Claude/Cursor
     * sources that `grok mcp list` deliberately omits. Native list and doctor
     * output only enrich that final effective set. Read-only discovery may run
     * beside ACP; doctor remains isolated because it starts MCP processes.
     */
    protected async mcpOverview(runDoctor: boolean): Promise<ManagementResult> {
        const readOnly = { allowWhileRuntime: true } satisfies GrokCommandOptions;
        const inspected = await this.runCli(['inspect', '--json'], true, readOnly);
        const nativeList = await this.runCli(['mcp', 'list', '--json'], true, readOnly);
        const cachedDoctor = this.mcpDoctorSnapshot;
        let doctor = cachedDoctor && cachedDoctor.workspaceRoot === this.workspaceRoot
            ? cachedDoctor.result
            : undefined;
        if (runDoctor) {
            doctor = await this.runCli(['mcp', 'doctor', '--json']);
            if (doctor.ok && this.workspaceRoot) {
                this.mcpDoctorSnapshot = { workspaceRoot: this.workspaceRoot, result: doctor };
            }
        }
        return mergeMcpManagementResults(inspected, nativeList, doctor);
    }

    protected runCli(args: string[], expectJson = true, options: GrokCommandOptions = {}): Promise<ManagementResult> {
        if (this.supervisor.running && !options.allowWhileRuntime) {
            return Promise.resolve({
                ok: false,
                error: 'Agent 正在运行；列表仍可查看。如需诊断或修改 MCP，请先结束当前任务并停止 Agent。'
            });
        }
        if (this.managementChild && this.managementChild.exitCode === null) {
            return Promise.resolve({ ok: false, error: '另一个 Agent 集成查询正在执行，请稍后重试。' });
        }
        const root = options.cwd ?? this.workspaceRoot ?? process.cwd();
        const binary = this.supervisor.binaryPath();
        const exactSecrets = options.injectedEnvironment === undefined
            ? this.providers.redactionSecrets()
            : Object.values(options.injectedEnvironment).filter((value): value is string => typeof value === 'string' && value.length > 0);
        return new Promise(resolve => {
            const child = spawn(binary, ['--no-auto-update', '--cwd', root, ...args], {
                cwd: root,
                env: this.supervisor.commandEnvironment(options.injectedEnvironment ?? this.providers.mcpEnvironment(root)),
                shell: false,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            this.managementChild = child;
            const output: Buffer[] = [];
            const errors: Buffer[] = [];
            let size = 0;
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (result: ManagementResult): void => {
                if (settled) return;
                settled = true;
                if (this.managementChild === child) this.managementChild = undefined;
                if (timer) clearTimeout(timer);
                resolve(result);
            };
            const accept = (target: Buffer[], chunk: Buffer): void => {
                size += chunk.length;
                if (size > 5 * 1024 * 1024) {
                    this.supervisor.terminateProcessTree(child, true);
                    finish({ ok: false, error: 'Grok command exceeded the 5 MiB response limit.' });
                } else {
                    target.push(chunk);
                }
            };
            child.stdout.on('data', chunk => accept(output, Buffer.from(chunk)));
            child.stderr.on('data', chunk => accept(errors, Buffer.from(chunk)));
            child.once('error', error => finish({
                ok: false,
                error: options.exposeOutput === false ? options.failureMessage ?? 'Grok command failed.' : errorMessage(error)
            }));
            child.once('exit', code => {
                if (settled) return;
                const stderr = deepRedact(Buffer.concat(errors).toString('utf8'), exactSecrets).trim();
                if (code !== 0) {
                    finish({
                        ok: false,
                        error: options.exposeOutput === false
                            ? options.failureMessage ?? 'Grok command failed.'
                            : stderr || `Grok command exited with code ${code}.`
                    });
                    return;
                }
                const stdout = Buffer.concat(output).toString('utf8');
                if (!expectJson) {
                    finish(options.exposeOutput === false
                        ? { ok: true, data: { completed: true } }
                        : { ok: true, data: { output: deepRedact(stdout.trim(), exactSecrets), stderr } });
                    return;
                }
                try {
                    finish({ ok: true, data: deepRedact(JSON.parse(stdout), exactSecrets) });
                } catch {
                    finish({ ok: false, error: 'Grok returned malformed JSON.' });
                }
            });
            timer = setTimeout(() => {
                this.supervisor.terminateProcessTree(child, true);
                finish({
                    ok: false,
                    error: options.exposeOutput === false
                        ? options.failureMessage ?? 'Grok command timed out.'
                        : `Grok command timed out after ${Math.ceil((options.timeoutMs ?? 30_000) / 1000)} seconds.`
                });
            }, options.timeoutMs ?? 30_000);
        });
    }
}

function contextPercentage(totalTokens: number | undefined, contextWindow: number | undefined): number | undefined {
    if (totalTokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined;
    return Math.max(0, Math.floor((totalTokens * 100) / contextWindow));
}

function sameContextState(left: AgentSessionContext, right: AgentSessionContext): boolean {
    return left.totalTokens === right.totalTokens
        && left.contextWindow === right.contextWindow
        && left.usagePercent === right.usagePercent
        && left.modelId === right.modelId
        && left.compactionStatus === right.compactionStatus
        && left.compactionCount === right.compactionCount
        && left.lastCompaction?.tokensBefore === right.lastCompaction?.tokensBefore
        && left.lastCompaction?.tokensAfter === right.lastCompaction?.tokensAfter
        && left.lastCompaction?.elapsedMs === right.lastCompaction?.elapsedMs;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function modelStateFrom(value: { _meta?: Record<string, unknown>; models?: unknown }): ModelState | undefined {
    return (asRecord(value._meta?.modelState) ?? asRecord(value.models)) as ModelState | undefined;
}

function normalizeOptionKind(option: { optionId: string; kind?: string; name?: string }): string {
    const raw = option.kind ?? option.optionId ?? option.name ?? '';
    return raw.toLowerCase().replace(/-/g, '_');
}

interface NormalizedToolIdentity {
    name: string;
    kind: string;
    namespace?: string;
    label?: string;
    readOnly?: boolean;
    canonicalInput?: Record<string, unknown>;
    meta?: Record<string, unknown>;
}

/**
 * Grok Build 0.2.102 publishes a versioned `x.ai/tool` envelope. Prefer that
 * semantic identity over the deliberately coarse ACP `kind` field, while
 * keeping a conservative fallback for older agents and persisted fixtures.
 */
function normalizeToolIdentity(update: Record<string, unknown>, updateType: string): NormalizedToolIdentity {
    const meta = asRecord(update._meta);
    const canonical = asRecord(meta?.['x.ai/tool']);
    const wireKind = safeToolToken(asString(canonical?.kind)) ?? safeToolToken(asString(update.kind)) ?? 'other';
    const wireName = safeWireName(asString(canonical?.name))
        ?? safeWireName(asString(update.toolName))
        ?? safeWireName(asString(update.kind))
        ?? (updateType === 'tool_call' ? safeWireName(asString(update.title)) : undefined)
        ?? 'tool';
    return {
        name: wireName,
        kind: wireKind,
        namespace: safeToolToken(asString(canonical?.namespace)),
        label: safeUiText(asString(canonical?.label), 64),
        readOnly: typeof canonical?.read_only === 'boolean' ? canonical.read_only : undefined,
        canonicalInput: asRecord(canonical?.input),
        meta
    };
}

function normalizeToolLocations(value: unknown): AgentToolLocation[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const locations = value.slice(0, 20).flatMap(candidate => {
        const item = asRecord(candidate);
        const rawPath = asString(item?.path)?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (!rawPath) return [];
        const line = asNumber(item?.line);
        return [{
            path: rawPath.slice(0, 4096),
            ...(line !== undefined && line >= 0 ? { line: Math.floor(line) } : {})
        }];
    });
    return locations.length ? locations : undefined;
}

function normalizeToolPresentation(
    identity: NormalizedToolIdentity,
    update: Record<string, unknown>,
    locations: AgentToolLocation[] | undefined
): AgentToolPresentation {
    const input = identity.canonicalInput ?? asRecord(update.rawInput);
    const mcpMeta = asRecord(identity.meta?.['x.ai/mcp_tool']);
    const pluginMeta = asRecord(identity.meta?.['x.ai/plugin']) ?? asRecord(identity.meta?.['xora/plugin']);
    const indirectToolName = safeWireName(asString(input?.tool_name) ?? asString(input?.toolName));
    const mcpIdentity = mcpToolParts(indirectToolName ?? identity.name);
    const managementSource = grokManagementSource(input);
    const explicitPluginName = safeEntityLabel(
        asString(pluginMeta?.name)
        ?? asString(pluginMeta?.pluginName)
        ?? asString(input?.plugin_name)
        ?? asString(input?.pluginName)
        ?? asString(input?.plugin)
    );
    const isMcp = managementSource === 'mcp' || identity.namespace === 'mcp' || !!mcpMeta || (identity.kind === 'use_tool' && !!mcpIdentity);
    const isPlugin = managementSource === 'plugin'
        || identity.kind === 'plugin'
        || identity.namespace === 'plugin'
        || !!pluginMeta
        || !!explicitPluginName
        || /(?:^|[_.:/-])plugins?(?:$|[_.:/-])/i.test(identity.name);
    const isSkill = managementSource === 'skill' || identity.kind === 'skill' || /(?:^|[_.:/-])skills?(?:$|[_.:/-])/i.test(identity.name);
    const source = isMcp ? 'mcp' : isPlugin ? 'plugin' : isSkill ? 'skill' : 'builtin';
    const action = toolAction(identity.kind, identity.name);
    const sourceLabel = source === 'mcp'
        ? safeEntityLabel(asString(mcpMeta?.serverName) ?? asString(mcpMeta?.server) ?? mcpIdentity?.server)
        : source === 'plugin'
            ? explicitPluginName
            : source === 'skill'
                ? skillName(input, update)
                : undefined;
    const operationLabel = source === 'mcp'
        ? safeEntityLabel(asString(mcpMeta?.toolName) ?? asString(mcpMeta?.tool) ?? mcpIdentity?.tool)
            ?? (managementSource === 'mcp' ? '管理配置' : undefined)
        : undefined;
    const mutatesFiles = action === 'file-create' || action === 'file-write'
        || action === 'file-delete' || action === 'file-move';
    return {
        action,
        source,
        targetLabel: presentationTarget(action, source, input, locations, sourceLabel, operationLabel),
        sourceLabel,
        operationLabel,
        // Provider metadata is useful for positive read-only hints, but it may
        // never downgrade an action whose canonical semantics mutate files.
        readOnly: mutatesFiles ? false : identity.readOnly
    };
}

/** Recognize only the first executable segment; no command text is retained. */
function grokManagementSource(input: Record<string, unknown> | undefined): 'mcp' | 'plugin' | 'skill' | undefined {
    const command = firstInputString(input, ['command', 'cmd', 'script']);
    if (!command) return undefined;
    const firstSegment = command.split(/[;&|]/, 1)[0];
    const tokens = firstSegment.match(/"[^"]*"|'[^']*'|\S+/g)?.map(token => token.replace(/^['"]|['"]$/g, '')) ?? [];
    const executable = tokens.findIndex(token => /(?:^|[\\/])grok(?:\.exe)?$/i.test(token));
    if (executable < 0) return undefined;
    const operands = tokens.slice(executable + 1).map(token => token.toLowerCase());
    if (operands.includes('mcp')) return 'mcp';
    if (operands.includes('plugin') || operands.includes('plugins') || operands.includes('marketplace')) return 'plugin';
    if (operands.includes('inspect') || operands.includes('skill') || operands.includes('skills')) return 'skill';
    return undefined;
}

function toolAction(kind: string, name: string): AgentToolAction {
    switch (kind) {
        case 'read':
        case 'list':
        case 'list_dir':
        case 'memory_get':
            return 'file-read';
        case 'create':
            return 'file-create';
        case 'edit':
        case 'write':
            return 'file-write';
        case 'delete': return 'file-delete';
        case 'move': return 'file-move';
        case 'search':
        case 'lsp':
        case 'memory_search':
        case 'search_tool':
            return 'project-search';
        case 'web_search': return 'web-search';
        case 'fetch':
        case 'web_fetch': return 'web-fetch';
        case 'browser': return 'browser';
        case 'execute':
            return /(?:^|[_.:/-])(?:test|tests|pytest|jest|vitest)(?:$|[_.:/-])/i.test(name) ? 'test' : 'terminal';
        case 'plan':
        case 'enter_plan':
        case 'exit_plan':
        case 'goal_update':
            return 'plan';
        case 'task':
        case 'background_task_action':
        case 'wait_tasks_action':
        case 'kill_task_action':
            return 'subagent';
    }
    const identity = `${kind}/${name}`;
    if (/(?:^|[_.:/-])(?:read|read_file|open_file|view_file|list_dir|list_files)(?:$|[_.:/-])/i.test(identity)) return 'file-read';
    if (/(?:^|[_.:/-])(?:create|create_file|new_file)(?:$|[_.:/-])/i.test(identity)) return 'file-create';
    if (/(?:^|[_.:/-])(?:edit|write|replace|patch|apply_patch)(?:$|[_.:/-])/i.test(identity)) return 'file-write';
    if (/(?:^|[_.:/-])(?:delete|remove|unlink)(?:$|[_.:/-])/i.test(identity)) return 'file-delete';
    if (/(?:^|[_.:/-])(?:move|rename)(?:$|[_.:/-])/i.test(identity)) return 'file-move';
    if (/(?:^|[_.:/-])web_search(?:$|[_.:/-])/i.test(identity)) return 'web-search';
    if (/(?:^|[_.:/-])(?:web_fetch|fetch_url)(?:$|[_.:/-])/i.test(identity)) return 'web-fetch';
    if (/(?:^|[_.:/-])(?:search|grep|find|glob|ripgrep)(?:$|[_.:/-])/i.test(identity)) return 'project-search';
    if (/(?:^|[_.:/-])(?:test|tests|pytest|jest|vitest)(?:$|[_.:/-])/i.test(identity)) return 'test';
    if (/(?:^|[_.:/-])(?:terminal|shell|exec|execute|execute_command|run_command|command)(?:$|[_.:/-])/i.test(identity)) return 'terminal';
    if (/(?:^|[_.:/-])(?:browser|playwright|computer_use)(?:$|[_.:/-])/i.test(name)) return 'browser';
    return 'other';
}

function presentationTarget(
    action: AgentToolAction,
    source: AgentToolPresentation['source'],
    input: Record<string, unknown> | undefined,
    locations: AgentToolLocation[] | undefined,
    sourceLabel: string | undefined,
    operationLabel: string | undefined
): string | undefined {
    if (source === 'mcp') return operationLabel;
    if (source === 'skill' || source === 'plugin') return sourceLabel;
    const pathValue = firstInputString(input, ['path', 'filePath', 'file_path', 'file', 'filename', 'directory'])
        ?? locations?.[0]?.path;
    if (action.startsWith('file-') && pathValue) return safeBasename(pathValue);
    if (action === 'project-search') {
        return safeUiText(firstInputString(input, ['pattern', 'query', 'symbol']), 72);
    }
    if (action === 'web-search') {
        return safeUiText(firstInputString(input, ['query', 'search_query', 'q']), 72);
    }
    if (action === 'web-fetch' || action === 'browser') {
        return safeDomain(firstInputString(input, ['url', 'uri', 'href', 'endpoint']));
    }
    if (action === 'terminal' || action === 'test') {
        return safeUiText(firstInputString(input, ['description', 'summary']), 72);
    }
    return undefined;
}

function skillName(input: Record<string, unknown> | undefined, update: Record<string, unknown>): string | undefined {
    const direct = safeEntityLabel(firstInputString(input, ['skill', 'skill_name', 'skillName', 'name']));
    if (direct) return direct;
    const title = asString(update.title)?.match(/^Skill:\s*([^\r\n-]+?)(?:\s+-\s+.*)?$/i)?.[1];
    return safeEntityLabel(title);
}

function mcpToolParts(value: string | undefined): { server: string; tool: string } | undefined {
    if (!value) return undefined;
    const parts = value.split('__').filter(Boolean);
    if (parts[0]?.toLowerCase() === 'mcp') parts.shift();
    if (parts.length < 2) return undefined;
    const server = safeEntityLabel(parts.shift());
    const tool = safeEntityLabel(parts.join('__'));
    return server && tool ? { server, tool } : undefined;
}

function firstInputString(input: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = asString(input?.[key]);
        if (value?.trim()) return value;
    }
    return undefined;
}

function safeWireName(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(normalized) ? normalized : undefined;
}

function safeToolToken(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(normalized) ? normalized.toLowerCase() : undefined;
}

function safeEntityLabel(value: string | undefined): string | undefined {
    const normalized = safeUiText(value, 64);
    if (!normalized || /[\\/]/.test(normalized) || normalized.includes('://')) return undefined;
    return normalized;
}

function safeUiText(value: string | undefined, maxLength: number): string | undefined {
    const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;
    return normalized.length > maxLength ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…` : normalized;
}

function safeBasename(value: string): string | undefined {
    const normalized = value.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/\/+$/, '');
    return safeUiText(normalized.slice(normalized.lastIndexOf('/') + 1), 72);
}

function safeDomain(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? safeUiText(url.hostname, 72) : undefined;
    } catch {
        return undefined;
    }
}

function normalizeToolStatus(status: string | undefined, updateType: string): ToolCallEvent['status'] {
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'rejected') return 'rejected';
    if (status === 'in_progress' || status === 'running') return 'running';
    return updateType === 'tool_call' ? 'pending' : 'running';
}

function textFromToolContent(value: unknown): string | undefined {
    if (!Array.isArray(value)) return undefined;
    const pieces = value.flatMap(candidate => {
        const item = asRecord(candidate);
        const content = asRecord(item?.content);
        const text = asString(content?.text) ?? asString(item?.text);
        return text ? [text] : [];
    });
    return pieces.length ? truncateToolOutput(pieces.join('\n')) : undefined;
}

function stringifySmall(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
        return truncateToolOutput(text);
    } catch {
        return '[unserializable output]';
    }
}

/** Keeps large patches/command payloads out of renderer IPC and JSONL history. */
function boundedToolInput(value: unknown): unknown {
    if (value === undefined) return undefined;
    try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (serialized.length <= 16_000) return value;
        return {
            truncated: true,
            notice: '工具参数过大，已在活动记录中省略。',
            approximateCharacters: serialized.length
        };
    } catch {
        return { truncated: true, notice: '工具参数无法安全显示。' };
    }
}

function truncateToolOutput(value: string): string {
    return value.length > 32_000 ? `${value.slice(0, 32_000)}…` : value;
}

function unifiedDiff(file: string, before: string, after: string): string {
    const oldLines = before.replace(/\n$/, '').split('\n');
    const newLines = after.replace(/\n$/, '').split('\n');
    return [
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map(line => `-${line}`),
        ...newLines.map(line => `+${line}`)
    ].join('\n');
}

function errorMessage(error: unknown): string {
    return deepRedact(error instanceof Error ? error.message : String(error));
}

function safeCliOperand(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.startsWith('-') || /[\0\r\n]/.test(normalized) || normalized.length > 4096) {
        throw new Error(`Unsafe ${label} argument.`);
    }
    return normalized;
}

function safeCliArgument(value: string): string {
    if (/\0|\r|\n/.test(value) || value.length > 4096) {
        throw new Error('Unsafe MCP process argument.');
    }
    return value;
}
