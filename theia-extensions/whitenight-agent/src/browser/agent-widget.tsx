import '../../src/browser/style/agent.css';

import { CommandService, MessageService } from '@theia/core/lib/common';
import { CommonCommands, DiffUris, open, OpenerService, ReactWidget } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { URI as VSCodeURI } from '@theia/core/shared/vscode-uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    AgentHostEvent,
    AgentHostService,
    AgentPlanEvent,
    DiffEvent,
    PermissionRequestEvent,
    ProviderProfile,
    RuntimeSnapshot,
    SessionRecord,
    ToolCallEvent
} from '../common/agent-protocol';
import { AgentHostClientImpl } from './agent-client';
import { AgentViewModel, TranscriptEntry } from './agent-view-model';
import { WorkspaceTrustGuard } from './workspace-trust-guard';

interface PromptSubmission {
    text: string;
    sessionId?: string;
}

interface RetryablePrompt extends PromptSubmission {
    message: string;
}

@injectable()
export class WhiteNightAgentWidget extends ReactWidget {
    static readonly ID = 'whitenight-code-agent';
    static readonly LABEL = 'Agent';

    @inject(AgentViewModel)
    protected readonly model!: AgentViewModel;

    @inject(AgentHostService)
    protected readonly service!: AgentHostService;

    @inject(AgentHostClientImpl)
    protected readonly client!: AgentHostClientImpl;

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    @inject(OpenerService)
    protected readonly openerService!: OpenerService;

    @inject(WorkspaceTrustGuard)
    protected readonly workspaceTrustGuard!: WorkspaceTrustGuard;

    protected prompt = '';
    protected providers: ProviderProfile[] = [];
    protected roots: string[] = [];
    protected submission: PromptSubmission | undefined;
    protected retryablePrompt: RetryablePrompt | undefined;
    protected readonly cancelRequested = new Set<string>();

