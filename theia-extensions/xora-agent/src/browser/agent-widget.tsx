import '../../src/browser/style/agent.css';

import { CommandService, Disposable, MessageService } from '@theia/core/lib/common';
import { CommonCommands, DiffUris, open, OpenerService, ReactWidget } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { URI as VSCodeURI } from '@theia/core/shared/vscode-uri';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { FileNavigatorCommands } from '@theia/navigator/lib/browser/file-navigator-commands';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    AgentHostEvent,
    AgentHostService,
    AgentPermissionMode,
    AgentAttachmentSummary,
    AgentPlanEvent,
    DiffEvent,
    PermissionRequestEvent,
    PromptImageAttachment,
    PromptImageMimeType,
    ProviderProfile,
    RuntimePhase,
    RuntimeSnapshot,
    SessionRecord,
    ToolCallEvent
} from '../common/agent-protocol';
import { AgentHostClientImpl } from './agent-client';
import {
    activityFiltersForTool,
    AgentActivityFilter,
    AgentContextSummary,
    presentAgentTool,
    sessionRelativeTime,
    sessionStatusLabel,
    summarizeAgentContext,
    summarizeToolCategories,
    toolMatchesActivityFilter
} from './agent-display-helpers';
import { OPEN_AGENT_SETTINGS_COMMAND } from './agent-entry-commands';
import { shouldSubmitPromptOnEnter } from './agent-input-helpers';
import { grokSubscriptionAuthStatus } from './agent-management-labels';
import { AgentMarkdown } from './agent-markdown';
import { runtimePhaseLabel, toolStatusLabel, transcriptRoleLabel } from './agent-ui-labels';
import { AgentViewModel, TranscriptEntry } from './agent-view-model';
import { WorkspaceTrustGuard } from './workspace-trust-guard';

interface PromptSubmission {
    readonly text: string;
    /** Immutable binding that prevents an async send from crossing Agent contexts. */
    readonly contextKey: string;
    readonly generation: number;
    readonly workspaceRoot: string;
    readonly providerId: string;
    readonly sourceSessionId?: string;
    sessionId?: string;
    readonly attachments: PromptImageAttachment[];
    readonly draftAttachmentIds?: string[];
}

interface RetryablePrompt extends PromptSubmission {
    message: string;
}

type AgentPopover = 'history' | 'context';
type AgentPaneView = 'conversation' | 'activity' | 'changes';

const MAX_RENDERED_TRANSCRIPT_ENTRIES = 180;
const MAX_PROMPT_IMAGE_COUNT = 4;
const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;
const ACTIVITY_FILTERS: Array<{ id: AgentActivityFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'files', label: '文件' },
    { id: 'search', label: '搜索' },
    { id: 'terminal', label: '终端' },
    { id: 'web', label: '网络' },
    { id: 'skill', label: '技能' },
    { id: 'mcp', label: 'MCP' },
    { id: 'plugin', label: '插件' },
    { id: 'other', label: '其他' }
];

interface DraftImageAttachment extends PromptImageAttachment {
    id: string;
    byteSize: number;
    previewUrl: string;
}

interface ComposerGate {
    kind: 'project' | 'restore';
    message: string;
}

// Yield one browser task so root, Provider and backend workspace attachment
// snapshots can coalesce. There is deliberately no user-input debounce: an
// opened project should begin preparing its Agent immediately.
const RUNTIME_PREWARM_DELAY_MS = 0;
// A cold Grok model-catalog refresh can fail transiently before ACP is ready.
// Retry only the background startup transaction, never a user prompt.
const RUNTIME_PREWARM_RETRY_DELAY_MS = 350;
const RUNTIME_PREWARM_MAX_ATTEMPTS = 2;

@injectable()
export class XoraAgentWidget extends ReactWidget {
    static readonly ID = 'xora-code-agent';
    static readonly LABEL = 'Xora Code';

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
    protected readonly permissionDecisions = new Set<string>();
    protected textarea: HTMLTextAreaElement | null = null;
    protected composerSubmitButton: HTMLButtonElement | null = null;
    protected composerResizeTarget: HTMLTextAreaElement | null = null;
    protected composerResizeFrame: number | undefined;
    protected transcriptNode: HTMLElement | null = null;
    protected stickToBottom = true;
    protected newOutputAvailable = false;
    protected followTranscriptFrame: number | undefined;
    protected sessionLoadGeneration = 0;
    protected agentContextGeneration = 0;
    protected sessionLoading = false;
    protected openPopover: AgentPopover | undefined;
    protected agentPaneView: AgentPaneView = 'conversation';
    protected activityFilter: AgentActivityFilter = 'all';
    protected readonly toolDisclosure = new Map<string, boolean>();
    protected readonly diffDisclosure = new Map<string, boolean>();
    protected newSessionModel: string | undefined;
    protected modelOptionsLoading = false;
    protected permissionModeChanging = false;
    protected imeComposing = false;
    protected imeCompositionJustEnded = false;
    protected imeCompositionGuardTimer: number | undefined;
    protected draftImages: DraftImageAttachment[] = [];
    protected imageInput: HTMLInputElement | null = null;
    protected imageReadsInFlight = 0;
    protected pendingImageBytes = 0;
    protected imageError: string | undefined;
    protected imageAnnouncement = '';
    protected previewImageId: string | undefined;
    protected imageReadGeneration = 0;
    protected imagePreviewCloseButton: HTMLButtonElement | null = null;
    protected imagePreviewReturnFocus: HTMLButtonElement | null = null;
    protected draftImageContextKey: string | undefined;
    protected observedAgentContextKey: string | undefined;
    protected observedProviderId: string | undefined;
    /** Project attachment itself is the intent signal. Agent readiness must
     * never wait for the first keystroke. */
    protected runtimePrewarmRequested = true;
    protected runtimePrewarmTimer: number | undefined;
    protected runtimePrewarmAttemptKey: string | undefined;
    protected runtimePrewarmAttempts = 0;
    protected activeSessionHydrationKey: string | undefined;
    protected observedRuntimePhase: RuntimePhase | undefined;

