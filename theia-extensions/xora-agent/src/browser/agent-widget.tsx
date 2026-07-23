import '../../src/browser/style/agent.css';

import { CommandService, Disposable, MessageService } from '@theia/core/lib/common';
import { CommonCommands, DiffUris, open, OpenerService, ReactWidget } from '@theia/core/lib/browser';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { isOSX, isWindows } from '@theia/core/lib/common/os';
import URI from '@theia/core/lib/common/uri';
import { URI as VSCodeURI } from '@theia/core/shared/vscode-uri';
import {
    filesystemPathKey,
    filesystemPathListIncludes,
    filesystemPathsEqual
} from '../common/workspace-path';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
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
import { friendlyAgentErrorMessage } from './agent-error-labels';
import { shouldSubmitPromptOnEnter } from './agent-input-helpers';
import { grokSubscriptionAuthStatus } from './agent-management-labels';
import { AgentMarkdown } from './agent-markdown';
import {
    detectSlashQuery,
    extractNamedResources,
    filterSlashCommands,
    replaceSlashToken,
    resourceMenuItems,
    SlashCommandId,
    SlashMenuItem,
    SlashQuery,
    slashCommandsToMenuItems
} from './agent-slash-menu';
import {
    agentModelChoiceGroups,
    decodeAgentModelChoice,
    PROVIDER_DEFAULT_MODEL_CHOICE_ID,
    providerCatalogModelId,
    selectedAgentModelChoice
} from './agent-model-options';
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
    /** Set only after Electron has accepted and published this exact user
     * turn. Until then the conversation renders a lightweight local bubble so
     * cold session creation never looks like a missed click. */
    userEventReceived?: boolean;
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

interface AgentInlineNotice {
    id: number;
    message: string;
    tone: 'info' | 'warning' | 'error';
}

// Yield one browser task so root, Provider and backend workspace attachment
// snapshots can coalesce. There is deliberately no user-input debounce: an
// opened project should begin preparing its Agent immediately.
const RUNTIME_PREWARM_DELAY_MS = 0;
// A cold Grok model-catalog refresh can fail transiently before ACP is ready.
// Retry only the background startup transaction, never a user prompt.
const RUNTIME_PREWARM_RETRY_DELAY_MS = 350;
const RUNTIME_PREWARM_MAX_ATTEMPTS = 2;
/** Keep the common A -> B -> A history path entirely in the renderer while
 * bounding retained JSONL data. Larger conversations still use the durable
 * Electron repository and never trade correctness for cache residency. */
const SESSION_HISTORY_CACHE_ENTRIES = 3;
const SESSION_HISTORY_CACHE_MAX_EVENTS = 2_500;

