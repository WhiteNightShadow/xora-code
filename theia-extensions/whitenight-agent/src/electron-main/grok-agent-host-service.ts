import { AcpCancelledError, AcpClient, createNodeWritableSink, RequestHandle } from '@whitenight-code/acp-client';
import { dialog } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    AgentCapabilities,
    AgentHostClient,
    AgentHostEvent,
    AgentHostService,
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
import { ProviderRegistry } from './provider-registry';
import { providerModelsEndpoint, requestProviderJson } from './provider-network';
import { AgentSessionRepository, deepRedact } from './session-repository';
import { GrokSidecarSupervisor } from './sidecar-supervisor';
import { SidecarUpdateCoordinator } from './sidecar-update-coordinator';
import { PermissionSubject, WorkspaceSecurityStore } from './workspace-security';

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

interface InitializeResponse {
    protocolVersion?: number;
    agentCapabilities?: Record<string, unknown>;
    authMethods?: Array<Record<string, unknown>>;
    agentInfo?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    models?: unknown;
}

/** One instance is created for each Electron renderer connection/window. */
export class GrokAgentHostService implements AgentHostService {
    protected client: AgentHostClient | undefined;
    protected readonly supervisor = new GrokSidecarSupervisor();
    protected readonly sessions = new AgentSessionRepository();
    protected readonly pendingPermissions = new Map<string, PendingPermission>();
    protected readonly activePrompts = new Map<string, RequestHandle<Record<string, unknown>>>();
    protected readonly revertableDiffs = new Map<string, RevertableDiff>();
    protected readonly knownSessionIds = new Set<string>();
    protected readonly acpSessionLookup = new Map<string, string>();
    protected acp: AcpClient | undefined;
    protected consumeTask: Promise<void> | undefined;
    protected managementChild: ChildProcess | undefined;
    protected workspaceRoot: string | undefined;
    protected providerId = 'grok-subscription';
    protected activeSessionId: string | undefined;
    protected phase: RuntimeSnapshot['phase'] = 'stopped';
    protected capabilities: AgentCapabilities | undefined;
    protected models: AgentModelOption[] = [];
    protected selectedModel: string | undefined;
    protected sidecarVersion: string | undefined;
    protected supportsAdditionalDirectories = false;
    protected intentionalStop = false;
    protected runtimeGeneration = 0;
    protected currentSecrets: string[] = [];
    /** Persistent trust alone never enables a newly connected window. */
    protected readonly theiaTrustedRoots = new Set<string>();
    protected lifecycleTail: Promise<void> = Promise.resolve();
    protected disposed = false;

    constructor(
        protected readonly providers: ProviderRegistry,
        protected readonly security: WorkspaceSecurityStore,
        protected readonly onAuthenticationChanged: () => void,
        protected readonly updates: SidecarUpdateCoordinator,
        protected readonly canApplyUpdate: () => boolean
    ) {
        for (const session of this.sessions.list()) {
            this.knownSessionIds.add(session.appSessionId);
            if (session.acpSessionId) this.acpSessionLookup.set(session.acpSessionId, session.appSessionId);
        }
    }

    setClient(client: AgentHostClient | undefined): void {
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
        if (this.workspaceRoot !== canonical) {
            // Selecting a root is deliberately not a trust assertion. The
            // browser must follow with Theia's resolved workspace decision.
            this.theiaTrustedRoots.clear();
            if (this.runtimeActive) {
                await this.stopRuntime();
            }
        }
        this.workspaceRoot = canonical;
        const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
        if (!active || active.workspaceRoot !== canonical) {
            this.activeSessionId = undefined;
        }
        this.emitSnapshot();
        return this.snapshot();
    }

