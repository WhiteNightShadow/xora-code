import { injectable } from '@theia/core/shared/inversify';
import {
    AgentHostClient,
    AgentHostEvent,
    AgentHostService,
    CreateSessionRequest,
    ComponentUpdateResult,
    ComponentUpdateStatus,
    ManagementRequest,
    ManagementResult,
    PermissionDecision,
    PromptRequest,
    ProviderProfile,
    RuntimeSnapshot,
    SessionRecord,
    StartRuntimeRequest,
    SynchronizeWorkspaceTrustRequest
} from '../common/agent-protocol';

@injectable()
export class FakeAgentHostService implements AgentHostService {
    protected client: AgentHostClient | undefined;
    protected trustedRoots = new Set<string>();
    protected theiaTrustedRoots = new Set<string>();
    protected pendingPermissions = new Map<string, () => void>();
    protected sequence = 0;
    protected snapshot: RuntimeSnapshot = {
        phase: 'stopped',
        workspaceTrusted: false,
        providerId: 'grok-subscription',
        sidecarVersion: 'fake-0.1.0',
        models: [
            { id: 'grok', name: 'Grok (fixture)', contextWindow: 1_000_000 },
            { id: 'fixture-model', name: 'Fixture Model', contextWindow: 128_000 }
        ],
        selectedModel: 'grok',
        sessions: []
    };

    setClient(client: AgentHostClient | undefined): void {
        this.client = client;
    }

    async getSnapshot(): Promise<RuntimeSnapshot> {
        return this.cloneSnapshot();
    }

    async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<RuntimeSnapshot> {
        if (workspaceRoot !== this.snapshot.workspaceRoot) {
            this.theiaTrustedRoots.clear();
            if (this.snapshot.phase !== 'stopped') await this.stopRuntime();
        }
        this.snapshot.workspaceRoot = workspaceRoot;
        this.snapshot.workspaceTrusted = false;
        return this.publishSnapshot();
    }

    async synchronizeWorkspaceTrust(request: SynchronizeWorkspaceTrustRequest): Promise<RuntimeSnapshot> {
        if (request.trusted) {
            if (!this.snapshot.workspaceRoot || !request.workspaceRoots.includes(this.snapshot.workspaceRoot)) {
                throw new Error('The selected Agent root must belong to the trusted Theia workspace.');
            }
            for (const root of request.workspaceRoots) this.trustedRoots.add(root);
            this.theiaTrustedRoots = new Set(request.workspaceRoots);
            this.snapshot.workspaceTrusted = this.isWorkspaceTrusted(this.snapshot.workspaceRoot);
            return this.publishSnapshot();
        }
        for (const root of request.workspaceRoots) this.trustedRoots.delete(root);
        this.theiaTrustedRoots.clear();
        this.snapshot.workspaceTrusted = false;
        for (const resolve of this.pendingPermissions.values()) resolve();
        this.pendingPermissions.clear();
        if (this.snapshot.phase !== 'stopped') {
            await this.stopRuntime();
        }
        return this.publishSnapshot();
    }

    async startRuntime(request: StartRuntimeRequest): Promise<RuntimeSnapshot> {
        if (request.workspaceRoot !== this.snapshot.workspaceRoot) {
            throw new Error('Select this Agent root before starting its runtime.');
        }
        if (!this.isWorkspaceTrusted(request.workspaceRoot)) {
            throw new Error('The workspace is not trusted.');
        }
        this.snapshot.workspaceRoot = request.workspaceRoot;
        this.snapshot.workspaceTrusted = true;
        this.snapshot.providerId = request.providerId;
        this.snapshot.phase = 'starting';
        this.publishSnapshot();
        this.snapshot.phase = 'initializing';
        this.publishSnapshot();
        this.snapshot.capabilities = {
            protocolVersion: 1,
            loadSession: true,
            prompt: { image: false, audio: false, embeddedContext: true },
            mcp: { http: true, sse: true },
            authMethods: [
                { id: 'xai.api_key', name: 'xAI API Key' },
                { id: 'grok.com', name: 'Grok subscription' }
            ],
            defaultAuthMethodId: request.providerId === 'grok-subscription' ? 'grok.com' : 'xai.api_key'
        };
        this.snapshot.phase = 'ready';
        return this.publishSnapshot();
    }

    async stopRuntime(): Promise<void> {
        this.snapshot.phase = 'stopped';
        this.publishSnapshot();
    }

    async authenticate(_methodId: string): Promise<void> {
        this.snapshot.phase = 'ready';
        this.publishSnapshot();
    }

    async createSession(request: CreateSessionRequest): Promise<SessionRecord> {
        const now = new Date().toISOString();
        const id = `fixture-${++this.sequence}`;
        const session: SessionRecord = {
            appSessionId: id,
            acpSessionId: id,
            title: request.title ?? 'New session',
            workspaceRoot: request.workspaceRoot,
            providerId: request.providerId,
            model: request.model ?? this.snapshot.selectedModel,
            sidecarVersion: this.snapshot.sidecarVersion,
            createdAt: now,
            updatedAt: now,
            status: 'idle'
        };
        this.snapshot.sessions.unshift(session);
        this.snapshot.activeSessionId = id;
        this.client?.onAgentEvent({ kind: 'session', session });
        this.publishSnapshot();
        return session;
    }

    async loadSession(appSessionId: string): Promise<SessionRecord> {
        const session = this.requireSession(appSessionId);
        this.snapshot.activeSessionId = appSessionId;
        this.client?.onAgentEvent({ kind: 'session', session });
        return session;
    }