    @postConstruct()
    protected init(): void {
        this.id = XoraAgentWidget.ID;
        this.title.label = XoraAgentWidget.LABEL;
        this.title.caption = 'Xora Code · Agent 编程助手';
        this.title.closable = false;
        this.title.iconClass = 'xora-agent-brand-icon';
        this.addClass('xora-agent-widget');
        this.node.tabIndex = 0;
        this.observedAgentContextKey = this.imageDraftContextKey();
        this.observedProviderId = this.model.snapshot.providerId;
        this.observedRuntimePhase = this.model.snapshot.phase;
        this.toDispose.push(this.model.onDidChange(() => {
            this.reconcileAgentContext();
            this.reconcileRuntimePrewarmState();
            this.scheduleRuntimePrewarm();
            this.update();
            this.followTranscript();
        }));
        this.toDispose.push(this.client.onEvent(event => this.acceptAgentEvent(event)));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(roots => {
            this.activateWorkspace(roots.map(root => root.resource.path.toString()));
        }));
        this.toDispose.push(Disposable.create(() => {
            this.imageReadGeneration += 1;
            if (this.imeCompositionGuardTimer !== undefined) {
                window.clearTimeout(this.imeCompositionGuardTimer);
            }
            if (this.followTranscriptFrame !== undefined) {
                window.cancelAnimationFrame(this.followTranscriptFrame);
            }
            if (this.composerResizeFrame !== undefined) {
                window.cancelAnimationFrame(this.composerResizeFrame);
            }
            this.composerResizeFrame = undefined;
            this.composerResizeTarget = null;
            this.cancelRuntimePrewarmTimer();
            for (const image of this.draftImages) URL.revokeObjectURL(image.previewUrl);
            this.draftImages = [];
        }));
        this.update();
        // Providers and workspace roots are metadata, not prerequisites for
        // painting the conversation surface. Defer their IPC/filesystem work
        // until the widget has yielded its first frame.
        requestAnimationFrame(() => {
            void this.refreshProviders();
            void this.refreshRoots();
        });
    }

    protected override onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        requestAnimationFrame(() => this.textarea?.focus());
    }

    protected render(): React.ReactNode {
        const snapshot = this.model.snapshot;
        const recoveringRuntime = snapshot.phase === 'crashed'
            && this.runtimePrewarmRequested
            && this.runtimePrewarmAttempts < RUNTIME_PREWARM_MAX_ATTEMPTS;
        const prewarmRecoveryInProgress = this.runtimePrewarmRequested
            && this.runtimePrewarmAttempts > 0
            && this.runtimePrewarmAttempts <= RUNTIME_PREWARM_MAX_ATTEMPTS
            && ['starting', 'initializing', 'crashed'].includes(snapshot.phase);
        const active = snapshot.sessions.find(session => session.appSessionId === snapshot.activeSessionId);
        const selectedModel = this.selectedModelValue(snapshot, active);
        const permissionMode = snapshot.permissionMode;
        const contextSummary = summarizeAgentContext(snapshot, this.model.transcript);
        const pendingPermissions = this.model.transcript.filter(entry =>
            entry.kind === 'permission' && this.model.pendingPermissions.has(entry.id));
        const visibleTranscript = this.model.transcript.filter(entry => {
            if (entry.kind === 'permission') return !this.model.pendingPermissions.has(entry.id);
            // A background cold-start failure is an implementation detail while
            // its one bounded recovery attempt is still in progress. If that
            // recovery also fails, the final actionable error remains visible.
            return !(prewarmRecoveryInProgress
                && entry.kind === 'error'
                && entry.payload?.kind === 'error'
                && entry.payload.code === 'RUNTIME_START_FAILED'
                && !entry.payload.sessionId);
        });
        const toolEntries = visibleTranscript.filter(entry => entry.kind === 'tool');
        const diffEntries = visibleTranscript.filter(entry => entry.kind === 'diff');
        const paneTranscript = this.transcriptForPane(visibleTranscript);
        const hiddenTranscriptCount = Math.max(0, paneTranscript.length - MAX_RENDERED_TRANSCRIPT_ENTRIES);
        const renderedTranscript = hiddenTranscriptCount
            ? paneTranscript.slice(-MAX_RENDERED_TRANSCRIPT_ENTRIES)
            : paneTranscript;
        const imageCapabilityError = this.draftImages.length > 0 && snapshot.capabilities?.prompt.image === false
            ? '当前 Grok Build 版本不支持图片输入。图片已保留，请移除或更新运行时后再发送。'
            : undefined;
        const composerImageError = this.imageError ?? imageCapabilityError;
        const composerHasContent = !!this.prompt.trim() || this.draftImages.length > 0;
        const composerGate = this.composerGate(snapshot);
        return <div className='xora-agent-root' onKeyDown={event => this.handleRootKeyDown(event)}>
            <header className='xora-agent-header'>
                <div className='xora-agent-heading'>
                    <span className='xora-agent-heading-icon' aria-hidden='true'>
                        <span className='xora-agent-brand-icon' />
                    </span>
                    <div className='xora-agent-heading-copy'>
                        <strong title={active?.title}>{active?.title ?? '新会话'}</strong>
                        <span className='xora-agent-runtime-line' aria-live='polite'>
                            <span className={`xora-runtime-dot xora-runtime-${recoveringRuntime ? 'starting' : snapshot.phase}`} />
                            <span className='xora-agent-runtime-label'>{this.sessionLoading
                                    ? '正在恢复会话'
                                    : this.submission && active?.status !== 'running'
                                        ? ['starting', 'initializing', 'draining', 'updating'].includes(snapshot.phase)
                                            ? '正在连接，随后发送'
                                            : '正在准备任务'
                                        : active?.status === 'running'
                                            ? 'Agent 正在工作'
                                            : recoveringRuntime
                                                ? '正在重新连接'
                                            : snapshot.phase === 'stopped' && (snapshot.workspaceRoot || this.roots.length)
                                                ? '正在准备'
                                                : runtimePhaseLabel(snapshot.phase)}</span>
                        </span>
                    </div>
                </div>
                <div className='xora-agent-header-actions'>
                    <button
                        className='xora-agent-icon-button'
                        aria-label='打开会话历史'
                        aria-haspopup='dialog'
                        aria-expanded={this.openPopover === 'history'}
                        title='会话历史'
                        onClick={() => this.togglePopover('history')}>
                        <span className='codicon codicon-history' />
                    </button>
                    <button
                        className='xora-agent-icon-button'
                        aria-label='新建 Agent 会话'
                        title='新建会话'
                        disabled={!!this.submission || this.sessionLoading}
                        onClick={() => this.startNewSession()}>
                        <span className='codicon codicon-add' />
                    </button>
                    <button
                        className='xora-agent-icon-button'
                        aria-label='打开 Agent 设置'
                        title='账户、模型、技能、MCP 与插件设置'
                        onClick={() => {
                            this.closePopover();
                            void this.commandService.executeCommand(OPEN_AGENT_SETTINGS_COMMAND.id);
                        }}>
                        <span className='codicon codicon-settings-gear' />
                    </button>
                </div>
            </header>
            {this.renderPopover()}
            {this.renderImagePreview()}
            {this.renderConversationBar()}
            {this.renderPaneTabs(toolEntries.length, diffEntries.length)}
            {this.agentPaneView === 'activity' ? this.renderActivityFilters(toolEntries) : undefined}
            <section
                className='xora-transcript'
                role='log'
                aria-label='Agent 会话'
                aria-busy={this.sessionLoading}
                ref={node => { this.transcriptNode = node; }}
                onScroll={event => this.onTranscriptScroll(event.currentTarget)}>
                {this.agentPaneView === 'conversation' && this.model.transcript.length === 0
                    ? this.renderEmpty()
                    : renderedTranscript.length === 0
                        ? this.renderPaneEmpty()
                        : <>
                            {hiddenTranscriptCount ? <div className='xora-history-window-notice' role='status'>
                                为保持切换流畅，仅显示最近 {MAX_RENDERED_TRANSCRIPT_ENTRIES} 条记录；完整历史仍保存在本地。
                            </div> : undefined}
                            {this.agentPaneView === 'changes' ? this.renderChangesOverview(renderedTranscript) : undefined}
                            {this.renderTranscript(renderedTranscript)}
                    </>}
                {snapshot.message ? this.renderRuntimeNotice(snapshot.message) : undefined}
                {this.retryablePrompt ? this.renderRetry(this.retryablePrompt) : undefined}
            </section>
            {this.agentPaneView === 'conversation' && this.newOutputAvailable ? <button className='xora-jump-latest' onClick={() => this.scrollToBottom()}>
                <span className='codicon codicon-arrow-down' /> 有新输出
            </button> : undefined}
            {pendingPermissions.length ? <aside className='xora-permission-dock' aria-label='等待处理的权限请求'>
                {pendingPermissions.map(entry => this.renderEntry(entry))}
            </aside> : undefined}
            <footer className='xora-composer'>
                <div className='xora-composer-surface'>
                    <input
                        ref={node => { this.imageInput = node; }}
                        className='xora-image-file-input'
                        type='file'
                        tabIndex={-1}
                        aria-hidden='true'
                        accept='image/png,image/jpeg,image/webp'
                        multiple
                        onChange={event => {
                            const files = Array.from(event.currentTarget.files ?? []);
                            event.currentTarget.value = '';
                            if (files.length) this.requestRuntimePrewarm(true);
                            void this.addImageFiles(files, '选择');
                        }}
                    />
                    {this.renderDraftImages()}
                    <textarea
                        ref={node => { this.textarea = node; }}
                        aria-label='Agent 任务输入框'
                        placeholder={composerGate
                            ? `${composerGate.message}；你可以先在这里写下任务…`
                            : '描述任务，或输入 / 查看可用命令…'}
                        rows={1}
                        defaultValue={this.prompt}
                        onChange={event => {
                            this.prompt = event.currentTarget.value;
                            this.scheduleComposerResize(event.currentTarget);
                            this.syncComposerSubmitButton();
                            // This textarea is deliberately uncontrolled.
                            // React's controlled-input restore runs before
                            // Lumino's async update and otherwise erases an
                            // active Chinese/Japanese/Korean IME composition.
                            // Do not redraw the complete transcript for each
                            // keystroke: the native button is updated directly.
                        }}
                        onCompositionStart={() => {
                            this.imeComposing = true;
                            this.imeCompositionJustEnded = false;
                            if (this.imeCompositionGuardTimer !== undefined) {
                                window.clearTimeout(this.imeCompositionGuardTimer);
                                this.imeCompositionGuardTimer = undefined;
                            }
                        }}
                        onCompositionEnd={event => {
                            this.prompt = event.currentTarget.value;
                            this.imeComposing = false;
                            this.imeCompositionJustEnded = true;
                            this.scheduleComposerResize(event.currentTarget);
                            this.syncComposerSubmitButton();
                            this.imeCompositionGuardTimer = window.setTimeout(() => {
                                this.imeCompositionJustEnded = false;
                                this.imeCompositionGuardTimer = undefined;
                            }, 0);
                        }}
                        onPaste={event => {
                            this.requestRuntimePrewarm(true);
                            this.handleImagePaste(event);
                        }}
                        onKeyDown={event => {
                            const nativeEvent = event.nativeEvent as KeyboardEvent;
                            if (shouldSubmitPromptOnEnter({
                                key: event.key,
                                shiftKey: event.shiftKey,
                                widgetComposing: this.imeComposing,
                                nativeComposing: nativeEvent.isComposing,
                                nativeKeyCode: nativeEvent.keyCode,
                                compositionJustEnded: this.imeCompositionJustEnded
                            })) {
                                event.preventDefault();
                                void this.send();
                            }
                        }}
                    />
                    {composerGate ? <div className={`xora-composer-gate xora-composer-gate-${composerGate.kind}`} role='status'>
                        <span className={`codicon ${composerGate.kind === 'project' ? 'codicon-folder-opened' : 'codicon-loading'}`} />
                        <span>{composerGate.message}，草稿会保留。</span>
                    </div> : undefined}
                    <div className='xora-composer-actions'>
                        <div className='xora-composer-selectors'>
                            <label className='xora-model-control' title={active ? '当前模型' : '新会话使用的模型'}>
                                <span className='codicon codicon-symbol-misc' />
                                <select
                                    aria-label='Agent 模型'
                                    title={snapshot.models.length === 0 ? '点击加载当前服务提供的模型' : undefined}
                                    disabled={active?.status === 'running'
                                        || !!this.submission
                                        || this.sessionLoading
                                        || this.modelOptionsLoading
                                        || snapshot.phase === 'starting'
                                        || snapshot.phase === 'initializing'
                                        || snapshot.phase === 'draining'
                                        || snapshot.phase === 'updating'}
                                    value={selectedModel}
                                    onMouseDown={event => {
                                        if (snapshot.models.length === 0) {
                                            event.preventDefault();
                                            void this.loadModelOptions();
                                        }
                                    }}
                                    onKeyDown={event => {
                                        if (snapshot.models.length === 0 && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
                                            event.preventDefault();
                                            void this.loadModelOptions();
                                        }
                                    }}
                                    onChange={event => this.selectModel(active, event.currentTarget.value)}>
                                    {this.renderModelOptions(snapshot, active)}
                                </select>
                            </label>
                            <label
                                className={`xora-permission-mode-control${permissionMode === 'full-access' ? ' is-full-access' : ''}`}
                                title={permissionMode === 'full-access'
                                    ? '所有项目和会话都会自动批准兼容的 Agent 工具请求'
                                    : '所有项目和会话执行敏感操作前都会请求你的批准'}>
                                <span className='codicon codicon-shield' />
                                <select
                                    aria-label='Agent 全局权限'
                                    disabled={active?.status === 'running' || !!this.submission || this.sessionLoading || this.permissionModeChanging}
                                    value={permissionMode}
                                    onChange={event => void this.selectPermissionMode(event.currentTarget.value as AgentPermissionMode)}>
                                    <option value='request-approval'>请求审批</option>
                                    <option value='full-access'>完全访问权限</option>
                                </select>
                            </label>
                            <button
                                className='xora-composer-tool'
                                type='button'
                                aria-label='添加图片'
                                title={this.draftImages.length + this.imageReadsInFlight >= MAX_PROMPT_IMAGE_COUNT
                                    ? `每次最多添加 ${MAX_PROMPT_IMAGE_COUNT} 张图片`
                                    : '添加图片（支持直接粘贴）'}
                                disabled={this.draftImages.length + this.imageReadsInFlight >= MAX_PROMPT_IMAGE_COUNT}
                                onClick={() => this.imageInput?.click()}>
                                <span className='codicon codicon-attach' />
                            </button>
                            <button
                                className={`xora-context-trigger xora-context-${contextSummary.compactionStatus}${contextSummary.usagePercent !== undefined ? ' has-usage' : ''}`}
                                type='button'
                                aria-label='查看当前会话上下文'
                                aria-haspopup='dialog'
                                aria-expanded={this.openPopover === 'context'}
                                title={this.contextTriggerTitle(contextSummary)}
                                onClick={() => this.togglePopover('context')}>
                                <span
                                    className='xora-context-ring'
                                    style={this.contextRingStyle(contextSummary)}
                                    aria-hidden='true' />
                            </button>
                        </div>
                        <span className='xora-image-live' aria-live='polite'>{this.imageAnnouncement}</span>
                        <span className='xora-composer-hint'>Enter 发送 · Shift+Enter 换行</span>
                    {active?.status === 'running'
                        ? <button
                            ref={node => { this.composerSubmitButton = node; }}
                            className='xora-composer-submit xora-composer-stop'
                            aria-label='停止当前任务'
                            title='停止当前任务'
                            disabled={this.cancelRequested.has(active.appSessionId)}
                            onClick={() => this.cancel(active.appSessionId)}>
                            <span className={`codicon ${this.cancelRequested.has(active.appSessionId) ? 'codicon-loading codicon-modifier-spin' : 'codicon-debug-stop'}`} />
                        </button>
                        : <button
                            ref={node => { this.composerSubmitButton = node; }}
                            className='xora-composer-submit'
                            aria-label={this.submission ? '正在发送任务' : '发送任务'}
                            title={this.submission
                                ? '正在发送…'
                                : composerImageError
                                    ? composerImageError
                                    : composerGate
                                        ? composerGate.message
                                    : this.imageReadsInFlight
                                        ? '正在读取图片…'
                                        : '发送任务'}
                            disabled={!composerHasContent
                                || !!this.submission
                                || !!composerGate
                                || this.sessionLoading
                                || this.imageReadsInFlight > 0
                                || !!imageCapabilityError}
                            onClick={() => this.send()}>
                            <span className={`codicon ${this.submission ? 'codicon-loading codicon-modifier-spin' : 'codicon-send'}`} />
                        </button>}
                    </div>
                    {composerImageError ? <div className='xora-composer-image-error' role='alert'>
                        <span className='codicon codicon-warning' />
                        <span>{composerImageError}</span>
                    </div> : undefined}
                </div>
            </footer>
        </div>;
    }

    protected renderConversationBar(): React.ReactNode {
        const snapshot = this.model.snapshot;
        if (this.roots.length <= 1) return undefined;
        return <div className='xora-agent-contextbar'>
            <label className='xora-agent-context-control' title='Agent 主目录'>
                <span className='codicon codicon-root-folder' />
                <select
                    aria-label='Agent 主目录'
                    disabled={!!this.submission || this.sessionLoading}
                    value={snapshot.workspaceRoot ?? this.roots[0]}
                    onChange={event => {
                        void this.selectWorkspaceRoot(event.currentTarget.value);
                    }}>
                    {this.roots.map(root => <option key={root} value={root}>{this.rootLabel(root)}</option>)}
                </select>
            </label>
        </div>;
    }

    protected transcriptForPane(entries: TranscriptEntry[]): TranscriptEntry[] {
        if (this.agentPaneView === 'conversation') return entries;
        if (this.agentPaneView === 'changes') return entries.filter(entry => entry.kind === 'diff');
        return entries.filter(entry => {
            if (entry.kind === 'tool') {
                return toolMatchesActivityFilter(entry.payload as ToolCallEvent, this.activityFilter);
            }
            if (this.activityFilter !== 'all') return false;
            return entry.kind === 'plan' || entry.kind === 'permission' || entry.kind === 'error';
        });
    }

    protected renderPaneTabs(toolCount: number, diffCount: number): React.ReactNode {
        const tabs: Array<{ id: AgentPaneView; label: string; count?: number }> = [
            { id: 'conversation', label: '对话' },
            { id: 'activity', label: '活动', count: toolCount },
            { id: 'changes', label: '变更', count: diffCount }
        ];
        return <nav className='xora-agent-pane-tabs' role='tablist' aria-label='Agent 会话视图'>
            {tabs.map(tab => <button
                key={tab.id}
                type='button'
                role='tab'
                aria-selected={this.agentPaneView === tab.id}
                className={this.agentPaneView === tab.id ? 'active' : undefined}
                onClick={() => this.selectAgentPane(tab.id)}>
                <span>{tab.label}</span>
                {tab.count ? <small>{tab.count}</small> : undefined}
            </button>)}
        </nav>;
    }

    protected renderActivityFilters(entries: TranscriptEntry[]): React.ReactNode {
        const counts = new Map<AgentActivityFilter, number>([['all', entries.length]]);
        for (const entry of entries) {
            for (const filter of activityFiltersForTool(entry.payload as ToolCallEvent)) {
                counts.set(filter, (counts.get(filter) ?? 0) + 1);
            }
        }
        return <div className='xora-activity-filters' role='toolbar' aria-label='筛选 Agent 活动'>
            {ACTIVITY_FILTERS.map(filter => <button
                key={filter.id}
                type='button'
                aria-pressed={this.activityFilter === filter.id}
                className={this.activityFilter === filter.id ? 'active' : undefined}
                onClick={() => {
                    this.activityFilter = filter.id;
                    this.update();
                    requestAnimationFrame(() => {
                        if (this.transcriptNode) this.transcriptNode.scrollTop = 0;
                    });
                }}>
                {filter.label}
                {(counts.get(filter.id) ?? 0) > 0 ? <small>{counts.get(filter.id)}</small> : undefined}
            </button>)}
        </div>;
    }

    protected selectAgentPane(view: AgentPaneView): void {
        if (this.agentPaneView === view) return;
        this.agentPaneView = view;
        this.closePopover();
        this.update();
        requestAnimationFrame(() => {
            if (!this.transcriptNode) return;
            this.transcriptNode.scrollTop = view === 'conversation' ? this.transcriptNode.scrollHeight : 0;
        });
    }

    protected renderPaneEmpty(): React.ReactNode {
        const empty = this.agentPaneView === 'changes'
            ? { icon: 'codicon-diff', title: '还没有文件变更', body: 'Agent 产生的修改会汇总在这里，可直接打开 Theia 差异视图审查。' }
            : { icon: 'codicon-pulse', title: '暂无此类活动', body: this.activityFilter === 'all'
                ? '运行任务后，文件、搜索、网络、技能、MCP 与插件操作会按标签记录在这里。'
                : '当前会话还没有匹配这个标签的操作。' };
        return <div className='xora-pane-empty'>
            <span className={`codicon ${empty.icon}`} />
            <strong>{empty.title}</strong>
            <p>{empty.body}</p>
        </div>;
    }

    protected renderChangesOverview(entries: TranscriptEntry[]): React.ReactNode {
        const diffs = entries.flatMap(entry => entry.payload?.kind === 'diff' ? [entry.payload] : []);
        const files = new Set(diffs.map(diff => diff.path));
        const totals = diffs.reduce((sum, diff) => {
            const counts = this.diffCounts(diff.diff);
            return { added: sum.added + counts.added, removed: sum.removed + counts.removed };
        }, { added: 0, removed: 0 });
        return <header className='xora-changes-overview'>
            <span className='xora-tool-icon tone-file-write'><span className='codicon codicon-diff' /></span>
            <div><strong>{files.size} 个文件变更</strong><span>逐项审查后再决定是否保留</span></div>
            <span className='xora-change-stats'><b>+{totals.added}</b><i>−{totals.removed}</i></span>
        </header>;
    }

    protected renderPopover(): React.ReactNode {
        if (!this.openPopover) return undefined;
        return <>
            <div className='xora-agent-popover-scrim' aria-hidden='true' onMouseDown={event => this.closePopoverFromScrim(event)} />
            {this.openPopover === 'history' ? this.renderHistoryPopover() : this.renderContextPopover()}
        </>;
    }

    protected renderDraftImages(): React.ReactNode {
        if (!this.draftImages.length && !this.imageReadsInFlight) return undefined;
        return <div
            className='xora-composer-attachments'
            role='list'
            aria-label={`待发送图片，${this.draftImages.length} 张`}>
            {this.draftImages.map(image => <div
                key={image.id}
                className='xora-composer-image'
                role='listitem'
                title={`${image.name ?? '图片'} · ${this.formatByteSize(image.byteSize)}`}>
                <button
                    className='xora-composer-image-preview'
                    type='button'
                    aria-label={`预览图片 ${image.name ?? ''}`.trim()}
                    aria-haspopup='dialog'
                    onClick={event => {
                        this.imagePreviewReturnFocus = event.currentTarget;
                        this.previewImageId = image.id;
                        this.update();
                        requestAnimationFrame(() => this.imagePreviewCloseButton?.focus());
                    }}>
                    <img src={image.previewUrl} alt={image.name ?? '待发送图片'} draggable={false} />
                </button>
                <button
                    className='xora-composer-image-remove'
                    type='button'
                    aria-label={`移除图片 ${image.name ?? ''}`.trim()}
                    title='移除图片'
                    disabled={this.isDraftImageLocked(image.id)}
                    onClick={() => this.removeDraftImage(image.id)}>
                    <span className='codicon codicon-close' />
                </button>
            </div>)}
            {Array.from({ length: this.imageReadsInFlight }, (_, index) => <div
                key={`reading-${index}`}
                className='xora-composer-image xora-composer-image-reading'
                role='listitem'
                aria-label='正在读取图片'>
                <span className='codicon codicon-loading codicon-modifier-spin' />
            </div>)}
        </div>;
    }

    protected renderImagePreview(): React.ReactNode {
        const image = this.draftImages.find(candidate => candidate.id === this.previewImageId);
        if (!image) return undefined;
        // The preview overlays only the Agent sidebar. Keep it non-modal so
        // users can intentionally return to the project tree or editor.
        return <div
            className='xora-image-preview-scrim'
            onMouseDown={event => {
                if (event.target === event.currentTarget) this.closeImagePreview();
            }}>
            <section
                className='xora-image-preview-dialog'
                role='dialog'
                aria-label={`预览 ${image.name ?? '图片'}`}>
                <header>
                    <div>
                        <strong>{image.name ?? '图片'}</strong>
                        <span>{this.formatByteSize(image.byteSize)}</span>
                    </div>
                    <button
                        ref={node => { this.imagePreviewCloseButton = node; }}
                        className='xora-agent-icon-button'
                        type='button'
                        aria-label='关闭图片预览'
                        onClick={() => this.closeImagePreview()}>
                        <span className='codicon codicon-close' />
                    </button>
                </header>
                <div className='xora-image-preview-stage'>
                    <img src={image.previewUrl} alt={image.name ?? '待发送图片预览'} />
                </div>
            </section>
        </div>;
    }

    protected closeImagePreview(): void {
        if (!this.previewImageId) return;
        const returnFocus = this.imagePreviewReturnFocus;
        this.previewImageId = undefined;
        this.imagePreviewCloseButton = null;
        this.imagePreviewReturnFocus = null;
        this.update();
        requestAnimationFrame(() => {
            if (returnFocus?.isConnected) returnFocus.focus();
            else this.textarea?.focus();
        });
    }

    protected handleImagePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
        const images = Array.from(event.clipboardData.items)
            .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
            .map(item => item.getAsFile())
            .filter((file): file is File => !!file);
        // Do not preventDefault: a clipboard can legitimately contain both
        // text and an image, and Chromium should still insert the text.
        if (images.length) void this.addImageFiles(images, '粘贴');
    }

    protected async addImageFiles(files: File[], source: '粘贴' | '选择'): Promise<void> {
        if (!files.length) return;
        const generation = this.imageReadGeneration;
        const contextKey = this.imageDraftContextKey();
        this.imageError = undefined;
        const accepted: File[] = [];
        const errors: string[] = [];
        let reservedCount = this.draftImages.length + this.imageReadsInFlight;
        let reservedBytes = this.draftImages.reduce((total, image) => total + image.byteSize, 0) + this.pendingImageBytes;
        for (const file of files) {
            if (reservedCount >= MAX_PROMPT_IMAGE_COUNT) {
                errors.push(`每次最多添加 ${MAX_PROMPT_IMAGE_COUNT} 张图片。`);
                break;
            }
            if (file.type && !this.isSupportedImageMimeType(file.type)) {
                errors.push('仅支持 PNG、JPEG 和 WebP 图片。');
                continue;
            }
            if (!file.size) {
                errors.push('图片内容为空，未添加。');
                continue;
            }
            if (file.size > MAX_PROMPT_IMAGE_BYTES || reservedBytes + file.size > MAX_PROMPT_IMAGE_BYTES) {
                errors.push('图片总大小不能超过 5 MB。');
                continue;
            }
            accepted.push(file);
            reservedCount += 1;
            reservedBytes += file.size;
        }
        if (!accepted.length) {
            this.imageError = errors[0];
            this.update();
            return;
        }

        const acceptedBytes = accepted.reduce((total, file) => total + file.size, 0);
        this.draftImageContextKey ??= contextKey;
        this.imageReadsInFlight += accepted.length;
        this.pendingImageBytes += acceptedBytes;
        this.update();
        const results = await Promise.all(accepted.map(async file => {
            try {
                return await this.readDraftImage(file, source);
            } catch (error) {
                errors.push(error instanceof Error ? error.message : '无法读取这张图片，请重新添加。');
                return undefined;
            }
        }));
        const added = results.filter((image): image is DraftImageAttachment => !!image);
        if (this.isDisposed || generation !== this.imageReadGeneration) {
            for (const image of added) URL.revokeObjectURL(image.previewUrl);
            return;
        }
        if (contextKey !== this.imageDraftContextKey()) {
            for (const image of added) URL.revokeObjectURL(image.previewUrl);
            this.imageReadsInFlight -= accepted.length;
            this.pendingImageBytes -= acceptedBytes;
            if (!this.hasImageDraft()) this.draftImageContextKey = undefined;
            this.imageAnnouncement = '会话上下文已变化，刚才读取的图片未添加。';
            this.update();
            return;
        }
        this.imageReadsInFlight -= accepted.length;
        this.pendingImageBytes -= acceptedBytes;
        this.draftImages.push(...added);
        if (!this.hasImageDraft()) this.draftImageContextKey = undefined;
        this.imageError = errors[0];
        if (added.length) {
            this.imageAnnouncement = `已添加 ${added.length} 张图片，共 ${this.draftImages.length} 张。`;
        }
        this.update();
    }

    protected async readDraftImage(file: File, source: '粘贴' | '选择'): Promise<DraftImageAttachment> {
        const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        const mimeType = this.detectImageMimeType(signature);
        if (!mimeType) throw new Error('仅支持 PNG、JPEG 和 WebP 图片。');
        if (file.type && this.isSupportedImageMimeType(file.type) && file.type !== mimeType) {
            throw new Error('图片内容与文件类型不一致，未添加。');
        }
        const dataUrl = await this.readFileAsDataUrl(file);
        const separator = dataUrl.indexOf(',');
        if (separator < 0) throw new Error('无法读取这张图片，请重新添加。');
        const data = dataUrl.slice(separator + 1);
        const previewUrl = URL.createObjectURL(file);
        return {
            id: typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            mimeType,
            data,
            name: this.imageFileName(file.name, mimeType, source),
            byteSize: file.size,
            previewUrl
        };
    }

    protected readFileAsDataUrl(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('无法读取这张图片，请重新添加。'));
            reader.onload = () => typeof reader.result === 'string'
                ? resolve(reader.result)
                : reject(new Error('无法读取这张图片，请重新添加。'));
            reader.readAsDataURL(file);
        });
    }

    protected detectImageMimeType(signature: Uint8Array): PromptImageMimeType | undefined {
        if (signature.length >= 8
            && signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47
            && signature[4] === 0x0d && signature[5] === 0x0a && signature[6] === 0x1a && signature[7] === 0x0a) {
            return 'image/png';
        }
        if (signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
            return 'image/jpeg';
        }
        if (signature.length >= 12
            && String.fromCharCode(...signature.slice(0, 4)) === 'RIFF'
            && String.fromCharCode(...signature.slice(8, 12)) === 'WEBP') {
            return 'image/webp';
        }
        return undefined;
    }

    protected isSupportedImageMimeType(value: string): value is PromptImageMimeType {
        return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
    }

    protected imageFileName(name: string, mimeType: PromptImageMimeType, source: '粘贴' | '选择'): string {
        const safeName = name.trim().replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 255);
        if (safeName) return safeName;
        const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
        return `${source === '粘贴' ? '粘贴图片' : '图片'}-${Date.now()}.${extension}`;
    }

    protected removeDraftImage(id: string): void {
        const image = this.draftImages.find(candidate => candidate.id === id);
        if (!image || this.isDraftImageLocked(id)) return;
        const previewWasOpen = this.previewImageId === id;
        URL.revokeObjectURL(image.previewUrl);
        this.draftImages = this.draftImages.filter(candidate => candidate.id !== id);
        if (previewWasOpen) this.dismissImagePreviewAfterContentRemoval();
        if (!this.hasImageDraft()) this.draftImageContextKey = undefined;
        this.imageError = undefined;
        this.imageAnnouncement = `已移除图片，还剩 ${this.draftImages.length} 张。`;
        this.update();
    }

    protected isDraftImageLocked(id: string): boolean {
        return this.submission?.draftAttachmentIds?.includes(id) ?? false;
    }

    protected hasImageDraft(): boolean {
        return (this.draftImages?.length ?? 0) > 0 || (this.imageReadsInFlight ?? 0) > 0;
    }

    protected clearDraftImages(announcement?: string): void {
        const previewWasOpen = !!this.previewImageId;
        this.imageReadGeneration += 1;
        for (const image of this.draftImages) URL.revokeObjectURL(image.previewUrl);
        this.draftImages = [];
        this.imageReadsInFlight = 0;
        this.pendingImageBytes = 0;
        this.imageError = undefined;
        if (previewWasOpen) this.dismissImagePreviewAfterContentRemoval();
        this.draftImageContextKey = undefined;
        if (this.imageInput) this.imageInput.value = '';
        if (announcement) this.imageAnnouncement = announcement;
    }

    /**
     * Context changes and attachment removal can dismiss the preview without
     * going through its close button. Restore focus to the composer after the
     * next render so focus is never left on a detached dialog node.
     */
    protected dismissImagePreviewAfterContentRemoval(): void {
        this.previewImageId = undefined;
        this.imagePreviewCloseButton = null;
        this.imagePreviewReturnFocus = null;
        requestAnimationFrame(() => {
            if (!this.isDisposed) this.textarea?.focus();
        });
    }

    protected imageDraftContextKey(): string {
        const snapshot = this.model.snapshot;
        return this.agentContextKey(
            snapshot.workspaceRoot ?? this.roots?.[0] ?? '',
            snapshot.providerId,
            snapshot.activeSessionId
        );
    }

    protected agentContextKey(workspaceRoot: string, providerId: string, sessionId?: string): string {
        return [workspaceRoot, providerId, sessionId ?? 'new'].join('\u0000');
    }

    protected submissionTargetContextKey(submission: PromptSubmission): string | undefined {
        if (submission.sourceSessionId || !submission.sessionId) return undefined;
        return this.agentContextKey(submission.workspaceRoot, submission.providerId, submission.sessionId);
    }

    protected isSubmissionContextCurrent(submission: PromptSubmission): boolean {
        if (submission.generation !== this.agentContextGeneration) return false;
        const current = this.imageDraftContextKey();
        return current === submission.contextKey || current === this.submissionTargetContextKey(submission);
    }

    protected invalidateAgentContext(announcement?: string): void {
        this.agentContextGeneration += 1;
        this.sessionLoadGeneration += 1;
        this.sessionLoading = false;
        this.runtimePrewarmRequested = true;
        this.runtimePrewarmAttemptKey = undefined;
        this.runtimePrewarmAttempts = 0;
        this.activeSessionHydrationKey = undefined;
        this.cancelRuntimePrewarmTimer();
        if (this.hasImageDraft()) this.clearDraftImages(announcement);
        this.retryablePrompt = undefined;
        this.toolDisclosure?.clear();
        this.diffDisclosure?.clear();
    }

    protected reconcileAgentContext(): void {
        const providerId = this.model.snapshot.providerId;
        if (this.observedProviderId !== undefined && providerId !== this.observedProviderId) {
            this.newSessionModel = undefined;
        }
        this.observedProviderId = providerId;
        const current = this.imageDraftContextKey();
        if (this.observedAgentContextKey !== undefined && current !== this.observedAgentContextKey) {
            const submission = this.submission;
            const controlledSubmissionTransition = submission
                && submission.generation === this.agentContextGeneration
                && this.observedAgentContextKey === submission.contextKey
                && current === this.submissionTargetContextKey(submission);
            if (controlledSubmissionTransition) {
                if (this.draftImageContextKey === submission.contextKey) {
                    this.draftImageContextKey = current;
                }
            } else {
                this.invalidateAgentContext('会话上下文已变化，未发送的图片已清除。');
            }
        }
        this.observedAgentContextKey = current;
    }

    protected consumeDraftImages(ids: string[]): void {
        const consumed = new Set(ids);
        const previewWasConsumed = !!this.previewImageId && consumed.has(this.previewImageId);
        for (const image of this.draftImages) {
            if (consumed.has(image.id)) URL.revokeObjectURL(image.previewUrl);
        }
        this.draftImages = this.draftImages.filter(image => !consumed.has(image.id));
        if (previewWasConsumed) this.dismissImagePreviewAfterContentRemoval();
        if (!this.draftImages.length && !this.imageReadsInFlight) this.draftImageContextKey = undefined;
        this.imageError = undefined;
    }

    protected formatByteSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    protected renderHistoryPopover(): React.ReactNode {
        const snapshot = this.model.snapshot;
        const sessions = snapshot.sessions.filter(session =>
            session.workspaceRoot === snapshot.workspaceRoot && session.providerId === snapshot.providerId);
        return <section className='xora-agent-popover xora-session-popover' role='dialog' aria-label='会话历史'>
            <header className='xora-popover-header'>
                <div>
                    <strong>会话历史</strong>
                    <span>{sessions.length ? `${sessions.length} 个会话` : '当前项目还没有会话'}</span>
                </div>
                <button
                    className='xora-agent-icon-button'
                    aria-label='刷新会话历史'
                    title='刷新'
                    disabled={!!this.submission || this.sessionLoading}
                    onClick={() => this.refreshAll()}>
                    <span className={`codicon ${this.sessionLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'}`} />
                </button>
            </header>
            <div className='xora-session-list' role='list'>
                {sessions.length ? sessions.map(session => {
                    const active = session.appSessionId === snapshot.activeSessionId;
                    return <button
                        key={session.appSessionId}
                        className={`xora-session-item${active ? ' active' : ''}`}
                        role='listitem'
                        aria-current={active ? 'true' : undefined}
                        disabled={!!this.submission || this.sessionLoading}
                        onClick={() => {
                            this.closePopover();
                            if (!active) void this.openSession(session);
                        }}>
                        <span className={`xora-session-status-dot xora-session-status-${session.status}`} />
                        <span className='xora-session-item-copy'>
                            <strong title={session.title}>{session.title || '未命名会话'}</strong>
                            <span>{sessionStatusLabel(session.status)} · {sessionRelativeTime(session.updatedAt)}</span>
                        </span>
                        {active ? <span className='codicon codicon-check' aria-label='当前会话' /> : undefined}
                    </button>;
                }) : <div className='xora-session-empty'>完成第一项任务后，会话会显示在这里。</div>}
            </div>
            <footer className='xora-popover-footer'>
                <button className='theia-button secondary' disabled={!!this.submission || this.sessionLoading} onClick={() => this.startNewSession()}>
                    <span className='codicon codicon-add' /> 新建会话
                </button>
            </footer>
        </section>;
    }

    protected renderContextPopover(): React.ReactNode {
        const snapshot = this.model.snapshot;
        const summary = summarizeAgentContext(snapshot, this.model.transcript);
        const active = snapshot.sessions.find(session => session.appSessionId === snapshot.activeSessionId);
        const permissionMode = snapshot.permissionMode;
        const usageKnown = summary.totalTokens !== undefined && summary.contextWindow !== undefined;
        const contextLabel = summary.compactionStatus === 'running'
            ? '正在整理上下文'
            : summary.compactionStatus === 'failed'
                ? '最近一次整理失败'
                : summary.compactionStatus === 'cancelled'
                    ? '最近一次整理已取消'
                    : usageKnown ? '当前上下文占用' : '上下文自动管理';
        return <section className='xora-agent-popover xora-context-popover' role='dialog' aria-label='当前会话上下文'>
            <header className='xora-popover-header'>
                <div>
                    <strong>上下文概览</strong>
                    <span>{active?.title ?? '新会话'}</span>
                </div>
                <button className='xora-agent-icon-button' aria-label='关闭上下文概览' onClick={() => this.closePopover()}>
                    <span className='codicon codicon-close' />
                </button>
            </header>
            <div className={`xora-context-usage xora-context-${summary.compactionStatus}`}>
                <span
                    className='xora-context-ring xora-context-ring-large'
                    style={this.contextRingStyle(summary)}
                    aria-hidden='true' />
                <div>
                    <span>{contextLabel}</span>
                    <strong>{summary.compactionStatus === 'running'
                        ? '整理中'
                        : summary.usagePercent !== undefined ? `${summary.usagePercent}%` : 'Grok Build'}</strong>
                    <small>{usageKnown
                        ? `${this.formatTokenCount(summary.totalTokens!)} / ${this.formatTokenCount(summary.contextWindow!)}`
                        : '获得运行时数据后显示真实占用'}</small>
                </div>
            </div>
            <div className='xora-context-model'>
                <span>当前模型</span>
                <strong>{summary.currentModelName}</strong>
                <small>{summary.contextWindow
                    ? `上下文窗口最多 ${this.formatContextWindow(summary.contextWindow)}`
                    : '上下文窗口由当前模型服务决定'}</small>
            </div>
            <dl className='xora-context-metrics'>
                <div><dt>消息</dt><dd>{summary.messageCount}</dd></div>
                <div><dt>操作</dt><dd>{summary.toolCount}</dd></div>
                <div><dt>变更文件</dt><dd>{summary.changedFileCount}</dd></div>
                <div><dt>权限</dt><dd>{permissionMode === 'full-access' ? '完全访问权限' : '请求审批'}</dd></div>
                <div><dt>Grok Build</dt><dd>{snapshot.sidecarVersion ?? active?.sidecarVersion ?? '未启动'}</dd></div>
            </dl>
            {summary.compactionCount > 0 ? <p className='xora-context-compaction-history'>
                <span className='codicon codicon-fold' />
                <span>已自动整理 {summary.compactionCount} 次{summary.lastCompaction
                    ? summary.lastCompaction.tokensBefore !== undefined
                        ? ` · ${this.formatTokenCount(summary.lastCompaction.tokensBefore)} → ${this.formatTokenCount(summary.lastCompaction.tokensAfter)}`
                        : ` · 整理后 ${this.formatTokenCount(summary.lastCompaction.tokensAfter)}`
                    : ''}</span>
            </p> : undefined}
            <p className='xora-context-disclaimer'>{usageKnown
                ? '占用来自 Grok Build 的上下文元数据；计费 usage 不参与这里的计算。'
                : '暂无实时用量。上下文仍由 Grok Build 原生自动管理，达到阈值后会自动整理。'}</p>
        </section>;
    }

    protected togglePopover(popover: AgentPopover): void {
        this.openPopover = this.openPopover === popover ? undefined : popover;
        this.update();
    }

    protected closePopover(): void {
        if (!this.openPopover) return;
        this.openPopover = undefined;
        this.update();
    }

    protected closePopoverFromScrim(event: React.MouseEvent<HTMLDivElement>): void {
        const textareaBounds = this.textarea?.getBoundingClientRect();
        const shouldFocusComposer = !!textareaBounds
            && event.clientX >= textareaBounds.left
            && event.clientX <= textareaBounds.right
            && event.clientY >= textareaBounds.top
            && event.clientY <= textareaBounds.bottom;
        this.closePopover();
        if (shouldFocusComposer) {
            event.preventDefault();
            requestAnimationFrame(() => this.textarea?.focus());
        }
    }

    protected handleRootKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
        const nativeEvent = event.nativeEvent as KeyboardEvent;
        if (this.imeComposing || this.imeCompositionJustEnded || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
        if (event.key !== 'Escape' || (!this.openPopover && !this.previewImageId)) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.previewImageId) this.closeImagePreview();
        else this.closePopover();
    }

    protected selectedModelValue(snapshot: RuntimeSnapshot, active: SessionRecord | undefined): string {
        const providerDefault = this.providers.find(provider => provider.id === snapshot.providerId)?.model;
        const selected = active
            ? snapshot.selectedModel ?? active.model ?? snapshot.models[0]?.id ?? ''
            : this.newSessionModel ?? snapshot.selectedModel ?? providerDefault ?? snapshot.models[0]?.id ?? '';
        if (!selected) return '';
        return snapshot.models.find(model => model.id === selected
            || this.normalizedModelKey(model.id) === this.normalizedModelKey(selected)
            || this.normalizedModelKey(model.name) === this.normalizedModelKey(selected))?.id ?? selected;
    }

    protected normalizedModelKey(value: string): string {
        return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    protected renderModelOptions(snapshot: RuntimeSnapshot, active: SessionRecord | undefined): React.ReactNode {
        const selected = this.selectedModelValue(snapshot, active);
        const selectedIsKnown = snapshot.models.some(model => model.id === selected);
        return <>
            {selected && !selectedIsKnown ? <option value={selected}>{selected}</option> : undefined}
            {!selected && snapshot.models.length === 0
                ? <option value=''>{this.modelOptionsLoading ? '正在加载模型…' : '选择模型…'}</option>
                : undefined}
            {snapshot.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </>;
    }

    protected formatContextWindow(value: number): string {
        return `${new Intl.NumberFormat('zh-CN').format(value)} tokens`;
    }

    protected formatTokenCount(value: number): string {
        return `${new Intl.NumberFormat('zh-CN', {
            notation: 'compact',
            maximumFractionDigits: 1
        }).format(value)} tokens`;
    }

    protected contextRingStyle(summary: AgentContextSummary): React.CSSProperties {
        const progress = Math.max(0, Math.min(100, summary.usagePercent ?? 0));
        return { '--xora-context-progress': `${progress}%` } as React.CSSProperties;
    }

    protected contextTriggerTitle(summary: AgentContextSummary): string {
        if (summary.compactionStatus === 'running') return '正在整理上下文';
        if (summary.usagePercent !== undefined) {
            return `上下文 ${summary.usagePercent}%${summary.compactionCount ? ` · 已自动整理 ${summary.compactionCount} 次` : ''}`;
        }
        return '上下文由 Grok Build 自动管理';
    }

    protected renderEmpty(): React.ReactNode {
        const snapshot = this.model.snapshot;
        const provider = this.providers.find(candidate => candidate.id === snapshot.providerId);
        const subscriptionStatus = grokSubscriptionAuthStatus(snapshot);
        const grokAuthenticated = provider?.kind === 'grok-subscription' && subscriptionStatus === 'authenticated';
        const configuredProvider = provider?.kind !== 'grok-subscription' && provider?.credentialConfigured === true;
        const settingsConnected = grokAuthenticated || configuredProvider;
        const settingsLabel = grokAuthenticated
            ? 'Grok 订阅已登录'
            : provider?.kind === 'grok-subscription' && subscriptionStatus === 'unauthenticated'
                ? '登录 Grok'
                : configuredProvider
                    ? `${provider.name} 已配置`
                    : '账户与模型设置';
        return <div className='xora-empty'>
            <div className='xora-empty-mark' aria-hidden='true'><span className='xora-agent-brand-icon' /></div>
            <h3>今天想完成什么？</h3>
            <p>描述目标即可。Xora Code 会先保存文件，并在执行敏感操作前请求确认。</p>
            <div className='xora-prompt-suggestions'>
                {[
                    ['codicon-map', '梳理项目结构', '阅读这个项目，概括技术栈、目录结构和主要入口。'],
                    ['codicon-bug', '检查并修复问题', '检查当前项目中最明显的问题，说明原因并修复。'],
                    ['codicon-beaker', '为改动补充测试', '检查当前改动，并为关键行为补充或更新测试。']
                ].map(([icon, label, prompt]) => <button key={label} onClick={() => this.useSuggestion(prompt)}>
                    <span className={`codicon ${icon}`} />
                    <span>{label}</span>
                    <span className='codicon codicon-arrow-right' />
                </button>)}
            </div>
            <button
                className={`xora-empty-settings${settingsConnected ? ' is-connected' : ''}`}
                title='打开账户、模型与扩展设置'
                onClick={() => this.commandService.executeCommand(OPEN_AGENT_SETTINGS_COMMAND.id)}>
                {settingsConnected ? <span className='codicon codicon-check' /> : undefined}
                {settingsLabel}
            </button>
        </div>;
    }

    /** The composer belongs to the Agent surface, not Theia's executable
     * workspace trust gate. Only a missing project or an explicit history
     * restore prevents submission. */
    protected composerGate(snapshot: RuntimeSnapshot): ComposerGate | undefined {
        if (!snapshot.workspaceRoot && this.roots.length === 0) {
            return { kind: 'project', message: '打开项目后即可发送' };
        }
        if (this.sessionLoading) {
            return { kind: 'restore', message: '正在恢复会话' };
        }
        return undefined;
    }

    /** Project open is the prewarm signal. Keystrokes may call this method too,
     * but they are no longer required to start Grok or initialize ACP. */
    protected requestRuntimePrewarm(_explicitContent = false): void {
        this.runtimePrewarmRequested = true;
        this.scheduleRuntimePrewarm();
    }

    protected scheduleRuntimePrewarm(): void {
        if (!this.runtimePrewarmRequested || this.submission || this.sessionLoading) return;
        const snapshot = this.model.snapshot;
        if (snapshot.phase === 'ready' || snapshot.phase === 'auth-required') {
            this.runtimePrewarmRequested = false;
            this.runtimePrewarmAttempts = 0;
            this.runtimePrewarmAttemptKey = undefined;
            this.cancelRuntimePrewarmTimer();
            if (snapshot.phase === 'ready') void this.hydrateActiveSessionInBackground();
            return;
        }
        // Never race an in-flight lifecycle transition. A crashed background
        // startup gets one bounded retry; prompts themselves are never replayed.
        if (snapshot.phase !== 'stopped' && snapshot.phase !== 'crashed') return;
        if (snapshot.phase === 'crashed' && this.runtimePrewarmAttempts >= RUNTIME_PREWARM_MAX_ATTEMPTS) {
            this.runtimePrewarmRequested = false;
            return;
        }
        const root = snapshot.workspaceRoot;
        if (!root || !snapshot.workspaceAttached || !this.roots.includes(root)) return;
        const provider = this.providers.find(candidate => candidate.id === snapshot.providerId);
        if (!provider || (provider.kind !== 'grok-subscription' && provider.credentialConfigured !== true)) return;

        const key = this.agentContextKey(root, snapshot.providerId, snapshot.activeSessionId);
        if (this.runtimePrewarmAttemptKey === key) return;
        this.cancelRuntimePrewarmTimer();
        this.runtimePrewarmAttemptKey = key;
        this.runtimePrewarmTimer = window.setTimeout(() => {
            this.runtimePrewarmTimer = undefined;
            void this.prewarmRuntime(root, snapshot.providerId, key);
        }, snapshot.phase === 'crashed' ? RUNTIME_PREWARM_RETRY_DELAY_MS : RUNTIME_PREWARM_DELAY_MS);
    }

    protected async prewarmRuntime(root: string, providerId: string, key: string): Promise<void> {
        const current = this.model.snapshot;
        if ((current.phase !== 'stopped' && current.phase !== 'crashed')
            || current.workspaceRoot !== root
            || current.providerId !== providerId
            || !current.workspaceAttached) {
            if (this.runtimePrewarmAttemptKey === key) this.runtimePrewarmAttemptKey = undefined;
            this.scheduleRuntimePrewarm();
            return;
        }
        this.runtimePrewarmAttempts += 1;
        try {
            await this.service.startRuntime({ workspaceRoot: root, providerId });
            if (this.model.snapshot.workspaceRoot === root && this.model.snapshot.providerId === providerId) {
                await this.model.refresh();
                await this.hydrateActiveSessionInBackground();
            }
        } catch {
            // The backend publishes a redacted crash snapshot. Prewarming is
            // best-effort and must not interrupt drafting with a duplicate toast.
            await this.model.refresh().catch(() => undefined);
            const failed = this.model.snapshot;
            if (failed.phase === 'crashed'
                && failed.workspaceRoot === root
                && failed.providerId === providerId
                && failed.workspaceAttached
                && this.runtimePrewarmAttempts < RUNTIME_PREWARM_MAX_ATTEMPTS) {
                this.runtimePrewarmRequested = true;
                if (this.runtimePrewarmAttemptKey === key) this.runtimePrewarmAttemptKey = undefined;
                this.scheduleRuntimePrewarm();
            }
        } finally {
            const phase = this.model.snapshot.phase;
            if (phase === 'ready' || phase === 'auth-required') {
                this.runtimePrewarmRequested = false;
                this.runtimePrewarmAttempts = 0;
                this.runtimePrewarmAttemptKey = undefined;
            } else if (phase === 'crashed' && this.runtimePrewarmAttempts >= RUNTIME_PREWARM_MAX_ATTEMPTS) {
                this.runtimePrewarmRequested = false;
            }
            this.update();
        }
    }

    protected reconcileRuntimePrewarmState(): void {
        const phase = this.model.snapshot.phase;
        if (phase === 'stopped' && this.observedRuntimePhase !== undefined && this.observedRuntimePhase !== 'stopped') {
            this.runtimePrewarmRequested = true;
            this.runtimePrewarmAttempts = 0;
            this.runtimePrewarmAttemptKey = undefined;
            this.activeSessionHydrationKey = undefined;
        }
        // If an already-ready, idle transport dies, restore standby without
        // waiting for another keystroke. An active submission keeps ownership
        // of its failure path, and its prompt is never replayed.
        if (phase === 'crashed'
            && this.observedRuntimePhase === 'ready'
            && !this.runtimePrewarmRequested
            && !this.submission) {
            this.runtimePrewarmRequested = true;
            this.runtimePrewarmAttempts = 0;
            this.runtimePrewarmAttemptKey = undefined;
            this.activeSessionHydrationKey = undefined;
        }
        this.observedRuntimePhase = phase;
    }

    protected async hydrateActiveSessionInBackground(): Promise<void> {
        const snapshot = this.model.snapshot;
        const sessionId = snapshot.activeSessionId;
        const root = snapshot.workspaceRoot;
        if (snapshot.phase !== 'ready' || !root || !sessionId) return;
        const key = this.agentContextKey(root, snapshot.providerId, sessionId);
        if (this.activeSessionHydrationKey === key) return;
        this.activeSessionHydrationKey = key;
        try {
            await this.service.loadSession(sessionId);
        } catch {
            // A stale/non-loadable history remains visible locally. The first
            // explicit Send retries through the normal actionable error path.
        }
    }

    protected cancelRuntimePrewarmTimer(): void {
        if (this.runtimePrewarmTimer === undefined) return;
        window.clearTimeout(this.runtimePrewarmTimer);
        this.runtimePrewarmTimer = undefined;
    }

    protected renderRuntimeNotice(message: string): React.ReactNode {
        return <div className='xora-runtime-notice' role='status'>
            <span className='codicon codicon-info' />
            <span>{message}</span>
        </div>;
    }

    protected useSuggestion(prompt: string): void {
        this.prompt = prompt;
        this.requestRuntimePrewarm();
        if (this.textarea) {
            this.textarea.value = prompt;
            this.resizeComposer(this.textarea);
        }
        this.update();
        requestAnimationFrame(() => {
            if (!this.textarea) return;
            this.resizeComposer(this.textarea);
            this.textarea.focus();
            this.textarea.setSelectionRange(prompt.length, prompt.length);
        });
    }

    protected startNewSession(): void {
        if (this.submission || this.sessionLoading) return;
        this.resetToNewSession('已为新会话清除未发送图片。', true);
    }

    /**
     * A Theia workspace activation is a navigation boundary, not a request to
     * resume the backend's last active ACP session. Keep persisted history in
     * the session list, but pin the visible model to its explicit new-session
     * state before runtime prewarming can consider restoring anything.
     *
     * This method intentionally runs even when the canonical root is unchanged:
     * reopening the same folder must still present a clean conversation page.
     */
    protected activateWorkspace(roots: string[]): void {
        this.roots = roots;
        this.resetToNewSession('项目已变化，未发送的图片已清除。');
        this.requestRuntimePrewarm(true);
        this.update();
    }

    protected resetToNewSession(announcement: string, focusComposer = false): void {
        this.invalidateAgentContext(announcement);
        this.openPopover = undefined;
        this.newSessionModel = this.model.snapshot.selectedModel;
        this.retryablePrompt = undefined;
        this.newOutputAvailable = false;
        this.stickToBottom = true;
        this.agentPaneView = 'conversation';
        this.activityFilter = 'all';
        // AgentViewModel emits one render for the transition. Set all local
        // state first so clicking New session never schedules a duplicate
        // full-panel update.
        this.observedAgentContextKey = this.agentContextKey(
            this.model.snapshot.workspaceRoot ?? this.roots[0] ?? '',
            this.model.snapshot.providerId
        );
        this.model.startNewSession();
        if (focusComposer) requestAnimationFrame(() => this.textarea?.focus());
    }

    protected async refreshAll(): Promise<void> {
        try {
            await Promise.all([this.model.refresh(), this.refreshProviders()]);
        } catch (error) {
            this.messages.error(`无法刷新 Agent：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async selectWorkspaceRoot(root: string): Promise<void> {
        if (root === this.model.snapshot.workspaceRoot || this.sessionLoading || this.submission) return;
        try {
            await this.workspaceTrustGuard.selectWorkspaceRoot(root);
            this.resetToNewSession('Agent 主目录已切换，未发送的图片已清除。');
            this.requestRuntimePrewarm(true);
        } catch (error) {
            this.messages.error(error instanceof Error ? error.message : String(error));
        } finally {
            this.update();
        }
    }

    protected async selectModel(session: SessionRecord | undefined, modelId: string): Promise<void> {
        if (this.sessionLoading) return;
        if (!session) {
            if (!modelId) return;
            // Apply immediately so the composer remains responsive even when
            // another window briefly holds the preferences file lock.
            this.newSessionModel = modelId;
            this.update();
            try {
                await this.service.selectDefaultModel(this.model.snapshot.providerId, modelId);
                await this.model.refresh();
            } catch (error) {
                this.messages.error(`无法保存默认模型：${error instanceof Error ? error.message : String(error)}`);
            } finally {
                this.update();
            }
            return;
        }
        try {
            await this.service.selectModel(session.appSessionId, modelId);
            await this.model.refresh();
        } catch (error) {
            this.messages.error(`无法切换模型：${error instanceof Error ? error.message : String(error)}`);
            await this.model.refresh().catch(() => undefined);
        }
    }

    protected async loadModelOptions(): Promise<void> {
        let snapshot = this.model.snapshot;
        if (snapshot.models.length > 0 || this.modelOptionsLoading || this.submission || this.sessionLoading) return;
        // Runtime initialize may report Grok's process default before a
        // session exists. Keep the user's cross-project default pinned while
        // loading the authoritative model catalogue.
        if (!snapshot.activeSessionId && !this.newSessionModel && snapshot.selectedModel) {
            this.newSessionModel = snapshot.selectedModel;
        }
        const root = await this.workspaceRoot();
        if (!root) {
            this.messages.warn('请先打开一个文件夹或工作区。');
            return;
        }
        if (!snapshot.workspaceAttached) {
            await this.workspaceTrustGuard.selectWorkspaceRoot(root);
            await this.model.refresh();
            snapshot = this.model.snapshot;
        }
        const providerId = snapshot.providerId;
        const contextKey = this.agentContextKey(root, providerId, snapshot.activeSessionId);
        const generation = this.agentContextGeneration;
        const contextIsCurrent = (): boolean => generation === this.agentContextGeneration
            && this.imageDraftContextKey() === contextKey
            && this.model.snapshot.providerId === providerId;
        this.modelOptionsLoading = true;
        this.update();
        try {
            if (!this.providers.some(provider => provider.id === providerId)) {
                await this.refreshProviders();
            }
            let runtime = this.model.snapshot;
            if (runtime.phase === 'stopped' || runtime.phase === 'crashed') {
                runtime = await this.service.startRuntime({ workspaceRoot: root, providerId });
            } else if (!['ready', 'auth-required'].includes(runtime.phase)) {
                return;
            }
            if (!contextIsCurrent()) return;
            if (!await this.authenticateRuntime(runtime, contextIsCurrent)) return;
            if (!contextIsCurrent()) return;
            await this.model.refresh();
            if (!contextIsCurrent()) return;
            if (this.model.snapshot.models.length === 0) {
                this.messages.info('当前服务未提供可切换的模型，将使用默认模型。');
            }
        } catch (error) {
            if (contextIsCurrent()) {
                this.messages.error(`无法加载模型：${error instanceof Error ? error.message : String(error)}`);
            }
        } finally {
            this.modelOptionsLoading = false;
            this.update();
        }
    }

    protected async selectPermissionMode(mode: AgentPermissionMode): Promise<void> {
        if (this.permissionModeChanging || this.sessionLoading || this.submission) return;
        const currentMode = this.model.snapshot.permissionMode;
        if (mode === currentMode) return;
        if (mode === 'full-access') {
            const choice = await this.messages.warn(
                '完全访问会自动批准所有项目、会话和窗口后续的兼容工具请求，包括运行命令和修改文件。此设置会保存到 Xora Code；项目 Trust、工作区路径边界与 Electron 后端安全策略仍然生效。',
                '启用完全访问'
            );
            if (choice !== '启用完全访问') {
                this.update();
                return;
            }
        }
        this.permissionModeChanging = true;
        this.update();
        try {
            await this.service.setPermissionMode(mode);
            await this.model.refresh();
            this.messages.info(mode === 'full-access'
                ? '所有项目和会话已启用完全访问权限。'
                : '所有项目和会话已恢复为请求审批。');
        } catch (error) {
            this.messages.error(`无法修改 Agent 全局权限：${error instanceof Error ? error.message : String(error)}`);
            await this.model.refresh().catch(() => undefined);
        } finally {
            this.permissionModeChanging = false;
            this.update();
        }
    }

    protected async decidePermission(
        permission: PermissionRequestEvent,
        outcome: 'allow-once' | 'allow-always' | 'reject'
    ): Promise<void> {
        if (this.permissionDecisions.has(permission.requestId)) return;
        this.permissionDecisions.add(permission.requestId);
        this.update();
        try {
            await this.model.decide({ requestId: permission.requestId, outcome });
        } catch (error) {
            this.messages.error(`无法提交权限决定：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.permissionDecisions.delete(permission.requestId);
            this.update();
        }
    }

    protected followTranscript(): void {
        if (this.agentPaneView !== 'conversation' || this.followTranscriptFrame !== undefined) return;
        this.followTranscriptFrame = window.requestAnimationFrame(() => {
            this.followTranscriptFrame = undefined;
            const node = this.transcriptNode;
            if (!node) return;
            if (this.stickToBottom) {
                node.scrollTop = node.scrollHeight;
                if (this.newOutputAvailable) {
                    this.newOutputAvailable = false;
                    this.update();
                }
            } else if (!this.newOutputAvailable && this.model.transcript.length > 0) {
                this.newOutputAvailable = true;
                this.update();
            }
        });
    }

    protected onTranscriptScroll(node: HTMLElement): void {
        if (this.agentPaneView !== 'conversation') return;
        const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 56;
        this.stickToBottom = nearBottom;
        if (nearBottom && this.newOutputAvailable) {
            this.newOutputAvailable = false;
            this.update();
        }
    }

    protected scrollToBottom(): void {
        this.stickToBottom = true;
        this.newOutputAvailable = false;
        if (this.transcriptNode) this.transcriptNode.scrollTop = this.transcriptNode.scrollHeight;
        this.update();
    }

    protected resizeComposer(textarea: HTMLTextAreaElement): void {
        textarea.style.height = '0px';
        const height = `${Math.min(160, Math.max(44, textarea.scrollHeight))}px`;
        if (textarea.style.height !== height) textarea.style.height = height;
    }

    /** Coalesce all input events in a frame into one layout measurement. */
    protected scheduleComposerResize(textarea: HTMLTextAreaElement): void {
        this.composerResizeTarget = textarea;
        if (this.composerResizeFrame !== undefined) return;
        this.composerResizeFrame = window.requestAnimationFrame(() => {
            this.composerResizeFrame = undefined;
            const target = this.composerResizeTarget;
            this.composerResizeTarget = null;
            if (target?.isConnected) this.resizeComposer(target);
        });
    }

    /** Typing changes only the send affordance; all other dependencies are
     * synchronized by the normal React render path. */
    protected syncComposerSubmitButton(): void {
        const button = this.composerSubmitButton;
        if (!button || button.classList.contains('xora-composer-stop')) return;
        const snapshot = this.model.snapshot;
        const imageCapabilityError = this.draftImages.length > 0 && snapshot.capabilities?.prompt.image === false;
        button.disabled = (!this.prompt.trim() && this.draftImages.length === 0)
            || !!this.submission
            || !!this.composerGate(snapshot)
            || this.sessionLoading
            || this.imageReadsInFlight > 0
            || imageCapabilityError;
    }

    protected rootLabel(root: string): string {
        const normalized = root.replace(/\\/g, '/').replace(/\/$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || root;
    }

    protected fileLabel(path: string): string {
        return this.rootLabel(path);
    }

    protected fileDirectoryLabel(path: string): string {
        const uri = this.workspaceFileUri(path);
        const root = this.model.snapshot.workspaceRoot;
        if (uri && root) {
            const relative = new URI(VSCodeURI.file(root)).normalizePath().relative(uri)?.toString();
            if (relative) {
                const normalized = relative.replace(/\\/g, '/');
                const separator = normalized.lastIndexOf('/');
                return separator >= 0 ? normalized.slice(0, separator) || '项目根目录' : '项目根目录';
            }
        }
        const normalized = path.replace(/\\/g, '/');
        const separator = normalized.lastIndexOf('/');
        return separator >= 0 ? normalized.slice(0, separator) || '项目根目录' : '项目根目录';
    }

    protected fileIconClass(path: string): string {
        const extension = this.fileLabel(path).toLowerCase().split('.').pop();
        if (extension === 'md' || extension === 'mdx') return 'codicon-markdown';
        if (extension === 'json' || extension === 'jsonc') return 'codicon-json';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(extension ?? '')) return 'codicon-file-media';
        if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'css', 'scss', 'html', 'vue', 'svelte'].includes(extension ?? '')) {
            return 'codicon-file-code';
        }
        return 'codicon-file';
    }

    protected workspaceFileUri(filePath: string): URI | undefined {
        const root = this.model.snapshot.workspaceRoot;
        if (!root) return undefined;
        const rootUri = new URI(VSCodeURI.file(root)).normalizePath();
        const normalizedPath = filePath.replace(/\\/g, '/');
        const absolute = normalizedPath.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedPath);
        const candidate = (absolute
            ? new URI(VSCodeURI.file(filePath))
            : rootUri.resolve(normalizedPath)).normalizePath();
        const caseSensitive = !/^[a-zA-Z]:[\\/]/.test(root);
        return rootUri.isEqualOrParent(candidate, caseSensitive) ? candidate : undefined;
    }

    protected diffCounts(diff: string): { added: number; removed: number } {
        let added = 0;
        let removed = 0;
        for (const line of diff.split(/\r?\n/)) {
            if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
            if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
        }
        return { added, removed };
    }

    protected planStatusIcon(status: AgentPlanEvent['entries'][number]['status']): string {
        switch (status) {
            case 'completed': return 'codicon-check';
            case 'in-progress': return 'codicon-loading codicon-modifier-spin';
            case 'failed': return 'codicon-error';
            default: return 'codicon-circle-outline';
        }
    }

    protected printToolInput(input: unknown): string {
        if (typeof input === 'string') return input;
        try {
            return JSON.stringify(input, undefined, 2);
        } catch {
            return String(input);
        }
    }

    protected async copyMessage(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            this.messages.info('已复制消息。');
        } catch {
            this.messages.warn('无法访问剪贴板，请手动选择文本复制。');
        }
    }

    protected renderTranscript(entries: TranscriptEntry[]): React.ReactNode[] {
        const rendered: React.ReactNode[] = [];
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            if (entry.kind !== 'tool') {
                rendered.push(this.renderEntry(entry));
                continue;
            }
            const tools = [entry];
            while (index + 1 < entries.length && entries[index + 1].kind === 'tool') {
                tools.push(entries[index + 1]);
                index += 1;
            }
            // Keep the conversation timeline structurally stable from the
            // very first tool event. Previously one running tool rendered as
            // a fully expanded card, then remounted as an "Agent 活动" group
            // when the next event arrived. Large input/output blocks flashed
            // for a frame and shifted the whole transcript.
            rendered.push(this.agentPaneView === 'conversation' || tools.length > 1
                ? this.renderToolGroup(tools, this.agentPaneView === 'conversation')
                : this.renderToolEntry(entry));
        }
        return rendered;
    }

    protected renderToolGroup(entries: TranscriptEntry[], compact = false): React.ReactNode {
        const tools = entries.map(entry => entry.payload as ToolCallEvent);
        const categories = summarizeToolCategories(tools);
        const active = tools.some(tool => tool.status === 'pending' || tool.status === 'running');
        const failed = tools.some(tool => tool.status === 'failed' || tool.status === 'rejected');
        const status = active ? '执行中' : failed ? '有未完成项' : '已完成';
        const disclosureId = `group:${entries[0].id}`;
        const defaultExpanded = compact ? false : active || failed;
        const expanded = this.toolDisclosureOpen(disclosureId, defaultExpanded);
        return <details
            key={`tool-group-${entries[0].id}`}
            className='xora-activity xora-tool-group'
            open={expanded}
            onToggle={event => this.rememberToolDisclosure(disclosureId, event.currentTarget.open, defaultExpanded)}>
            <summary className='xora-activity-summary'>
                <span className='xora-tool-icon tone-group'><span className={`codicon ${active ? 'codicon-loading codicon-modifier-spin' : failed ? 'codicon-warning' : 'codicon-check-all'}`} /></span>
                <span className='xora-tool-group-copy'>
                    <span className='xora-activity-title'>Agent 活动</span>
                    <span className='xora-tool-category-list'>{categories.map(category => <span key={category.filter}>
                        {category.label}{category.count > 1 ? ` ${category.count}` : ''}
                    </span>)}</span>
                </span>
                <span className='xora-activity-meta'>{tools.length} 项 · {status}</span>
                <span className='codicon codicon-chevron-right xora-details-chevron' />
            </summary>
            {expanded ? <div className='xora-tool-group-body'>
                {entries.map(entry => this.renderToolEntry(entry, true))}
            </div> : undefined}
        </details>;
    }

    protected renderToolEntry(entry: TranscriptEntry, nested = false): React.ReactNode {
        const tool = entry.payload as ToolCallEvent;
        const display = presentAgentTool(tool);
        const terminal = display.action === 'terminal' || display.action === 'test';
        const expanded = this.toolDisclosureOpen(entry.id, tool.status === 'running' || tool.status === 'failed' || tool.status === 'rejected');
        return <details
            key={entry.id}
            open={expanded}
            onToggle={event => this.rememberToolDisclosure(entry.id, event.currentTarget.open, tool.status === 'running' || tool.status === 'failed' || tool.status === 'rejected')}
            className={`xora-activity xora-tool-card tone-${display.tone}${terminal ? ' xora-terminal-card' : ''}${nested ? ' xora-tool-group-item' : ''}`}>
            <summary className='xora-activity-summary'>
                <span className={`xora-tool-icon tone-${display.tone}`}><span className={`codicon ${display.iconClass}`} /></span>
                <span className='xora-tool-copy'>
                    <span className='xora-tool-title-line'>
                        <span className='xora-tool-kind'>{display.badgeLabel}</span>
                        <span className='xora-activity-title' title={display.title}>{display.title}</span>
                    </span>
                    {display.detailLabel ? <span className='xora-tool-target'>{display.detailLabel}</span> : undefined}
                </span>
                <span className={`xora-tool-status xora-tool-status-${tool.status}`}>{toolStatusLabel(tool.status)}</span>
                <span className='codicon codicon-chevron-right xora-details-chevron' />
            </summary>
            {expanded ? <div className='xora-activity-body'>
                <div className='xora-tool-technical-line'>
                    <span>技术详情</span>
                    <code>{tool.toolName}</code>
                    {display.readOnly ? <span className='xora-readonly-chip'>只读</span> : undefined}
                </div>
                {tool.input !== undefined ? <details className='xora-tool-input'>
                    <summary>查看参数</summary>
                    <pre>{this.printToolInput(tool.input)}</pre>
                </details> : undefined}
                {tool.output ? <pre className={terminal ? 'xora-terminal-output' : undefined}>{tool.output}</pre> : <p>暂无输出。</p>}
            </div> : undefined}
        </details>;
    }

    protected toolDisclosureOpen(id: string, defaultValue: boolean): boolean {
        return this.toolDisclosure.get(id) ?? defaultValue;
    }

    protected rememberToolDisclosure(id: string, open: boolean, defaultValue: boolean): void {
        if ((this.toolDisclosure.get(id) ?? defaultValue) === open) return;
        this.toolDisclosure.set(id, open);
        this.update();
    }

    protected renderEntry(entry: TranscriptEntry): React.ReactNode {
        if (entry.kind === 'plan') {
            const plan = entry.payload as AgentPlanEvent;
            const completed = plan.entries.filter(item => item.status === 'completed').length;
            const active = plan.entries.some(item => item.status === 'in-progress');
            return <details key={entry.id} className='xora-activity xora-plan-card' open={active}>
                <summary className='xora-activity-summary'>
                    <span className='codicon codicon-checklist' />
                    <span className='xora-activity-title'>{plan.title ?? '执行计划'}</span>
                    <span className='xora-activity-meta'>{completed}/{plan.entries.length}</span>
                    <span className='codicon codicon-chevron-right xora-details-chevron' />
                </summary>
                <ol className='xora-plan-list'>{plan.entries.map(item => <li key={item.id} className={`xora-plan-${item.status}`}>
                    <span className={`codicon ${this.planStatusIcon(item.status)}`} />
                    <span>{item.text}</span>
                </li>)}</ol>
            </details>;
        }
        if (entry.kind === 'tool') {
            return this.renderToolEntry(entry);
        }
        if (entry.kind === 'permission') {
            const permission = entry.payload as PermissionRequestEvent;
            const display = presentAgentTool({
                title: permission.title,
                toolCallId: permission.toolCallId ?? permission.requestId,
                toolName: permission.toolName ?? 'tool',
                presentation: permission.presentation
            });
            const pending = this.model.pendingPermissions.has(permission.requestId);
            const deciding = this.permissionDecisions.has(permission.requestId);
            if (!pending) {
                return <article key={entry.id} className='xora-permission-history'>
                    <span className='codicon codicon-shield' />
                    <span>{display.badgeLabel} · {display.title}</span>
                    <span>已处理</span>
                </article>;
            }
            return <article key={entry.id} className='xora-permission-card'>
                <header>
                    <span className={`xora-tool-icon tone-${display.tone}`}><span className={`codicon ${display.iconClass}`} /></span>
                    <div>
                        <span className='xora-permission-label'><span className='xora-tool-kind'>{display.badgeLabel}</span> 等待确认</span>
                        <strong>{display.title}</strong>
                        <span>{this.permissionRiskLabel(permission)}</span>
                    </div>
                </header>
                {permission.detail ? <pre>{permission.detail}</pre> : undefined}
                <div className='xora-card-actions'>
                    {permission.options.includes('allow-once') ? <button className='theia-button main' disabled={deciding} onClick={() => this.decidePermission(permission, 'allow-once')}>允许一次</button> : undefined}
                    {permission.options.includes('allow-always') ? <button className='theia-button secondary' disabled={deciding} title='规则仍受项目、工具和有效期约束' onClick={() => this.decidePermission(permission, 'allow-always')}>在此项目允许</button> : undefined}
                    <button className='theia-button secondary' disabled={deciding} onClick={() => this.decidePermission(permission, 'reject')}>拒绝</button>
                </div>
            </article>;
        }
        if (entry.kind === 'diff') {
            const diff = entry.payload as DiffEvent;
            const expanded = this.diffDisclosure.get(diff.diffId) ?? false;
            const counts = this.diffCounts(diff.diff);
            return <article key={entry.id} className='xora-diff-card'>
                <header className='xora-diff-header'>
                    <button
                        type='button'
                        className='xora-diff-file-link'
                        title={`打开并在项目树中定位 ${diff.path}`}
                        onClick={() => this.openAndRevealFile(diff)}>
                        <span className='xora-diff-file-icon' aria-hidden='true'>
                            <span className={`codicon ${this.fileIconClass(diff.path)}`} />
                        </span>
                        <span className='xora-diff-file-copy'>
                            <strong>{this.fileLabel(diff.path)}</strong>
                            <span>{this.fileDirectoryLabel(diff.path)}</span>
                        </span>
                    </button>
                    <span className='xora-diff-stats' aria-label={`新增 ${counts.added} 行，删除 ${counts.removed} 行`}>
                        <b>+{counts.added}</b>
                        <i>−{counts.removed}</i>
                    </span>
                </header>
                <footer className='xora-diff-actions'>
                    <button type='button' disabled={!diff.oldPath} onClick={() => this.openDiff(diff)}>
                        <span className='codicon codicon-diff' />
                        <span>查看差异</span>
                    </button>
                    <button type='button' disabled={!diff.newHash} onClick={() => this.revertDiff(diff)}>
                        <span className='codicon codicon-discard' />
                        <span>安全撤销</span>
                    </button>
                    <details
                        className='xora-inline-diff'
                        open={expanded}
                        onToggle={event => {
                            const open = event.currentTarget.open;
                            if ((this.diffDisclosure.get(diff.diffId) ?? false) !== open) {
                                this.diffDisclosure.set(diff.diffId, open);
                                this.update();
                            }
                        }}>
                        <summary title='展开 Agent 返回的原始补丁'>
                            <span className='codicon codicon-code' />
                            <span>{expanded ? '收起补丁' : '展开补丁'}</span>
                            <span className='codicon codicon-chevron-down xora-details-chevron' />
                        </summary>
                        {expanded ? <pre>{diff.diff}</pre> : undefined}
                    </details>
                </footer>
            </article>;
        }
        const attachments = entry.payload?.kind === 'text-delta' ? entry.payload.attachments ?? [] : [];
        return <article key={entry.id} className={`xora-message xora-message-${entry.kind}`}>
            <div className='xora-message-header'>
                <span>{entry.kind === 'assistant' ? 'Agent' : transcriptRoleLabel(entry.kind)}</span>
                {entry.text ? <button aria-label='复制消息' title='复制' onClick={() => this.copyMessage(entry.text!)}>
                    <span className='codicon codicon-copy' />
                </button> : undefined}
            </div>
            {attachments.length ? this.renderMessageAttachments(attachments) : undefined}
            {entry.text ? <div className='xora-message-text'>{entry.kind === 'user'
                ? entry.text
                : this.isStreamingAssistantEntry(entry)
                    ? <div className='xora-agent-streaming-text'>{entry.text}</div>
                    : <AgentMarkdown text={entry.text} />}</div> : undefined}
        </article>;
    }

    protected isStreamingAssistantEntry(entry: TranscriptEntry): boolean {
        const payload = entry.payload;
        return entry.kind === 'assistant'
            && this.model.transcript[this.model.transcript.length - 1] === entry
            && !!payload
            && 'sessionId' in payload
            && this.model.snapshot.sessions.some(session =>
                session.appSessionId === payload.sessionId && session.status === 'running');
    }

    protected permissionRiskLabel(permission: PermissionRequestEvent): string {
        const presentation = permission.presentation;
        if (presentation?.action === 'file-create' || presentation?.action === 'file-write'
            || presentation?.action === 'file-delete' || presentation?.action === 'file-move') return '将修改项目文件';
        if (presentation?.action === 'terminal' || presentation?.action === 'test') return '将在项目中运行命令';
        if (presentation?.source === 'mcp' || presentation?.action === 'web-search' || presentation?.action === 'web-fetch') return '将访问外部服务';
        if (presentation?.readOnly) return '只读操作';
        return '敏感操作需要你的确认';
    }

    protected renderMessageAttachments(attachments: AgentAttachmentSummary[]): React.ReactNode {
        return <div className='xora-message-attachments' aria-label={`${attachments.length} 张图片`}>
            {attachments.map((attachment, index) => <span
                key={`${attachment.sha256}-${index}`}
                className='xora-message-attachment'
                title={`${attachment.name ?? '图片'} · ${attachment.mimeType} · ${this.formatByteSize(attachment.byteSize)}`}>
                <span className='codicon codicon-file-media' />
                <span>{attachment.name ?? '图片'}</span>
                <small>{this.formatByteSize(attachment.byteSize)}</small>
            </span>)}
        </div>;
    }

    protected renderRetry(retry: RetryablePrompt): React.ReactNode {
        const snapshot = this.model.snapshot;
        const running = snapshot.sessions.some(session => session.status === 'running');
        return <article className='xora-card xora-retry-card' role='alert'>
            <div><strong>任务执行失败</strong><span className='codicon codicon-warning' /></div>
            <p>{retry.message}</p>
            {retry.text ? <div className='xora-retry-prompt'>{retry.text}</div> : undefined}
            {retry.attachments.length ? <div className='xora-retry-attachments'>
                <span className='codicon codicon-file-media' />
                含 {retry.attachments.length} 张图片
            </div> : undefined}
            <div className='xora-card-actions'>
                <button
                    className='theia-button main'
                    disabled={!!this.submission || running}
                    onClick={() => this.retry(retry)}>
                    {retry.attachments.length ? `重试（含 ${retry.attachments.length} 张图片）` : '重试'}
                </button>
                <button className='theia-button secondary' disabled={!!this.submission} onClick={() => this.dismissRetry()}>忽略</button>
            </div>
        </article>;
    }

    protected async send(retry?: PromptSubmission): Promise<void> {
        if (this.submission || this.sessionLoading || (!retry && this.imageReadsInFlight > 0)) {
            return;
        }
        if (retry && !this.isSubmissionContextCurrent(retry)) {
            this.retryablePrompt = undefined;
            this.messages.warn('会话上下文已变化，旧任务不会在当前会话中重试。');
            this.update();
            return;
        }
        const contextSnapshot = this.model.snapshot;
        const composerGate = this.composerGate(contextSnapshot);
        if (composerGate) {
            this.messages.info(`${composerGate.message}。当前输入已作为草稿保留。`);
            return;
        }
        const workspaceRoot = contextSnapshot.workspaceRoot ?? this.roots?.[0] ?? '';
        const providerId = contextSnapshot.providerId;
        const sourceSessionId = contextSnapshot.activeSessionId;
        const draftTextAtStart = this.prompt;
        const text = retry?.text.trim() ?? draftTextAtStart.trim();
        const draftImages = retry ? [] : [...this.draftImages];
        const attachments = retry?.attachments ?? draftImages.map(image => ({
            mimeType: image.mimeType,
            data: image.data,
            ...(image.name ? { name: image.name } : {})
        }));
        if (!text && !attachments.length) return;
        const submission: PromptSubmission = {
            text,
            contextKey: this.agentContextKey(workspaceRoot, providerId, sourceSessionId),
            generation: this.agentContextGeneration,
            workspaceRoot,
            providerId,
            sourceSessionId,
            sessionId: retry?.sessionId,
            attachments,
            ...(!retry && draftImages.length ? { draftAttachmentIds: draftImages.map(image => image.id) } : {})
        };
        const previousRetry = retry ? this.retryablePrompt : undefined;
        let promptConsumed = !!retry;
        this.runtimePrewarmRequested = false;
        this.cancelRuntimePrewarmTimer();
        this.submission = submission;
        this.retryablePrompt = undefined;
        this.imageError = undefined;
        this.stickToBottom = true;
        this.update();
        try {
            const root = await this.workspaceRoot();
            if (!this.isSubmissionContextCurrent(submission)) return;
            if (!root) {
                this.messages.warn('请先打开一个文件夹或工作区。');
                return;
            }
            if (root !== submission.workspaceRoot) {
                this.invalidateAgentContext('项目已变化，未发送的图片已清除。');
                return;
            }
            let runtime = this.model.snapshot;
            // Workspace attachment is independent from native Theia trust and
            // normally completes during project open. Close the tiny startup
            // race here without asking the user to resend their first task.
            if (!runtime.workspaceAttached) {
                await this.workspaceTrustGuard.selectWorkspaceRoot(root);
                if (!this.isSubmissionContextCurrent(submission)) return;
                await this.model.refresh();
                runtime = this.model.snapshot;
            }
            const runtimeNeedsStart = runtime.phase !== 'ready' && runtime.phase !== 'auth-required';
            // Runtime initialization is read-only with respect to the project.
            // Overlap it with Save All, but never create/load a session or send
            // the prompt until saving has completed successfully.
            const runtimePromise = runtimeNeedsStart
                ? this.service.startRuntime({ workspaceRoot: root, providerId: submission.providerId })
                : Promise.resolve(runtime);
            const [, preparedRuntime] = await Promise.all([
                this.commandService.executeCommand(CommonCommands.SAVE_ALL.id),
                runtimePromise
            ]);
            if (!this.isSubmissionContextCurrent(submission)) return;
            runtime = preparedRuntime;
            if (runtime.phase !== 'ready') {
                if (!await this.authenticateRuntime(runtime, () => this.isSubmissionContextCurrent(submission))) {
                    if (previousRetry && this.isSubmissionContextCurrent(submission)) this.retryablePrompt = previousRetry;
                    return;
                }
                if (!this.isSubmissionContextCurrent(submission)) return;
                runtime = this.model.snapshot;
            }
            if (attachments.length && runtime.capabilities?.prompt.image !== true) {
                const message = '当前 Grok Build 版本不支持图片输入。图片已保留，请移除或更新运行时后再发送。';
                this.imageError = message;
                if (previousRetry) this.retryablePrompt = { ...previousRetry, message };
                this.messages.warn(message);
                return;
            }
            let sessionId = submission.sessionId ?? this.model.snapshot.activeSessionId;
            if (!sessionId) {
                // Pin the view model to its explicit "new session" state so a
                // backend snapshot emitted just before createSession resolves
                // cannot expose an unverified active session transition.
                this.model.startNewSession();
                if (!this.isSubmissionContextCurrent(submission)) return;
                const session = await this.service.createSession({
                    workspaceRoot: root,
                    providerId: submission.providerId,
                    model: this.newSessionModel ?? contextSnapshot.selectedModel,
                    title: text.slice(0, 64) || (attachments.length === 1 ? '图片任务' : `${attachments.length} 张图片`),
                    additionalDirectories: this.roots.filter(candidate => candidate !== root)
                });
                if (!this.isSubmissionContextCurrent(submission)) return;
                sessionId = session.appSessionId;
                // Publish the resolved ID before the model update. Reconciliation
                // then recognises new-session -> created-session as this send's
                // sole allowed context transition instead of an external switch.
                submission.sessionId = sessionId;
                this.model.setSession(session);
                if (!this.isSubmissionContextCurrent(submission)) return;
            } else {
                // This is a fast no-op in the backend when the background
                // prewarm already hydrated the active ACP session. Keeping it
                // unconditional prevents a stopped/restarted runtime from ever
                // accepting a prompt for a stale, unhydrated session.
                await this.service.loadSession(sessionId);
                if (!this.isSubmissionContextCurrent(submission)) return;
            }
            submission.sessionId = sessionId;
            if ((!retry && this.prompt === draftTextAtStart) || (retry && this.prompt.trim() === text)) {
                this.prompt = '';
                if (this.textarea) {
                    this.textarea.value = '';
                    this.resizeComposer(this.textarea);
                }
            }
            if (submission.draftAttachmentIds?.length) {
                this.consumeDraftImages(submission.draftAttachmentIds);
                this.imageAnnouncement = '图片已加入任务。';
            }
            promptConsumed = true;
            this.update();
            requestAnimationFrame(() => {
                if (this.textarea) this.resizeComposer(this.textarea);
            });
            await this.service.sendPrompt({ sessionId, text, attachments });
            if (!this.isSubmissionContextCurrent(submission)) return;
        } catch (error) {
            // A late failure from an old project/provider/session must never
            // recreate its retry card (and image payload) in the new context.
            if (!this.isSubmissionContextCurrent(submission)) return;
            const message = error instanceof Error ? error.message : String(error);
            const cancelled = (submission.sessionId ? this.cancelRequested.has(submission.sessionId) : false)
                || this.isCancellationError(error);
            if (!cancelled && promptConsumed) {
                const visibleMessage = (this.retryablePrompt as RetryablePrompt | undefined)?.message ?? message;
                this.retryablePrompt = { ...submission, message: visibleMessage };
                this.messages.error(`任务发送失败：${visibleMessage}`);
            } else if (!cancelled) {
                this.messages.error(`任务发送失败：${message}`);
            }
        } finally {
            if (submission.sessionId) this.cancelRequested.delete(submission.sessionId);
            if (this.submission === submission) this.submission = undefined;
            this.update();
        }
    }

    protected retry(retry: RetryablePrompt): void {
        if (this.retryablePrompt !== retry || this.submission) return;
        void this.send(retry);
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
            this.messages.error(`无法取消任务：${error instanceof Error ? error.message : String(error)}`);
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
        if (!this.isSubmissionContextCurrent(submission)) return;
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

    protected async openSession(session: SessionRecord): Promise<void> {
        if (this.model.snapshot.activeSessionId === session.appSessionId && !this.sessionLoading) {
            this.closePopover();
            return;
        }
        const originContextKey = this.imageDraftContextKey();
        const targetContextKey = this.agentContextKey(session.workspaceRoot, session.providerId, session.appSessionId);
        this.invalidateAgentContext('会话已切换，未发送的图片已清除。');
        const generation = this.sessionLoadGeneration;
        this.openPopover = undefined;
        this.sessionLoading = true;
        this.update();
        try {
            const history = await this.service.getSessionHistory(session.appSessionId);
            if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== originContextKey) return;
            // Local JSONL is the source of truth for visible history. Show it
            // before the potentially slow ACP restore so switching never
            // leaves the previous conversation on screen for up to 60s.
            this.observedAgentContextKey = targetContextKey;
            this.model.showSessionHistory(session, history);
            if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
            this.stickToBottom = true;
            this.followTranscript();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
            let loaded: SessionRecord;
            try {
                loaded = await this.service.loadSession(session.appSessionId);
            } catch (error) {
                if (!(error instanceof Error) || !error.message.includes('AUTHENTICATION_REQUIRED')) throw error;
                const runtime = await this.service.getSnapshot();
                if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
                if (!await this.authenticateRuntime(runtime, () =>
                    generation === this.sessionLoadGeneration && this.imageDraftContextKey() === targetContextKey)) return;
                if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
                loaded = await this.service.loadSession(session.appSessionId);
            }
            if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
            this.model.updateSession(loaded);
        } catch (error) {
            if (generation !== this.sessionLoadGeneration) return;
            this.messages.error(`无法恢复会话：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (generation === this.sessionLoadGeneration) {
                this.sessionLoading = false;
                this.update();
            }
        }
    }

    protected async authenticateRuntime(runtime: RuntimeSnapshot, contextIsCurrent?: () => boolean): Promise<boolean> {
        if (runtime.phase !== 'auth-required') return true;
        const provider = this.providers.find(candidate => candidate.id === runtime.providerId);
        const methodId = provider?.kind === 'grok-subscription'
            ? runtime.capabilities?.authMethods.find(method => method.id !== 'xai.api_key'
                && method.id === runtime.capabilities?.defaultAuthMethodId)?.id
                ?? runtime.capabilities?.authMethods.find(method => method.id === 'grok.com')?.id
            : runtime.capabilities?.authMethods.find(method => method.id === 'xai.api_key')?.id
                ?? runtime.capabilities?.defaultAuthMethodId
                ?? runtime.capabilities?.authMethods[0]?.id;
        if (!methodId) throw new Error('Grok Build 未提供兼容的认证方式。');
        if (contextIsCurrent && !contextIsCurrent()) return false;
        const result = await this.service.authenticate(methodId);
        if (contextIsCurrent && !contextIsCurrent()) return false;
        if (result.status === 'authenticated') return true;
        const warning = provider?.kind === 'grok-subscription'
            ? '首次使用当前 Grok 订阅需要确认。登录或切换账号会共用 ~/.grok，并影响外部 Grok CLI 和其他 Xora Code 窗口；相同配置后续不再提示。'
            : provider?.kind === 'xai-api-key'
                ? provider.model
                    ? `是否允许 Agent 使用已加密保存的凭据连接 ${provider.baseUrl ?? '当前 API 服务'}？相同配置后续不再提示。`
                    : '首次使用 xAI API 密钥需要确认。Grok Build 认证可能更新共用的 ~/.grok 认证状态；相同配置后续不再提示。'
                : `是否使用“${provider?.name ?? '当前服务'}”已配置的凭据继续？只有当前服务的凭据会注入 Agent 进程，相同配置后续不再提示。`;
        const choice = await this.messages.warn(warning, '继续');
        if (contextIsCurrent && !contextIsCurrent()) return false;
        if (choice !== '继续') return false;
        if (contextIsCurrent && !contextIsCurrent()) return false;
        const confirmed = await this.service.authenticate(methodId, true);
        return confirmed.status === 'authenticated' && (!contextIsCurrent || contextIsCurrent());
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
            this.requestRuntimePrewarm(true);
            this.update();
        } catch (error) {
            this.messages.error(`无法加载模型服务：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async refreshRoots(): Promise<void> {
        const roots = await this.workspaceService.roots;
        this.roots = roots.map(root => root.resource.path.toString());
        this.requestRuntimePrewarm(true);
        this.update();
    }

    protected async openDiff(diff: DiffEvent): Promise<void> {
        const after = this.workspaceFileUri(diff.path);
        if (!diff.oldPath || !after) {
            return;
        }
        const before = new URI(VSCodeURI.file(diff.oldPath));
        await open(this.openerService, DiffUris.encode(before, after, `${diff.path}（Agent 修改）`));
    }

    protected async openAndRevealFile(diff: DiffEvent): Promise<void> {
        const uri = this.workspaceFileUri(diff.path);
        if (!uri) {
            this.messages.error('无法定位该文件：文件不在当前项目中。');
            return;
        }
        try {
            await open(this.openerService, uri);
            await this.commandService.executeCommand(FileNavigatorCommands.REVEAL_IN_NAVIGATOR.id, uri);
        } catch (error) {
            this.messages.error(`无法打开 ${this.fileLabel(diff.path)}：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async revertDiff(diff: DiffEvent): Promise<void> {
        try {
            await this.service.revertDiff(diff.diffId);
            this.messages.info(`已撤销 ${diff.path} 的 Agent 修改。`);
        } catch (error) {
            await this.openDiff(diff);
            this.messages.error(error instanceof Error ? error.message : String(error));
        }
    }
}