    async synchronizeWorkspaceTrust(request: SynchronizeWorkspaceTrustRequest): Promise<RuntimeSnapshot> {
        if (request.workspaceRoots.length > 256) {
            throw new Error('Workspace trust synchronization contains too many roots.');
        }
        if (request.trusted) {
            const canonicalRoots = [...new Set(request.workspaceRoots.map(root => this.security.canonicalRoot(root)))];
            if (!this.workspaceRoot || !canonicalRoots.includes(this.workspaceRoot)) {
                throw new Error('The selected Agent root must belong to the trusted Theia workspace.');
            }
            this.security.synchronizeTrust(canonicalRoots, true);
            this.theiaTrustedRoots.clear();
            for (const root of canonicalRoots) this.theiaTrustedRoots.add(root);
            this.emitSnapshot();
            return this.snapshot();
        }

        // Revoke the in-memory grant before awaiting shutdown so every new
        // privileged call fails as soon as Theia publishes the change.
        this.theiaTrustedRoots.clear();
        const shouldStop = this.runtimeActive || this.phase !== 'stopped';
        if (shouldStop) {
            this.interruptRuntimeForTrustRevocation();
        }
        let persistenceError: unknown;
        try {
            this.security.synchronizeTrust(request.workspaceRoots, false);
        } catch (error) {
            persistenceError = error;
        }
        this.emitSnapshot('Theia revoked workspace trust; stopping executable Agent activity.');
        if (shouldStop) {
            await this.stopRuntime();
        }
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
        if (!this.isWorkspaceTrusted(root)) {
            throw new Error('Trust this project before starting the Agent runtime.');
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
        this.workspaceRoot = root;
        this.providerId = provider.id;
        this.phase = 'starting';
        this.intentionalStop = false;
        this.emitSnapshot();

        try {
            const environment = {
                ...this.providers.mcpEnvironment(root),
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
                clientInfo: { name: 'WhiteNight Code', title: 'WhiteNight Code', version: '0.1.0' }
            }, { timeoutMs: 30_000 });
            if (generation !== this.runtimeGeneration) {
                throw new AcpCancelledError('initialize', 'initialize', 'Runtime generation changed.');
            }
            this.acceptInitialize(initialized);

            const desiredMethod = provider.kind === 'grok-subscription'
                ? this.capabilities?.defaultAuthMethodId ?? 'grok.com'
                : 'xai.api_key';
            const method = this.capabilities?.authMethods.find(item => item.id === desiredMethod)?.id;
            if (method) {
                this.phase = 'auth-required';
                if (provider.kind === 'grok-subscription') {
                    this.emitSnapshot('Grok subscription authentication is ready. WhiteNight Code is waiting for your confirmation.');
                } else if (provider.kind === 'xai-api-key') {
                    this.emitSnapshot('xAI API authentication is ready. Confirm before Grok Build accesses the shared ~/.grok authentication state.');
                } else {
                    this.emitSnapshot(`The configured API credential is ready for ${this.capabilities?.authMethods.find(item => item.id === method)?.name ?? method}.`);
                }
            } else if ((this.capabilities?.authMethods.length ?? 0) > 0) {
                this.phase = 'auth-required';
                this.emitSnapshot('Choose one of the authentication methods advertised by Grok Build.');
            } else {
                this.phase = 'ready';
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
        return this.withLifecycle(() => this.stopRuntimeLocked());
    }

    protected async stopRuntimeLocked(): Promise<void> {
        ++this.runtimeGeneration;
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
        this.acp?.close(new Error('WhiteNight Code stopped the sidecar.'));
        this.acp = undefined;
        if (this.managementChild) {
            this.supervisor.terminateProcessTree(this.managementChild, true);
            this.managementChild = undefined;
        }
        await this.supervisor.stop();
        await this.consumeTask?.catch(() => undefined);
        this.consumeTask = undefined;
        this.sessions.flushEvents();
        this.phase = 'stopped';
        this.capabilities = undefined;
        this.models = [];
        this.selectedModel = undefined;
        this.sidecarVersion = undefined;
        this.currentSecrets = [];
        this.emitSnapshot();
    }

    async authenticate(methodId: string): Promise<void> {
        const acp = this.requireAcp();
        if (!this.capabilities?.authMethods.some(method => method.id === methodId)) {
            throw new Error('The sidecar did not advertise this authentication method.');
        }
        await acp.request('authenticate', { methodId }, { timeoutMs: 5 * 60_000 });
        this.phase = 'ready';
        this.onAuthenticationChanged();
        this.emitSnapshot();
    }

    async createSession(request: CreateSessionRequest): Promise<SessionRecord> {
        const acp = this.requireReady();
        const root = this.security.canonicalRoot(request.workspaceRoot);
        if (root !== this.workspaceRoot || request.providerId !== this.providerId) {
            throw new Error('Restart the runtime for the selected workspace and Provider first.');
        }
        const provider = this.providers.get(request.providerId);
        const effectiveModel = request.model ?? (provider?.kind === 'custom' ? provider.id : this.selectedModel);
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
        this.acceptModelState(modelStateFrom(result));
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
        this.activeSessionId = record.appSessionId;
        this.emit({ kind: 'session', session: record });
        this.emitSnapshot();
        return record;
    }

    async loadSession(appSessionId: string): Promise<SessionRecord> {
        const record = this.sessions.get(appSessionId);
        if (!record?.acpSessionId) {
            throw new Error('This history has no recoverable ACP session.');
        }
        this.knownSessionIds.add(appSessionId);
        this.acpSessionLookup.set(record.acpSessionId, appSessionId);
        if (!this.acp || this.workspaceRoot !== record.workspaceRoot || this.providerId !== record.providerId) {
            await this.startRuntime({ workspaceRoot: record.workspaceRoot, providerId: record.providerId });
        }
        try {
            if (this.phase === 'auth-required') {
                throw new Error('AUTHENTICATION_REQUIRED');
            }
            const result = await this.requireReady().request<Record<string, unknown>>('session/load', {
                sessionId: record.acpSessionId,
                cwd: record.workspaceRoot,
                mcpServers: [],
                ...(record.model ? { _meta: { modelId: record.model } } : {})
            }, { timeoutMs: 60_000 });
            this.acceptModelState(modelStateFrom(result));
            const loaded = this.sessions.update(appSessionId, { status: 'idle', sidecarVersion: this.sidecarVersion });
            this.activeSessionId = appSessionId;
            this.emit({ kind: 'session', session: loaded });
            this.emitSnapshot();
            return loaded;
        } catch (error) {
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
            throw new Error('Unknown WhiteNight Code session.');
        }
        this.knownSessionIds.add(appSessionId);
        return deepRedact(this.sessions.readEvents(appSessionId), this.currentSecrets);
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
        if (this.activePrompts.has(request.sessionId)) {
            throw new Error('This session already has a running task.');
        }
        this.emit({ kind: 'text-delta', sessionId: request.sessionId, role: 'user', text: request.text });
        const running = this.sessions.update(request.sessionId, { status: 'running' });
        this.emit({ kind: 'session', session: running });
        try {
            const handle = acp.startRequest<Record<string, unknown>>('session/prompt', {
                sessionId: record.acpSessionId,
                prompt: [{ type: 'text', text: request.text }]
            }, {
                timeoutMs: 0,
                cancellation: { method: 'session/cancel', params: { sessionId: record.acpSessionId } }
            });
            this.activePrompts.set(request.sessionId, handle);
            const result = await handle.promise;
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
                throw new Error('WhiteNight Code requires a sidecar allow-once option to enforce desktop policy.');
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
        this.emit({ kind: 'session', session: updated });
        this.emitSnapshot();
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
        const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.wnc-revert`;
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
        if (!this.providers.get(providerId)) {
            throw new Error('Unknown Provider profile.');
        }
        if (this.activePrompts.size > 0) {
            throw new Error('Cancel or finish the current task before switching credentials.');
        }
        if (this.supervisor.running || this.acp) {
            await this.stopRuntime();
        }
        this.providerId = providerId;
        this.activeSessionId = undefined;
        this.models = [];
        this.selectedModel = undefined;
        this.emitSnapshot();
        return this.snapshot();
    }

    async fetchProviderModels(providerId: string): Promise<AgentModelOption[]> {
        const provider = this.providers.get(providerId);
        if (!provider || provider.kind !== 'custom' || !provider.baseUrl) {
            throw new Error('Model discovery is available for custom API Providers.');
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
        return this.providers.save(profile, apiKey);
    }

    async deleteProvider(providerId: string): Promise<void> {
        if (providerId === this.providerId && this.supervisor.running) {
            throw new Error('Stop the current runtime before deleting its Provider.');
        }
        this.providers.delete(providerId);
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
            return { ok: false, error: 'Trust the selected project before running Grok inspect.' };
        }
        return this.runCli(['inspect', '--json']);
    }

    async runManagementCommand(command: 'mcp-list' | 'mcp-doctor' | 'plugin-list' | 'plugin-marketplaces'): Promise<ManagementResult> {
        if (!this.workspaceRoot || !this.isWorkspaceTrusted(this.workspaceRoot)) {
            return { ok: false, error: 'Trust the selected project before running Grok management commands.' };
        }
        const commands: Record<typeof command, string[]> = {
            'mcp-list': ['mcp', 'list', '--json'],
            'mcp-doctor': ['mcp', 'doctor', '--json'],
            'plugin-list': ['plugin', 'list', '--json'],
            'plugin-marketplaces': ['plugin', 'marketplace', 'list', '--json']
        };
        return this.runCli(commands[command]);
    }

    async manage(request: ManagementRequest): Promise<ManagementResult> {
        if (!this.workspaceRoot || !this.isWorkspaceTrusted(this.workspaceRoot)) {
            return { ok: false, error: 'Trust a project before changing executable integrations.' };
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
            if (request.action === 'remove') {
                this.providers.deleteMcpCredential(this.workspaceRoot, request.name);
                return result;
            }
            if (request.action === 'add' && request.secretValue) {
                const remote = request.transport === 'http' || request.transport === 'sse';
                const environmentName = remote
                    ? `WHITENIGHT_CODE_MCP_${request.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_TOKEN`
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
        this.client = undefined;
        this.disposed = true;
        ++this.runtimeGeneration;
        this.intentionalStop = true;
        this.acp?.close(new Error('WhiteNight Code is shutting down.'));
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
        this.emitSnapshot('Grok authentication changed in another window or CLI-compatible flow.');
    }

    notifySharedGrokStateChanged(): void {
        this.emitSnapshot('Shared Grok configuration or authentication changed; management views will re-read ~/.grok on refresh.');
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
            // Unknown extensions are intentionally tolerated. Persisting only a
            // redacted diagnostic marker avoids exposing payload secrets.
            const appSessionId = this.appSessionForAcp(asString(asRecord(params)?.sessionId));
            if (appSessionId) {
                this.sessions.appendEvent(appSessionId, {
                    kind: 'text-delta', sessionId: appSessionId, role: 'system', text: `Ignored compatible ACP extension: ${method}`
                });
            }
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
        if (typeof state.currentModelId === 'string') {
            this.selectedModel = state.currentModelId;
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
        this.emitSnapshot();
    }

    protected acceptSessionUpdate(params: unknown): void {
        const envelope = asRecord(params);
        const acpSessionId = asString(envelope?.sessionId);
        const update = asRecord(envelope?.update);
        const type = asString(update?.sessionUpdate);
        const appSessionId = this.appSessionForAcp(acpSessionId);
        if (!appSessionId || !type || !update) {
            return;
        }
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

    protected acceptToolUpdate(appSessionId: string, update: Record<string, unknown>, type: string): void {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) {
            return;
        }
        const status = normalizeToolStatus(asString(update.status), type);
        const output = textFromToolContent(update.content) ?? stringifySmall(update.rawOutput);
        const event: ToolCallEvent = {
            kind: 'tool-call',
            sessionId: appSessionId,
            toolCallId,
            title: asString(update.title) ?? toolCallId,
            toolName: asString(update.kind) ?? 'tool',
            status,
            input: deepRedact(update.rawInput),
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
                        const before = this.sessions.saveBeforeImage(appSessionId, changedPath, oldText);
                        const newHash = crypto.createHash('sha256').update(newText).digest('hex');
                        const diffId = crypto.randomUUID();
                        const targetPath = path.isAbsolute(changedPath) ? changedPath : path.resolve(this.workspaceRoot!, changedPath);
                        this.safeWorkspaceFile(targetPath);
                        this.revertableDiffs.set(diffId, { targetPath, beforePath: before.path, expectedNewHash: newHash });
                        this.emit({
                            kind: 'diff',
                            diffId,
                            sessionId: appSessionId,
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
        const location = Array.isArray(tool.locations) ? asRecord(tool.locations[0]) : undefined;
        const rawInput = asRecord(tool.rawInput);
        const subject: PermissionSubject = {
            toolName: asString(tool.kind) ?? asString(tool.title) ?? 'unknown',
            path: asString(location?.path) ?? asString(rawInput?.path),
            command: asString(rawInput?.command),
            mcpServer: asString(rawInput?.server) ?? asString(rawInput?.mcpServer)
        };
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
            toolCallId: asString(tool.toolCallId),
            title: asString(tool.title) ?? `Allow ${subject.toolName}?`,
            detail: stringifySmall(deepRedact(tool.rawInput)),
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
        const workspaceTrusted = this.workspaceRoot ? this.isWorkspaceTrusted(this.workspaceRoot) : false;
        return {
            phase: this.phase,
            workspaceRoot: this.workspaceRoot,
            workspaceTrusted,
            providerId: this.providerId,
            sidecarVersion: this.sidecarVersion,
            capabilities: this.capabilities,
            models: this.models.map(model => ({ ...model })),
            selectedModel: this.selectedModel,
            sessions: this.sessions.list(),
            activeSessionId: this.activeSessionId,
            message
        };
    }

    protected emitSnapshot(message?: string): void {
        this.emit({ kind: 'snapshot', snapshot: this.snapshot(message) }, false);
    }

    protected emit(event: AgentHostEvent, persist = true): void {
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
        this.phase = 'crashed';
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
        this.emitSnapshot('The sidecar stopped. WhiteNight Code will never replay the last prompt automatically.');
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

    protected isWorkspaceTrusted(root: string): boolean {
        const canonical = this.security.canonicalRoot(root);
        return this.theiaTrustedRoots.has(canonical) && this.security.isTrusted(canonical);
    }

    protected interruptRuntimeForTrustRevocation(): void {
        ++this.runtimeGeneration;
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

    protected runCli(args: string[], expectJson = true): Promise<ManagementResult> {
        if (this.supervisor.running) {
            return Promise.resolve({ ok: false, error: 'Stop the Agent runtime before running a management command in this window.' });
        }
        if (this.managementChild && this.managementChild.exitCode === null) {
            return Promise.resolve({ ok: false, error: 'Another Grok management command is already running in this window.' });
        }
        const root = this.workspaceRoot ?? process.cwd();
        const binary = this.supervisor.binaryPath();
        const exactSecrets = this.providers.redactionSecrets();
        return new Promise(resolve => {
            const child = spawn(binary, ['--no-auto-update', '--cwd', root, ...args], {
                cwd: root,
                env: this.supervisor.commandEnvironment(this.providers.mcpEnvironment(root)),
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
            child.once('error', error => finish({ ok: false, error: errorMessage(error) }));
            child.once('exit', code => {
                if (settled) return;
                const stderr = deepRedact(Buffer.concat(errors).toString('utf8'), exactSecrets).trim();
                if (code !== 0) {
                    finish({ ok: false, error: stderr || `Grok command exited with code ${code}.` });
                    return;
                }
                const stdout = Buffer.concat(output).toString('utf8');
                if (!expectJson) {
                    finish({ ok: true, data: { output: deepRedact(stdout.trim(), exactSecrets), stderr } });
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
                finish({ ok: false, error: 'Grok command timed out after 30 seconds.' });
            }, 30_000);
        });
    }
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
    return pieces.length ? pieces.join('\n') : undefined;
}

function stringifySmall(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
        return text.length > 32_000 ? `${text.slice(0, 32_000)}…` : text;
    } catch {
        return '[unserializable output]';
    }
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