function sessionProviderLabel(providerId: string, selectedProviderId: string): string {
    if (providerId === selectedProviderId) return '当前模型服务';
    if (providerId === 'grok-subscription') return 'Grok 订阅';
    if (providerId === 'xai-api-key') return '历史模型服务';
    return '历史自定义服务';
}

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

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(FileService)
    protected readonly fileService!: FileService;

    protected prompt = '';
    protected providers: ProviderProfile[] = [];
    protected roots: string[] = [];
    /** Active `/` command palette over the composer (visual selection). */
    protected slashMenuOpen = false;
    protected slashQuery: SlashQuery | undefined;
    protected slashItems: SlashMenuItem[] = [];
    protected slashActiveIndex = 0;
    protected slashLoading = false;
    protected slashPanel: 'commands' | 'mcp' | 'skill' = 'commands';
    protected slashError: string | undefined;
    protected slashLoadGeneration = 0;
    protected submission: PromptSubmission | undefined;
    /** Covers the asynchronous Provider refresh before a PromptSubmission is
     * created. Without this guard, two quick Enter presses can both cross the
     * refresh boundary and submit the same draft. */
    protected sendPreparationInFlight = false;
    /** Optimistic bubble painted before Provider/Save All preparation finishes. */
    protected sendPreparationPreview: Pick<PromptSubmission, 'text' | 'attachments'> | undefined;
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
    protected providerRefreshInFlight: Promise<void> | undefined;
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
    /** Last session for which a hydration request was started. Retained for
     * diagnostics after completion; the Promise below is the single-flight
     * authority. */
    protected activeSessionHydrationKey: string | undefined;
    protected activeSessionHydrationPromise: { key: string; promise: Promise<SessionRecord> } | undefined;
    /** Successful ACP loads bound to the current runtime. Grok keeps multiple
     * sessions attached, so A -> B -> A must not replay session/load. */
    protected hydratedSessionKeys = new Set<string>();
    /** Small LRU of immutable, already-redacted local histories. Electron's
     * session updatedAt value is the cross-process invalidation token. */
    protected sessionHistoryCache = new Map<string, {
        updatedAt: string;
        events: AgentHostEvent[];
    }>();
    protected observedRuntimePhase: RuntimePhase | undefined;
    /** Open multi-session tabs for the current project (order is left-to-right). */
    protected openSessionTabs: string[] = [];
    protected renamingSessionId: string | undefined;
    protected renameDraft = '';
    /** One automatic "restore latest conversation" transaction per workspace. */
    protected workspaceRestoreKey: string | undefined;
    protected workspaceRestoreGeneration = 0;
    protected workspaceRestorePending = false;
    protected workspaceRestorePromise: Promise<void> | undefined;
    /** Low-distraction feedback owned by the Agent panel instead of global toasts. */
    protected inlineNotice: AgentInlineNotice | undefined;
    protected inlineNoticeTimer: number | undefined;
    protected inlineNoticeSequence = 0;
    protected readonly openMarkdownPath = (filePath: string): void => {
        void this.openWorkspacePath(filePath, { reveal: true });
    };

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
            this.activateWorkspace(roots.map(root => FileUri.fsPath(root.resource)));
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
            if (this.inlineNoticeTimer !== undefined) window.clearTimeout(this.inlineNoticeTimer);
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
        const modelChoiceGroups = agentModelChoiceGroups(this.providers, snapshot, active);
        const modelChoiceCount = modelChoiceGroups.reduce((count, group) => count + group.choices.length, 0);
        const selectedModel = selectedAgentModelChoice(modelChoiceGroups, snapshot, active, this.newSessionModel);
        const permissionMode = snapshot.permissionMode;
        const contextSummary = summarizeAgentContext(snapshot, this.model.transcript);
        const pendingPermissions = [...this.model.pendingPermissions.values()].map(permission => ({
            id: permission.requestId,
            kind: 'permission' as const,
            payload: permission
        }));
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
        const composerGate = this.composerGate(snapshot);
        const sendInFlight = !!this.submission || this.sendPreparationInFlight;
        const pendingSubmission = this.agentPaneView === 'conversation'
            ? this.submission && !this.submission.userEventReceived
                ? this.submission
                : this.sendPreparationPreview
            : undefined;
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
                                    : sendInFlight && active?.status !== 'running'
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
                        disabled={sendInFlight || this.sessionLoading}
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
            {this.renderSessionTabs()}
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
                {this.agentPaneView === 'conversation' && this.model.transcript.length === 0 && !pendingSubmission
                    ? this.workspaceRestorePending ? this.renderWorkspaceRestorePending() : this.renderEmpty()
                    : renderedTranscript.length === 0 && !pendingSubmission
                        ? this.renderPaneEmpty()
                        : <>
                            {hiddenTranscriptCount ? <div className='xora-history-window-notice' role='status'>
                                为保持切换流畅，仅显示最近 {MAX_RENDERED_TRANSCRIPT_ENTRIES} 条记录；完整历史仍保存在本地。
                            </div> : undefined}
                            {this.agentPaneView === 'changes' ? this.renderChangesOverview(renderedTranscript) : undefined}
                            {this.renderTranscript(renderedTranscript)}
                            {pendingSubmission ? this.renderPendingSubmission(pendingSubmission) : undefined}
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
            {this.inlineNotice ? <div
                className={`xora-agent-inline-notice tone-${this.inlineNotice.tone}`}
                role={this.inlineNotice.tone === 'error' ? 'alert' : 'status'}>
                <span className={`codicon ${this.inlineNotice.tone === 'error'
                    ? 'codicon-error'
                    : this.inlineNotice.tone === 'warning' ? 'codicon-warning' : 'codicon-info'}`} />
                <span>{this.inlineNotice.message}</span>
                <button type='button' aria-label='关闭提示' onClick={() => this.dismissInlineNotice(this.inlineNotice?.id)}>
                    <span className='codicon codicon-close' />
                </button>
            </div> : undefined}
            <footer className='xora-composer'>
                {this.renderSlashMenu()}
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
                        aria-controls={this.slashMenuOpen ? 'xora-slash-menu' : undefined}
                        aria-expanded={this.slashMenuOpen}
                        aria-autocomplete={this.slashMenuOpen ? 'list' : undefined}
                        placeholder={composerGate
                            ? `${composerGate.message}；你可以先在这里写下任务…`
                            : '描述任务，或输入 / 可视化选择文件 · MCP · 技能…'}
                        rows={1}
                        defaultValue={this.prompt}
                        onChange={event => {
                            this.prompt = event.currentTarget.value;
                            this.scheduleComposerResize(event.currentTarget);
                            this.syncComposerSubmitButton();
                            this.syncSlashMenuFromComposer(event.currentTarget);
                            // This textarea is deliberately uncontrolled.
                            // React's controlled-input restore runs before
                            // Lumino's async update and otherwise erases an
                            // active Chinese/Japanese/Korean IME composition.
                            // Do not redraw the complete transcript for each
                            // keystroke: the native button is updated directly.
                        }}
                        onSelect={event => {
                            if (!this.imeComposing) this.syncSlashMenuFromComposer(event.currentTarget);
                        }}
                        onClick={event => {
                            if (!this.imeComposing) this.syncSlashMenuFromComposer(event.currentTarget);
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
                            this.syncSlashMenuFromComposer(event.currentTarget);
                            this.imeCompositionGuardTimer = window.setTimeout(() => {
                                this.imeCompositionJustEnded = false;
                                this.imeCompositionGuardTimer = undefined;
                            }, 0);
                        }}
                        onPaste={event => {
                            this.requestRuntimePrewarm(true);
                            this.handleImagePaste(event);
                        }}
                        onBlur={() => {
                            // Delay so mousedown on a menu item can run first.
                            window.setTimeout(() => {
                                if (this.isDisposed) return;
                                const active = document.activeElement;
                                if (active?.closest?.('.xora-slash-menu')) return;
                                if (this.slashMenuOpen) this.closeSlashMenu();
                            }, 120);
                        }}
                        onKeyDown={event => {
                            if (this.handleSlashMenuKeyDown(event)) return;
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
                                    title={modelChoiceCount === 0
                                        ? '点击加载当前服务提供的模型'
                                        : '选择当前模型服务提供的模型'}
                                    disabled={active?.status === 'running'
                                        || sendInFlight
                                        || this.sessionLoading
                                        || this.modelOptionsLoading
                                        || snapshot.phase === 'starting'
                                        || snapshot.phase === 'initializing'
                                        || snapshot.phase === 'draining'
                                        || snapshot.phase === 'updating'}
                                    value={selectedModel}
                                    onMouseDown={event => {
                                        if (this.currentProviderNeedsModelLoad(snapshot)) {
                                            if (modelChoiceCount === 0) event.preventDefault();
                                            void this.loadModelOptions();
                                        }
                                    }}
                                    onKeyDown={event => {
                                        if (this.currentProviderNeedsModelLoad(snapshot) && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
                                            if (modelChoiceCount === 0) event.preventDefault();
                                            void this.loadModelOptions();
                                        }
                                    }}
                                    onChange={event => this.selectModel(active, event.currentTarget.value)}>
                                    {this.renderModelOptions(modelChoiceGroups)}
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
                                    disabled={active?.status === 'running' || sendInFlight || this.sessionLoading || this.permissionModeChanging}
                                    value={permissionMode}
                                    onChange={event => void this.selectPermissionMode(event.currentTarget.value as AgentPermissionMode)}>
                                    <option value='request-approval'>请求审批</option>
                                    <option value='full-access'>完全访问权限</option>
                                </select>
                            </label>
                            <button
                                className={`xora-composer-tool${this.slashMenuOpen ? ' is-active' : ''}`}
                                type='button'
                                aria-label='打开命令菜单'
                                aria-haspopup='listbox'
                                aria-expanded={this.slashMenuOpen}
                                title='输入 / 可视化选择：文件、图片、MCP、技能'
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => this.toggleSlashMenuFromButton()}>
                                <span className='codicon codicon-symbol-keyword' />
                                <span className='xora-composer-tool-label'>/</span>
                            </button>
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
                                className='xora-composer-tool'
                                type='button'
                                aria-label='选择工作区文件'
                                title='选择工作区文件并插入 @路径'
                                onClick={() => void this.pickWorkspaceFilesForPrompt()}>
                                <span className='codicon codicon-file' />
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
                            ref={node => {
                                this.composerSubmitButton = node;
                                if (node) this.syncComposerSubmitButton();
                            }}
                            className='xora-composer-submit'
                            type='button'
                            aria-label={sendInFlight ? '正在发送任务' : '发送任务'}
                            title={sendInFlight
                                ? '正在发送…'
                                : composerImageError
                                    ? composerImageError
                                    : composerGate
                                        ? composerGate.message
                                    : this.imageReadsInFlight
                                        ? '正在读取图片…'
                                        : '发送任务'}
                            // Prompt text is intentionally kept outside React
                            // state for CJK IME stability. React must therefore
                            // not retain a stale `disabled=true` prop merely
                            // because the last full render saw an empty prompt;
                            // its synthetic event layer would swallow clicks
                            // even after syncComposerSubmitButton enabled the
                            // native DOM node. Lifecycle gates stay declarative,
                            // while content availability is synchronized by the
                            // ref and native textarea change path.
                            disabled={sendInFlight
                                || !!composerGate
                                || this.sessionLoading
                                || this.imageReadsInFlight > 0
                                || !!imageCapabilityError}
                            onClick={() => this.send()}>
                            <span className={`codicon ${sendInFlight ? 'codicon-loading codicon-modifier-spin' : 'codicon-send'}`} />
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
        // Normalize Windows roots so FileUri.fsPath (`d:\…`) and backend
        // realpath (`D:\…`) share one context key and do not abort send.
        const rootKey = filesystemPathKey(workspaceRoot, this.pathPlatform());
        return [rootKey, providerId, sessionId ?? 'new'].join('\u0000');
    }

    protected pathPlatform(): NodeJS.Platform {
        // Renderer has no Node `process` global; never read process.platform here.
        if (isWindows) return 'win32';
        if (isOSX) return 'darwin';
        return 'linux';
    }

    protected rootsInclude(root: string | undefined): boolean {
        return filesystemPathListIncludes(this.roots, root, this.pathPlatform());
    }

    protected sameWorkspaceRoot(left: string | undefined, right: string | undefined): boolean {
        return filesystemPathsEqual(left, right, this.pathPlatform());
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
        this.activeSessionHydrationPromise = undefined;
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
            if (this.providers.length > 0 && !this.providers.some(provider => provider.id === providerId)) {
                void this.refreshProviders();
            }
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

    protected formatTurnDuration(elapsedMs: number): string {
        if (elapsedMs < 1_000) return `${Math.max(0.1, elapsedMs / 1_000).toFixed(1)} 秒`;
        if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(elapsedMs < 10_000 ? 1 : 0)} 秒`;
        const minutes = Math.floor(elapsedMs / 60_000);
        const seconds = Math.round((elapsedMs % 60_000) / 1_000);
        return `${minutes} 分 ${seconds} 秒`;
    }

    protected renderSessionTabs(): React.ReactNode {
        const snapshot = this.model.snapshot;
        const sessions = this.openSessionTabs
            .map(id => snapshot.sessions.find(session => session.appSessionId === id))
            .filter((session): session is SessionRecord => !!session
                && this.sameWorkspaceRoot(session.workspaceRoot, snapshot.workspaceRoot));
        if (!sessions.length && !snapshot.activeSessionId) return undefined;
        const tabs = sessions.length
            ? sessions
            : snapshot.sessions.filter(session => session.appSessionId === snapshot.activeSessionId);
        if (!tabs.length) return undefined;
        return <div className='xora-session-tabs' role='tablist' aria-label='打开的会话'>
            {tabs.map(session => {
                const active = session.appSessionId === snapshot.activeSessionId;
                const renaming = this.renamingSessionId === session.appSessionId;
                return <div
                    key={session.appSessionId}
                    className={`xora-session-tab${active ? ' active' : ''}${session.status === 'running' ? ' running' : ''}`}
                    role='tab'
                    aria-selected={active}
                    title={session.title || '未命名会话'}>
                    {renaming ? <input
                        className='xora-session-rename-input'
                        value={this.renameDraft}
                        autoFocus
                        aria-label='重命名会话'
                        onChange={event => {
                            this.renameDraft = event.currentTarget.value;
                            this.update();
                        }}
                        onBlur={() => void this.commitSessionRename(session.appSessionId)}
                        onKeyDown={event => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                void this.commitSessionRename(session.appSessionId);
                            } else if (event.key === 'Escape') {
                                event.preventDefault();
                                this.renamingSessionId = undefined;
                                this.renameDraft = '';
                                this.update();
                            }
                        }}
                    /> : <button
                        type='button'
                        className='xora-session-tab-button'
                        onClick={() => {
                            if (!active) void this.openSession(session);
                        }}
                        onDoubleClick={event => {
                            event.preventDefault();
                            this.beginSessionRename(session);
                        }}>
                        <span className={`xora-session-status-dot xora-session-status-${session.status}`} />
                        <span className='xora-session-tab-title'>{session.title || '未命名会话'}</span>
                    </button>}
                    <button
                        type='button'
                        className='xora-session-tab-close'
                        aria-label={`关闭标签 ${session.title || '未命名会话'}`}
                        title='关闭标签（不删除历史）'
                        onClick={event => {
                            event.stopPropagation();
                            this.closeSessionTab(session.appSessionId);
                        }}>
                        <span className='codicon codicon-close' />
                    </button>
                </div>;
            })}
            <button
                type='button'
                className='xora-session-tab-add'
                aria-label='新建会话标签'
                title='新建会话'
                disabled={!!this.submission || this.sessionLoading}
                onClick={() => this.startNewSession()}>
                <span className='codicon codicon-add' />
            </button>
        </div>;
    }

    protected renderHistoryPopover(): React.ReactNode {
        const snapshot = this.model.snapshot;
        // Provider/model selection is application-wide, but history belongs to
        // the project. Older conversations remain visible and are rebound to
        // the current Provider when opened; selecting history never switches
        // application credentials back to its original Provider.
        const sessions = snapshot.sessions.filter(session => this.sameWorkspaceRoot(session.workspaceRoot, snapshot.workspaceRoot));
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
                    const renaming = this.renamingSessionId === session.appSessionId;
                    return <div
                        key={session.appSessionId}
                        className={`xora-session-item${active ? ' active' : ''}`}
                        role='listitem'
                        aria-current={active ? 'true' : undefined}>
                        <span className={`xora-session-status-dot xora-session-status-${session.status}`} />
                        {renaming ? <input
                            className='xora-session-rename-input'
                            value={this.renameDraft}
                            autoFocus
                            aria-label='重命名会话'
                            onChange={event => {
                                this.renameDraft = event.currentTarget.value;
                                this.update();
                            }}
                            onBlur={() => void this.commitSessionRename(session.appSessionId)}
                            onKeyDown={event => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void this.commitSessionRename(session.appSessionId);
                                } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    this.renamingSessionId = undefined;
                                    this.renameDraft = '';
                                    this.update();
                                }
                            }}
                        /> : <button
                            type='button'
                            className='xora-session-item-main'
                            onClick={() => {
                                this.closePopover();
                                this.rememberOpenSessionTab(session.appSessionId);
                                if (!active) void this.openSession(session);
                            }}>
                            <span className='xora-session-item-copy'>
                                <strong title={session.title}>{session.title || '未命名会话'}</strong>
                                <span>
                                    {sessionStatusLabel(session.status)} · {sessionProviderLabel(session.providerId, snapshot.providerId)} · {sessionRelativeTime(session.updatedAt)}
                                </span>
                            </span>
                        </button>}
                        <span className='xora-session-item-actions'>
                            <button
                                type='button'
                                className='xora-agent-icon-button'
                                aria-label='重命名会话'
                                title='重命名'
                                disabled={session.status === 'running' || this.sessionLoading}
                                onClick={event => {
                                    event.stopPropagation();
                                    this.beginSessionRename(session);
                                }}>
                                <span className='codicon codicon-edit' />
                            </button>
                            <button
                                type='button'
                                className='xora-agent-icon-button'
                                aria-label='删除会话'
                                title='删除会话'
                                disabled={session.status === 'running' || this.sessionLoading}
                                onClick={event => {
                                    event.stopPropagation();
                                    void this.deleteSession(session);
                                }}>
                                <span className='codicon codicon-trash' />
                            </button>
                        </span>
                    </div>;
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

    protected currentProviderNeedsModelLoad(snapshot: RuntimeSnapshot): boolean {
        const provider = this.providers.find(candidate => candidate.id === snapshot.providerId);
        return snapshot.models.length === 0 && !providerCatalogModelId(provider ?? {
            id: snapshot.providerId,
            name: snapshot.providerId,
            kind: 'grok-subscription'
        });
    }

    protected renderModelOptions(groups: ReturnType<typeof agentModelChoiceGroups>): React.ReactNode {
        if (groups.length === 0) {
            return <option value=''>{this.modelOptionsLoading ? '正在加载模型…' : '选择模型…'}</option>;
        }
        return groups.map(group => <optgroup key={group.providerId} label={group.providerName}>
            {group.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </optgroup>);
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

    protected renderWorkspaceRestorePending(): React.ReactNode {
        return <div className='xora-empty xora-session-restore-pending' role='status'>
            <div className='xora-empty-mark' aria-hidden='true'>
                <span className='codicon codicon-loading codicon-modifier-spin' />
            </div>
            <h3>正在打开上次会话</h3>
            <p>本地记录会先显示，Agent 连接在后台继续准备。</p>
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
        if (!this.runtimePrewarmRequested || this.submission || this.sessionLoading || this.modelOptionsLoading) return;
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
        if (!root || !snapshot.workspaceAttached || !this.rootsInclude(root)) return;
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
            || !this.sameWorkspaceRoot(current.workspaceRoot, root)
            || current.providerId !== providerId
            || !current.workspaceAttached) {
            if (this.runtimePrewarmAttemptKey === key) this.runtimePrewarmAttemptKey = undefined;
            this.scheduleRuntimePrewarm();
            return;
        }
        this.runtimePrewarmAttempts += 1;
        try {
            await this.service.startRuntime({ workspaceRoot: root, providerId });
            if (this.sameWorkspaceRoot(this.model.snapshot.workspaceRoot, root) && this.model.snapshot.providerId === providerId) {
                await this.model.refresh();
                await this.hydrateActiveSessionInBackground();
            }
        } catch {
            // The backend publishes a redacted crash snapshot. Prewarming is
            // best-effort and must not interrupt drafting with a duplicate toast.
            await this.model.refresh().catch(() => undefined);
            const failed = this.model.snapshot;
            if (failed.phase === 'crashed'
                && this.sameWorkspaceRoot(failed.workspaceRoot, root)
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
        // A stopped/relaunching/auth-required process cannot prove that an ACP
        // session loaded by the previous ready runtime is still attached.
        // Clear only renderer acceleration state; Electron remains the final
        // authority and durable history is untouched.
        if (phase !== 'ready' && phase !== this.observedRuntimePhase) {
            this.activeSessionHydrationKey = undefined;
            this.activeSessionHydrationPromise = undefined;
            this.hydratedSessionKeyState().clear();
        }
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
        try {
            await this.ensureSessionHydrated(sessionId, key);
        } catch {
            // A stale/non-loadable history remains visible locally. The first
            // explicit Send retries through the normal actionable error path.
        }
    }

    /**
     * Shares project-prewarm, explicit history restore and first-send loads.
     * A successful key is valid only while the renderer remains in the same
     * workspace/Provider/session and the runtime stays ready. Backend checks
     * still protect every prompt if a global setting changes concurrently.
     */
    protected async ensureSessionHydrated(sessionId: string, key: string): Promise<SessionRecord> {
        const current = (this.model.snapshot.sessions ?? []).find(session => session.appSessionId === sessionId);
        if (this.hydratedSessionKeyState().has(key) && current) return current;
        const inFlight = this.activeSessionHydrationPromise;
        if (inFlight?.key === key) return inFlight.promise;

        const generation = this.sessionLoadGeneration;
        const promise = this.service.loadSession(sessionId);
        this.activeSessionHydrationKey = key;
        this.activeSessionHydrationPromise = { key, promise };
        try {
            const loaded = await promise;
            if (generation === this.sessionLoadGeneration
                && this.model.snapshot.phase === 'ready'
                && this.imageDraftContextKey() === key) {
                this.hydratedSessionKeyState().add(key);
            }
            return loaded;
        } finally {
            if (this.activeSessionHydrationPromise?.promise === promise) {
                this.activeSessionHydrationPromise = undefined;
            }
        }
    }

    protected hydratedSessionKeyState(): Set<string> {
        // Unit fixtures create partial widget instances without field
        // initializers; keep the production fast path and fixtures identical.
        return this.hydratedSessionKeys ?? (this.hydratedSessionKeys = new Set());
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

    protected showInlineNotice(
        message: string,
        tone: AgentInlineNotice['tone'] = 'info',
        durationMs = tone === 'error' ? 8_000 : 3_600
    ): void {
        if (this.inlineNoticeTimer !== undefined
            && typeof window !== 'undefined' && typeof window.clearTimeout === 'function') window.clearTimeout(this.inlineNoticeTimer);
        this.inlineNoticeSequence = Number.isSafeInteger(this.inlineNoticeSequence) ? this.inlineNoticeSequence + 1 : 1;
        const notice = { id: this.inlineNoticeSequence, message, tone };
        this.inlineNotice = notice;
        this.update();
        if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return;
        this.inlineNoticeTimer = window.setTimeout(() => {
            this.inlineNoticeTimer = undefined;
            this.dismissInlineNotice(notice.id);
        }, durationMs);
    }

    protected dismissInlineNotice(id?: number): void {
        if (!this.inlineNotice || (id !== undefined && this.inlineNotice.id !== id)) return;
        this.inlineNotice = undefined;
        if (this.inlineNoticeTimer !== undefined
            && typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
            window.clearTimeout(this.inlineNoticeTimer);
            this.inlineNoticeTimer = undefined;
        }
        this.update();
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

    protected renderSlashMenu(): React.ReactNode {
        if (!this.slashMenuOpen) return undefined;
        const title = this.slashPanel === 'mcp'
            ? 'MCP 服务'
            : this.slashPanel === 'skill'
                ? '技能 Skill'
                : '命令';
        return <div
            id='xora-slash-menu'
            className='xora-slash-menu'
            role='listbox'
            aria-label={`Agent ${title}菜单`}
            onMouseDown={event => event.preventDefault()}>
            <div className='xora-slash-menu-header'>
                <strong>{title}</strong>
                <span>{this.slashLoading ? '加载中…' : '↑↓ 选择 · Enter 确认 · Esc 关闭'}</span>
            </div>
            {this.slashError ? <div className='xora-slash-menu-error' role='alert'>{this.slashError}</div> : undefined}
            {this.slashLoading && !this.slashItems.length
                ? <div className='xora-slash-menu-empty'>
                    <span className='codicon codicon-loading codicon-modifier-spin' /> 正在加载…
                </div>
                : !this.slashItems.length
                    ? <div className='xora-slash-menu-empty'>没有匹配项。试试 /file · /mcp · /skill</div>
                    : <ul className='xora-slash-menu-list'>
                        {this.slashItems.map((item, index) => <li key={item.key}>
                            <button
                                type='button'
                                role='option'
                                aria-selected={index === this.slashActiveIndex}
                                className={`xora-slash-menu-item${index === this.slashActiveIndex ? ' is-active' : ''}`}
                                onMouseEnter={() => {
                                    if (this.slashActiveIndex !== index) {
                                        this.slashActiveIndex = index;
                                        this.update();
                                    }
                                }}
                                onClick={() => void this.activateSlashItem(item)}>
                                <span className={`codicon codicon-${item.icon}`} aria-hidden='true' />
                                <span className='xora-slash-menu-item-copy'>
                                    <strong>{item.label}</strong>
                                    <span>{item.description}</span>
                                    {item.detail ? <em>{item.detail}</em> : undefined}
                                </span>
                            </button>
                        </li>)}
                    </ul>}
        </div>;
    }

    protected syncSlashMenuFromComposer(textarea: HTMLTextAreaElement): void {
        if (this.imeComposing) return;
        const cursor = textarea.selectionStart ?? textarea.value.length;
        const query = detectSlashQuery(textarea.value, cursor);
        if (!query) {
            if (this.slashMenuOpen) this.closeSlashMenu();
            return;
        }
        // Resource panels stay open while the user filters after `/mcp` or `/skill`.
        if (this.slashPanel !== 'commands') {
            const root = query.query.toLowerCase();
            const stays = this.slashPanel === 'mcp'
                ? root === 'mcp' || root.startsWith('mcp')
                : root === 'skill' || root.startsWith('skill') || root.startsWith('skills');
            if (!stays && !filterSlashCommands(query.query).some(c => c.id === this.slashPanel)) {
                this.slashPanel = 'commands';
            }
        }
        this.slashQuery = query;
        if (this.slashPanel === 'commands') {
            const items = slashCommandsToMenuItems(filterSlashCommands(query.query));
            const same = this.slashMenuOpen
                && this.slashItems.length === items.length
                && this.slashItems.every((item, index) => item.key === items[index]?.key);
            this.slashMenuOpen = true;
            this.slashItems = items;
            this.slashError = undefined;
            this.slashLoading = false;
            if (!same) this.slashActiveIndex = 0;
            this.update();
            return;
        }
        this.slashMenuOpen = true;
        this.update();
    }

    protected closeSlashMenu(): void {
        if (!this.slashMenuOpen && this.slashPanel === 'commands' && !this.slashItems.length) return;
        this.slashMenuOpen = false;
        this.slashQuery = undefined;
        this.slashItems = [];
        this.slashActiveIndex = 0;
        this.slashLoading = false;
        this.slashPanel = 'commands';
        this.slashError = undefined;
        this.update();
    }

    protected toggleSlashMenuFromButton(): void {
        if (this.slashMenuOpen) {
            this.closeSlashMenu();
            this.textarea?.focus();
            return;
        }
        const textarea = this.textarea;
        if (!textarea) return;
        const value = textarea.value;
        const cursor = textarea.selectionStart ?? value.length;
        const needsSlash = cursor === 0 || /\s/.test(value.charAt(cursor - 1) || ' ');
        const insertion = needsSlash ? '/' : '/';
        // Always insert a fresh `/` token for discovery.
        const next = `${value.slice(0, cursor)}${insertion}${value.slice(cursor)}`;
        const nextCursor = cursor + insertion.length;
        this.applyComposerText(next, nextCursor);
        this.slashPanel = 'commands';
        this.syncSlashMenuFromComposer(this.textarea!);
        this.textarea?.focus();
    }

    protected handleSlashMenuKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
        if (!this.slashMenuOpen) {
            // Allow explicit discovery with Ctrl/Cmd+/ when not already in a token.
            if (event.key === '/' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                this.toggleSlashMenuFromButton();
                return true;
            }
            return false;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            this.closeSlashMenu();
            return true;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!this.slashItems.length) return true;
            this.slashActiveIndex = (this.slashActiveIndex + 1) % this.slashItems.length;
            this.update();
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (!this.slashItems.length) return true;
            this.slashActiveIndex = (this.slashActiveIndex - 1 + this.slashItems.length) % this.slashItems.length;
            this.update();
            return true;
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            const item = this.slashItems[this.slashActiveIndex];
            if (!item) return false;
            event.preventDefault();
            void this.activateSlashItem(item);
            return true;
        }
        return false;
    }

    protected async activateSlashItem(item: SlashMenuItem): Promise<void> {
        if (item.insertText) {
            this.commitSlashReplacement(item.insertText);
            return;
        }
        if (item.kind === 'action' && item.commandId === 'settings') {
            this.commitSlashReplacement('');
            await this.openAgentSettings();
            return;
        }
        if (item.commandId) {
            await this.runSlashCommand(item.commandId);
        }
    }

    protected async runSlashCommand(commandId: SlashCommandId): Promise<void> {
        switch (commandId) {
            case 'file':
                this.commitSlashReplacement('');
                await this.pickWorkspaceFilesForPrompt();
                return;
            case 'image':
                this.commitSlashReplacement('');
                this.imageInput?.click();
                return;
            case 'settings':
                this.commitSlashReplacement('');
                await this.openAgentSettings();
                return;
            case 'clear':
                this.closeSlashMenu();
                this.applyComposerText('', 0);
                return;
            case 'mcp':
                await this.openSlashResourcePanel('mcp');
                return;
            case 'skill':
                await this.openSlashResourcePanel('skill');
                return;
        }
    }

    protected async openSlashResourcePanel(kind: 'mcp' | 'skill'): Promise<void> {
        const generation = ++this.slashLoadGeneration;
        this.slashPanel = kind;
        this.slashLoading = true;
        this.slashError = undefined;
        this.slashItems = [];
        this.slashActiveIndex = 0;
        this.slashMenuOpen = true;
        this.update();
        try {
            const result = kind === 'mcp'
                ? await this.service.runManagementCommand('mcp-list')
                : await this.service.inspect();
            if (generation !== this.slashLoadGeneration) return;
            const entries = extractNamedResources(result.data ?? result, kind);
            this.slashItems = resourceMenuItems(kind, entries);
            this.slashLoading = false;
            if (!entries.length) {
                this.slashError = kind === 'mcp'
                    ? '未发现 MCP 服务。可在 Agent 设置中添加。'
                    : '未发现技能。可在 Agent 设置中管理 Skill。';
            }
            this.update();
        } catch (error) {
            if (generation !== this.slashLoadGeneration) return;
            this.slashLoading = false;
            this.slashError = friendlyAgentErrorMessage(error);
            this.slashItems = resourceMenuItems(kind, []);
            this.update();
        }
    }

    protected commitSlashReplacement(replacement: string): void {
        const textarea = this.textarea;
        const query = this.slashQuery
            ?? (textarea ? detectSlashQuery(textarea.value, textarea.selectionStart ?? textarea.value.length) : undefined);
        if (!textarea || !query) {
            if (replacement) this.insertComposerText(replacement);
            this.closeSlashMenu();
            return;
        }
        const next = replaceSlashToken(textarea.value, query, replacement);
        this.closeSlashMenu();
        this.applyComposerText(next.text, next.cursor);
    }

    protected applyComposerText(text: string, cursor: number): void {
        this.prompt = text;
        if (this.textarea) {
            this.textarea.value = text;
            this.resizeComposer(this.textarea);
            const clamped = Math.max(0, Math.min(cursor, text.length));
            this.textarea.setSelectionRange(clamped, clamped);
        }
        this.syncComposerSubmitButton();
        this.requestRuntimePrewarm();
        this.update();
        requestAnimationFrame(() => this.textarea?.focus());
    }

    protected insertComposerText(fragment: string): void {
        const textarea = this.textarea;
        if (!textarea) {
            this.applyComposerText(`${this.prompt}${fragment}`, (this.prompt + fragment).length);
            return;
        }
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? start;
        const value = textarea.value;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const needsSpaceBefore = fragment.length > 0 && before.length > 0 && !/\s$/.test(before) && !fragment.startsWith('\n');
        const needsSpaceAfter = fragment.length > 0 && after.length > 0 && !/^\s/.test(after) && !/\s$/.test(fragment);
        const body = `${needsSpaceBefore ? ' ' : ''}${fragment}${needsSpaceAfter ? ' ' : ''}`;
        const next = `${before}${body}${after}`;
        this.applyComposerText(next, before.length + body.length);
    }

    protected async openAgentSettings(): Promise<void> {
        try {
            await this.commandService.executeCommand(OPEN_AGENT_SETTINGS_COMMAND.id);
        } catch (error) {
            this.showInlineNotice(`无法打开 Agent 设置：${friendlyAgentErrorMessage(error)}`, 'error');
        }
    }

    protected async pickWorkspaceFilesForPrompt(): Promise<void> {
        try {
            const rootPath = this.model.snapshot.workspaceRoot ?? this.roots[0];
            const folder = rootPath
                ? await this.fileService.resolve(FileUri.create(rootPath))
                : undefined;
            const selection = await this.fileDialogService.showOpenDialog({
                title: '选择要引用的文件',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: true,
                openLabel: '插入引用'
            }, folder);
            if (!selection) return;
            const uris = Array.isArray(selection) ? selection : [selection];
            if (!uris.length) return;
            const refs = uris.map(uri => this.formatWorkspaceFileRef(uri, rootPath)).filter(Boolean);
            if (!refs.length) return;
            this.insertComposerText(refs.join(' '));
            this.showInlineNotice(`已插入 ${refs.length} 个文件引用`);
        } catch (error) {
            this.showInlineNotice(`选择文件失败：${friendlyAgentErrorMessage(error)}`, 'error');
        }
    }

    protected formatWorkspaceFileRef(uri: URI, workspaceRoot?: string): string {
        const fsPath = FileUri.fsPath(uri);
        if (!fsPath) return '';
        let display = fsPath.replace(/\\/g, '/');
        if (workspaceRoot) {
            const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
            const normalized = display.replace(/\/$/, '');
            if (normalized === root) display = '.';
            else if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
                display = normalized.slice(root.length + 1);
            }
        }
        // @path is a common agent convention; keep path readable for the model.
        return `@${display}`;
    }

    protected startNewSession(): void {
        if (this.submission || this.sessionLoading) return;
        this.resetToNewSession('已为新会话清除未发送图片。', true);
    }

    /**
     * Opening a project restores its most recently updated local conversation.
     * The JSONL history paints first; ACP hydration remains a guarded background
     * operation and never replays a prompt. Explicitly clicking New still wins.
     */
    protected activateWorkspace(roots: string[], preferredRoot?: string, workspaceAlreadySelected = false): void {
        this.roots = roots;
        const root = preferredRoot && this.rootsInclude(preferredRoot)
            ? preferredRoot
            : this.rootsInclude(this.model.snapshot.workspaceRoot)
                ? this.model.snapshot.workspaceRoot
                : roots[0];
        const key = JSON.stringify({
            root: filesystemPathKey(root ?? '', this.pathPlatform()),
            roots: roots.map(candidate => filesystemPathKey(candidate, this.pathPlatform()))
        });
        if (this.workspaceRestoreKey === key) {
            this.requestRuntimePrewarm(true);
            this.update();
            return;
        }
        this.workspaceRestoreKey = key;
        const generation = ++this.workspaceRestoreGeneration;
        this.workspaceRestorePending = !!root;
        this.resetToNewSession('项目已变化，未发送的图片已清除。', false, true);
        this.requestRuntimePrewarm(true);
        this.update();
        if (!root) {
            this.workspaceRestorePending = false;
            return;
        }
        const restore = this.restoreLatestWorkspaceSession(root, generation, workspaceAlreadySelected);
        this.workspaceRestorePromise = restore;
        void restore.finally(() => {
            if (this.workspaceRestoreGeneration !== generation) return;
            this.workspaceRestorePending = false;
            if (this.workspaceRestorePromise === restore) this.workspaceRestorePromise = undefined;
            this.update();
        });
    }

    protected async restoreLatestWorkspaceSession(
        root: string,
        generation: number,
        workspaceAlreadySelected: boolean
    ): Promise<void> {
        try {
            if (!workspaceAlreadySelected) await this.workspaceTrustGuard.selectWorkspaceRoot(root);
            await this.model.refresh();
            if (generation !== this.workspaceRestoreGeneration || !this.sameWorkspaceRoot(root, this.model.snapshot.workspaceRoot)) return;
            const latest = this.model.snapshot.sessions.find(session => this.sameWorkspaceRoot(session.workspaceRoot, root));
            if (!latest) return;
            this.workspaceRestorePending = false;
            await this.openSession(latest);
        } catch (error) {
            if (generation === this.workspaceRestoreGeneration) {
                this.showInlineNotice(`无法打开上次会话：${friendlyAgentErrorMessage(error)}`, 'warning');
            }
        }
    }

    protected resetToNewSession(announcement: string, focusComposer = false, preserveWorkspaceRestore = false): void {
        if (!preserveWorkspaceRestore) {
            ++this.workspaceRestoreGeneration;
            this.workspaceRestorePending = false;
            this.workspaceRestorePromise = undefined;
        }
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
            this.showInlineNotice(`无法刷新 Agent：${friendlyAgentErrorMessage(error)}`, 'error');
        }
    }

    protected async selectWorkspaceRoot(root: string): Promise<void> {
        if (this.sameWorkspaceRoot(root, this.model.snapshot.workspaceRoot) || this.sessionLoading || this.submission) return;
        try {
            await this.workspaceTrustGuard.selectWorkspaceRoot(root);
            this.activateWorkspace(this.roots, root, true);
        } catch (error) {
            this.showInlineNotice(friendlyAgentErrorMessage(error), 'error');
        } finally {
            this.update();
        }
    }

    protected async selectModel(session: SessionRecord | undefined, modelId: string): Promise<void> {
        if (this.sessionLoading) return;
        const decoded = decodeAgentModelChoice(modelId);
        const selection = decoded ?? { providerId: this.model.snapshot.providerId, modelId };
        // Provider/credential selection belongs to Settings. A stale DOM event
        // from before another window changed the global service is ignored;
        // the composer never switches credentials itself.
        if (selection.modelId === PROVIDER_DEFAULT_MODEL_CHOICE_ID) {
            this.newSessionModel = this.model.snapshot.selectedModel;
            this.requestRuntimePrewarm(true);
            this.update();
            return;
        }
        if (selection.providerId !== this.model.snapshot.providerId) {
            this.showInlineNotice('模型服务已变化，请在设置中确认当前服务后重新选择模型。', 'warning');
            await this.model.refresh().catch(() => undefined);
            return;
        }
        modelId = selection.modelId;
        if (!session) {
            if (!modelId) return;
            // Apply immediately so the composer remains responsive even when
            // another window briefly holds the preferences file lock.
            const previousModel = this.newSessionModel ?? this.model.snapshot.selectedModel;
            this.newSessionModel = modelId;
            this.update();
            try {
                await this.service.selectDefaultModel(this.model.snapshot.providerId, modelId);
                await this.model.refresh();
            } catch (error) {
                this.newSessionModel = previousModel;
                this.showInlineNotice(`无法保存默认模型：${friendlyAgentErrorMessage(error)}`, 'error');
                await this.model.refresh().catch(() => undefined);
            } finally {
                this.update();
            }
            return;
        }
        try {
            await this.service.selectModel(session.appSessionId, modelId);
            await this.model.refresh();
        } catch (error) {
            this.showInlineNotice(`无法切换模型：${friendlyAgentErrorMessage(error)}`, 'error');
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
            this.showInlineNotice('请先打开一个文件夹或工作区。', 'warning');
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
                this.showInlineNotice('当前服务未提供可切换的模型，将使用默认模型。');
            }
        } catch (error) {
            if (contextIsCurrent()) {
                this.showInlineNotice(`无法加载模型：${friendlyAgentErrorMessage(error)}`, 'error');
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
            this.showInlineNotice(mode === 'full-access'
                ? '所有项目和会话已启用完全访问权限。'
                : '所有项目和会话已恢复为请求审批。');
        } catch (error) {
            this.showInlineNotice(`无法修改 Agent 全局权限：${error instanceof Error ? error.message : String(error)}`, 'error');
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
            this.showInlineNotice(`无法提交权限决定：${error instanceof Error ? error.message : String(error)}`, 'error');
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
            this.showInlineNotice('已复制消息。');
        } catch {
            this.showInlineNotice('无法访问剪贴板，请手动选择文本复制。', 'warning');
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
                {tool.locations?.length ? <div className='xora-tool-locations' role='list' aria-label='相关文件'>
                    {tool.locations.map((location, index) => <button
                        key={`${location.path}-${location.line ?? 0}-${index}`}
                        type='button'
                        className='xora-file-link'
                        role='listitem'
                        title={`打开 ${location.path}`}
                        onClick={() => void this.openWorkspacePath(location.path, { line: location.line, reveal: true })}
                        onContextMenu={event => {
                            event.preventDefault();
                            void this.openWorkspacePath(location.path, { line: location.line, reveal: true });
                        }}>
                        <span className={`codicon ${this.fileIconClass(location.path)}`} />
                        <span>{this.fileLabel(location.path)}</span>
                        {location.line ? <span className='xora-file-link-line'>:{location.line}</span> : undefined}
                    </button>)}
                </div> : undefined}
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
                        onClick={() => this.openAndRevealFile(diff)}
                        onContextMenu={event => {
                            event.preventDefault();
                            void this.openAndRevealFile(diff);
                        }}>
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
                <span className='xora-message-meta'>
                    {entry.kind === 'assistant' && entry.turnElapsedMs !== undefined
                        ? <span className='xora-message-duration' title='本轮 AI 响应耗时'>
                            <span className='codicon codicon-watch' />
                            {this.formatTurnDuration(entry.turnElapsedMs)}
                        </span>
                        : undefined}
                    {entry.text ? <button aria-label='复制消息' title='复制' onClick={() => this.copyMessage(entry.text!)}>
                        <span className='codicon codicon-copy' />
                    </button> : undefined}
                </span>
            </div>
            {attachments.length ? this.renderMessageAttachments(attachments) : undefined}
            {entry.text ? <div className='xora-message-text'>{entry.kind === 'user'
                ? entry.text
                : this.isStreamingAssistantEntry(entry)
                    ? <div className='xora-agent-streaming-text'>{entry.text}</div>
                    : <AgentMarkdown
                        text={entry.text}
                        onOpenPath={this.openMarkdownPath}
                    />}</div> : undefined}
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

    protected renderPendingSubmission(submission: Pick<PromptSubmission, 'text' | 'attachments'>): React.ReactNode {
        return <article className='xora-message xora-message-user xora-message-pending' aria-label='任务已接收，正在发送'>
            {submission.text ? <div className='xora-message-text'>{submission.text}</div> : undefined}
            {submission.attachments.length ? <div className='xora-pending-attachment-count'>
                <span className='codicon codicon-file-media' />
                {submission.attachments.length} 张图片
            </div> : undefined}
            <div className='xora-pending-send-state' role='status'>
                <span className='codicon codicon-loading codicon-modifier-spin' />
                正在发送
            </div>
        </article>;
    }

    protected async send(retry?: PromptSubmission): Promise<void> {
        if (this.submission || this.sendPreparationInFlight || this.sessionLoading || (!retry && this.imageReadsInFlight > 0)) {
            return;
        }
        if (retry && !this.isSubmissionContextCurrent(retry)) {
            this.retryablePrompt = undefined;
            this.showInlineNotice('会话上下文已变化，旧任务不会在当前会话中重试。', 'warning');
            this.update();
            return;
        }
        // Freeze exactly what the user submitted before waiting for the
        // backend's latest application-wide Provider. Text or images added
        // while that refresh is pending remain as the next draft.
        this.sendPreparationInFlight = true;
        const draftTextAtStart = this.prompt;
        const preparedText = retry?.text.trim() ?? draftTextAtStart.trim();
        const preparedDraftImages = retry ? [] : [...this.draftImages];
        const preparedAttachments = retry?.attachments ?? preparedDraftImages.map(image => ({
            mimeType: image.mimeType,
            data: image.data,
            ...(image.name ? { name: image.name } : {})
        }));
        const preparationContextKey = this.imageDraftContextKey();
        const preparationGeneration = this.agentContextGeneration;
        if (!preparedText && !preparedAttachments.length) {
            this.sendPreparationInFlight = false;
            this.update();
            return;
        }
        this.sendPreparationPreview = { text: preparedText, attachments: preparedAttachments };
        // Disk-first remains mandatory, but saving editors is independent of
        // the authoritative Provider snapshot read. Start both together so a
        // prewarmed first Send does not pay two serial IPC/filesystem waits.
        const saveAllPromise = Promise.resolve()
            .then(() => this.commandService.executeCommand(CommonCommands.SAVE_ALL.id))
            .then(
                () => ({ ok: true as const }),
                error => ({ ok: false as const, error })
            );
        this.update();
        // A ready, attached runtime already receives cross-window snapshot
        // events, while Electron revalidates Provider/model/epoch again in
        // createSession and sendPrompt. Avoid an unconditional lifecycle RPC
        // on every warm Send; cold or incomplete contexts still refresh.
        const currentBeforePreparation = this.model.snapshot;
        const needsAuthoritativeRefresh = !retry && (!currentBeforePreparation.workspaceAttached
            || !['ready', 'auth-required'].includes(currentBeforePreparation.phase)
            || !(this.providers ?? []).some(provider => provider.id === currentBeforePreparation.providerId));
        if (needsAuthoritativeRefresh) {
            try {
                await this.model.refresh();
            } catch (error) {
                this.sendPreparationInFlight = false;
                this.sendPreparationPreview = undefined;
                this.update();
                this.showInlineNotice(`无法同步当前模型服务：${friendlyAgentErrorMessage(error)}`, 'error');
                return;
            }
        }
        // A Provider/session switch during refresh deliberately clears image
        // drafts. Never rebind the local pre-refresh copy to the new service;
        // retain the text and require the user to attach images again.
        if (!retry && preparedDraftImages.length > 0
            && (preparationGeneration !== this.agentContextGeneration
                || preparationContextKey !== this.imageDraftContextKey())) {
            this.sendPreparationInFlight = false;
            this.sendPreparationPreview = undefined;
            this.update();
            this.showInlineNotice('模型或会话已变化，文字草稿已保留；请在当前会话中重新添加图片。', 'warning');
            return;
        }
        if (this.submission || this.sessionLoading || (!retry && this.imageReadsInFlight > 0)) {
            this.sendPreparationInFlight = false;
            this.sendPreparationPreview = undefined;
            this.update();
            return;
        }
        const contextSnapshot = this.model.snapshot;
        const composerGate = this.composerGate(contextSnapshot);
        if (composerGate) {
            this.sendPreparationInFlight = false;
            this.sendPreparationPreview = undefined;
            this.update();
            this.showInlineNotice(`${composerGate.message}。当前输入已作为草稿保留。`);
            return;
        }
        const workspaceRoot = contextSnapshot.workspaceRoot ?? this.roots?.[0] ?? '';
        const providerId = contextSnapshot.providerId;
        const sourceSessionId = contextSnapshot.activeSessionId;
        const text = preparedText;
        const draftImages = preparedDraftImages;
        const attachments = preparedAttachments;
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
        this.sendPreparationInFlight = false;
        this.sendPreparationPreview = undefined;
        this.retryablePrompt = undefined;
        this.imageError = undefined;
        this.stickToBottom = true;
        this.update();
        try {
            const root = await this.workspaceRoot();
            if (!this.isSubmissionContextCurrent(submission)) {
                this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                return;
            }
            if (!root) {
                this.showInlineNotice('请先打开一个文件夹或工作区。', 'warning');
                return;
            }
            // Prefer the backend/canonical root for all host calls once we know
            // it is the same folder (Windows drive-letter casing may differ).
            const hostRoot = this.sameWorkspaceRoot(root, submission.workspaceRoot)
                ? (this.model.snapshot.workspaceRoot ?? root)
                : root;
            if (!this.sameWorkspaceRoot(hostRoot, submission.workspaceRoot)) {
                this.invalidateAgentContext('项目已变化，未发送的图片已清除。');
                this.showInlineNotice('项目路径已变化，当前任务未发送。请再点一次发送。', 'warning');
                return;
            }
            let runtime = this.model.snapshot;
            // Workspace attachment is independent from native Theia trust and
            // normally completes during project open. Close the tiny startup
            // race here without asking the user to resend their first task.
            if (!runtime.workspaceAttached) {
                await this.workspaceTrustGuard.selectWorkspaceRoot(hostRoot);
                if (!this.isSubmissionContextCurrent(submission)) {
                    this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                    return;
                }
                await this.model.refresh();
                runtime = this.model.snapshot;
            }
            // `model.refresh()` above crossed the Electron lifecycle queue and
            // is therefore authoritative for this submission. Reuse an
            // already-ready/auth-pending prewarm instead of queueing a second
            // startRuntime RPC; a cold/stale snapshot still starts normally.
            const runtimeReusable = runtime.workspaceAttached
                && this.sameWorkspaceRoot(runtime.workspaceRoot, hostRoot)
                && runtime.providerId === submission.providerId
                && (runtime.phase === 'ready' || runtime.phase === 'auth-required');
            const runtimePromise = runtimeReusable
                ? Promise.resolve(runtime)
                : this.service.startRuntime({
                    workspaceRoot: hostRoot,
                    providerId: submission.providerId
                });
            const [saveAll, preparedRuntime] = await Promise.all([saveAllPromise, runtimePromise]);
            if (!saveAll.ok) throw saveAll.error;
            if (!this.isSubmissionContextCurrent(submission)) {
                this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                return;
            }
            runtime = preparedRuntime;
            if (runtime.phase !== 'ready') {
                if (!await this.authenticateRuntime(runtime, () => this.isSubmissionContextCurrent(submission))) {
                    if (previousRetry && this.isSubmissionContextCurrent(submission)) this.retryablePrompt = previousRetry;
                    return;
                }
                if (!this.isSubmissionContextCurrent(submission)) {
                    this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                    return;
                }
                runtime = this.model.snapshot;
            }
            if (attachments.length && runtime.capabilities?.prompt.image !== true) {
                const message = '当前 Grok Build 版本不支持图片输入。图片已保留，请移除或更新运行时后再发送。';
                this.imageError = message;
                if (previousRetry) this.retryablePrompt = { ...previousRetry, message };
                this.showInlineNotice(message, 'warning');
                return;
            }
            let sessionId = submission.sessionId ?? this.model.snapshot.activeSessionId;
            if (!sessionId) {
                // Pin the view model to its explicit "new session" state so a
                // backend snapshot emitted just before createSession resolves
                // cannot expose an unverified active session transition.
                this.model.startNewSession();
                if (!this.isSubmissionContextCurrent(submission)) {
                    this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                    return;
                }
                const session = await this.service.createSession({
                    workspaceRoot: hostRoot,
                    providerId: submission.providerId,
                    model: this.newSessionModel ?? contextSnapshot.selectedModel,
                    title: text.slice(0, 64) || (attachments.length === 1 ? '图片任务' : `${attachments.length} 张图片`),
                    additionalDirectories: this.roots.filter(candidate => !this.sameWorkspaceRoot(candidate, hostRoot))
                });
                if (!this.isSubmissionContextCurrent(submission)) {
                    this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                    return;
                }
                sessionId = session.appSessionId;
                // Publish the resolved ID before the model update. Reconciliation
                // then recognises new-session -> created-session as this send's
                // sole allowed context transition instead of an external switch.
                submission.sessionId = sessionId;
                this.model.setSession(session);
                this.rememberOpenSessionTab(sessionId);
                // session/new is already attached in the current ACP runtime.
                this.hydratedSessionKeyState().add(
                    this.agentContextKey(hostRoot, submission.providerId, sessionId)
                );
                if (!this.isSubmissionContextCurrent(submission)) {
                    this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                    return;
                }
            } else {
                const hydrationKey = this.agentContextKey(hostRoot, submission.providerId, sessionId);
                await this.ensureSessionHydrated(sessionId, hydrationKey);
                if (!this.isSubmissionContextCurrent(submission)) {
                    this.showInlineNotice('会话上下文已变化，当前任务未发送。请再点一次发送。', 'warning');
                    return;
                }
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
            const message = friendlyAgentErrorMessage(error);
            const cancelled = (submission.sessionId ? this.cancelRequested.has(submission.sessionId) : false)
                || this.isCancellationError(error);
            if (!cancelled && promptConsumed) {
                const visibleMessage = (this.retryablePrompt as RetryablePrompt | undefined)?.message ?? message;
                this.retryablePrompt = { ...submission, message: visibleMessage };
            } else if (!cancelled) {
                this.showInlineNotice(`任务发送失败：${message}`, 'error');
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
            this.showInlineNotice(`无法取消任务：${error instanceof Error ? error.message : String(error)}`, 'error');
            this.update();
        }
    }

    protected acceptAgentEvent(event: AgentHostEvent): void {
        // Session records carry status/model/updatedAt metadata, not transcript
        // content. In particular loadSession emits a session record before its
        // RPC resolves; deleting here would prevent openSession from moving the
        // cached transcript to the returned updatedAt token. Real content
        // events invalidate immediately, while external metadata changes are
        // still rejected by cachedSessionHistory's updatedAt comparison.
        const changedSessionId = event.kind !== 'session'
            && 'sessionId' in event
            && typeof event.sessionId === 'string'
            ? event.sessionId
            : undefined;
        if (changedSessionId) this.sessionHistoryCacheState().delete(changedSessionId);
        if (event.kind === 'turn-completed' && event.stopReason === 'cancelled') {
            if (this.retryablePrompt?.sessionId === event.sessionId) this.retryablePrompt = undefined;
            this.update();
            return;
        }
        const submission = this.submission;
        if (event.kind === 'text-delta' && event.role === 'user' && submission
            && submission.sessionId === event.sessionId) {
            submission.userEventReceived = true;
            this.update();
            return;
        }
        if (event.kind !== 'error' || !event.recoverable || !submission) return;
        if (!this.isSubmissionContextCurrent(submission)) return;
        if (event.sessionId && submission.sessionId && event.sessionId !== submission.sessionId) return;
        if ((submission.sessionId && this.cancelRequested.has(submission.sessionId))
            || this.isCancellationMessage(event.code, event.message)) return;
        this.retryablePrompt = { ...submission, message: friendlyAgentErrorMessage(event.message) };
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

    protected rememberOpenSessionTab(appSessionId: string): void {
        if (!appSessionId) return;
        // Tests and partial instances may not run field initializers.
        const tabs = this.openSessionTabs ?? [];
        if (!tabs.includes(appSessionId)) {
            this.openSessionTabs = [...tabs, appSessionId];
        } else {
            this.openSessionTabs = tabs;
        }
    }

    protected closeSessionTab(appSessionId: string): void {
        this.openSessionTabs = (this.openSessionTabs ?? []).filter(id => id !== appSessionId);
        if (this.model.snapshot.activeSessionId === appSessionId) {
            const next = this.openSessionTabs
                .map(id => this.model.snapshot.sessions.find(session => session.appSessionId === id))
                .find((session): session is SessionRecord => !!session);
            if (next) void this.openSession(next);
            else this.startNewSession();
        } else {
            this.update();
        }
    }

    protected beginSessionRename(session: SessionRecord): void {
        this.renamingSessionId = session.appSessionId;
        this.renameDraft = session.title || '';
        this.update();
    }

    protected async commitSessionRename(appSessionId: string): Promise<void> {
        if (this.renamingSessionId !== appSessionId) return;
        const title = this.renameDraft.trim();
        this.renamingSessionId = undefined;
        this.renameDraft = '';
        if (!title) {
            this.update();
            return;
        }
        try {
            const updated = await this.service.renameSession(appSessionId, title);
            this.model.updateSession(updated);
            this.rememberOpenSessionTab(appSessionId);
            this.update();
        } catch (error) {
            this.showInlineNotice(`无法重命名会话：${friendlyAgentErrorMessage(error)}`, 'error');
            this.update();
        }
    }

    protected async deleteSession(session: SessionRecord): Promise<void> {
        try {
            // Direct delete — no confirmation dialog; history is local-only and the
            // action is already an explicit trash-button click in the session list.
            await this.service.deleteSession(session.appSessionId);
            this.sessionHistoryCacheState().delete(session.appSessionId);
            for (const key of this.hydratedSessionKeyState()) {
                if (key.endsWith(`\u0000${session.appSessionId}`)) this.hydratedSessionKeyState().delete(key);
            }
            this.openSessionTabs = (this.openSessionTabs ?? []).filter(id => id !== session.appSessionId);
            await this.model.refresh();
            if (this.model.snapshot.activeSessionId === session.appSessionId
                || !this.model.snapshot.activeSessionId) {
                const next = this.openSessionTabs
                    .map(id => this.model.snapshot.sessions.find(item => item.appSessionId === id))
                    .find((item): item is SessionRecord => !!item);
                if (next) await this.openSession(next);
                else this.startNewSession();
            } else {
                this.update();
            }
        } catch (error) {
            this.showInlineNotice(`无法删除会话：${friendlyAgentErrorMessage(error)}`, 'error');
        }
    }

    protected async openWorkspacePath(filePath: string, options?: { reveal?: boolean; line?: number }): Promise<void> {
        const uri = this.workspaceFileUri(filePath);
        if (!uri) {
            this.showInlineNotice('无法定位该文件：文件不在当前项目中。', 'error');
            return;
        }
        try {
            const target = options?.line && options.line > 0
                ? uri.withFragment(`L${options.line}`)
                : uri;
            await open(this.openerService, target);
            if (options?.reveal !== false) {
                await this.commandService.executeCommand(FileNavigatorCommands.REVEAL_IN_NAVIGATOR.id, uri);
            }
        } catch (error) {
            this.showInlineNotice(`无法打开 ${this.fileLabel(filePath)}：${error instanceof Error ? error.message : String(error)}`, 'error');
        }
    }

    protected sessionHistoryCacheState(): Map<string, { updatedAt: string; events: AgentHostEvent[] }> {
        return this.sessionHistoryCache ?? (this.sessionHistoryCache = new Map());
    }

    protected cachedSessionHistory(session: SessionRecord): AgentHostEvent[] | undefined {
        if (session.status === 'running') return undefined;
        const cache = this.sessionHistoryCacheState();
        const cached = cache.get(session.appSessionId);
        if (!cached || cached.updatedAt !== session.updatedAt) return undefined;
        // Refresh LRU order without copying a potentially large transcript.
        cache.delete(session.appSessionId);
        cache.set(session.appSessionId, cached);
        return cached.events;
    }

    protected cacheSessionHistory(session: SessionRecord, events: AgentHostEvent[], updatedAt = session.updatedAt): void {
        const cache = this.sessionHistoryCacheState();
        cache.delete(session.appSessionId);
        if (session.status !== 'running' && events.length <= SESSION_HISTORY_CACHE_MAX_EVENTS) {
            cache.set(session.appSessionId, { updatedAt, events });
        }
        while (cache.size > SESSION_HISTORY_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value as string | undefined;
            if (!oldest) break;
            cache.delete(oldest);
        }
    }

    protected async openSession(session: SessionRecord): Promise<void> {
        this.rememberOpenSessionTab(session.appSessionId);
        if (this.model.snapshot.activeSessionId === session.appSessionId && !this.sessionLoading) {
            this.closePopover();
            this.update();
            return;
        }
        // A historical record may belong to an older Provider. Its local
        // transcript is still selected in the current application context;
        // the backend safely attaches a fresh ACP session without replaying
        // the old prompts. Using session.providerId here caused the restore to
        // abort before that migration could run.
        const targetContextKey = this.agentContextKey(
            session.workspaceRoot,
            this.model.snapshot.providerId,
            session.appSessionId
        );
        this.invalidateAgentContext('会话已切换，未发送的图片已清除。');
        const generation = this.sessionLoadGeneration;
        this.openPopover = undefined;
        this.sessionLoading = true;
        const cachedHistory = this.cachedSessionHistory(session);
        // Select the requested conversation synchronously. This immediately
        // removes the previous transcript; cached local content can paint in
        // the same browser frame and a first-time disk read fills it next.
        this.observedAgentContextKey = targetContextKey;
        this.model.showSessionHistory(session, cachedHistory ?? []);
        this.stickToBottom = true;
        this.followTranscript();
        this.update();
        try {
            if (!cachedHistory) {
                const history = await this.service.getSessionHistory(session.appSessionId);
                if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
                this.cacheSessionHistory(session, history);
                this.model.showSessionHistory(session, history);
                this.stickToBottom = true;
                this.followTranscript();
            }
            // The conversation is usable as soon as its local history is on
            // screen. ACP hydration continues below and is single-flighted
            // with a possible immediate Send, so switching never locks the
            // composer on network/auth latency.
            if (generation === this.sessionLoadGeneration) {
                this.sessionLoading = false;
                this.workspaceRestorePending = false;
                this.update();
            }
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
            let loaded: SessionRecord;
            try {
                loaded = await this.ensureSessionHydrated(session.appSessionId, targetContextKey);
            } catch (error) {
                if (!(error instanceof Error) || !error.message.includes('AUTHENTICATION_REQUIRED')) throw error;
                const runtime = await this.service.getSnapshot();
                if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
                if (!await this.authenticateRuntime(runtime, () =>
                    generation === this.sessionLoadGeneration && this.imageDraftContextKey() === targetContextKey)) return;
                if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
                loaded = await this.ensureSessionHydrated(session.appSessionId, targetContextKey);
            }
            if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
            const history = this.sessionHistoryCacheState().get(session.appSessionId);
            if (history) this.cacheSessionHistory(loaded, history.events, loaded.updatedAt);
            this.model.updateSession(loaded);
        } catch (error) {
            if (generation !== this.sessionLoadGeneration) return;
            this.showInlineNotice(`无法恢复会话：${friendlyAgentErrorMessage(error)}`, 'warning');
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
                    : '首次恢复旧版 API 服务需要确认。建议在设置中迁移到自定义模型服务；相同配置后续不再提示。'
                : `是否使用“${provider?.name ?? '当前服务'}”已配置的凭据继续？只有当前服务的凭据会注入 Agent 进程，相同配置后续不再提示。`;
        const choice = await this.messages.warn(warning, '继续');
        if (contextIsCurrent && !contextIsCurrent()) return false;
        if (choice !== '继续') return false;
        if (contextIsCurrent && !contextIsCurrent()) return false;
        const confirmed = await this.service.authenticate(methodId, true);
        return confirmed.status === 'authenticated' && (!contextIsCurrent || contextIsCurrent());
    }

    protected async workspaceRoot(): Promise<string | undefined> {
        const snapshotRoot = this.model.snapshot.workspaceRoot;
        if (snapshotRoot && this.rootsInclude(snapshotRoot)) {
            // Prefer backend/canonical root when it is the same folder as a
            // Theia workspace root (case/separator differences allowed).
            return snapshotRoot;
        }
        const roots = await this.workspaceService.roots;
        return roots[0] ? FileUri.fsPath(roots[0].resource) : undefined;
    }

    protected async refreshProviders(): Promise<void> {
        if (this.providerRefreshInFlight) return this.providerRefreshInFlight;
        const refresh = (async (): Promise<void> => {
            try {
                this.providers = await this.service.listProviders();
                this.requestRuntimePrewarm(true);
                this.update();
            } catch (error) {
                this.showInlineNotice(`无法加载模型服务：${friendlyAgentErrorMessage(error)}`, 'error');
            }
        })();
        this.providerRefreshInFlight = refresh;
        try {
            await refresh;
        } finally {
            if (this.providerRefreshInFlight === refresh) this.providerRefreshInFlight = undefined;
        }
    }

    protected async refreshRoots(): Promise<void> {
        const roots = await this.workspaceService.roots;
        this.activateWorkspace(roots.map(root => FileUri.fsPath(root.resource)));
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
        await this.openWorkspacePath(diff.path, { reveal: true });
    }

    protected async revertDiff(diff: DiffEvent): Promise<void> {
        try {
            await this.service.revertDiff(diff.diffId);
            this.showInlineNotice(`已撤销 ${diff.path} 的 Agent 修改。`);
        } catch (error) {
            await this.openDiff(diff);
            this.showInlineNotice(error instanceof Error ? error.message : String(error), 'error');
        }
    }
}
