import { injectable } from '@theia/core/shared/inversify';
import * as path from 'path';
import {
    AgentPermissionMode,
    AgentToolPresentation,
    AgentHostClient,
    AgentHostEvent,
    AgentHostService,
    AuthenticationResult,
    CreateSessionRequest,
    ComponentUpdateResult,
    ComponentUpdateStatus,
    GuidePromptRequest,
    GuidePromptResult,
    ExportSessionResult,
    ManagementRequest,
    ManagementResult,
    PermissionDecision,
    PlanApprovalDecision,
    PromptRequest,
    ProviderProfile,
    RuntimeSnapshot,
    SessionRecord,
    StartRuntimeRequest,
    SynchronizeWorkspaceTrustRequest
} from '../common/agent-protocol';
import { normalizeWindowsFilesystemPath } from '../common/workspace-path';
import { validatePromptImageAttachments } from '../electron-main/prompt-image-attachments';

@injectable()
export class FakeAgentHostService implements AgentHostService {
    protected client: AgentHostClient | undefined;
    protected trustedRoots = new Set<string>();
    protected theiaTrustedRoots = new Set<string>();
    protected attachedWorkspaceRoots = new Set<string>();
    protected pendingPermissions = new Map<string, { sessionId: string; resolve: () => void }>();
    protected authenticationConfirmations = new Set<string>();
    protected sequence = 0;
    protected providerProfiles: ProviderProfile[] = [
        { id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription', managed: true },
        { id: 'xai-api-key', name: 'xAI API 密钥', kind: 'xai-api-key', secretRef: 'provider:xai-api-key', managed: true }
    ];
    protected configuredCredentials = new Set<string>();
    protected preferredModels = new Map<string, string>([['grok-subscription', 'grok']]);
    protected snapshot: RuntimeSnapshot = {
        revision: 0,
        phase: 'stopped',
        workspaceAttached: false,
        workspaceTrusted: false,
        providerId: 'grok-subscription',
        grokSubscriptionAuthStatus: 'unknown',
        sidecarVersion: 'fake-0.1.0',
        models: [
            { id: 'grok', name: 'Grok (fixture)', contextWindow: 1_000_000 },
            { id: 'fixture-model', name: 'Fixture Model', contextWindow: 128_000 }
        ],
        selectedModel: 'grok',
        sessions: [],
        permissionMode: 'request-approval'
    };

    setClient(client: AgentHostClient | undefined): void {
        this.client = client;
    }

    async getSnapshot(): Promise<RuntimeSnapshot> {
        return this.cloneSnapshot();
    }

    async setWorkspaceRoot(workspaceRoot: string | undefined): Promise<RuntimeSnapshot> {
        const canonical = workspaceRoot ? this.canonicalRoot(workspaceRoot) : undefined;
        if (canonical !== this.snapshot.workspaceRoot) {
            this.theiaTrustedRoots.clear();
            this.attachedWorkspaceRoots.clear();
            if (this.snapshot.phase !== 'stopped') await this.stopRuntime();
        }
        this.snapshot.workspaceRoot = canonical;
        this.snapshot.workspaceAttached = !!canonical && this.attachedWorkspaceRoots.has(canonical);
        this.snapshot.workspaceTrusted = !!canonical && this.isWorkspaceTrusted(canonical);
        return this.publishSnapshot();
    }

    async synchronizeWorkspaceTrust(request: SynchronizeWorkspaceTrustRequest): Promise<RuntimeSnapshot> {
        if (request.workspaceRoots.length > 256) {
            throw new Error('Workspace trust synchronization contains too many roots.');
        }
        const canonicalRoots = [...new Set(request.workspaceRoots.map(root => this.canonicalRoot(root)))];
        if ((!this.snapshot.workspaceRoot && canonicalRoots.length > 0)
            || (this.snapshot.workspaceRoot && !canonicalRoots.includes(this.snapshot.workspaceRoot))) {
            throw new Error('The selected Agent root must belong to the open Theia workspace.');
        }
        this.attachedWorkspaceRoots = new Set(canonicalRoots);
        this.snapshot.workspaceAttached = !!this.snapshot.workspaceRoot
            && this.attachedWorkspaceRoots.has(this.snapshot.workspaceRoot);
        if (request.trusted) {
            for (const root of canonicalRoots) this.trustedRoots.add(root);
            this.theiaTrustedRoots = new Set(canonicalRoots);
            this.snapshot.workspaceTrusted = !!this.snapshot.workspaceRoot
                && this.isWorkspaceTrusted(this.snapshot.workspaceRoot);
            return this.publishSnapshot();
        }
        for (const root of canonicalRoots) this.trustedRoots.delete(root);
        this.theiaTrustedRoots.clear();
        this.snapshot.workspaceTrusted = false;
        for (const pending of this.pendingPermissions.values()) pending.resolve();
        this.pendingPermissions.clear();
        return this.publishSnapshot();
    }

    async startRuntime(request: StartRuntimeRequest): Promise<RuntimeSnapshot> {
        const root = this.canonicalRoot(request.workspaceRoot);
        if (root !== this.snapshot.workspaceRoot) {
            throw new Error('Select this Agent root before starting its runtime.');
        }
        if (!this.attachedWorkspaceRoots.has(root)) {
            throw new Error('The selected Agent root is not attached to the current Theia workspace.');
        }
        this.snapshot.workspaceRoot = root;
        this.snapshot.workspaceAttached = true;
        this.snapshot.workspaceTrusted = this.isWorkspaceTrusted(root);
        this.snapshot.providerId = request.providerId;
        this.snapshot.phase = 'starting';
        this.publishSnapshot();
        this.snapshot.phase = 'initializing';
        this.publishSnapshot();
        this.snapshot.capabilities = {
            protocolVersion: 1,
            loadSession: true,
            guidePrompt: true,
            goal: { available: true, command: true, updateTool: true },
            sessionModes: true,
            prompt: { image: true, audio: false, embeddedContext: true },
            mcp: { http: true, sse: true },
            authMethods: [
                { id: 'xai.api_key', name: 'xAI API 密钥' },
                { id: 'grok.com', name: 'Grok 订阅' }
            ],
            defaultAuthMethodId: request.providerId === 'grok-subscription' ? 'grok.com' : 'xai.api_key'
        };
        this.snapshot.phase = 'ready';
        if (request.providerId === 'grok-subscription') {
            this.snapshot.grokSubscriptionAuthStatus = 'authenticated';
        }
        return this.publishSnapshot();
    }

    async stopRuntime(): Promise<void> {
        this.snapshot.phase = 'stopped';
        this.publishSnapshot();
    }

    async authenticate(_methodId: string, sharedStateConfirmed = false): Promise<AuthenticationResult> {
        const providerId = this.snapshot.providerId;
        if (!this.authenticationConfirmations.has(providerId) && !sharedStateConfirmed) {
            return { status: 'confirmation-required' };
        }
        if (sharedStateConfirmed) this.authenticationConfirmations.add(providerId);
        this.snapshot.phase = 'ready';
        if (providerId === 'grok-subscription') {
            this.snapshot.grokSubscriptionAuthStatus = 'authenticated';
        }
        this.publishSnapshot();
        return { status: 'authenticated' };
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
            availableModes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }],
            currentModeId: request.modeId ?? 'code',
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
        this.publishSnapshot();
        return session;
    }

    async renameSession(appSessionId: string, title: string): Promise<SessionRecord> {
        const session = this.requireSession(appSessionId);
        const nextTitle = title.trim().slice(0, 120);
        if (!nextTitle) throw new Error('会话名称不能为空。');
        session.title = nextTitle;
        session.updatedAt = new Date().toISOString();
        this.client?.onAgentEvent({ kind: 'session', session });
        this.publishSnapshot();
        return session;
    }

    async deleteSession(appSessionId: string): Promise<void> {
        const index = this.snapshot.sessions.findIndex(session => session.appSessionId === appSessionId);
        if (index < 0) throw new Error(`Unknown session: ${appSessionId}`);
        this.snapshot.sessions.splice(index, 1);
        if (this.snapshot.activeSessionId === appSessionId) {
            this.snapshot.activeSessionId = undefined;
        }
        this.publishSnapshot();
    }

    async getSessionHistory(_appSessionId: string): Promise<AgentHostEvent[]> {
        return [];
    }

    async exportSession(_appSessionId: string): Promise<ExportSessionResult> {
        return { status: 'cancelled' };
    }

    async setSessionMode(appSessionId: string, modeId: string): Promise<SessionRecord> {
        const session = this.requireSession(appSessionId);
        if (!session.availableModes?.some(mode => mode.id === modeId)) throw new Error('Unsupported Agent mode.');
        session.currentModeId = modeId;
        session.updatedAt = new Date().toISOString();
        this.client?.onAgentEvent({ kind: 'session', session });
        return session;
    }

    async respondPlanApproval(_decision: PlanApprovalDecision): Promise<void> {
        // Browser-only fake sessions do not park live reverse requests. The
        // full fake ACP process owns Plan approval contract tests.
    }

    async sendPrompt(request: PromptRequest): Promise<void> {
        const promptStartedAt = Date.now();
        const session = this.requireSession(request.sessionId);
        if (typeof request.text !== 'string') throw new Error('Prompt text must be a string.');
        if (request.attachments !== undefined && !Array.isArray(request.attachments)) {
            throw new Error('Image attachments must be an array.');
        }
        if (request.attachments?.length && this.snapshot.capabilities?.prompt.image !== true) {
            throw new Error('The active Agent does not support image prompts.');
        }
        const images = validatePromptImageAttachments(request.attachments);
        if (!request.text.length && !images.blocks.length) throw new Error('A prompt cannot be empty.');
        session.status = 'running';
        session.updatedAt = new Date().toISOString();
        this.client?.onAgentEvent({ kind: 'session', session });
        this.client?.onAgentEvent({
            kind: 'text-delta',
            sessionId: request.sessionId,
            role: 'user',
            text: request.text,
            ...(images.summaries.length ? { attachments: images.summaries } : {})
        });
        const thoughtId = `fixture-thought-${++this.sequence}`;
        const thoughtStartedAt = new Date().toISOString();
        this.client?.onAgentEvent({
            kind: 'thought-delta', sessionId: request.sessionId, thoughtId,
            text: '先确认项目结构，', startedAt: thoughtStartedAt
        });
        await new Promise(resolve => setTimeout(resolve, 80));
        this.client?.onAgentEvent({
            kind: 'thought-delta', sessionId: request.sessionId, thoughtId,
            text: '再选择最小改动并验证结果。', startedAt: thoughtStartedAt
        });
        this.client?.onAgentEvent({
            kind: 'thought-delta', sessionId: request.sessionId, thoughtId,
            text: '', startedAt: thoughtStartedAt, completed: true, elapsedMs: 80
        });
        this.client?.onAgentEvent({
            kind: 'plan',
            sessionId: request.sessionId,
            title: '执行计划',
            entries: [
                { id: 'inspect', text: '检查项目结构', status: 'completed' },
                { id: 'change', text: '准备请求的改动', status: 'in-progress' },
                { id: 'verify', text: '验证结果', status: 'pending' }
            ]
        });
        const fixtureActivities: Array<{
            title: string;
            toolName: string;
            toolKind: string;
            toolNamespace: string;
            presentation: AgentToolPresentation;
            input: Record<string, string>;
            output: string;
        }> = [
            {
                title: '搜索项目内容',
                toolName: 'grep',
                toolKind: 'search',
                toolNamespace: 'grok_build',
                presentation: {
                    action: 'project-search', source: 'builtin', targetLabel: 'Agent 入口', operationLabel: 'grep', readOnly: true
                },
                input: { pattern: 'Agent 入口' },
                output: '找到 8 处匹配'
            },
            {
                title: '搜索互联网',
                toolName: 'web_search',
                toolKind: 'web_search',
                toolNamespace: 'grok_build',
                presentation: {
                    action: 'web-search', source: 'builtin', targetLabel: 'Agent UI 设计', operationLabel: 'web_search', readOnly: true
                },
                input: { query: 'Agent UI 设计' },
                output: '已整理 5 个来源'
            },
            {
                title: '运行界面审查技能',
                toolName: 'skill',
                toolKind: 'skill',
                toolNamespace: 'grok_build',
                presentation: {
                    action: 'other', source: 'skill', sourceLabel: 'ui-review', operationLabel: 'skill', readOnly: true
                },
                input: { skill: 'ui-review' },
                output: '界面审查已完成'
            },
            {
                title: '调用项目服务',
                toolName: 'project__lookup',
                toolKind: 'use_tool',
                toolNamespace: 'mcp',
                presentation: {
                    action: 'project-search', source: 'mcp', sourceLabel: 'Project', operationLabel: 'lookup', readOnly: true
                },
                input: { tool: 'project__lookup' },
                output: '服务返回 3 条结果'
            },
            {
                title: '运行插件检查',
                toolName: 'quality-check',
                toolKind: 'plugin',
                toolNamespace: 'plugin',
                presentation: {
                    action: 'other', source: 'plugin', sourceLabel: '质量检查', operationLabel: 'inspect', readOnly: true
                },
                input: { plugin: 'quality-check' },
                output: '插件检查已完成'
            }
        ];
        for (const activity of fixtureActivities) {
            this.client?.onAgentEvent({
                kind: 'tool-call',
                sessionId: request.sessionId,
                toolCallId: `tool-${++this.sequence}`,
                status: 'completed',
                ...activity
            });
        }
        const toolCallId = `tool-${++this.sequence}`;
        this.client?.onAgentEvent({
            kind: 'tool-call',
            sessionId: request.sessionId,
            toolCallId,
            title: '读取项目清单',
            toolName: 'filesystem/read_directory',
            toolKind: 'list_dir',
            toolNamespace: 'grok_build',
            presentation: {
                action: 'file-read', source: 'builtin', targetLabel: '项目根目录', operationLabel: 'list_dir', readOnly: true
            },
            status: 'running',
            input: { path: session.workspaceRoot }
        });
        const words = `我已阅读项目，并开始处理：${request.text}`.split(' ');
        for (const word of words) {
            await new Promise(resolve => setTimeout(resolve, 12));
            this.client?.onAgentEvent({ kind: 'text-delta', sessionId: request.sessionId, role: 'assistant', text: `${word} ` });
        }
        this.client?.onAgentEvent({
            kind: 'tool-call',
            sessionId: request.sessionId,
            toolCallId,
            title: '读取项目清单',
            toolName: 'filesystem/read_directory',
            toolKind: 'list_dir',
            toolNamespace: 'grok_build',
            presentation: {
                action: 'file-read', source: 'builtin', targetLabel: '项目根目录', operationLabel: 'list_dir', readOnly: true
            },
            status: 'completed',
            input: { path: session.workspaceRoot },
            output: 'package.json\nsrc/\ntest/'
        });
        const changeToolCallId = `tool-${++this.sequence}`;
        this.client?.onAgentEvent({
            kind: 'tool-call',
            sessionId: request.sessionId,
            toolCallId: changeToolCallId,
            title: '修改示例文件',
            toolName: 'search_replace',
            toolKind: 'edit',
            toolNamespace: 'grok_build',
            presentation: {
                action: 'file-write', source: 'builtin', targetLabel: 'example.ts', operationLabel: 'search_replace', readOnly: false
            },
            status: 'completed',
            input: { path: 'src/example.ts' },
            output: '已应用 1 处修改'
        });
        this.client?.onAgentEvent({
            kind: 'diff',
            sessionId: request.sessionId,
            diffId: `diff-${this.sequence}`,
            toolCallId: changeToolCallId,
            path: 'src/example.ts',
            newHash: 'fixture-new-hash',
            diff: '@@ -1,2 +1,3 @@\n export const ready = true;\n+export const verified = true;'
        });
        if (this.snapshot.permissionMode !== 'full-access' || !this.isWorkspaceTrusted(session.workspaceRoot)) {
            const permissionId = `permission-${++this.sequence}`;
            this.client?.onAgentEvent({
                kind: 'permission-request',
                sessionId: request.sessionId,
                requestId: permissionId,
                title: '运行项目测试',
                detail: 'npm test',
                toolName: 'execute',
                presentation: {
                    action: 'test', source: 'builtin', targetLabel: '项目测试', operationLabel: 'execute', readOnly: false
                },
                options: ['allow-once', 'allow-always', 'reject']
            });
            await new Promise<void>(resolve => this.pendingPermissions.set(permissionId, { sessionId: request.sessionId, resolve }));
        }
        if (this.requireSession(request.sessionId).status === 'cancelled') {
            this.client?.onAgentEvent({
                kind: 'turn-completed', sessionId: request.sessionId, stopReason: 'cancelled', elapsedMs: Date.now() - promptStartedAt
            });
            return;
        }
        this.client?.onAgentEvent({
            kind: 'plan',
            sessionId: request.sessionId,
            title: '执行计划',
            entries: [
                { id: 'inspect', text: '检查项目结构', status: 'completed' },
                { id: 'change', text: '准备请求的改动', status: 'completed' },
                { id: 'verify', text: '验证结果', status: 'completed' }
            ]
        });
        session.status = 'completed';
        session.updatedAt = new Date().toISOString();
        this.client?.onAgentEvent({ kind: 'session', session });
        this.client?.onAgentEvent({
            kind: 'turn-completed', sessionId: request.sessionId, stopReason: 'end_turn', elapsedMs: Date.now() - promptStartedAt
        });
    }

    async guidePrompt(request: GuidePromptRequest): Promise<GuidePromptResult> {
        const session = this.requireSession(request.sessionId);
        if (session.status !== 'running') return { status: 'not-running' };
        if (typeof request.text !== 'string') throw new Error('Guidance text must be a string.');
        if (request.attachments !== undefined && !Array.isArray(request.attachments)) {
            throw new Error('Image attachments must be an array.');
        }
        if (request.attachments?.length && this.snapshot.capabilities?.prompt.image !== true) {
            throw new Error('The active Agent does not support image guidance.');
        }
        const images = validatePromptImageAttachments(request.attachments);
        if (!request.text.length && !images.blocks.length) throw new Error('Guidance cannot be empty.');
        const interjectionId = `fixture-interjection-${++this.sequence}`;
        this.client?.onAgentEvent({
            kind: 'text-delta',
            sessionId: request.sessionId,
            role: 'user',
            text: request.text,
            guidance: true,
            messageId: interjectionId,
            ...(images.summaries.length ? { attachments: images.summaries } : {})
        });
        return { status: 'accepted', interjectionId };
    }

    async cancel(sessionId: string): Promise<void> {
        const session = this.requireSession(sessionId);
        session.status = 'cancelled';
        session.updatedAt = new Date().toISOString();
        for (const [requestId, pending] of this.pendingPermissions) {
            if (pending.sessionId !== sessionId) continue;
            this.pendingPermissions.delete(requestId);
            pending.resolve();
        }
        this.client?.onAgentEvent({ kind: 'session', session });
    }

    async setPermissionMode(mode: AgentPermissionMode): Promise<RuntimeSnapshot> {
        if (mode !== 'request-approval' && mode !== 'full-access') {
            throw new Error('Unsupported Agent permission mode.');
        }
        this.snapshot.permissionMode = mode;
        return this.publishSnapshot();
    }

    async respondPermission(decision: PermissionDecision): Promise<void> {
        const pending = this.pendingPermissions.get(decision.requestId);
        this.pendingPermissions.delete(decision.requestId);
        pending?.resolve();
    }

    async selectModel(sessionId: string, modelId: string): Promise<void> {
        const session = this.requireSession(sessionId);
        session.model = modelId;
        session.updatedAt = new Date().toISOString();
        this.snapshot.selectedModel = modelId;
        this.preferredModels.set(this.snapshot.providerId, modelId);
        this.client?.onAgentEvent({ kind: 'session', session });
        this.publishSnapshot();
    }

    async selectDefaultModel(providerId: string, modelId: string): Promise<RuntimeSnapshot> {
        if (providerId !== this.snapshot.providerId) throw new Error('Select the Provider first.');
        this.preferredModels.set(providerId, modelId);
        if (!this.snapshot.activeSessionId) this.snapshot.selectedModel = modelId;
        return this.publishSnapshot();
    }

    async revertDiff(_diffId: string): Promise<void> {
    }

    async listProviders(): Promise<ProviderProfile[]> {
        return this.providerProfiles.map(profile => profile.kind === 'grok-subscription' ? { ...profile } : {
            ...profile,
            credentialConfigured: this.configuredCredentials.has(profile.id)
        });
    }

    async selectProvider(providerId: string): Promise<RuntimeSnapshot> {
        this.snapshot.providerId = providerId;
        this.snapshot.activeSessionId = undefined;
        this.snapshot.selectedModel = this.preferredModels.get(providerId)
            ?? this.providerProfiles.find(profile => profile.id === providerId)?.model;
        return this.publishSnapshot();
    }

    async probeProviderModels(_request: {
        protocol: import('../common/agent-protocol').ProviderProtocol;
        baseUrl: string;
        apiKey: string;
    }) {
        return [
            { id: 'probe-model-a', name: 'Probe Model A', contextWindow: 128_000 },
            { id: 'probe-model-b', name: 'Probe Model B', contextWindow: 256_000 }
        ];
    }

    async fetchProviderModels(_providerId: string) {
        return this.snapshot.models.map(model => ({ ...model }));
    }

    async saveProvider(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile> {
        const existing = this.providerProfiles.findIndex(candidate => candidate.id === profile.id);
        let saved: ProviderProfile;
        if (profile.id === 'xai-api-key') {
            if (profile.kind !== 'xai-api-key' || existing < 0) {
                throw new Error('The built-in xAI Provider is invalid.');
            }
            const builtIn = this.providerProfiles[existing];
            if (builtIn.kind !== 'xai-api-key') {
                throw new Error('The built-in xAI Provider is invalid.');
            }
            saved = {
                ...builtIn,
                protocol: profile.protocol,
                baseUrl: profile.baseUrl,
                model: profile.model,
                contextWindow: profile.contextWindow,
                backendSearch: profile.backendSearch
            };
            this.providerProfiles.splice(existing, 1, saved);
        } else if (profile.kind === 'custom') {
            saved = { ...profile, managed: false, secretRef: `provider:${profile.id}` };
            if (existing >= 0) this.providerProfiles.splice(existing, 1, saved);
            else this.providerProfiles.push(saved);
        } else {
            throw new Error('Built-in providers cannot be changed.');
        }
        if (apiKey) this.configuredCredentials.add(profile.id);
        this.authenticationConfirmations.delete(profile.id);
        return {
            ...saved,
            credentialConfigured: this.configuredCredentials.has(saved.id)
        };
    }

    async clearProviderCredential(providerId: string): Promise<void> {
        const profile = this.providerProfiles.find(candidate => candidate.id === providerId);
        if (!profile) throw new Error('The selected Provider no longer exists.');
        if (profile.kind === 'grok-subscription') throw new Error('Use subscription logout instead.');
        if (this.snapshot.providerId === providerId && this.snapshot.phase !== 'stopped') await this.stopRuntime();
        this.configuredCredentials.delete(providerId);
        this.authenticationConfirmations.delete(providerId);
        this.snapshot.message = 'Provider credential cleared.';
        this.publishSnapshot();
    }

    async deleteProvider(providerId: string): Promise<void> {
        this.providerProfiles = this.providerProfiles.filter(profile => profile.id !== providerId || profile.managed);
        this.configuredCredentials.delete(providerId);
        this.authenticationConfirmations.delete(providerId);
    }

    async loginGrokSubscription(): Promise<ManagementResult> {
        if (this.snapshot.phase !== 'stopped') await this.stopRuntime();
        this.snapshot.providerId = 'grok-subscription';
        this.snapshot.activeSessionId = undefined;
        this.authenticationConfirmations.add('grok-subscription');
        this.snapshot.grokSubscriptionAuthStatus = 'authenticated';
        this.snapshot.message = 'Grok 订阅登录完成。';
        this.publishSnapshot();
        return { ok: true, data: { completed: true } };
    }

    async logoutGrokSubscription(): Promise<ManagementResult> {
        if (this.snapshot.phase !== 'stopped') await this.stopRuntime();
        this.authenticationConfirmations.delete('grok-subscription');
        this.snapshot.grokSubscriptionAuthStatus = 'unauthenticated';
        this.snapshot.message = '已退出共享的 Grok 订阅登录。';
        this.publishSnapshot();
        return { ok: true, data: { completed: true } };
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
        for (const pending of this.pendingPermissions.values()) pending.resolve();
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
        this.snapshot.revision = (this.snapshot.revision ?? 0) + 1;
        const snapshot = this.cloneSnapshot();
        this.client?.onAgentEvent({ kind: 'snapshot', snapshot });
        return snapshot;
    }

    protected cloneSnapshot(): RuntimeSnapshot {
        return JSON.parse(JSON.stringify(this.snapshot)) as RuntimeSnapshot;
    }

    protected isWorkspaceTrusted(root: string): boolean {
        const canonical = this.canonicalRoot(root);
        return this.trustedRoots.has(canonical) && this.theiaTrustedRoots.has(canonical);
    }

    protected canonicalRoot(root: string): string {
        const candidate = normalizeWindowsFilesystemPath(root);
        if (!path.isAbsolute(candidate)) throw new Error('Workspace root must be an absolute path.');
        return path.normalize(path.resolve(candidate));
    }
}