    @postConstruct()
    protected init(): void {
        this.id = WhiteNightAgentWidget.ID;
        this.title.label = WhiteNightAgentWidget.LABEL;
        this.title.caption = 'WhiteNight Code Agent';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-sparkle';
        this.addClass('whitenight-agent-widget');
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.toDispose.push(this.client.onEvent(event => this.acceptAgentEvent(event)));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(roots => {
            this.roots = roots.map(root => root.resource.path.toString());
            this.update();
        }));
        void this.refreshProviders();
        void this.refreshRoots();
        this.update();
    }

    protected render(): React.ReactNode {
        const snapshot = this.model.snapshot;
        const active = snapshot.sessions.find(session => session.appSessionId === snapshot.activeSessionId);
        return <div className='wn-agent-root'>
            <header className='wn-agent-header'>
                <div>
                    <strong>WhiteNight Agent</strong>
                    <span className={`wn-runtime wn-runtime-${snapshot.phase}`}>{snapshot.phase}</span>
                </div>
                <button className='theia-button secondary' title='Refresh runtime' onClick={() => this.model.refresh()}>↻</button>
            </header>
            {this.renderControls()}
            {!snapshot.workspaceTrusted ? this.renderTrust() : undefined}
            <section className='wn-transcript'>
                {this.model.transcript.length === 0
                    ? <div className='wn-empty'>
                        <span className='codicon codicon-sparkle' />
                        <h3>Start an agent task</h3>
                        <p>Files are saved before each prompt. Tool execution still requires approval.</p>
                    </div>
                    : this.model.transcript.map(entry => this.renderEntry(entry))}
                {this.retryablePrompt ? this.renderRetry(this.retryablePrompt) : undefined}
            </section>
            <footer className='wn-composer'>
                <textarea
                    aria-label='Agent prompt'
                    placeholder={snapshot.workspaceTrusted ? 'Ask the agent to work on this project…' : 'Trust this project to enable the agent'}
                    disabled={!snapshot.workspaceTrusted || snapshot.phase === 'starting' || snapshot.phase === 'initializing'}
                    value={this.prompt}
                    onChange={event => { this.prompt = event.currentTarget.value; this.update(); }}
                    onKeyDown={event => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            void this.send();
                        }
                    }}
                />
                <div className='wn-composer-actions'>
                    <span>{active?.model ?? snapshot.selectedModel ?? 'Default model'}</span>
                    {active?.status === 'running'
                        ? <button
                            className='theia-button secondary'
                            disabled={this.cancelRequested.has(active.appSessionId)}
                            onClick={() => this.cancel(active.appSessionId)}>
                            {this.cancelRequested.has(active.appSessionId) ? 'Cancelling…' : 'Cancel'}
                        </button>
                        : <button className='theia-button main' disabled={!this.prompt.trim() || !!this.submission} onClick={() => this.send()}>
                            {this.submission ? 'Sending…' : 'Send'}
                        </button>}
                </div>
            </footer>
        </div>;
    }

    protected renderControls(): React.ReactNode {
        const snapshot = this.model.snapshot;
        const active = snapshot.sessions.find(session => session.appSessionId === snapshot.activeSessionId);
        return <div className='wn-agent-controls'>
            {this.roots.length > 1 ? <select
                aria-label='Agent main root'
                disabled={!!this.submission}
                value={snapshot.workspaceRoot ?? this.roots[0]}
                onChange={event => {
                    void this.workspaceTrustGuard.selectWorkspaceRoot(event.currentTarget.value)
                        .catch(error => this.messages.error(error instanceof Error ? error.message : String(error)));
                }}>
                {this.roots.map(root => <option key={root} value={root}>{root}</option>)}
            </select> : undefined}
            <select
                aria-label='Provider'
                disabled={active?.status === 'running' || !!this.submission}
                value={snapshot.providerId}
                onChange={event => {
                    void this.service.selectProvider(event.currentTarget.value)
                        .then(() => this.model.refresh())
                        .catch(error => this.messages.error(error instanceof Error ? error.message : String(error)));
                }}>
                {this.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
            <select
                aria-label='Session'
                disabled={!!this.submission}
                value={snapshot.activeSessionId ?? ''}
                onChange={event => {
                    const session = snapshot.sessions.find(candidate => candidate.appSessionId === event.currentTarget.value);
                    if (session) {
                        void this.openSession(session);
                    }
                }}>
                <option value=''>New session</option>
                {snapshot.sessions.map(session => <option key={session.appSessionId} value={session.appSessionId}>{session.title}</option>)}
            </select>
            <select
                aria-label='Model'
                disabled={!!this.submission}
                value={snapshot.selectedModel ?? ''}
                onChange={event => {
                    const active = snapshot.activeSessionId;
                    if (active) {
                        void this.service.selectModel(active, event.currentTarget.value);
                    }
                }}>
                <option value=''>Default model</option>
                {snapshot.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
        </div>;
    }

    protected renderTrust(): React.ReactNode {
        return <div className='wn-trust-card'>
            <strong>Restricted project</strong>
            <p>Agent processes, terminals, MCP servers, hooks and executable plugins remain disabled until this project is trusted.</p>
            <button className='theia-button main' onClick={() => this.trustWorkspace()}>Trust this project</button>
        </div>;
    }

    protected renderEntry(entry: TranscriptEntry): React.ReactNode {
        if (entry.kind === 'plan') {
            const plan = entry.payload as AgentPlanEvent;
            return <article key={entry.id} className='wn-card wn-plan-card'>
                <strong>{plan.title ?? 'Plan'}</strong>
                <ol>{plan.entries.map(item => <li key={item.id} className={`wn-plan-${item.status}`}>{item.text}</li>)}</ol>
            </article>;
        }
        if (entry.kind === 'tool') {
            const tool = entry.payload as ToolCallEvent;
            const terminal = this.isTerminalTool(tool.toolName);
            return <article key={entry.id} className={`wn-card wn-tool-card${terminal ? ' wn-terminal-card' : ''}`}>
                <div><strong>{tool.title}</strong><span>{tool.status}</span></div>
                <code>{tool.toolName}</code>
                {tool.output ? <pre className={terminal ? 'wn-terminal-output' : undefined}>{tool.output}</pre> : undefined}
            </article>;
        }
        if (entry.kind === 'permission') {
            const permission = entry.payload as PermissionRequestEvent;
            const pending = this.model.pendingPermissions.has(permission.requestId);
            return <article key={entry.id} className='wn-card wn-permission-card'>
                <strong>{permission.title}</strong>
                {permission.detail ? <p>{permission.detail}</p> : undefined}
                <div className='wn-card-actions'>
                    {permission.options.includes('allow-once') ? <button className='theia-button main' disabled={!pending} onClick={() => this.model.decide({ requestId: permission.requestId, outcome: 'allow-once' })}>Allow once</button> : undefined}
                    {permission.options.includes('allow-always') ? <button className='theia-button secondary' disabled={!pending} onClick={() => this.model.decide({ requestId: permission.requestId, outcome: 'allow-always' })}>Always allow</button> : undefined}
                    <button className='theia-button secondary' disabled={!pending} onClick={() => this.model.decide({ requestId: permission.requestId, outcome: 'reject' })}>Reject</button>
                </div>
            </article>;
        }
        if (entry.kind === 'diff') {
            const diff = entry.payload as DiffEvent;
            return <article key={entry.id} className='wn-card wn-diff-card'>
                <strong>Changed {diff.path}</strong>
                <button className='theia-button secondary' disabled={!diff.oldPath} onClick={() => this.openDiff(diff)}>Open native Diff</button>
                <button className='theia-button secondary' disabled={!diff.newHash} onClick={() => this.revertDiff(diff)}>Revert safely</button>
                <pre>{diff.diff}</pre>
            </article>;
        }
        return <article key={entry.id} className={`wn-message wn-message-${entry.kind}`}>
            <div className='wn-message-role'>{entry.kind}</div>
            <div className='wn-message-text'>{entry.text}</div>
        </article>;
    }

    protected renderRetry(retry: RetryablePrompt): React.ReactNode {
        const snapshot = this.model.snapshot;
        const running = snapshot.sessions.some(session => session.status === 'running');
        return <article className='wn-card wn-retry-card' role='alert'>
            <div><strong>Task failed</strong><span className='codicon codicon-warning' /></div>
            <p>{retry.message}</p>
            <div className='wn-retry-prompt'>{retry.text}</div>
            <div className='wn-card-actions'>
                <button
                    className='theia-button main'
                    disabled={!!this.submission || running || !snapshot.workspaceTrusted}
                    onClick={() => this.retry(retry)}>
                    Retry
                </button>
                <button className='theia-button secondary' disabled={!!this.submission} onClick={() => this.dismissRetry()}>Dismiss</button>
            </div>
        </article>;
    }

    protected async trustWorkspace(): Promise<void> {
        const root = await this.workspaceRoot();
        if (!root) {
            this.messages.warn('Open a folder or workspace first.');
            return;
        }
        try {
            await this.workspaceTrustGuard.requestWorkspaceTrust();
        } catch (error) {
            this.messages.error(`Unable to update workspace trust: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async send(retry?: PromptSubmission): Promise<void> {
        if (this.submission) {
            return;
        }
        const text = retry?.text.trim() ?? this.prompt.trim();
        if (!text) return;
        const submission: PromptSubmission = { text, sessionId: retry?.sessionId };
        this.submission = submission;
        this.retryablePrompt = undefined;
        this.update();
        try {
            const root = await this.workspaceRoot();
            if (!root) {
                this.messages.warn('Open a folder or workspace first.');
                return;
            }
            await this.commandService.executeCommand(CommonCommands.SAVE_ALL.id);
            let runtimeRestarted = false;
            if (this.model.snapshot.phase !== 'ready') {
                const runtime = await this.service.startRuntime({ workspaceRoot: root, providerId: this.model.snapshot.providerId });
                if (!await this.authenticateRuntime(runtime)) return;
                runtimeRestarted = true;
            }
            let sessionId = submission.sessionId ?? this.model.snapshot.activeSessionId;
            if (!sessionId) {
                const session = await this.service.createSession({
                    workspaceRoot: root,
                    providerId: this.model.snapshot.providerId,
                    model: this.model.snapshot.selectedModel,
                    title: text.slice(0, 64),
                    additionalDirectories: this.roots.filter(candidate => candidate !== root)
                });
                sessionId = session.appSessionId;
                this.model.setSession(session);
            }
            if (retry?.sessionId && runtimeRestarted) {
                await this.service.loadSession(sessionId);
            }
            submission.sessionId = sessionId;
            if (!retry || this.prompt.trim() === text) this.prompt = '';
            this.update();
            await this.service.sendPrompt({ sessionId, text });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const cancelled = (submission.sessionId ? this.cancelRequested.has(submission.sessionId) : false)
                || this.isCancellationError(error);
            if (!cancelled) {
                const visibleMessage = (this.retryablePrompt as RetryablePrompt | undefined)?.message ?? message;
                this.retryablePrompt = { ...submission, message: visibleMessage };
                this.messages.error(`Unable to send the task: ${visibleMessage}`);
            }
        } finally {
            if (submission.sessionId) this.cancelRequested.delete(submission.sessionId);
            if (this.submission === submission) this.submission = undefined;
            this.update();
        }
    }

    protected retry(retry: RetryablePrompt): void {
        if (this.retryablePrompt !== retry || this.submission) return;
        void this.send({ text: retry.text, sessionId: retry.sessionId });
    }

    protected dismissRetry(): void {
        if (this.submission) return;
        this.retryablePrompt = undefined;
        this.update();
    }

    protected async cancel(sessionId: string): Promise<void> {
        if (this.cancelRequested.has(sessionId)) return;
        this.cancelRequested.add(sessionId);
        this.update();
        try {
            await this.service.cancel(sessionId);
        } catch (error) {
            this.cancelRequested.delete(sessionId);
            this.messages.error(`Unable to cancel the task: ${error instanceof Error ? error.message : String(error)}`);
            this.update();
        }
    }

    protected acceptAgentEvent(event: AgentHostEvent): void {
        if (event.kind === 'turn-completed' && event.stopReason === 'cancelled') {
            if (this.retryablePrompt?.sessionId === event.sessionId) this.retryablePrompt = undefined;
            this.update();
            return;
        }
        const submission = this.submission;
        if (event.kind !== 'error' || !event.recoverable || !submission) return;
        if (event.sessionId && submission.sessionId && event.sessionId !== submission.sessionId) return;
        if ((submission.sessionId && this.cancelRequested.has(submission.sessionId))
            || this.isCancellationMessage(event.code, event.message)) return;
        this.retryablePrompt = { ...submission, message: event.message };
        this.update();
    }

    protected isCancellationError(error: unknown): boolean {
        if (!(error instanceof Error)) return false;
        const candidate = error as Error & { code?: unknown };
        if (candidate.name === 'AbortError' || candidate.name === 'AcpCancelledError') return true;
        if (candidate.code === 'ABORT_ERR' || candidate.code === 'CANCELLED' || candidate.code === 'CANCELED') return true;
        return this.isCancellationMessage('', candidate.message);
    }

    protected isCancellationMessage(code: string, message: string): boolean {
        if (/^(?:PROMPT_)?CANCEL(?:LED|ED)$/i.test(code)) return true;
        return /^cancel(?:led|ed)(?:\s+by\s+(?:the\s+)?user)?\.?$/i.test(message.trim());
    }

    protected isTerminalTool(toolName: string): boolean {
        return /(?:^|[\/.:-])(?:terminal|shell|exec(?:ute)?(?:_command)?|run_command)(?:$|[\/.:-])/i.test(toolName);
    }

    protected async openSession(session: SessionRecord): Promise<void> {
        this.model.setSession(session);
        try {
            this.model.loadHistory(await this.service.getSessionHistory(session.appSessionId));
            try {
                await this.service.loadSession(session.appSessionId);
            } catch (error) {
                if (!(error instanceof Error) || !error.message.includes('AUTHENTICATION_REQUIRED')) throw error;
                const runtime = await this.service.getSnapshot();
                if (!await this.authenticateRuntime(runtime)) return;
                await this.service.loadSession(session.appSessionId);
            }
        } catch (error) {
            this.messages.error(`Unable to restore the session: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async authenticateRuntime(runtime: RuntimeSnapshot): Promise<boolean> {
        if (runtime.phase !== 'auth-required') return true;
        const provider = this.providers.find(candidate => candidate.id === runtime.providerId);
        const warning = provider?.kind === 'grok-subscription'
            ? 'Grok subscription login shares ~/.grok. Signing in or switching accounts affects the external Grok CLI and other WhiteNight Code windows.'
            : provider?.kind === 'xai-api-key'
                ? 'The API key is encrypted by WhiteNight Code, but Grok Build authentication may update its shared ~/.grok authentication state. This can affect the external Grok CLI and other windows.'
                : `Continue with the configured credential for ${provider?.name ?? 'this Provider'}? Only the active Provider credential is injected into this sidecar.`;
        const choice = await this.messages.warn(warning, 'Continue');
        if (choice !== 'Continue') return false;
        const methodId = provider?.kind === 'grok-subscription'
            ? runtime.capabilities?.defaultAuthMethodId
                ?? runtime.capabilities?.authMethods.find(method => method.id === 'grok.com')?.id
            : runtime.capabilities?.authMethods.find(method => method.id === 'xai.api_key')?.id
                ?? runtime.capabilities?.defaultAuthMethodId
                ?? runtime.capabilities?.authMethods[0]?.id;
        if (!methodId) throw new Error('Grok Build did not advertise a compatible authentication method.');
        await this.service.authenticate(methodId);
        return true;
    }

    protected async workspaceRoot(): Promise<string | undefined> {
        if (this.model.snapshot.workspaceRoot && this.roots.includes(this.model.snapshot.workspaceRoot)) {
            return this.model.snapshot.workspaceRoot;
        }
        const roots = await this.workspaceService.roots;
        return roots[0]?.resource.path.toString();
    }

    protected async refreshProviders(): Promise<void> {
        try {
            this.providers = await this.service.listProviders();
            this.update();
        } catch (error) {
            this.messages.error(`Unable to load Providers: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async refreshRoots(): Promise<void> {
        const roots = await this.workspaceService.roots;
        this.roots = roots.map(root => root.resource.path.toString());
        this.update();
    }

    protected async openDiff(diff: DiffEvent): Promise<void> {
        if (!diff.oldPath || !this.model.snapshot.workspaceRoot) {
            return;
        }
        const before = new URI(VSCodeURI.file(diff.oldPath));
        const afterPath = diff.path.startsWith('/') ? diff.path : `${this.model.snapshot.workspaceRoot}/${diff.path}`;
        const after = new URI(VSCodeURI.file(afterPath));
        await open(this.openerService, DiffUris.encode(before, after, `${diff.path} (Agent change)`));
    }

    protected async revertDiff(diff: DiffEvent): Promise<void> {
        try {
            await this.service.revertDiff(diff.diffId);
            this.messages.info(`Reverted ${diff.path}.`);
        } catch (error) {
            await this.openDiff(diff);
            this.messages.error(error instanceof Error ? error.message : String(error));
        }
    }
}