    async getSessionHistory(_appSessionId: string): Promise<AgentHostEvent[]> {
        return [];
    }

    async sendPrompt(request: PromptRequest): Promise<void> {
        const session = this.requireSession(request.sessionId);
        session.status = 'running';
        session.updatedAt = new Date().toISOString();
        this.client?.onAgentEvent({ kind: 'session', session });
        this.client?.onAgentEvent({
            kind: 'plan',
            sessionId: request.sessionId,
            title: 'Fixture plan',
            entries: [
                { id: 'inspect', text: 'Inspect the project', status: 'completed' },
                { id: 'change', text: 'Prepare the requested change', status: 'in-progress' },
                { id: 'verify', text: 'Verify the result', status: 'pending' }
            ]
        });
        const words = `Fixture response for: ${request.text}`.split(' ');
        for (const word of words) {
            await new Promise(resolve => setTimeout(resolve, 12));
            this.client?.onAgentEvent({ kind: 'text-delta', sessionId: request.sessionId, role: 'assistant', text: `${word} ` });
        }
        const permissionId = `permission-${++this.sequence}`;
        this.client?.onAgentEvent({
            kind: 'permission-request',
            sessionId: request.sessionId,
            requestId: permissionId,
            title: 'Run fixture verification',
            detail: 'npm test',
            options: ['allow-once', 'allow-always', 'reject']
        });
        await new Promise<void>(resolve => this.pendingPermissions.set(permissionId, resolve));
        session.status = 'completed';
        session.updatedAt = new Date().toISOString();
        this.client?.onAgentEvent({ kind: 'session', session });
        this.client?.onAgentEvent({ kind: 'turn-completed', sessionId: request.sessionId, stopReason: 'end_turn' });
    }

    async cancel(sessionId: string): Promise<void> {
        const session = this.requireSession(sessionId);
        session.status = 'cancelled';
        session.updatedAt = new Date().toISOString();
        this.client?.onAgentEvent({ kind: 'session', session });
    }

    async respondPermission(decision: PermissionDecision): Promise<void> {
        const resolve = this.pendingPermissions.get(decision.requestId);
        this.pendingPermissions.delete(decision.requestId);
        resolve?.();
    }

    async selectModel(sessionId: string, modelId: string): Promise<void> {
        const session = this.requireSession(sessionId);
        session.model = modelId;
        session.updatedAt = new Date().toISOString();
        this.snapshot.selectedModel = modelId;
        this.client?.onAgentEvent({ kind: 'session', session });
        this.publishSnapshot();
    }

    async revertDiff(_diffId: string): Promise<void> {
    }

    async listProviders(): Promise<ProviderProfile[]> {
        return [
            { id: 'grok-subscription', name: 'Grok subscription', kind: 'grok-subscription', managed: true },
            { id: 'xai-api-key', name: 'xAI API Key', kind: 'xai-api-key', secretRef: 'provider:xai-api-key', managed: true }
        ];
    }

    async selectProvider(providerId: string): Promise<RuntimeSnapshot> {
        this.snapshot.providerId = providerId;
        this.snapshot.activeSessionId = undefined;
        return this.publishSnapshot();
    }

    async fetchProviderModels(_providerId: string) {
        return this.snapshot.models.map(model => ({ ...model }));
    }

    async saveProvider(profile: ProviderProfile, _apiKey?: string): Promise<ProviderProfile> {
        return { ...profile };
    }

    async deleteProvider(_providerId: string): Promise<void> {
    }

    async getSidecarUpdateStatus(): Promise<ComponentUpdateStatus> {
        return { enabled: true, configured: true, channel: 'stable', message: 'Fixture component updater is ready.' };
    }

    async applySidecarUpdate(): Promise<ComponentUpdateResult> {
        return { status: 'up-to-date', version: 'fake-0.1.0' };
    }

    async rollbackSidecarUpdate(): Promise<ComponentUpdateResult> {
        return { status: 'installed', version: 'fake-previous' };
    }

    async inspect(): Promise<ManagementResult> {
        return { ok: true, data: { fixture: true, skills: [], mcpServers: [], plugins: [] } };
    }

    async runManagementCommand(command: 'mcp-list' | 'mcp-doctor' | 'plugin-list' | 'plugin-marketplaces'): Promise<ManagementResult> {
        return { ok: true, data: { fixture: true, command, items: [] } };
    }

    async manage(request: ManagementRequest): Promise<ManagementResult> {
        return { ok: true, data: { fixture: true, request } };
    }

    dispose(): void {
        this.client = undefined;
        for (const resolve of this.pendingPermissions.values()) resolve();
        this.pendingPermissions.clear();
    }

    protected requireSession(id: string): SessionRecord {
        const session = this.snapshot.sessions.find(candidate => candidate.appSessionId === id);
        if (!session) {
            throw new Error(`Unknown session: ${id}`);
        }
        return session;
    }

    protected publishSnapshot(): RuntimeSnapshot {
        const snapshot = this.cloneSnapshot();
        this.client?.onAgentEvent({ kind: 'snapshot', snapshot });
        return snapshot;
    }

    protected cloneSnapshot(): RuntimeSnapshot {
        return JSON.parse(JSON.stringify(this.snapshot)) as RuntimeSnapshot;
    }

    protected isWorkspaceTrusted(root: string): boolean {
        return this.trustedRoots.has(root) && this.theiaTrustedRoots.has(root);
    }
}
