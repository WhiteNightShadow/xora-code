import '../../src/browser/style/agent.css';

import { CommandService, Disposable, MessageService } from '@theia/core/lib/common';
import { CommonCommands, open, OpenerService, ReactWidget } from '@theia/core/lib/browser';
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
import { FileSearchService } from '@theia/file-search/lib/common/file-search-service';
import { FileNavigatorCommands } from '@theia/navigator/lib/browser/file-navigator-commands';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { DiffService } from '@theia/workspace/lib/browser/diff-service';
import {
    AgentHostEvent,
    AgentHostService,
    AgentExecutionMode,
    AgentGoalStateEvent,
    AgentPlanApprovalRequestEvent,
    AgentTaskContractEvent,
    AgentThoughtEvent,
    AgentPermissionMode,
    AgentReasoningOption,
    AgentAttachmentSummary,
    AgentPlanEvent,
    DiffEvent,
    PermissionRequestEvent,
    PromptImageAttachment,
    PromptImageMimeType,
    ProviderProfile,
    RuntimePhase,
    RuntimeSnapshot,
    SessionHistoryPage,
    SessionHistoryPageRequest,
    SessionRecord,
    ToolCallEvent
} from '../common/agent-protocol';
import { AgentHostClientImpl } from './agent-client';
import {
    activityFiltersForTool,
    AgentActivityFilter,
    AgentContextSummary,
    isGoalCompletionRequest,
    presentAgentTool,
    sessionRelativeTime,
    sessionStatusLabel,
    summarizeAgentContext,
    summarizeToolCategories,
    toolMatchesActivityFilter
} from './agent-display-helpers';
import { OPEN_AGENT_SETTINGS_COMMAND } from './agent-entry-commands';
import { friendlyAgentErrorMessage } from './agent-error-labels';
import { shouldCommitRenameOnEnter, shouldSubmitPromptOnEnter } from './agent-input-helpers';
import { grokSubscriptionAuthStatus } from './agent-management-labels';
import { AgentMarkdown } from './agent-markdown';
import {
    detectSlashQuery,
    extractNamedResources,
    filterSlashCommands,
    hasDelimitedResourceReference,
    replaceSlashToken,
    resourceMenuItems,
    SlashCommandId,
    SlashMenuItem,
    SlashQuery,
    slashCommandsToMenuItems
} from './agent-slash-menu';
import {
    agentModelChoiceGroups,
    decodeAgentModelConfiguration,
    decodeAgentModelChoice,
    encodeAgentModelConfiguration,
    PROVIDER_DEFAULT_MODEL_CHOICE_ID,
    providerCatalogModelId,
    selectedAgentModelChoice
} from './agent-model-options';
import { runtimePhaseLabel, toolStatusLabel, transcriptRoleLabel } from './agent-ui-labels';
import { AgentViewModel, TranscriptEntry } from './agent-view-model';
import { WorkspaceTrustGuard } from './workspace-trust-guard';

interface PromptSubmission {
    /** Renderer-local identity used for FIFO queueing and single-item cancel. */
    readonly id: string;
    readonly text: string;
    /** Immutable binding that prevents an async send from crossing Agent contexts. */
    readonly contextKey: string;
    readonly generation: number;
    readonly workspaceRoot: string;
    readonly providerId: string;
    /** Explicit, conversation-local choice captured when the user sends. */
    readonly taskMode: ComposerTaskMode;
    readonly executionMode: AgentExecutionMode;
    /** Renderer-local click-to-completion anchor used only for live UX. */
    readonly acceptedAt: number;
    readonly sourceSessionId?: string;
    sessionId?: string;
    readonly attachments: PromptImageAttachment[];
    readonly draftAttachmentIds?: string[];
    /** Set only after Electron has accepted and published this exact user
     * turn. Until then the conversation renders a lightweight local bubble so
     * cold session creation never looks like a missed click. */
    userEventReceived?: boolean;
    cancelled?: boolean;
    state?: 'queued' | 'guiding' | 'preparing' | 'running';
    /** Blocks FIFO promotion while the same row is crossing x.ai/interject. */
    guidanceCompletion?: Promise<void>;
    resolveGuidance?: () => void;
    resolveCompletion?: () => void;
    completion?: Promise<void>;
}

interface RetryablePrompt extends PromptSubmission {
    message: string;
}

interface SessionContextMenuState {
    sessionId: string;
    x: number;
    y: number;
}

type AgentPopover = 'history' | 'context';
type AgentPaneView = 'conversation' | 'activity' | 'changes';
type ComposerTaskMode = 'standard' | 'continuous';

const MAX_RENDERED_TRANSCRIPT_ENTRIES = 180;
const MAX_PROMPT_IMAGE_COUNT = 4;
const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_QUEUED_PROMPTS_PER_SESSION = 16;
const ACTIVITY_FILTERS: Array<{ id: AgentActivityFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'files', label: '文件' },
    { id: 'search', label: '搜索' },
    { id: 'terminal', label: '终端' },
    { id: 'web', label: '网络' },
    { id: 'agent', label: '子 Agent' },
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
    kind: 'project' | 'restore' | 'plan-approval';
    message: string;
}

interface AgentInlineNotice {
    id: number;
    message: string;
    tone: 'info' | 'warning' | 'error';
}

interface ComposerDraftState {
    text: string;
    references: ComposerResourceReference[];
    images: DraftImageAttachment[];
    imageError?: string;
    imageAnnouncement: string;
    previewImageId?: string;
}

interface ComposerResourceReference {
    kind: 'mcp' | 'skill';
    name: string;
}

/**
 * One renderer lane per conversation. Grok/ACP still receives at most one
 * prompt request per session at a time, while independent session lanes can
 * progress concurrently through the same sidecar.
 */
interface SessionPromptLane {
    key: string;
    workspaceRoot: string;
    providerId: string;
    sourceSessionId?: string;
    sessionId?: string;
    queue: PromptSubmission[];
    active?: PromptSubmission;
    processing?: Promise<void>;
    retryable?: RetryablePrompt;
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
/** A small cushion prevents trackpad momentum and fractional layout values
 * from detaching a reader who is still visually at the end of the chat. */
const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 72;

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

    @inject(FileSearchService)
    protected readonly fileSearchService!: FileSearchService;

    @inject(DiffService)
    protected readonly diffService!: DiffService;

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
    /** Compatibility mirror for focused tests; lane state is authoritative. */
    protected submission: PromptSubmission | undefined;
    /** Covers the asynchronous Provider refresh before a PromptSubmission is
     * created. Without this guard, two quick Enter presses can both cross the
     * refresh boundary and submit the same draft. */
    protected sendPreparationInFlight = false;
    /** Optimistic bubble painted before Provider/Save All preparation finishes. */
    protected sendPreparationPreview: Pick<PromptSubmission, 'text' | 'attachments'> | undefined;
    protected retryablePrompt: RetryablePrompt | undefined;
    protected readonly cancelRequested = new Set<string>();
    protected promptSequence = 0;
    protected newSessionLaneSequence = 0;
    protected activeComposerLaneKey: string | undefined;
    protected composerDrafts = new Map<string, ComposerDraftState>();
    /** Execution intent is isolated with the composer lane. It never becomes
     * a global default and therefore cannot silently affect another session. */
    protected composerTaskModes = new Map<string, ComposerTaskMode>();
    /** Visual tokens remain conversation-local just like text and images. */
    protected composerReferences: ComposerResourceReference[] = [];
    protected promptLanes = new Map<string, SessionPromptLane>();
    protected readonly permissionDecisions = new Set<string>();
    protected readonly planApprovalDecisions = new Set<string>();
    protected readonly planApprovalCriteria = new Map<string, string>();
    protected readonly planApprovalFeedback = new Map<string, string>();
    protected textarea: HTMLTextAreaElement | null = null;
    protected composerSubmitButton: HTMLButtonElement | null = null;
    protected composerResizeTarget: HTMLTextAreaElement | null = null;
    protected composerResizeFrame: number | undefined;
    protected transcriptNode: HTMLElement | null = null;
    protected stickToBottom = true;
    protected newOutputAvailable = false;
    /** Keep conversation switches cheap, while still allowing the reader to
     * reveal older local history in bounded pages. This resets whenever the
     * visible conversation changes so returning to a tab paints its newest
     * 180 records first. */
    protected renderedTranscriptLimit = MAX_RENDERED_TRANSCRIPT_ENTRIES;
    /** Scroll-height anchor used when older records are prepended. */
    protected transcriptPrependAnchor: { scrollHeight: number; scrollTop: number } | undefined;
    protected transcriptHistoryRevealPending = false;
    /** React 18 may commit a concurrent root after the frame in which
     * ReactWidget.update() was requested. Apply scrolling from the transcript
     * ref callback, which runs after that DOM commit, rather than guessing at
     * the next animation frame. */
    protected transcriptFollowPending = true;
    protected transcriptOutputPending = false;
    protected observedTranscriptSignature = '';
    /** Tool and plan updates replace their payload object even when the
     * rendered text happens to keep the same length. Track that identity so a
     * progress update such as `step 1/9` -> `step 2/9` still wakes live follow
     * mode (or the unread chip while the reader is reviewing older output). */
    protected transcriptPayloadRevisions = new WeakMap<object, number>();
    protected nextTranscriptPayloadRevision = 1;
    protected sessionLoadGeneration = 0;
    protected agentContextGeneration = 0;
    protected sessionLoading = false;
    protected openPopover: AgentPopover | undefined;
    protected agentPaneView: AgentPaneView = 'conversation';
    protected activityFilter: AgentActivityFilter = 'all';
    protected readonly toolDisclosure = new Map<string, boolean>();
    protected readonly diffDisclosure = new Map<string, boolean>();
    protected readonly thoughtDisclosure = new Map<string, boolean>();
    protected sessionContextMenu: SessionContextMenuState | undefined;
    protected exportingSessionId: string | undefined;
    protected newSessionModel: string | undefined;
    /** Pending selection for a not-yet-created conversation. The value is the
     * canonical ACP token (for example `xhigh`), never a model-name guess. */
    protected newSessionReasoningEffort: string | undefined;
    protected modelOptionsLoading = false;
    /** Model and reasoning changes may have to wait for a visible historical
     * conversation to finish rebinding to the current Provider. Keep that
     * wait local to the two selectors: drafting and reading history remain
     * fully interactive. */
    protected modelSelectionLoading = false;
    /**
     * Provider metadata lives outside ACP modelState. Serialize refreshes so
     * a slow response that started before Settings saved a newer profile can
     * never become the final value rendered by the model selector.
     */
    protected providerRefreshTail: Promise<void> = Promise.resolve();
    protected observedProviderProfilesRevision: number | undefined;
    protected runtimeAuthenticationInFlight: { providerId: string; promise: Promise<boolean> } | undefined;
    protected permissionModeChanging = false;
    protected imeComposing = false;
    protected imeCompositionLaneKey: string | undefined;
    protected ignoreDetachedCompositionEnd = false;
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
    protected sessionHydrationPromises = new Map<string, Promise<SessionRecord>>();
    /** Successful ACP loads bound to the current runtime. Grok keeps multiple
     * sessions attached, so A -> B -> A must not replay session/load. */
    protected hydratedSessionKeys = new Set<string>();
    /** Small LRU of immutable, already-redacted local histories. Electron's
     * session updatedAt value is the cross-process invalidation token. */
    protected sessionHistoryCache = new Map<string, {
        updatedAt: string;
        events: AgentHostEvent[];
    }>();
    /** Paging state is independent from the small LRU above. Live events can
     * invalidate a cached snapshot while an already visible conversation still
     * needs its stable byte cursor to continue reading older JSONL pages. */
    protected sessionHistoryPages = new Map<string, {
        events: AgentHostEvent[];
        before?: string;
        hasMore: boolean;
    }>();
    /** Live events received while a first JSONL read is in flight. */
    protected sessionHistoryCatchup = new Map<string, AgentHostEvent[]>();
    protected observedRuntimePhase: RuntimePhase | undefined;
    /** Open multi-session tabs for the current project (order is left-to-right). */
    protected openSessionTabs: string[] = [];
    protected renamingSessionId: string | undefined;
    protected renameDraft = '';
    protected renameImeComposing = false;
    protected renameImeCompositionJustEnded = false;
    protected renameImeCompositionGuardTimer: number | undefined;
    /** One automatic "restore latest conversation" transaction per workspace. */
    protected workspaceRestoreKey: string | undefined;
    protected workspaceRestoreGeneration = 0;
    protected workspaceRestorePending = false;
    protected workspaceRestorePromise: Promise<void> | undefined;
    /** Low-distraction feedback owned by the Agent panel instead of global toasts. */
    protected inlineNotice: AgentInlineNotice | undefined;
    protected inlineNoticeTimer: number | undefined;
    protected inlineNoticeSequence = 0;
    /** Live elapsed labels update their own text nodes so a long turn does not
     * force the entire 180-entry transcript through React every second. */
    protected readonly liveElapsedNodes = new Set<HTMLElement>();
    protected liveElapsedTimer: number | undefined;
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
        this.activeComposerLaneKey = this.imageDraftContextKey();
        this.observedAgentContextKey = this.activeComposerLaneKey;
        this.observedProviderId = this.model.snapshot.providerId;
        this.observedProviderProfilesRevision = this.model.snapshot.providerProfilesRevision;
        this.observedRuntimePhase = this.model.snapshot.phase;
        this.observedTranscriptSignature = this.transcriptOutputSignature();
        this.toDispose.push(this.model.onDidChange(() => {
            const transcriptChanged = this.observeTranscriptOutput();
            const providerProfilesChanged = this.reconcileProviderProfiles();
            this.reconcileAgentContext(providerProfilesChanged);
            this.reconcileRuntimePrewarmState();
            this.scheduleRuntimePrewarm();
            this.followTranscript(transcriptChanged);
            this.update();
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
            if (this.renameImeCompositionGuardTimer !== undefined) {
                window.clearTimeout(this.renameImeCompositionGuardTimer);
            }
            if (this.composerResizeFrame !== undefined) {
                window.cancelAnimationFrame(this.composerResizeFrame);
            }
            this.composerResizeFrame = undefined;
            this.composerResizeTarget = null;
            this.cancelRuntimePrewarmTimer();
            if (this.inlineNoticeTimer !== undefined) window.clearTimeout(this.inlineNoticeTimer);
            this.stopLiveElapsedTimer();
            this.liveElapsedNodes.clear();
            const previewUrls = new Set(this.draftImages.map(image => image.previewUrl));
            for (const draft of this.composerDraftState().values()) {
                for (const image of draft.images) previewUrls.add(image.previewUrl);
            }
            for (const previewUrl of previewUrls) URL.revokeObjectURL(previewUrl);
            this.draftImages = [];
            this.composerDraftState().clear();
            this.composerTaskModeState().clear();
            for (const lane of this.promptLaneState().values()) {
                for (const item of lane.queue) item.cancelled = true;
                if (lane.active) lane.active.cancelled = true;
            }
            this.promptLaneState().clear();
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
        const reasoningOptions = this.reasoningOptionsForChoice(snapshot, selectedModel);
        const selectedReasoningEffort = this.selectedReasoningEffort(
            reasoningOptions,
            active
                // Model and reasoning are application-wide choices.  A
                // historical session's descriptive value must not mask the
                // latest global preference while it is being re-hydrated in a
                // newly opened project.
                ? snapshot.preferredReasoningEffort
                    ?? active.reasoningEffort
                    ?? snapshot.selectedReasoningEffort
                // Keep an explicit draft choice responsive while its durable
                // preference RPC is in flight.
                : this.newSessionReasoningEffort
                    ?? snapshot.preferredReasoningEffort
                    ?? snapshot.selectedReasoningEffort
        );
        const selectedModelConfiguration = selectedModel
            ? encodeAgentModelConfiguration(selectedModel, reasoningOptions.length ? selectedReasoningEffort : undefined)
            : '';
        const permissionMode = snapshot.permissionMode;
        const taskMode = this.currentComposerTaskMode();
        // Some lightweight embedders and legacy test fixtures provide only
        // the original view-model surface. Missing Goal state means standard
        // mode; it must never make ordinary prompt admission fail.
        const goalState = this.model.goalState?.(active?.appSessionId);
        const taskContract = this.model.taskContract?.(active?.appSessionId);
        const contextSummary = summarizeAgentContext(snapshot, this.model.transcript);
        const pendingPermissions = [...this.model.pendingPermissions.values()].map(permission => ({
            id: permission.requestId,
            kind: 'permission' as const,
            payload: permission
        }));
        const pendingPlanApprovals: TranscriptEntry[] = [...this.model.pendingPlanApprovals.values()].map(request => ({
            id: request.requestId,
            kind: 'plan-approval',
            payload: request,
            activityTurnId: request.turnId ? `activity:${request.sessionId}:${request.turnId}` : undefined
        }));
        const visibleTranscript = this.model.transcript.filter(entry => {
            if (entry.kind === 'permission') return !this.model.pendingPermissions.has(entry.id);
            if (entry.kind === 'plan-approval') return !this.model.pendingPlanApprovals.has(entry.id);
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
        const hiddenTranscriptCount = Math.max(0, paneTranscript.length - this.renderedTranscriptLimit);
        const historyPage = active ? this.sessionHistoryPageState().get(active.appSessionId) : undefined;
        const hasEarlierHistory = hiddenTranscriptCount > 0 || !!historyPage?.hasMore;
        const renderedTranscript = hiddenTranscriptCount
            ? paneTranscript.slice(-this.renderedTranscriptLimit)
            : paneTranscript;
        const composerImageError = this.imageError;
        const composerGate = this.composerGate(snapshot);
        // A missing project is already explained in the placeholder. Keep the
        // composer compact instead of repeating the same message in a second
        // full-width row; restore/approval states still need an explicit gate.
        const showComposerGate = composerGate?.kind === 'restore' || composerGate?.kind === 'plan-approval';
        const currentLane = this.currentPromptLane(false);
        const sendInFlight = currentLane?.active?.state === 'preparing';
        const pendingSubmissions = this.agentPaneView === 'conversation'
            ? this.visiblePendingSubmissions()
            : [];
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
                        disabled={this.sessionLoading}
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
            {this.renderSessionContextMenu()}
            {this.renderImagePreview()}
            {this.renderConversationBar()}
            {this.renderPaneTabs(toolEntries.length, diffEntries.length)}
            {goalState && goalState.status !== 'cleared'
                ? this.renderGoalStatus(goalState)
                : taskContract ? this.renderTaskContractStatus(taskContract, active) : undefined}
            {this.agentPaneView === 'activity' ? this.renderActivityFilters(toolEntries) : undefined}
            <section
                className='xora-transcript'
                role='log'
                aria-label='Agent 会话'
                aria-busy={this.sessionLoading}
                ref={node => this.bindTranscriptNode(node)}
                onScroll={event => this.onTranscriptScroll(event.currentTarget)}>
                {this.agentPaneView === 'conversation' && this.model.transcript.length === 0 && !pendingSubmissions.length
                    ? this.workspaceRestorePending ? this.renderWorkspaceRestorePending() : this.renderEmpty()
                    : renderedTranscript.length === 0 && !pendingSubmissions.length
                        ? this.renderPaneEmpty()
                        : <>
                            {hasEarlierHistory ? <button
                                className='xora-history-window-notice'
                                type='button'
                                title='继续向上滚动也会自动加载'
                                disabled={this.transcriptHistoryRevealPending}
                                onClick={() => { void this.revealEarlierTranscript(); }}>
                                <span className='codicon codicon-arrow-up' aria-hidden='true' />
                                {this.transcriptHistoryRevealPending
                                    ? '正在加载更早记录…'
                                    : hiddenTranscriptCount
                                        ? `加载更早记录 · 还有 ${hiddenTranscriptCount} 条`
                                        : '加载更早记录'}
                            </button> : undefined}
                            {this.agentPaneView === 'changes' ? this.renderChangesOverview(renderedTranscript) : undefined}
                            {this.renderTranscript(renderedTranscript)}
                            {pendingSubmissions.map((submission, index) => this.renderPendingSubmission(
                                submission,
                                currentLane?.active === submission,
                                index
                            ))}
                    </>}
                {this.agentPaneView === 'conversation'
                    ? this.renderTurnProgress(visibleTranscript, active, currentLane)
                    : undefined}
                {snapshot.message ? this.renderRuntimeNotice(snapshot.message) : undefined}
                {this.retryablePrompt ? this.renderRetry(this.retryablePrompt) : undefined}
            </section>
            {this.agentPaneView !== 'changes' && this.newOutputAvailable ? <button
                className='xora-jump-latest'
                aria-label={this.agentPaneView === 'activity' ? '有新活动，回到底部' : '有新消息，回到底部'}
                title='回到底部'
                onClick={() => this.scrollToBottom()}>
                <span className='codicon codicon-arrow-down' /> {this.agentPaneView === 'activity' ? '有新活动 · 回到底部' : '有新消息 · 回到底部'}
            </button> : undefined}
            {pendingPermissions.length || pendingPlanApprovals.length ? <aside className='xora-permission-dock' aria-label='等待处理的请求'>
                {[...pendingPlanApprovals, ...pendingPermissions].map(entry => this.renderEntry(entry))}
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
                    {this.renderDraftImages(snapshot.capabilities?.prompt.image === false)}
                    {this.renderComposerReferences()}
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
                            if (this.imeComposing
                                && this.imeCompositionLaneKey
                                && this.imeCompositionLaneKey !== this.activeComposerLaneKey) {
                                const draft = this.composerDraftState().get(this.imeCompositionLaneKey) ?? {
                                    text: '', references: [], images: [], imageAnnouncement: ''
                                };
                                this.composerDraftState().set(this.imeCompositionLaneKey, {
                                    ...draft,
                                    text: event.currentTarget.value
                                });
                                return;
                            }
                            this.prompt = event.currentTarget.value;
                            this.refreshComposerReferences(this.prompt);
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
                            this.imeCompositionLaneKey = this.activeComposerLaneKey;
                            this.ignoreDetachedCompositionEnd = false;
                            this.imeCompositionJustEnded = false;
                            if (this.imeCompositionGuardTimer !== undefined) {
                                window.clearTimeout(this.imeCompositionGuardTimer);
                                this.imeCompositionGuardTimer = undefined;
                            }
                        }}
                        onCompositionEnd={event => {
                            if (this.ignoreDetachedCompositionEnd) {
                                this.ignoreDetachedCompositionEnd = false;
                                this.imeCompositionLaneKey = undefined;
                                this.imeComposing = false;
                                this.imeCompositionJustEnded = false;
                                return;
                            }
                            const compositionLaneKey = this.imeCompositionLaneKey;
                            this.imeCompositionLaneKey = undefined;
                            if (compositionLaneKey && compositionLaneKey !== this.activeComposerLaneKey) {
                                this.imeComposing = false;
                                this.imeCompositionJustEnded = false;
                                return;
                            }
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
                    {showComposerGate && composerGate ? <div className={`xora-composer-gate xora-composer-gate-${composerGate.kind}`} role='status'>
                        <span className={`codicon ${composerGate.kind === 'project'
                            ? 'codicon-folder-opened'
                            : composerGate.kind === 'plan-approval' ? 'codicon-checklist' : 'codicon-loading'}`} />
                        <span>{composerGate.message}，草稿会保留。</span>
                    </div> : undefined}
                    <div className='xora-composer-actions'>
                        <div className='xora-composer-selectors'>
                            <label className='xora-model-control' title={active ? '当前模型与思考等级' : '新会话使用的模型与思考等级'}>
                                <select
                                    aria-label='Agent 模型与思考等级'
                                    title={modelChoiceCount === 0
                                        ? '点击加载当前服务提供的模型'
                                        : '选择模型；支持时可在模型下选择思考等级'}
                                    disabled={this.hasPromptLaneWork()
                                        || this.sessionLoading
                                        || this.modelOptionsLoading
                                        || this.modelSelectionLoading
                                        || snapshot.phase === 'starting'
                                        || snapshot.phase === 'initializing'
                                        || snapshot.phase === 'draining'
                                        || snapshot.phase === 'updating'}
                                    value={selectedModelConfiguration}
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
                                    onChange={event => void this.selectModelConfiguration(active, event.currentTarget.value)}>
                                    {this.renderModelConfigurationOptions(modelChoiceGroups, snapshot)}
                                </select>
                            </label>
                            <label
                                className={`xora-permission-mode-control${permissionMode === 'full-access' ? ' is-full-access' : ''}`}
                                title={permissionMode === 'full-access'
                                    ? '所有项目和会话都会自动批准兼容的 Agent 工具请求，并允许访问整块磁盘'
                                    : '所有项目和会话执行敏感操作前都会请求你的批准'}>
                                <select
                                    aria-label='Agent 全局权限'
                                    disabled={this.hasPromptLaneWork() || this.sessionLoading || this.permissionModeChanging}
                                    value={permissionMode}
                                    onChange={event => void this.selectPermissionMode(event.currentTarget.value as AgentPermissionMode)}>
                                    <option value='request-approval'>请求审批</option>
                                    <option value='full-access'>完全访问</option>
                                </select>
                            </label>
                        </div>
                        <div className='xora-composer-secondary'>
                            <div className='xora-composer-utility-group' role='group' aria-label='任务方式、附件与上下文'>
                                <button
                                    className={`xora-composer-tool xora-composer-options-trigger is-${taskMode}${this.slashMenuOpen ? ' is-active' : ''}`}
                                    type='button'
                                    aria-label={`打开任务与引用选项：当前为${taskMode === 'continuous' ? '持续完成' : '常规'}`}
                                    aria-haspopup='listbox'
                                    aria-expanded={this.slashMenuOpen}
                                    title='任务方式、文件、MCP 与技能'
                                    onMouseDown={event => event.preventDefault()}
                                    onClick={() => this.toggleSlashMenuFromButton()}>
                                    <span className={`codicon ${taskMode === 'continuous' ? 'codicon-sync' : 'codicon-list-selection'}`} />
                                    <span className='xora-composer-tool-label'>工具</span>
                                </button>
                                <button
                                    className='xora-composer-tool xora-composer-attachment-trigger'
                                    type='button'
                                    aria-label={this.draftImages.length ? `添加图片，当前已有 ${this.draftImages.length} 张` : '添加图片'}
                                    title={this.draftImages.length + this.imageReadsInFlight >= MAX_PROMPT_IMAGE_COUNT
                                        ? `每次最多添加 ${MAX_PROMPT_IMAGE_COUNT} 张图片`
                                        : '添加图片（支持直接粘贴）'}
                                    disabled={this.draftImages.length + this.imageReadsInFlight >= MAX_PROMPT_IMAGE_COUNT}
                                    onClick={() => this.imageInput?.click()}>
                                    <span className='codicon codicon-attach' />
                                    {this.draftImages.length ? <span className='xora-composer-attachment-count' aria-hidden='true'>
                                        {this.draftImages.length}
                                    </span> : undefined}
                                </button>
                                <button
                                    className={`xora-context-trigger xora-composer-tool xora-context-${contextSummary.compactionStatus}${contextSummary.usagePercent !== undefined ? ' has-usage' : ''}`}
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
                            <div className='xora-composer-submit-group' role='group' aria-label='任务操作'>
                                {active?.status === 'running' ? <button
                                    ref={node => { this.composerSubmitButton = node; }}
                                    className='xora-composer-submit xora-composer-stop'
                                    aria-label='停止当前任务'
                                    title='停止当前任务'
                                    disabled={this.cancelRequested.has(active.appSessionId)}
                                    onClick={() => this.cancel(active.appSessionId)}>
                                    <span className={`codicon ${this.cancelRequested.has(active.appSessionId) ? 'codicon-loading codicon-modifier-spin' : 'codicon-debug-stop'}`} />
                                </button> : undefined}
                                <button
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
                                    disabled={!!composerGate
                                        || this.sessionLoading
                                        || this.imageReadsInFlight > 0}
                                    onClick={() => this.send()}>
                                    <span className={`codicon ${sendInFlight ? 'codicon-loading codicon-modifier-spin' : 'codicon-send'}`} />
                                </button>
                            </div>
                        </div>
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
                    disabled={this.hasPromptLaneWork() || this.sessionLoading}
                    value={snapshot.workspaceRoot ?? this.roots[0]}
                    onChange={event => {
                        void this.selectWorkspaceRoot(event.currentTarget.value);
                    }}>
                    {this.roots.map(root => <option key={root} value={root}>{this.rootLabel(root)}</option>)}
                </select>
            </label>
        </div>;
    }

    protected renderGoalStatus(goal: AgentGoalStateEvent): React.ReactNode {
        const modelLabel = goal.agentTurnStatus === 'running'
            ? '模型执行中'
            : goal.agentTurnStatus === 'end-turn'
                ? '模型已结束'
                : goal.agentTurnStatus === 'cancelled' ? '模型已中止' : '模型出错';
        const verificationLabel = goal.verificationStatus === 'verified'
            ? 'Xora · 目标已核验'
            : goal.verificationStatus === 'verifying'
                ? 'Xora · 正在核验'
                : goal.verificationStatus === 'incomplete'
                    ? '仍有未完成项'
                    : goal.verificationStatus === 'blocked'
                        ? '验收受阻'
                        : goal.verificationStatus === 'paused'
                            ? '监督已暂停'
                            : goal.verificationStatus === 'working'
                                ? '持续完成中'
                                : '等待验收';
        const verified = goal.verificationStatus === 'verified';
        const paused = goal.verificationStatus === 'paused'
            || ['user-paused', 'back-off-paused', 'no-progress-paused', 'infra-paused', 'blocked', 'budget-limited']
                .includes(goal.status);
        const tone = verified ? 'verified' : paused ? 'paused' : goal.verificationStatus === 'verifying' ? 'verifying' : 'active';
        return <aside className={`xora-goal-status is-${tone}`} role='status' aria-live='polite'>
            <span className={`codicon ${verified
                ? 'codicon-verified-filled'
                : paused ? 'codicon-debug-pause' : 'codicon-sync codicon-modifier-spin'}`} aria-hidden='true' />
            <span className='xora-goal-status-title'>持续完成</span>
            <span className='xora-goal-state-chip'>{modelLabel}</span>
            <span className='xora-goal-state-separator' aria-hidden='true'>·</span>
            <span className='xora-goal-state-chip' title='核验结果来自 Grok Build Goal，由 Xora 持久化并独立于模型回合状态展示'>{verificationLabel}</span>
            {goal.workerRounds > 0 ? <span className='xora-goal-rounds'>{goal.workerRounds} 轮</span> : undefined}
        </aside>;
    }

    /** Truthful bridge between native Plan approval and the first
     * goal_updated. It also makes an interrupted restart explicit instead of
     * resurrecting a synthetic "active" Goal that Xora cannot replay. */
    protected renderTaskContractStatus(
        contract: AgentTaskContractEvent,
        session: SessionRecord | undefined
    ): React.ReactNode {
        const live = session?.status === 'running';
        const verified = contract.lifecycle === 'verified';
        const interrupted = contract.lifecycle === 'interrupted' || !live;
        const modelLabel = contract.lifecycle === 'approved' && live
            ? '模型按计划执行中'
            : contract.lifecycle === 'goal-starting' && live
                ? '模型已结束'
                : contract.lifecycle === 'goal-active' && live
                    ? '模型执行中'
                    : verified ? '模型已结束' : '模型已中断';
        const xoraLabel = verified
            ? 'Xora · 目标已核验'
            : interrupted
                ? 'Xora · 持续完成未启动'
                : contract.lifecycle === 'goal-starting'
                    ? 'Xora · 正在启动验收'
                    : 'Xora · 等待 Goal 状态';
        const tone = verified ? 'verified' : interrupted ? 'paused' : 'verifying';
        return <aside className={`xora-goal-status is-${tone}`} role='status' aria-live='polite'>
            <span className={`codicon ${verified
                ? 'codicon-verified-filled'
                : interrupted ? 'codicon-debug-pause' : 'codicon-sync codicon-modifier-spin'}`} aria-hidden='true' />
            <span className='xora-goal-status-title'>持续完成</span>
            <span className='xora-goal-state-chip'>{modelLabel}</span>
            <span className='xora-goal-state-separator' aria-hidden='true'>·</span>
            <span
                className='xora-goal-state-chip'
                title={interrupted
                    ? '已批准的目标与验收条件保存在本地；Xora 不会在重启后自动重放任务'
                    : '已锁定目标、计划与验收条件，等待 Grok Build 发布原生 Goal 状态'}>
                {xoraLabel}
            </span>
        </aside>;
    }

    protected transcriptForPane(entries: TranscriptEntry[]): TranscriptEntry[] {
        if (this.agentPaneView === 'conversation') return entries;
        if (this.agentPaneView === 'changes') return entries.filter(entry => entry.kind === 'diff');
        return entries.filter(entry => {
            if (entry.kind === 'tool') {
                return toolMatchesActivityFilter(entry.payload as ToolCallEvent, this.activityFilter);
            }
            if (this.activityFilter !== 'all') return false;
            return entry.kind === 'plan' || entry.kind === 'plan-approval' || entry.kind === 'permission' || entry.kind === 'error';
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
                    this.newOutputAvailable = false;
                    this.followTranscript(false, true);
                    this.update();
                }}>
                {filter.label}
                {(counts.get(filter.id) ?? 0) > 0 ? <small>{counts.get(filter.id)}</small> : undefined}
            </button>)}
        </div>;
    }

    protected selectAgentPane(view: AgentPaneView): void {
        if (this.agentPaneView === view) return;
        this.agentPaneView = view;
        this.resetTranscriptWindow();
        this.newOutputAvailable = false;
        this.closePopover();
        if (view !== 'changes') this.followTranscript(false, true);
        this.update();
        if (view === 'changes') requestAnimationFrame(() => {
            if (this.transcriptNode) this.transcriptNode.scrollTop = 0;
        });
    }

    protected renderPaneEmpty(): React.ReactNode {
        const empty = this.agentPaneView === 'changes'
            ? { icon: 'codicon-diff', title: '还没有文件变更', body: 'Agent 产生的修改会汇总在这里，可直接打开 Theia 差异视图审查。' }
            : { icon: 'codicon-pulse', title: '暂无此类活动', body: this.activityFilter === 'all'
                ? '运行任务后，文件、搜索、网络、子 Agent、技能、MCP 与插件操作会按标签记录在这里。'
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

    protected renderDraftImages(useWorkspaceFallback = false): React.ReactNode {
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
                    <span className='xora-composer-image-thumb'>
                        <img src={image.previewUrl} alt={image.name ?? '待发送图片'} draggable={false} />
                    </span>
                    <span className='xora-composer-image-copy'>
                        <strong>{image.name ?? '图片'}</strong>
                        <small>图片 · {this.formatByteSize(image.byteSize)}</small>
                    </span>
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
                <span className='xora-composer-image-copy'>
                    <strong>正在读取图片</strong>
                    <small>请稍候</small>
                </span>
            </div>)}
            {useWorkspaceFallback && this.draftImages.length ? <span
                className='xora-composer-image-fallback-hint'
                role='status'
                title='当前 Agent 未声明原生图片输入，Xora 会安全保存到当前项目后作为文件附件发送'>
                <span className='codicon codicon-file-media' aria-hidden='true' />
                将作为项目图片附件发送
            </span> : undefined}
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
        return this.promptLaneKey(
            snapshot.workspaceRoot ?? this.roots?.[0] ?? '',
            snapshot.providerId,
            snapshot.activeSessionId
        );
    }

    protected promptLaneKey(workspaceRoot: string, providerId: string, sessionId?: string): string {
        const context = this.agentContextKey(workspaceRoot, providerId, sessionId);
        return sessionId ? context : `${context}\u0000draft-${this.newSessionLaneSequence ?? 0}`;
    }

    protected composerDraftState(): Map<string, ComposerDraftState> {
        return this.composerDrafts ?? (this.composerDrafts = new Map());
    }

    protected composerTaskModeState(): Map<string, ComposerTaskMode> {
        return this.composerTaskModes ?? (this.composerTaskModes = new Map());
    }

    protected currentComposerTaskMode(): ComposerTaskMode {
        const key = this.activeComposerLaneKey ?? this.imageDraftContextKey();
        const selected = this.composerTaskModeState().get(key);
        return selected === 'continuous' ? 'continuous' : 'standard';
    }

    protected selectComposerTaskMode(mode: ComposerTaskMode): void {
        if (this.currentComposerHasPromptLaneWork() || this.sessionLoading) return;
        const key = this.activeComposerLaneKey ?? this.imageDraftContextKey();
        this.composerTaskModeState().set(key, mode);
        // Project attachment already prewarms the runtime. Starting another
        // prewarm transaction from this purely local choice can race a late
        // session restore and make the newly selected mode appear to revert.
        // `send()` still prepares a stopped runtime when needed.
        this.update();
        requestAnimationFrame(() => {
            // Selecting an item returns focus to the uncontrolled textarea,
            // which also closes the command palette. Re-apply the choice to
            // the lane visible after that focus transition so a concurrent
            // last-session restore cannot visually snap it back to 常规.
            const visibleKey = this.activeComposerLaneKey ?? this.imageDraftContextKey();
            if (!this.currentComposerHasPromptLaneWork()) {
                this.composerTaskModeState().set(visibleKey, mode);
                this.update();
            }
            this.textarea?.focus();
        });
    }

    protected sessionModeIsPlan(session: SessionRecord | undefined): boolean {
        if (!session?.currentModeId) return false;
        if (session.currentModeId.toLowerCase() === 'plan') return true;
        const mode = session.availableModes?.find(candidate => candidate.id === session.currentModeId);
        return /(?:^|\s)plan(?:ning)?(?:\s|$)/i.test(mode?.name ?? '');
    }

    protected sessionModeId(session: SessionRecord | undefined, kind: 'plan' | 'code'): string | undefined {
        const exact = session?.availableModes?.find(mode => mode.id.toLowerCase() === kind);
        if (exact) return exact.id;
        const semantic = session?.availableModes?.find(mode => kind === 'plan'
            ? /(?:^|\s)plan(?:ning)?(?:\s|$)/i.test(`${mode.id} ${mode.name}`)
            : /(?:^|\s)(?:code|agent|build|execute)(?:\s|$)/i.test(`${mode.id} ${mode.name}`));
        return semantic?.id ?? (session?.availableModes === undefined ? kind : undefined);
    }

    protected promptLaneState(): Map<string, SessionPromptLane> {
        return this.promptLanes ?? (this.promptLanes = new Map());
    }

    protected currentPromptLane(create = false): SessionPromptLane | undefined {
        const key = this.activeComposerLaneKey ?? this.imageDraftContextKey();
        let lane = this.promptLaneState().get(key);
        if (!lane && create) {
            const snapshot = this.model.snapshot;
            lane = {
                key,
                workspaceRoot: snapshot.workspaceRoot ?? this.roots?.[0] ?? '',
                providerId: snapshot.providerId,
                sourceSessionId: snapshot.activeSessionId,
                sessionId: snapshot.activeSessionId,
                queue: []
            };
            this.promptLaneState().set(key, lane);
        }
        return lane;
    }

    protected storeActiveComposerDraft(): void {
        const key = this.activeComposerLaneKey ?? this.imageDraftContextKey();
        this.activeComposerLaneKey = key;
        this.composerDraftState().set(key, {
            text: this.prompt ?? '',
            references: [...(this.composerReferences ?? [])],
            images: [...(this.draftImages ?? [])],
            imageError: this.imageError,
            imageAnnouncement: this.imageAnnouncement ?? '',
            previewImageId: this.previewImageId
        });
    }

    protected activateComposerLane(key: string): void {
        const previous = this.activeComposerLaneKey;
        if (previous && previous !== key && this.imeComposing) {
            // Finish ownership of the native composition before rebinding the
            // uncontrolled textarea. A late compositionend is ignored instead
            // of writing A's candidate into B's draft.
            this.prompt = this.textarea?.value ?? this.prompt;
            this.storeActiveComposerDraft();
            this.textarea?.blur();
            this.imeComposing = false;
            this.imeCompositionJustEnded = false;
            this.imeCompositionLaneKey = undefined;
            this.ignoreDetachedCompositionEnd = true;
            if (this.imeCompositionGuardTimer !== undefined) {
                window.clearTimeout(this.imeCompositionGuardTimer);
                this.imeCompositionGuardTimer = undefined;
            }
        }
        if (previous && previous !== key) this.storeActiveComposerDraft();
        this.activeComposerLaneKey = key;
        // Reads started for the previous draft are intentionally discarded;
        // already decoded images remain owned by that lane's saved draft.
        if (previous !== key) {
            this.imageReadGeneration += 1;
            this.imageReadsInFlight = 0;
            this.pendingImageBytes = 0;
        }
        const draft = this.composerDraftState().get(key);
        this.prompt = draft?.text ?? '';
        this.composerReferences = [...(draft?.references ?? [])].filter(reference =>
            hasDelimitedResourceReference(this.prompt, reference.name));
        this.draftImages = [...(draft?.images ?? [])];
        this.imageError = draft?.imageError;
        this.imageAnnouncement = draft?.imageAnnouncement ?? '';
        this.previewImageId = draft?.previewImageId;
        this.draftImageContextKey = this.draftImages.length ? key : undefined;
        this.closeSlashMenu();
        this.syncVisiblePromptLane();
        const apply = (): void => {
            if (!this.textarea) return;
            this.textarea.value = this.prompt;
            this.resizeComposer(this.textarea);
            this.syncComposerSubmitButton();
        };
        apply();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
    }

    protected syncVisiblePromptLane(): void {
        const lane = this.currentPromptLane(false);
        this.submission = lane?.active;
        this.sendPreparationInFlight = lane?.active?.state === 'preparing';
        const optimistic = lane?.active && !lane.active.userEventReceived ? lane.active : lane?.queue[0];
        this.sendPreparationPreview = optimistic
            ? { text: optimistic.text, attachments: optimistic.attachments }
            : undefined;
        this.retryablePrompt = lane?.retryable;
    }

    protected visiblePendingSubmissions(): PromptSubmission[] {
        const lane = this.currentPromptLane(false);
        if (!lane) return [];
        return [
            ...(lane.active && !lane.active.userEventReceived ? [lane.active] : []),
            ...lane.queue.filter(item => !item.cancelled)
        ];
    }

    /** Provider, permission and root controls are application/runtime-wide.
     * A background lane therefore owns the same safety lock as the visible
     * conversation even though it must not block typing or sending here. */
    protected hasPromptLaneWork(): boolean {
        if (this.model?.snapshot?.sessions?.some(session => session.status === 'running')) return true;
        for (const lane of this.promptLaneState().values()) {
            if (lane.active || lane.queue.some(item => !item.cancelled)) return true;
        }
        return false;
    }

    protected sessionHasPromptLaneWork(appSessionId: string): boolean {
        const lane = this.findPromptLaneBySession(appSessionId);
        return !!lane && (!!lane.active || lane.queue.some(item => !item.cancelled));
    }

    /** Task mode belongs to one composer lane. A task running in another
     * conversation must not prevent this lane from choosing Plan/Goal before
     * it sends, while work already accepted by this lane keeps its captured
     * mode immutable. */
    protected currentComposerHasPromptLaneWork(): boolean {
        const lane = this.currentPromptLane(false);
        if (lane && (lane.active || lane.queue.some(item => !item.cancelled))) return true;
        const activeSessionId = this.model?.snapshot?.activeSessionId;
        if (!activeSessionId) return false;
        if (this.sessionHasPromptLaneWork(activeSessionId)) return true;
        return this.model.snapshot.sessions?.some(session =>
            session.appSessionId === activeSessionId && session.status === 'running') === true;
    }

    /** Releases every renderer-owned resource for an unreachable composer.
     * Running lanes are never disposed through this path. */
    protected disposePromptLane(key: string): void {
        const lane = this.promptLaneState().get(key);
        if (lane?.active) return;
        const draft = this.composerDraftState().get(key);
        if (draft) {
            for (const image of draft.images) URL.revokeObjectURL(image.previewUrl);
            this.composerDraftState().delete(key);
        }
        if (lane) {
            for (const item of lane.queue) {
                item.cancelled = true;
                item.resolveCompletion?.();
            }
            this.promptLaneState().delete(key);
        }
        this.composerTaskModeState().delete(key);
        if (this.activeComposerLaneKey === key) {
            this.prompt = '';
            this.composerReferences = [];
            this.draftImages = [];
            this.imageError = undefined;
            this.previewImageId = undefined;
            this.draftImageContextKey = undefined;
            if (this.textarea) this.textarea.value = '';
        }
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
        const snapshot = this.model.snapshot;
        const root = snapshot.workspaceRoot ?? this.roots?.[0] ?? '';
        // Viewing another conversation is not a runtime boundary. Only a
        // project/Provider change may invalidate a queued or running prompt.
        return this.sameWorkspaceRoot(root, submission.workspaceRoot)
            && snapshot.providerId === submission.providerId;
    }

    protected invalidateAgentContext(announcement?: string): void {
        this.storeActiveComposerDraft();
        this.agentContextGeneration += 1;
        this.sessionLoadGeneration += 1;
        this.sessionLoading = false;
        this.runtimePrewarmRequested = true;
        this.runtimePrewarmAttemptKey = undefined;
        this.runtimePrewarmAttempts = 0;
        this.activeSessionHydrationKey = undefined;
        this.activeSessionHydrationPromise = undefined;
        this.cancelRuntimePrewarmTimer();
        if (announcement) this.imageAnnouncement = announcement;
        this.submission = undefined;
        this.sendPreparationInFlight = false;
        this.sendPreparationPreview = undefined;
        this.retryablePrompt = undefined;
        this.toolDisclosure?.clear();
        this.diffDisclosure?.clear();
        this.thoughtDisclosure?.clear();
        this.sessionContextMenu = undefined;
    }

    protected reconcileProviderProfiles(): boolean {
        const revision = this.model.snapshot.providerProfilesRevision;
        if (!Number.isSafeInteger(revision) || revision === this.observedProviderProfilesRevision) return false;
        this.observedProviderProfilesRevision = revision;
        void this.refreshProviders();
        return true;
    }

    protected reconcileAgentContext(providerRefreshScheduled = false): void {
        const providerId = this.model.snapshot.providerId;
        if (this.observedProviderId !== undefined && providerId !== this.observedProviderId) {
            this.invalidateAgentContext('模型服务已变化，草稿已按会话分别保留。');
            this.newSessionModel = undefined;
            this.newSessionReasoningEffort = undefined;
            // Older backends do not advertise providerProfilesRevision. A
            // Provider switch is still an unambiguous cache boundary, even
            // when the target id happened to exist in an old local list.
            if (!providerRefreshScheduled) {
                void this.refreshProviders();
            }
        }
        this.observedProviderId = providerId;
        const current = this.imageDraftContextKey();
        if (this.observedAgentContextKey !== undefined && current !== this.observedAgentContextKey) {
            this.activateComposerLane(current);
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

    protected bindLiveElapsed(
        node: HTMLElement | null,
        startedAtMs: number | undefined,
        frozenElapsedMs?: number
    ): void {
        if (!node) return;
        this.liveElapsedNodes.delete(node);
        if (Number.isFinite(frozenElapsedMs) && (frozenElapsedMs ?? -1) >= 0) {
            delete node.dataset.xoraStartedAt;
            node.textContent = this.formatTurnDuration(frozenElapsedMs!);
            return;
        }
        if (!Number.isFinite(startedAtMs)) {
            node.textContent = '';
            return;
        }
        node.dataset.xoraStartedAt = String(startedAtMs);
        this.liveElapsedNodes.add(node);
        this.updateLiveElapsedNode(node);
        this.ensureLiveElapsedTimer();
    }

    protected ensureLiveElapsedTimer(): void {
        if (this.liveElapsedTimer !== undefined || typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
        this.liveElapsedTimer = window.setInterval(() => {
            for (const node of [...this.liveElapsedNodes]) {
                if (!node.isConnected) {
                    this.liveElapsedNodes.delete(node);
                    continue;
                }
                this.updateLiveElapsedNode(node);
            }
            if (!this.liveElapsedNodes.size) this.stopLiveElapsedTimer();
        }, 1_000);
    }

    protected updateLiveElapsedNode(node: HTMLElement): void {
        const startedAtMs = Number(node.dataset.xoraStartedAt);
        if (!Number.isFinite(startedAtMs)) return;
        node.textContent = this.formatTurnDuration(Math.max(0, Date.now() - startedAtMs));
    }

    protected stopLiveElapsedTimer(): void {
        if (this.liveElapsedTimer === undefined) return;
        if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
            window.clearInterval(this.liveElapsedTimer);
        }
        this.liveElapsedTimer = undefined;
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
                    onContextMenu={event => this.openSessionContextMenu(event, session)}
                    title={session.title || '未命名会话'}>
                    {renaming ? <input
                        className='xora-session-rename-input'
                        defaultValue={this.renameDraft}
                        autoFocus
                        aria-label='重命名会话'
                        onChange={event => {
                            this.renameDraft = event.currentTarget.value;
                        }}
                        onCompositionStart={() => this.beginSessionRenameComposition()}
                        onCompositionEnd={event => this.endSessionRenameComposition(event.currentTarget.value)}
                        onBlur={() => void this.commitSessionRename(session.appSessionId)}
                        onKeyDown={event => this.handleSessionRenameKeyDown(event, session.appSessionId)}
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
                disabled={this.sessionLoading}
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
                    disabled={this.sessionLoading}
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
                        onContextMenu={event => this.openSessionContextMenu(event, session)}
                        aria-current={active ? 'true' : undefined}>
                        <span className={`xora-session-status-dot xora-session-status-${session.status}`} />
                        {renaming ? <input
                            className='xora-session-rename-input'
                            defaultValue={this.renameDraft}
                            autoFocus
                            aria-label='重命名会话'
                            onChange={event => {
                                this.renameDraft = event.currentTarget.value;
                            }}
                            onCompositionStart={() => this.beginSessionRenameComposition()}
                            onCompositionEnd={event => this.endSessionRenameComposition(event.currentTarget.value)}
                            onBlur={() => void this.commitSessionRename(session.appSessionId)}
                            onKeyDown={event => this.handleSessionRenameKeyDown(event, session.appSessionId)}
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
                                disabled={session.status === 'running'
                                    || this.sessionHasPromptLaneWork(session.appSessionId)
                                    || this.sessionLoading}
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
                <button className='theia-button secondary' disabled={this.sessionLoading} onClick={() => this.startNewSession()}>
                    <span className='codicon codicon-add' /> 新建会话
                </button>
            </footer>
        </section>;
    }

    protected openSessionContextMenu(event: React.MouseEvent<HTMLElement>, session: SessionRecord): void {
        event.preventDefault();
        event.stopPropagation();
        const menuWidth = 196;
        const menuHeight = 132;
        const margin = 8;
        this.openPopover = undefined;
        this.sessionContextMenu = {
            sessionId: session.appSessionId,
            x: Math.max(margin, Math.min(event.clientX, window.innerWidth - menuWidth - margin)),
            y: Math.max(margin, Math.min(event.clientY, window.innerHeight - menuHeight - margin))
        };
        this.update();
    }

    protected closeSessionContextMenu(): void {
        if (!this.sessionContextMenu) return;
        this.sessionContextMenu = undefined;
        this.update();
    }

    protected renderSessionContextMenu(): React.ReactNode {
        const state = this.sessionContextMenu;
        if (!state) return undefined;
        const session = this.model.snapshot.sessions.find(candidate => candidate.appSessionId === state.sessionId);
        if (!session) return undefined;
        const busy = session.status === 'running'
            || this.sessionHasPromptLaneWork(session.appSessionId)
            || this.sessionLoading;
        return <>
            <div
                className='xora-session-context-scrim'
                aria-hidden='true'
                onMouseDown={() => this.closeSessionContextMenu()}
                onContextMenu={event => {
                    event.preventDefault();
                    this.closeSessionContextMenu();
                }} />
            <section
                className='xora-session-context-menu'
                role='menu'
                aria-label={`会话操作：${session.title || '未命名会话'}`}
                style={{ left: state.x, top: state.y }}
                onMouseDown={event => event.stopPropagation()}>
                <button
                    type='button'
                    role='menuitem'
                    disabled={busy || this.exportingSessionId === session.appSessionId}
                    title={busy ? '任务结束后可导出完整会话' : '导出为 Markdown'}
                    onClick={() => void this.exportSession(session)}>
                    <span className={`codicon ${this.exportingSessionId === session.appSessionId ? 'codicon-loading codicon-modifier-spin' : 'codicon-export'}`} />
                    <span>{this.exportingSessionId === session.appSessionId ? '正在导出…' : '导出会话…'}</span>
                </button>
                <button
                    type='button'
                    role='menuitem'
                    disabled={busy}
                    onClick={() => {
                        this.sessionContextMenu = undefined;
                        this.beginSessionRename(session);
                    }}>
                    <span className='codicon codicon-edit' />
                    <span>重命名</span>
                </button>
                <div className='xora-session-context-separator' role='separator' />
                <button
                    type='button'
                    role='menuitem'
                    className='danger'
                    disabled={busy}
                    onClick={() => {
                        this.sessionContextMenu = undefined;
                        void this.deleteSession(session);
                    }}>
                    <span className='codicon codicon-trash' />
                    <span>删除会话</span>
                </button>
            </section>
        </>;
    }

    protected async exportSession(session: SessionRecord): Promise<void> {
        if (this.exportingSessionId) return;
        this.exportingSessionId = session.appSessionId;
        this.sessionContextMenu = undefined;
        this.update();
        try {
            const result = await this.service.exportSession(session.appSessionId);
            if (result.status === 'exported') {
                this.showInlineNotice(`会话已导出为 ${result.fileName ?? 'Markdown 文档'}。`);
            }
        } catch (error) {
            this.showInlineNotice(`无法导出会话：${friendlyAgentErrorMessage(error)}`, 'error');
        } finally {
            this.exportingSessionId = undefined;
            this.update();
        }
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
        if (event.key !== 'Escape' || (!this.openPopover && !this.previewImageId && !this.sessionContextMenu)) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.previewImageId) this.closeImagePreview();
        else if (this.sessionContextMenu) this.closeSessionContextMenu();
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

    protected renderModelConfigurationOptions(
        groups: ReturnType<typeof agentModelChoiceGroups>,
        snapshot: RuntimeSnapshot
    ): React.ReactNode {
        if (groups.length === 0) {
            return <option value=''>{this.modelOptionsLoading ? '正在加载模型…' : '选择模型…'}</option>;
        }
        return groups.flatMap(group => group.choices.map(choice => {
            const reasoning = this.reasoningOptionsForChoice(snapshot, choice.value);
            if (reasoning.length > 1) {
                return <optgroup key={`${group.providerId}:${choice.modelId}`} label={choice.label}>
                    {reasoning.map(option => <option
                        key={`${choice.value}:${option.id}`}
                        value={encodeAgentModelConfiguration(choice.value, option.value)}>
                        {choice.label} · {this.reasoningOptionLabel(option)}
                    </option>)}
                </optgroup>;
            }
            return <option
                key={choice.value}
                value={encodeAgentModelConfiguration(choice.value, reasoning[0]?.value)}>
                {choice.label}{reasoning[0] ? ` · ${this.reasoningOptionLabel(reasoning[0])}` : ''}
            </option>;
        }));
    }

    /** The menu is driven entirely by ACP model metadata. A Grok release, a
     * custom endpoint or a future reasoning level therefore needs no model-id
     * whitelist in the renderer. */
    protected reasoningOptionsForChoice(snapshot: RuntimeSnapshot, choice: string): AgentReasoningOption[] {
        const decoded = decodeAgentModelChoice(choice);
        const modelId = decoded?.modelId ?? choice;
        if (!modelId || modelId === PROVIDER_DEFAULT_MODEL_CHOICE_ID) return [];
        return snapshot.models.find(model => model.id === modelId)?.reasoningOptions ?? [];
    }

    protected selectedReasoningEffort(
        options: AgentReasoningOption[],
        requested: string | undefined
    ): string {
        return options.find(option => option.id === requested || option.value === requested)?.value
            ?? options.find(option => option.default)?.value
            ?? options[0]?.value
            ?? '';
    }

    protected reasoningOptionLabel(option: AgentReasoningOption): string {
        const localized: Record<string, string> = {
            none: '关闭',
            minimal: '最低',
            low: '低',
            medium: '中',
            high: '高',
            xhigh: '极高'
        };
        return localized[option.value.toLowerCase()] ?? option.name;
    }

    protected async selectModelConfiguration(
        session: SessionRecord | undefined,
        value: string
    ): Promise<void> {
        const configuration = decodeAgentModelConfiguration(value);
        if (!configuration) {
            this.showInlineNotice('模型选项已变化，请重新选择。', 'warning');
            return;
        }
        const options = this.reasoningOptionsForChoice(this.model.snapshot, configuration.modelChoice);
        const reasoningEffort = configuration.reasoningEffort
            ? options.find(option => option.id === configuration.reasoningEffort
                || option.value === configuration.reasoningEffort)?.value
            : undefined;
        if (configuration.reasoningEffort && !reasoningEffort) {
            this.showInlineNotice('当前模型不再提供这个思考等级，请重新选择。', 'warning');
            return;
        }
        await this.selectModel(session, configuration.modelChoice, reasoningEffort);
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
        const planApprovals = this.model.pendingPlanApprovals?.values?.() ?? [];
        if (snapshot.activeSessionId && [...planApprovals]
            .some(request => request.sessionId === snapshot.activeSessionId)) {
            return { kind: 'plan-approval', message: '请先处理当前计划审批' };
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
        const previousPhase = this.observedRuntimePhase;
        // A stopped/relaunching/auth-required process cannot prove that an ACP
        // session loaded by the previous ready runtime is still attached.
        // Clear only renderer acceleration state; Electron remains the final
        // authority and durable history is untouched.
        if (phase !== 'ready' && phase !== this.observedRuntimePhase) {
            this.activeSessionHydrationKey = undefined;
            this.activeSessionHydrationPromise = undefined;
            this.sessionHydrationPromiseState().clear();
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
        // Authentication completes on the already-running sidecar, so the
        // normal stopped/crashed prewarm path does not run again. Resume the
        // visible history hydration that was intentionally skipped while the
        // process was auth-required.
        if (previousPhase === 'auth-required' && phase === 'ready') {
            void this.hydrateActiveSessionInBackground();
        }
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
        const hydrationPromises = this.sessionHydrationPromiseState();
        const concurrent = hydrationPromises.get(key);
        if (concurrent) return concurrent;
        const promise = this.service.loadSession(sessionId);
        hydrationPromises.set(key, promise);
        this.activeSessionHydrationKey = key;
        this.activeSessionHydrationPromise = { key, promise };
        try {
            const loaded = await promise;
            const authority = loaded ?? current;
            if (this.model.snapshot.phase === 'ready'
                && authority
                && this.sameWorkspaceRoot(authority.workspaceRoot, this.model.snapshot.workspaceRoot)
                && authority.providerId === this.model.snapshot.providerId) {
                this.hydratedSessionKeyState().add(key);
            }
            return loaded;
        } finally {
            if (hydrationPromises.get(key) === promise) hydrationPromises.delete(key);
            if (this.activeSessionHydrationPromise?.promise === promise) {
                this.activeSessionHydrationPromise = undefined;
            }
        }
    }

    protected sessionHydrationPromiseState(): Map<string, Promise<SessionRecord>> {
        return this.sessionHydrationPromises ?? (this.sessionHydrationPromises = new Map());
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
        this.syncComposerReferences(prompt);
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
        const active = this.model.snapshot.sessions.find(session => session.appSessionId === this.model.snapshot.activeSessionId);
        const taskMode = this.currentComposerTaskMode();
        const title = this.slashPanel === 'mcp'
            ? 'MCP 服务'
            : this.slashPanel === 'skill'
                ? '技能 Skill'
                : '任务与引用';
        return <div
            id='xora-slash-menu'
            className='xora-slash-menu'
            role='listbox'
            aria-label={`Agent ${title}菜单`}>
            <div className='xora-slash-menu-header'>
                <strong>{title}</strong>
                <span>{this.slashLoading ? '加载中…' : '↑↓ 选择 · Enter 确认 · Esc 关闭'}</span>
            </div>
            {this.slashPanel === 'commands' ? <div className='xora-slash-menu-quick' aria-label='任务方式与常用引用'>
                <div className='xora-task-mode-segment' role='group' aria-label='任务执行方式'>
                    <button
                        type='button'
                        aria-pressed={taskMode === 'standard'}
                        className={taskMode === 'standard' ? 'active' : undefined}
                        disabled={this.currentComposerHasPromptLaneWork() || this.sessionLoading}
                        onClick={() => this.selectComposerTaskMode('standard')}>
                        <span className='codicon codicon-run' /> 常规
                    </button>
                    <button
                        type='button'
                        aria-pressed={taskMode === 'continuous'}
                        className={taskMode === 'continuous' ? 'active' : undefined}
                        disabled={this.currentComposerHasPromptLaneWork()
                            || this.sessionLoading
                            || (!!active && active.goalCapability?.available !== true)}
                        title={!!active && active.goalCapability?.available !== true
                            ? '当前会话未提供持续完成功能'
                            : '持续执行目标，并由 Xora 核验完成条件'}
                        onClick={() => this.selectComposerTaskMode('continuous')}>
                        <span className='codicon codicon-sync' /> 持续完成
                    </button>
                </div>
                <button
                    className='xora-slash-menu-file'
                    type='button'
                    onClick={() => void this.runSlashCommand('file')}>
                    <span className='codicon codicon-files' /> 引用文件
                </button>
            </div> : undefined}
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
        // The compact toolbar button is a discoverability surface, not text
        // input: opening it must never insert a stray slash into the user's
        // draft. Typing `/` in the textarea keeps the full keyboard workflow.
        this.slashPanel = 'commands';
        this.slashQuery = undefined;
        this.slashItems = slashCommandsToMenuItems(filterSlashCommands(''));
        this.slashActiveIndex = 0;
        this.slashLoading = false;
        this.slashError = undefined;
        this.slashMenuOpen = true;
        this.update();
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
            if (item.resourceKind) this.rememberComposerReference(item.resourceKind, item.insertText);
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
                    ? '没有已启用的 Xora MCP 服务。可在 Agent 设置中导入、启用或诊断。'
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
        this.syncComposerReferences(text);
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

    protected rememberComposerReference(kind: ComposerResourceReference['kind'], name: string): void {
        const normalized = name.trim();
        const current = this.composerReferences ?? [];
        if (!normalized || current.some(reference => reference.kind === kind && reference.name === normalized)) return;
        this.composerReferences = [...current, { kind, name: normalized }];
    }

    /** Returns true only when a visual update is needed. */
    protected syncComposerReferences(text: string): boolean {
        const current = this.composerReferences ?? [];
        const next = current.filter(reference => hasDelimitedResourceReference(text, reference.name));
        if (next.length === current.length) return false;
        this.composerReferences = next;
        return true;
    }

    protected refreshComposerReferences(text: string): void {
        if (this.syncComposerReferences(text)) this.update();
    }

    protected renderComposerReferences(): React.ReactNode {
        const references = this.composerReferences ?? [];
        if (!references.length) return undefined;
        return <div className='xora-composer-references' aria-label='已选择的技能和 MCP'>
            {references.map(reference => <span
                key={`${reference.kind}:${reference.name}`}
                className={`xora-composer-reference xora-composer-reference-${reference.kind}`}
                title={`${reference.kind === 'mcp' ? 'MCP' : '技能'} · ${reference.name}`}>
                <span className={`codicon ${reference.kind === 'mcp' ? 'codicon-server-process' : 'codicon-lightbulb'}`} aria-hidden='true' />
                <span>{reference.name}</span>
                <small>{reference.kind === 'mcp' ? 'MCP' : 'Skill'}</small>
            </span>)}
        </div>;
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
        if (this.sessionLoading) return;
        this.resetToNewSession('已切换到新的会话草稿。', true);
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
        this.resetToNewSession('项目已变化，草稿已按项目分别保留。', false, true, true);
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

    protected resetToNewSession(
        announcement: string,
        focusComposer = false,
        preserveWorkspaceRestore = false,
        runtimeBoundary = false
    ): void {
        if (!preserveWorkspaceRestore) {
            ++this.workspaceRestoreGeneration;
            this.workspaceRestorePending = false;
            this.workspaceRestorePromise = undefined;
        }
        const previousLaneKey = this.activeComposerLaneKey;
        const previousWasUnsavedNewSession = !this.model.snapshot.activeSessionId;
        this.storeActiveComposerDraft();
        if (previousWasUnsavedNewSession && previousLaneKey) {
            const previousLane = this.promptLaneState().get(previousLaneKey);
            if (!previousLane?.active && !previousLane?.queue.some(item => !item.cancelled)) {
                this.disposePromptLane(previousLaneKey);
            }
        }
        if (runtimeBoundary) this.invalidateAgentContext(announcement);
        else this.sessionLoadGeneration += 1;
        this.openPopover = undefined;
        this.newSessionLaneSequence = Number.isSafeInteger(this.newSessionLaneSequence)
            ? this.newSessionLaneSequence + 1
            : 1;
        this.newSessionModel = this.model.snapshot.selectedModel;
        this.newSessionReasoningEffort = this.preferredReasoningEffortForModel(this.newSessionModel);
        this.newOutputAvailable = false;
        this.stickToBottom = true;
        this.resetTranscriptWindow();
        this.agentPaneView = 'conversation';
        this.activityFilter = 'all';
        // AgentViewModel emits one render for the transition. Set all local
        // state first so clicking New session never schedules a duplicate
        // full-panel update.
        this.observedAgentContextKey = this.promptLaneKey(
            this.model.snapshot.workspaceRoot ?? this.roots[0] ?? '',
            this.model.snapshot.providerId,
            undefined
        );
        this.activateComposerLane(this.observedAgentContextKey);
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
        if (this.sameWorkspaceRoot(root, this.model.snapshot.workspaceRoot)
            || this.sessionLoading
            || this.hasPromptLaneWork()) return;
        try {
            await this.workspaceTrustGuard.selectWorkspaceRoot(root);
            this.activateWorkspace(this.roots, root, true);
        } catch (error) {
            this.showInlineNotice(friendlyAgentErrorMessage(error), 'error');
        } finally {
            this.update();
        }
    }

    /**
     * A visible transcript can briefly still carry its previous Provider while
     * Electron attaches a fresh ACP session for the application-wide Provider.
     * Model controls must join that existing single-flight instead of racing a
     * session/set_model request against the old ACP id.
     */
    protected async hydrateSessionForModelControl(session: SessionRecord): Promise<SessionRecord> {
        const snapshot = this.model.snapshot;
        const root = snapshot.workspaceRoot;
        const providerId = snapshot.providerId;
        if (!root || snapshot.activeSessionId !== session.appSessionId) {
            throw new Error('The application-wide model service changed while the conversation was reconnecting.');
        }
        const key = this.agentContextKey(root, providerId, session.appSessionId);
        const hydrated = await this.ensureSessionHydrated(session.appSessionId, key);
        const current = this.model.snapshot;
        if (current.phase !== 'ready'
            || current.activeSessionId !== session.appSessionId
            || current.providerId !== providerId
            || !this.sameWorkspaceRoot(current.workspaceRoot, root)
            || hydrated.providerId !== providerId) {
            throw new Error('The application-wide model service changed while the conversation was reconnecting.');
        }
        // The session event normally arrives before loadSession resolves, but
        // explicitly applying the returned authority closes the IPC ordering
        // gap for a model choice made in the same frame.
        this.model.updateSession(hydrated);
        return hydrated;
    }

    protected async selectModel(
        session: SessionRecord | undefined,
        modelId: string,
        reasoningEffort?: string
    ): Promise<void> {
        if (this.sessionLoading || this.modelSelectionLoading || this.hasPromptLaneWork()) return;
        const decoded = decodeAgentModelChoice(modelId);
        const selection = decoded ?? { providerId: this.model.snapshot.providerId, modelId };
        // Provider/credential selection belongs to Settings. A stale DOM event
        // from before another window changed the global service is ignored;
        // the composer never switches credentials itself.
        if (selection.modelId === PROVIDER_DEFAULT_MODEL_CHOICE_ID) {
            this.newSessionModel = this.model.snapshot.selectedModel;
            this.newSessionReasoningEffort = this.preferredReasoningEffortForModel(this.newSessionModel);
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
            const previousReasoningEffort = this.newSessionReasoningEffort;
            this.newSessionModel = modelId;
            this.newSessionReasoningEffort = reasoningEffort ?? this.preferredReasoningEffortForModel(modelId);
            this.modelSelectionLoading = true;
            this.update();
            try {
                await this.service.selectDefaultModel(this.model.snapshot.providerId, modelId, this.newSessionReasoningEffort);
                await this.model.refresh();
            } catch (error) {
                this.newSessionModel = previousModel;
                this.newSessionReasoningEffort = previousReasoningEffort;
                this.showInlineNotice(`无法保存默认模型：${friendlyAgentErrorMessage(error)}`, 'error');
                await this.model.refresh().catch(() => undefined);
            } finally {
                this.modelSelectionLoading = false;
                this.update();
            }
            return;
        }
        this.modelSelectionLoading = true;
        this.update();
        try {
            const hydrated = await this.hydrateSessionForModelControl(session);
            await this.service.selectModel(hydrated.appSessionId, modelId, reasoningEffort);
            await this.model.refresh();
        } catch (error) {
            this.showInlineNotice(`${reasoningEffort === undefined ? '无法切换模型' : '无法切换模型或思考等级'}：${friendlyAgentErrorMessage(error)}`, 'error');
            await this.model.refresh().catch(() => undefined);
        } finally {
            this.modelSelectionLoading = false;
            this.update();
        }
    }

    protected defaultReasoningEffortForModel(modelId: string | undefined): string | undefined {
        const options = modelId
            ? (this.model?.snapshot?.models ?? []).find(model => model.id === modelId)?.reasoningOptions ?? []
            : [];
        return options.find(option => option.default)?.value ?? options[0]?.value;
    }

    protected preferredReasoningEffortForModel(modelId: string | undefined): string | undefined {
        const options = modelId
            ? (this.model?.snapshot?.models ?? []).find(model => model.id === modelId)?.reasoningOptions ?? []
            : [];
        const preferred = this.model?.snapshot?.preferredReasoningEffort;
        // `options.length === 0` is ambiguous during a cold workspace: ACP has
        // not advertised the model catalogue yet.  Carry the durable token
        // forward and let the Electron host validate it once the runtime is
        // ready; do not overwrite it with the model's eventual default.
        if (options.length === 0) return preferred;
        return options.find(option => option.id === preferred || option.value === preferred)?.value
            ?? this.defaultReasoningEffortForModel(modelId);
    }

    /** Return only a reasoning value that the currently advertised model can
     * accept.  When the catalogue is still cold, omit the explicit request so
     * Electron can load and safely calibrate the durable preference itself. */
    protected newSessionReasoningEffortForRequest(modelId: string | undefined): string | undefined {
        const options = modelId
            ? (this.model?.snapshot?.models ?? []).find(model => model.id === modelId)?.reasoningOptions ?? []
            : [];
        if (options.length === 0) return undefined;
        return this.selectedReasoningEffort(
            options,
            this.newSessionReasoningEffort ?? this.model?.snapshot?.preferredReasoningEffort
        ) || undefined;
    }

    protected async selectReasoningEffort(
        session: SessionRecord | undefined,
        effort: string,
        options: AgentReasoningOption[]
    ): Promise<void> {
        if (this.sessionLoading || this.modelSelectionLoading || this.hasPromptLaneWork()) return;
        const resolved = options.find(option => option.id === effort || option.value === effort)?.value;
        if (!resolved) {
            this.showInlineNotice('当前模型不再提供这个思考等级，请重新选择。', 'warning');
            return;
        }
        if (!session) {
            this.newSessionReasoningEffort = resolved;
            this.modelSelectionLoading = true;
            this.update();
            try {
                const modelId = this.newSessionModel ?? this.model.snapshot.selectedModel;
                if (modelId) {
                    await this.service.selectDefaultModel(this.model.snapshot.providerId, modelId, resolved);
                    await this.model.refresh();
                }
            } catch (error) {
                this.showInlineNotice(`无法保存默认思考等级：${friendlyAgentErrorMessage(error)}`, 'error');
                await this.model.refresh().catch(() => undefined);
            } finally {
                this.modelSelectionLoading = false;
                this.update();
            }
            return;
        }
        this.modelSelectionLoading = true;
        this.update();
        try {
            const hydrated = await this.hydrateSessionForModelControl(session);
            await this.service.selectReasoningEffort(hydrated.appSessionId, resolved);
            await this.model.refresh();
        } catch (error) {
            this.showInlineNotice(`无法切换思考等级：${friendlyAgentErrorMessage(error)}`, 'error');
            await this.model.refresh().catch(() => undefined);
        } finally {
            this.modelSelectionLoading = false;
            this.update();
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
        if (this.permissionModeChanging || this.sessionLoading || this.hasPromptLaneWork()) return;
        const currentMode = this.model.snapshot.permissionMode;
        if (mode === currentMode) return;
        if (mode === 'full-access') {
            const choice = await this.messages.warn(
                '完全访问会自动批准所有项目、会话和窗口后续的兼容工具请求，并允许 Agent 读取、修改或删除当前账户有权访问的任意磁盘文件。此设置会保存到 Xora Code；操作系统权限、Grok Build 的 deny 规则、Hooks、沙箱和系统管理策略仍然生效。',
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
                ? '已启用完全访问：Agent 可以访问整块磁盘。'
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

    /**
     * Marks a transcript update for the next committed React tree. React 18's
     * concurrent root does not guarantee that the DOM is current in the next
     * animation-frame callback, which used to make scrolling target the old
     * scrollHeight and leave the newest reply below the viewport.
     */
    protected followTranscript(outputChanged = true, force = false): void {
        if (this.agentPaneView === 'changes') return;
        if (force) this.stickToBottom = true;
        this.transcriptFollowPending = true;
        this.transcriptOutputPending = this.transcriptOutputPending || outputChanged;
    }

    /** Callback refs are committed after React has updated the transcript DOM,
     * so scrollHeight is authoritative here. The inline ref in render is
     * intentionally renewed on each render to provide this commit hook. */
    protected bindTranscriptNode(node: HTMLElement | null): void {
        this.transcriptNode = node;
        if (node && this.transcriptPrependAnchor) {
            const anchor = this.transcriptPrependAnchor;
            this.transcriptPrependAnchor = undefined;
            this.transcriptHistoryRevealPending = false;
            // Keep the first previously visible row under the pointer after
            // React prepends an older page. Without this anchor, loading
            // history appears to jump to the beginning of the conversation.
            node.scrollTop = Math.max(0, node.scrollHeight - anchor.scrollHeight + anchor.scrollTop);
            this.stickToBottom = false;
            return;
        }
        if (!node || !this.transcriptFollowPending || this.agentPaneView === 'changes') return;
        this.transcriptFollowPending = false;
        const outputChanged = this.transcriptOutputPending;
        this.transcriptOutputPending = false;
        if (this.stickToBottom) {
            // A compact window can make the welcome panel slightly taller than
            // its viewport. It is not conversation output, so keep its primary
            // icon and heading visible instead of "following" an empty bottom.
            const pureEmptyState = !!this.model
                && this.model.transcript.length === 0
                && this.visiblePendingSubmissions().length === 0
                && !this.model.snapshot.message
                && !this.retryablePrompt;
            node.scrollTop = pureEmptyState ? 0 : node.scrollHeight;
            if (this.newOutputAvailable) {
                this.newOutputAvailable = false;
                this.update();
            }
        } else if (outputChanged && !this.newOutputAvailable) {
            this.newOutputAvailable = true;
            this.update();
        }
    }

    /** Runtime/auth/session snapshot changes share AgentViewModel.onDidChange
     * with real transcript output. Track a compact render signature so those
     * metadata-only updates do not raise a misleading "new message" chip. */
    protected observeTranscriptOutput(): boolean {
        const next = this.transcriptOutputSignature();
        const changed = next !== this.observedTranscriptSignature;
        this.observedTranscriptSignature = next;
        return changed;
    }

    protected transcriptOutputSignature(): string {
        const entries = this.model.transcript;
        const visibleTail = entries.slice(-MAX_RENDERED_TRANSCRIPT_ENTRIES);
        return `${this.model.snapshot.activeSessionId ?? 'new'}:${entries.length}:${visibleTail
            .map(entry => this.transcriptEntryOutputSignature(entry))
            .join('\u001f')}`;
    }

    protected transcriptEntryOutputSignature(entry: TranscriptEntry): string {
        const payload = entry.payload;
        let payloadState = payload
            ? `${payload.kind}:${this.transcriptPayloadRevision(payload)}`
            : '';
        if (payload?.kind === 'tool-call') {
            payloadState += `:${payload.status}:${payload.elapsedMs ?? ''}:${payload.title}:${this.transcriptValueSize(payload.output)}`;
        } else if (payload?.kind === 'plan') {
            payloadState += `:${payload.entries.map(item => `${item.status}:${item.text}`).join(',')}`;
        } else if (payload?.kind === 'diff') {
            payloadState += `:${payload.diffId}:${payload.oldHash}:${payload.newHash}:${payload.diff.length}`;
        } else if (payload?.kind === 'permission-request') {
            payloadState += `:${payload.requestId}`;
        }
        return `${entry.id}:${entry.kind}:${entry.text?.length ?? 0}:${entry.text?.slice(-24) ?? ''}:${entry.turnElapsedMs ?? ''}:${payloadState}`;
    }

    protected transcriptPayloadRevision(payload: object): number {
        // Some unit harnesses instantiate the widget from its prototype. Keep
        // this state lazy so the helper remains deterministic there as well.
        const revisions = this.transcriptPayloadRevisions
            ?? (this.transcriptPayloadRevisions = new WeakMap<object, number>());
        const existing = revisions.get(payload);
        if (existing !== undefined) return existing;
        const revision = this.nextTranscriptPayloadRevision ?? 1;
        this.nextTranscriptPayloadRevision = revision + 1;
        revisions.set(payload, revision);
        return revision;
    }

    protected transcriptValueSize(value: unknown): number {
        if (typeof value === 'string') return value.length;
        if (Array.isArray(value)) return value.length;
        if (value && typeof value === 'object') return Object.keys(value).length;
        return value === undefined || value === null ? 0 : String(value).length;
    }

    protected onTranscriptScroll(node: HTMLElement): void {
        if (this.agentPaneView === 'changes') return;
        if (node.scrollTop <= 8
            && (this.renderedTranscriptLimit < this.transcriptForPane(this.model.transcript).length
                || this.activeHistoryPageHasMore())
            && !this.transcriptHistoryRevealPending) {
            void this.revealEarlierTranscript(node);
            return;
        }
        const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
        this.stickToBottom = nearBottom;
        if (nearBottom && this.newOutputAvailable) {
            this.newOutputAvailable = false;
            this.update();
        }
    }

    protected activeHistoryPageHasMore(): boolean {
        const sessionId = this.model.snapshot.activeSessionId;
        return !!sessionId && !!this.sessionHistoryPageState().get(sessionId)?.hasMore;
    }

    protected async revealEarlierTranscript(node = this.transcriptNode): Promise<void> {
        if (this.transcriptHistoryRevealPending) return;
        const available = this.transcriptForPane(this.model.transcript).length;
        const activeSessionId = this.model.snapshot.activeSessionId;
        const pageState = activeSessionId
            ? this.sessionHistoryPageState().get(activeSessionId)
            : undefined;
        if (this.renderedTranscriptLimit >= available && !pageState?.hasMore) return;
        this.transcriptHistoryRevealPending = true;
        this.transcriptPrependAnchor = node
            ? { scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }
            : undefined;
        this.stickToBottom = false;
        this.transcriptFollowPending = false;
        this.transcriptOutputPending = false;
        if (this.renderedTranscriptLimit < available) {
            this.renderedTranscriptLimit = Math.min(
                available,
                this.renderedTranscriptLimit + MAX_RENDERED_TRANSCRIPT_ENTRIES
            );
            this.update();
            if (!this.transcriptPrependAnchor) this.transcriptHistoryRevealPending = false;
            return;
        }

        const session = activeSessionId
            ? this.model.snapshot.sessions.find(candidate => candidate.appSessionId === activeSessionId)
            : undefined;
        if (!session || !pageState?.before) {
            this.transcriptHistoryRevealPending = false;
            this.transcriptPrependAnchor = undefined;
            this.update();
            return;
        }
        const sessionId = session.appSessionId;
        const generation = this.sessionLoadGeneration;
        const catchup: AgentHostEvent[] = [];
        this.sessionHistoryCatchup.set(sessionId, catchup);
        try {
            const page = await this.readSessionHistoryPage(sessionId, {
                before: pageState.before,
                limit: MAX_RENDERED_TRANSCRIPT_ENTRIES
            });
            if (generation !== this.sessionLoadGeneration
                || this.model.snapshot.activeSessionId !== sessionId) return;
            const combined = this.mergeHistoryCatchup(
                [...page.events, ...pageState.events],
                catchup
            );
            this.sessionHistoryPageState().set(sessionId, {
                events: combined,
                before: page.before,
                hasMore: page.hasMore
            });
            this.cacheSessionHistory(session, combined);
            const previousLimit = this.renderedTranscriptLimit;
            this.model.showSessionHistory(session, combined);
            const nextAvailable = this.transcriptForPane(this.model.transcript).length;
            this.renderedTranscriptLimit = Math.min(
                nextAvailable,
                previousLimit + MAX_RENDERED_TRANSCRIPT_ENTRIES
            );
            this.update();
        } catch (error) {
            this.transcriptPrependAnchor = undefined;
            this.showInlineNotice(`无法加载更早记录：${friendlyAgentErrorMessage(error)}`, 'warning');
        } finally {
            if (this.sessionHistoryCatchup.get(sessionId) === catchup) {
                this.sessionHistoryCatchup.delete(sessionId);
            }
            // A successful render clears this in bindTranscriptNode after it
            // restores the visual anchor. When there was no node, or an error
            // prevented a commit, release the guard here.
            if (!this.transcriptPrependAnchor) this.transcriptHistoryRevealPending = false;
            this.update();
        }
    }

    protected resetTranscriptWindow(): void {
        this.renderedTranscriptLimit = MAX_RENDERED_TRANSCRIPT_ENTRIES;
        this.transcriptPrependAnchor = undefined;
        this.transcriptHistoryRevealPending = false;
    }

    protected scrollToBottom(): void {
        this.stickToBottom = true;
        this.newOutputAvailable = false;
        this.transcriptFollowPending = false;
        this.transcriptOutputPending = false;
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
        button.disabled = (!this.prompt.trim() && this.draftImages.length === 0)
            || !!this.composerGate(snapshot)
            || this.sessionLoading
            || this.imageReadsInFlight > 0;
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
        return this.workspaceFileCandidates(filePath)[0];
    }

    protected workspaceCandidateRoots(): string[] {
        const roots = [this.model.snapshot.workspaceRoot, ...(this.roots ?? [])]
            .filter((root): root is string => !!root);
        const unique = new Map<string, string>();
        for (const root of roots) {
            const key = filesystemPathKey(root, this.pathPlatform());
            if (key && !unique.has(key)) unique.set(key, root);
        }
        return [...unique.values()];
    }

    protected absoluteFileUri(filePath: string): URI | undefined {
        const trimmed = filePath.trim();
        if (!trimmed || /[\0\r\n]/.test(trimmed)) return undefined;
        const normalized = trimmed.replace(/\\/g, '/');
        const windowsDrivePath = /^[A-Za-z]:\//.test(normalized);
        // A Windows drive prefix looks like a URI scheme (`C:`) to the
        // generic parser. Recognise it first so packaged Windows builds can
        // still open absolute paths in full-access mode.
        if (!windowsDrivePath && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
            if (!/^file:/i.test(trimmed)) return undefined;
            try {
                const uri = new URI(trimmed).normalizePath();
                return uri.scheme === 'file' ? uri : undefined;
            } catch {
                return undefined;
            }
        }
        if (!normalized.startsWith('/') && !windowsDrivePath) return undefined;
        try {
            return FileUri.create(trimmed).normalizePath();
        } catch {
            return undefined;
        }
    }

    protected relativeFilePath(filePath: string): string | undefined {
        const trimmed = filePath.trim().replace(/\\/g, '/');
        if (!trimmed || /[\0\r\n]/.test(trimmed) || this.absoluteFileUri(trimmed)) return undefined;
        const segments: string[] = [];
        for (const segment of trimmed.split('/')) {
            if (!segment || segment === '.') continue;
            if (segment === '..') return undefined;
            segments.push(segment);
        }
        return segments.length ? segments.join('/') : undefined;
    }

    protected uriIsInWorkspace(uri: URI): boolean {
        const caseSensitive = this.pathPlatform() !== 'win32';
        return this.workspaceCandidateRoots().some(root =>
            FileUri.create(root).normalizePath().isEqualOrParent(uri.normalizePath(), caseSensitive));
    }

    protected workspaceFileCandidates(filePath: string): URI[] {
        const absolute = this.absoluteFileUri(filePath);
        if (absolute) {
            return this.uriIsInWorkspace(absolute) || this.model.snapshot.permissionMode === 'full-access'
                ? [absolute]
                : [];
        }
        const relative = this.relativeFilePath(filePath);
        if (!relative) return [];
        const caseSensitive = this.pathPlatform() !== 'win32';
        const candidates: URI[] = [];
        const seen = new Set<string>();
        for (const root of this.workspaceCandidateRoots()) {
            const rootUri = FileUri.create(root).normalizePath();
            const candidate = rootUri.resolve(relative).normalizePath();
            if (!rootUri.isEqualOrParent(candidate, caseSensitive)) continue;
            const key = candidate.toString();
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push(candidate);
            }
        }
        return candidates;
    }

    protected async resolveWorkspaceFileUri(filePath: string): Promise<URI | undefined> {
        const candidates = this.workspaceFileCandidates(filePath);
        for (const candidate of candidates) {
            try {
                if (await this.fileService.exists(candidate)) return candidate;
            } catch {
                // Continue to the suffix resolver. A provider may reject one
                // workspace root while another root is still available.
            }
        }
        const relative = this.relativeFilePath(filePath);
        const roots = this.workspaceCandidateRoots();
        if (!relative || roots.length === 0 || !this.fileSearchService?.find) return undefined;
        let results: string[];
        try {
            results = await this.fileSearchService.find(relative, {
                rootUris: roots.map(root => FileUri.create(root).toString()),
                fuzzyMatch: false,
                useGitIgnore: false,
                limit: 64
            });
        } catch {
            return undefined;
        }
        const relativeKey = filesystemPathKey(relative, this.pathPlatform()).replace(/^\/+/, '');
        const suffix = `/${relativeKey}`;
        const ranked = results.flatMap(value => {
            let uri: URI;
            try {
                uri = new URI(value).normalizePath();
            } catch {
                return [];
            }
            if (uri.scheme !== 'file' || !this.uriIsInWorkspace(uri)) return [];
            const candidateKey = filesystemPathKey(FileUri.fsPath(uri), this.pathPlatform());
            if (candidateKey !== relativeKey && !candidateKey.endsWith(suffix)) return [];
            const rootIndex = roots.findIndex(root => {
                const rootKey = filesystemPathKey(root, this.pathPlatform());
                return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}/`);
            });
            const rootKey = rootIndex < 0 ? '' : filesystemPathKey(roots[rootIndex], this.pathPlatform());
            const candidateRelative = rootKey && candidateKey.startsWith(`${rootKey}/`)
                ? candidateKey.slice(rootKey.length + 1)
                : candidateKey;
            const extraSegments = Math.max(0,
                candidateRelative.split('/').length - relativeKey.split('/').length);
            return [{ uri, rootIndex: rootIndex < 0 ? roots.length : rootIndex, extraSegments }];
        }).sort((left, right) => left.extraSegments - right.extraSegments
            || left.rootIndex - right.rootIndex
            || left.uri.toString().localeCompare(right.uri.toString()));
        if (ranked.length === 0) return undefined;
        const best = ranked[0];
        const equallyRanked = ranked.filter(candidate =>
            candidate.extraSegments === best.extraSegments && candidate.rootIndex === best.rootIndex);
        return equallyRanked.length === 1 ? best.uri : undefined;
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
            case 'cancelled': return 'codicon-circle-slash';
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
        // Tool and diff updates are commonly interleaved. Grouping only
        // adjacent tools split a single prompt into many repeated "Agent 活动"
        // cards. Build the groups once by the persisted turn key, then render
        // each group at the position of its first visible tool. Diff cards keep
        // their original order and actions below that one stable summary.
        const toolsByTurn = new Map<string, TranscriptEntry[]>();
        for (const entry of entries) {
            if (entry.kind !== 'tool') continue;
            const groupId = entry.activityTurnId ?? `entry:${entry.id}`;
            const tools = toolsByTurn.get(groupId);
            if (tools) tools.push(entry);
            else toolsByTurn.set(groupId, [entry]);
        }
        const rendered: React.ReactNode[] = [];
        const renderedTurns = new Set<string>();
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            if (entry.kind !== 'tool') {
                rendered.push(this.renderEntry(entry));
                continue;
            }
            const groupId = entry.activityTurnId ?? `entry:${entry.id}`;
            if (renderedTurns.has(groupId)) continue;
            renderedTurns.add(groupId);
            rendered.push(this.renderToolGroup(
                toolsByTurn.get(groupId) ?? [entry],
                this.agentPaneView === 'conversation',
                groupId
            ));
        }
        return rendered;
    }

    protected renderTurnProgress(
        entries: TranscriptEntry[],
        session: SessionRecord | undefined,
        lane: SessionPromptLane | undefined
    ): React.ReactNode {
        if (!session || session.status !== 'running') return undefined;
        const sessionId = session.appSessionId;
        let activeToolEntry: TranscriptEntry | undefined;
        let latestToolEntry: TranscriptEntry | undefined;
        let activePlanEntry: TranscriptEntry | undefined;
        let latestGoalCompletionEntry: TranscriptEntry | undefined;
        let lastEntry: TranscriptEntry | undefined;
        // A restored transcript can contain thousands of entries. Resolve all
        // progress hints in one backwards pass instead of allocating several
        // reversed copies on every streamed notification.
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (!entry.payload || !('sessionId' in entry.payload) || entry.payload.sessionId !== sessionId) continue;
            lastEntry ??= entry;
            if (entry.kind === 'tool' && entry.payload.kind === 'tool-call') {
                latestToolEntry ??= entry;
                if (!latestGoalCompletionEntry && isGoalCompletionRequest(entry.payload)) {
                    latestGoalCompletionEntry = entry;
                }
                if (!activeToolEntry && (entry.payload.status === 'pending' || entry.payload.status === 'running')) {
                    activeToolEntry = entry;
                }
            } else if (!activePlanEntry && entry.kind === 'plan' && entry.payload.kind === 'plan'
                && entry.payload.entries.some(item => item.status === 'in-progress')) {
                activePlanEntry = entry;
            }
        }
        const permission = [...this.model.pendingPermissions.values()].find(candidate => candidate.sessionId === sessionId);
        const activeTool = activeToolEntry?.payload?.kind === 'tool-call' ? activeToolEntry.payload : undefined;
        const latestTool = latestToolEntry?.payload?.kind === 'tool-call' ? latestToolEntry.payload : undefined;
        const activePlan = activePlanEntry?.payload?.kind === 'plan' ? activePlanEntry.payload : undefined;
        const goal = this.model.goalState(sessionId);
        const authoritativeGoalVerifying = goal?.agentTurnStatus === 'running'
            && goal.verificationStatus === 'verifying';
        const completionRequestBelongsToCurrentTurn = !!latestGoalCompletionEntry
            && !!lastEntry
            && latestGoalCompletionEntry.activityTurnId === lastEntry.activityTurnId;
        const activeToolDisplay = activeTool ? presentAgentTool(activeTool) : undefined;
        const latestToolDisplay = latestTool ? presentAgentTool(latestTool) : undefined;
        const permissionDisplay = permission ? presentAgentTool({
            title: permission.title,
            toolCallId: permission.toolCallId ?? permission.requestId,
            toolName: permission.toolName ?? 'tool',
            presentation: permission.presentation
        }) : undefined;
        const startedAt = lane?.active?.sessionId === sessionId
            ? lane.active.acceptedAt
            : Date.parse(session.updatedAt);
        let title = '正在分析任务';
        let detail = 'Agent 已接收请求，正在规划下一步';
        let icon = 'codicon-loading codicon-modifier-spin';
        let tone = 'agent';
        if (permission && permissionDisplay) {
            title = '等待你的审批';
            detail = permissionDisplay.title;
            icon = 'codicon-shield';
            tone = permissionDisplay.tone;
        } else if (activeTool && activeToolDisplay) {
            title = `正在执行：${activeToolDisplay.title}`;
            detail = activeToolDisplay.detailLabel ?? `${activeToolDisplay.badgeLabel}操作进行中`;
            icon = activeToolDisplay.iconClass;
            tone = activeToolDisplay.tone;
        } else if (activePlan) {
            const activeStep = activePlan.entries.find(item => item.status === 'in-progress');
            title = '正在推进执行计划';
            detail = activeStep?.text ?? activePlan.title ?? '正在处理下一步';
            icon = 'codicon-checklist';
            tone = 'plan';
        } else if (authoritativeGoalVerifying || completionRequestBelongsToCurrentTurn) {
            title = '正在核验完成条件';
            detail = '模型已提交结果，Grok Build 正在进行最终验收';
            icon = 'codicon-verified';
            tone = 'plan';
        } else if (lastEntry?.kind === 'assistant') {
            title = '正在生成回复';
            detail = '结果会持续显示在当前会话中';
        } else if (latestToolDisplay) {
            title = '正在继续处理';
            detail = `刚刚完成：${latestToolDisplay.title}`;
            tone = latestToolDisplay.tone;
        }
        return <aside className={`xora-live-turn tone-${tone}`} role='status' aria-live='polite'>
            <span className={`xora-live-turn-icon tone-${tone}`} aria-hidden='true'>
                <span className={`codicon ${icon}`} />
            </span>
            <span className='xora-live-turn-copy'>
                <strong>{title}</strong>
                <span title={detail}>{detail}</span>
            </span>
            <span className='xora-live-turn-time' title='从发送任务起的等待时间'>
                <span className='codicon codicon-watch' aria-hidden='true' />
                <span ref={node => this.bindLiveElapsed(node, Number.isFinite(startedAt) ? startedAt : Date.now())} aria-hidden='true' />
            </span>
        </aside>;
    }

    protected renderToolGroup(entries: TranscriptEntry[], compact = false, groupId = entries[0].id): React.ReactNode {
        const tools = entries.map(entry => entry.payload as ToolCallEvent);
        const categories = summarizeToolCategories(tools);
        const active = tools.some(tool => tool.status === 'pending' || tool.status === 'running');
        const activeTool = [...tools].reverse().find(tool => tool.status === 'pending' || tool.status === 'running');
        const featuredTool = activeTool ?? tools[tools.length - 1];
        const featuredDisplay = featuredTool ? presentAgentTool(featuredTool) : undefined;
        const activeStartedAt = this.toolStartedAtMs(activeTool);
        const failed = tools.some(tool => tool.status === 'failed' || tool.status === 'rejected');
        const status = active ? '执行中' : failed ? '有未完成项' : '已完成';
        const disclosureId = `group:${groupId}`;
        // A running edge is painted immediately. Auto-opening its potentially
        // large input/output body and auto-closing it on the next terminal
        // frame caused the whole Agent activity region to flash. The summary
        // below already exposes the live operation and elapsed time, so only
        // failures outside the compact conversation view open automatically.
        const defaultExpanded = !compact && failed;
        const expanded = this.toolDisclosureOpen(disclosureId, defaultExpanded);
        return <details
            key={`tool-group-${groupId}`}
            className='xora-activity xora-tool-group'
            open={expanded}
            onToggle={event => this.rememberToolDisclosure(disclosureId, event.currentTarget.open, defaultExpanded)}>
            <summary className='xora-activity-summary'>
                <span className='xora-tool-icon tone-group'><span className={`codicon ${active ? 'codicon-loading codicon-modifier-spin' : failed ? 'codicon-warning' : 'codicon-check-all'}`} /></span>
                <span className='xora-tool-group-copy'>
                    <span className='xora-activity-title'>Agent 活动</span>
                    <span className='xora-tool-group-current'>
                        <span className='xora-tool-category-list'>{categories.map(category => <span key={category.filter}>
                            {category.label}{category.count > 1 ? ` ${category.count}` : ''}
                        </span>)}</span>
                        {featuredDisplay ? <span className='xora-tool-group-operation' title={featuredDisplay.title}>
                            {featuredDisplay.title}
                        </span> : undefined}
                    </span>
                </span>
                <span className='xora-activity-meta'>{tools.length} 项 · {status}{activeStartedAt !== undefined ? <>
                    {' · '}<span className='xora-activity-elapsed' ref={node => this.bindLiveElapsed(node, activeStartedAt)} />
                </> : undefined}</span>
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
        const active = tool.status === 'pending' || tool.status === 'running';
        const startedAt = this.toolStartedAtMs(tool);
        const hasElapsed = active ? startedAt !== undefined : tool.elapsedMs !== undefined;
        const defaultExpanded = tool.status === 'failed' || tool.status === 'rejected';
        const expanded = this.toolDisclosureOpen(entry.id, defaultExpanded);
        return <details
            key={entry.id}
            open={expanded}
            onToggle={event => this.rememberToolDisclosure(entry.id, event.currentTarget.open, defaultExpanded)}
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
                <span className={`xora-tool-status xora-tool-status-${tool.status}`}>{toolStatusLabel(tool.status)}{hasElapsed ? <>
                    {' · '}<span className='xora-activity-elapsed' ref={node => this.bindLiveElapsed(node, startedAt, active ? undefined : tool.elapsedMs)} />
                </> : undefined}</span>
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
                {tool.output ? <pre className={terminal ? 'xora-terminal-output' : undefined}>{tool.output}</pre> : <p>{active
                    ? '正在等待工具返回结果…'
                    : '此操作未返回额外输出。'}</p>}
            </div> : undefined}
        </details>;
    }

    protected toolStartedAtMs(tool: ToolCallEvent | undefined): number | undefined {
        if (!tool?.startedAt) return undefined;
        const startedAt = Date.parse(tool.startedAt);
        return Number.isFinite(startedAt) ? startedAt : undefined;
    }

    protected toolDisclosureOpen(id: string, defaultValue: boolean): boolean {
        return this.toolDisclosure.get(id) ?? defaultValue;
    }

    protected rememberToolDisclosure(id: string, open: boolean, defaultValue: boolean): void {
        if ((this.toolDisclosure.get(id) ?? defaultValue) === open) return;
        this.toolDisclosure.set(id, open);
        this.update();
    }

    protected planApprovalCriteriaText(request: AgentPlanApprovalRequestEvent): string {
        const existing = this.planApprovalCriteria.get(request.requestId);
        if (existing !== undefined) return existing;
        const suggested = request.suggestedContract.acceptanceCriteria.length
            ? request.suggestedContract.acceptanceCriteria
            : request.suggestedContract.planEntries.map(entry => `完成：${entry.text}`);
        return suggested.join('\n');
    }

    protected async decidePlanApproval(
        request: AgentPlanApprovalRequestEvent,
        outcome: 'approved' | 'cancelled' | 'abandoned'
    ): Promise<void> {
        if (this.planApprovalDecisions.has(request.requestId)) return;
        const feedback = (this.planApprovalFeedback.get(request.requestId) ?? '').trim();
        if (outcome === 'cancelled' && !feedback) {
            this.showInlineNotice('请先填写希望 Agent 如何修改计划。', 'warning');
            return;
        }
        const criteria = this.planApprovalCriteriaText(request)
            .split(/\r?\n/)
            .map(item => item.trim().replace(/^[-*]\s+/, ''))
            .filter(Boolean);
        if (outcome === 'approved' && !criteria.length) {
            this.showInlineNotice('批准前请至少保留一条验收条件。', 'warning');
            return;
        }
        this.planApprovalDecisions.add(request.requestId);
        this.update();
        try {
            await this.model.decidePlan({
                requestId: request.requestId,
                outcome,
                ...(feedback ? { feedback } : {}),
                ...(outcome === 'approved' ? {
                    contract: {
                        objective: request.suggestedContract.objective,
                        planEntries: request.suggestedContract.planEntries,
                        acceptanceCriteria: criteria
                    }
                } : {})
            });
            const session = this.model.snapshot.sessions.find(candidate => candidate.appSessionId === request.sessionId);
            if (session) {
                const laneKey = this.promptLaneKey(session.workspaceRoot, session.providerId, session.appSessionId);
                if (outcome === 'approved') {
                    // Electron continues the approved Plan as the same native
                    // Goal. Do not turn a later, unrelated manual prompt into
                    // another Goal merely because this approval succeeded.
                    this.composerTaskModeState().delete(laneKey);
                } else if (outcome === 'abandoned') {
                    this.composerTaskModeState().set(laneKey, 'standard');
                }
            }
            this.planApprovalCriteria.delete(request.requestId);
            this.planApprovalFeedback.delete(request.requestId);
            this.followTranscript(true, true);
        } catch (error) {
            this.showInlineNotice(`无法处理计划：${friendlyAgentErrorMessage(error)}`, 'error');
        } finally {
            this.planApprovalDecisions.delete(request.requestId);
            this.update();
        }
    }

    protected renderEntry(entry: TranscriptEntry): React.ReactNode {
        if (entry.kind === 'thought') {
            const thought = entry.payload as AgentThoughtEvent;
            if (!entry.text?.trim()) return undefined;
            const streaming = entry.thoughtStreaming === true;
            const expanded = streaming || (this.thoughtDisclosure.get(entry.id) ?? false);
            const startedAtMs = thought.startedAt ? Date.parse(thought.startedAt) : undefined;
            return <details
                key={entry.id}
                className={`xora-thought${streaming ? ' is-streaming' : ''}`}
                open={expanded}
                onToggle={event => {
                    if (streaming) return;
                    const open = event.currentTarget.open;
                    if ((this.thoughtDisclosure.get(entry.id) ?? false) === open) return;
                    this.thoughtDisclosure.set(entry.id, open);
                    this.update();
                }}>
                <summary>
                    <span className={`codicon ${streaming ? 'codicon-loading codicon-modifier-spin' : 'codicon-sparkle'}`} aria-hidden='true' />
                    <span>{streaming ? '正在思考' : '思考过程'}</span>
                    <small
                        ref={node => this.bindLiveElapsed(
                            node,
                            streaming && Number.isFinite(startedAtMs) ? startedAtMs : undefined,
                            streaming ? undefined : entry.thoughtElapsedMs
                        )} />
                    <span className='codicon codicon-chevron-right xora-details-chevron' aria-hidden='true' />
                </summary>
                {expanded ? <div className='xora-thought-content'>
                    <AgentMarkdown text={entry.text} onOpenPath={this.openMarkdownPath} />
                </div> : undefined}
            </details>;
        }
        if (entry.kind === 'plan') {
            const plan = entry.payload as AgentPlanEvent;
            const completed = plan.entries.filter(item => item.status === 'completed').length;
            const active = plan.entries.some(item => item.status === 'in-progress');
            const outcome = plan.outcome === 'cancelled'
                ? ' · 已中止'
                : plan.outcome === 'failed'
                    ? ' · 已失败'
                    : plan.outcome === 'completed'
                        ? ' · 已结束'
                        : '';
            return <details key={entry.id} className='xora-activity xora-plan-card' open={active}>
                <summary className='xora-activity-summary'>
                    <span className='codicon codicon-checklist' />
                    <span className='xora-activity-title'>{plan.title ?? '执行计划'}</span>
                    <span className='xora-activity-meta'>{completed}/{plan.entries.length}{outcome}</span>
                    <span className='codicon codicon-chevron-right xora-details-chevron' />
                </summary>
                <ol className='xora-plan-list'>{plan.entries.map(item => <li key={item.id} className={`xora-plan-${item.status}`}>
                    <span className={`codicon ${this.planStatusIcon(item.status)}`} />
                    <span>{item.text}</span>
                </li>)}</ol>
            </details>;
        }
        if (entry.kind === 'plan-approval') {
            const request = entry.payload as AgentPlanApprovalRequestEvent;
            const pending = this.model.pendingPlanApprovals.has(request.requestId);
            const deciding = this.planApprovalDecisions.has(request.requestId);
            if (!pending) {
                return <article key={entry.id} className='xora-permission-history'>
                    <span className='codicon codicon-checklist' />
                    <span>执行计划 · 已处理</span>
                    <span>已响应</span>
                </article>;
            }
            return <article key={entry.id} className='xora-plan-approval-card' role='dialog' aria-label='确认执行计划'>
                <header>
                    <span className='xora-tool-icon tone-plan'><span className='codicon codicon-checklist' /></span>
                    <div>
                        <span>只读规划已完成</span>
                        <strong>确认后开始执行，并持续完成当前目标</strong>
                    </div>
                </header>
                {request.planContent ? <div className='xora-plan-approval-content'>
                    <AgentMarkdown text={request.planContent} onOpenPath={this.openMarkdownPath} />
                </div> : undefined}
                <label className='xora-plan-contract-field'>
                    <span>验收条件 <small>每行一条，可在批准前调整</small></span>
                    <textarea
                        rows={Math.min(5, Math.max(2, this.planApprovalCriteriaText(request).split(/\r?\n/).length))}
                        defaultValue={this.planApprovalCriteriaText(request)}
                        disabled={deciding}
                        onChange={event => this.planApprovalCriteria.set(request.requestId, event.currentTarget.value)} />
                </label>
                <label className='xora-plan-contract-field xora-plan-feedback-field'>
                    <span>修改意见 <small>仅“请求修改”时需要</small></span>
                    <textarea
                        rows={2}
                        placeholder='例如：先补充回归测试，再修改实现…'
                        disabled={deciding}
                        onChange={event => this.planApprovalFeedback.set(request.requestId, event.currentTarget.value)} />
                </label>
                <div className='xora-card-actions'>
                    <button className='theia-button main' disabled={deciding} onClick={() => void this.decidePlanApproval(request, 'approved')}>
                        {deciding ? '正在处理…' : '批准并持续完成'}
                    </button>
                    <button className='theia-button secondary' disabled={deciding} onClick={() => void this.decidePlanApproval(request, 'cancelled')}>请求修改</button>
                    <button className='theia-button secondary' disabled={deciding} onClick={() => void this.decidePlanApproval(request, 'abandoned')}>放弃计划</button>
                </div>
            </article>;
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
        const guidance = entry.payload?.kind === 'text-delta' && entry.payload.guidance === true;
        return <article key={entry.id} className={`xora-message xora-message-${entry.kind}${guidance ? ' xora-message-guidance' : ''}`}>
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
            {guidance ? <div className='xora-guidance-label'>
                <span className='codicon codicon-compass' aria-hidden='true' />
                已引导当前任务
            </div> : undefined}
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
            {attachments.map((attachment, index) => {
                const label = <>
                    <span className='codicon codicon-file-media' />
                    <span>{attachment.name ?? '图片'}</span>
                    <small>{this.formatByteSize(attachment.byteSize)}</small>
                </>;
                const title = `${attachment.name ?? '图片'} · ${attachment.mimeType} · ${this.formatByteSize(attachment.byteSize)}`;
                return attachment.workspacePath ? <button
                    key={`${attachment.sha256}-${index}`}
                    className='xora-message-attachment is-openable'
                    type='button'
                    title={`${title} · 打开并在侧栏定位`}
                    aria-label={`打开图片 ${attachment.name ?? attachment.workspacePath}`}
                    onClick={() => void this.openWorkspacePath(attachment.workspacePath!, { reveal: true })}>
                    {label}
                </button> : <span
                    key={`${attachment.sha256}-${index}`}
                    className='xora-message-attachment'
                    title={title}>
                    {label}
                </span>;
            })}
        </div>;
    }

    protected renderRetry(retry: RetryablePrompt): React.ReactNode {
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
                    onClick={() => this.retry(retry)}>
                    {retry.attachments.length ? `重试（含 ${retry.attachments.length} 张图片）` : '重试'}
                </button>
                <button className='theia-button secondary' onClick={() => this.dismissRetry()}>忽略</button>
            </div>
        </article>;
    }

    protected renderPendingSubmission(submission: PromptSubmission, active: boolean, queueIndex: number): React.ReactNode {
        const guiding = submission.state === 'guiding';
        const lane = this.currentPromptLane(false);
        const canGuide = !active
            && !guiding
            && submission.state === 'queued'
            && lane?.active?.state === 'running'
            && !!lane.active.sessionId
            && this.model.snapshot.capabilities?.guidePrompt === true;
        const stateLabel = guiding
            ? '正在加入当前任务'
            : active
            ? submission.state === 'running' ? '正在执行' : '正在发送'
            : `排队中${queueIndex > 0 ? ` · 前面 ${queueIndex} 条` : ''}`;
        return <article
            key={submission.id}
            className='xora-message xora-message-user xora-message-pending'
            aria-label={`任务已接收，${stateLabel}`}>
            {submission.text ? <div className='xora-message-text'>{submission.text}</div> : undefined}
            {submission.attachments.length ? <div className='xora-pending-attachment-count'>
                <span className='codicon codicon-file-media' />
                {submission.attachments.length} 张图片
            </div> : undefined}
            <div className='xora-pending-send-state' role='status'>
                <span className={`codicon ${active || guiding ? 'codicon-loading codicon-modifier-spin' : 'codicon-clock'}`} />
                <span>{stateLabel}{active ? <>
                    {' · '}<span ref={node => this.bindLiveElapsed(node, submission.acceptedAt)} />
                </> : undefined}</span>
                <span className='xora-pending-actions'>
                    {canGuide ? <button
                        type='button'
                        className='xora-pending-guide'
                        title='不打断当前任务，在下一个安全节点让 Agent 读取这条消息'
                        onClick={() => void this.guidePromptItem(submission.id)}>
                        引导当前任务
                    </button> : undefined}
                    <button
                        type='button'
                        className='xora-pending-cancel'
                        aria-label='取消这条消息'
                        disabled={guiding}
                        onClick={() => void this.cancelPromptItem(submission.id)}>
                        取消
                    </button>
                </span>
            </div>
        </article>;
    }

    protected async send(retry?: PromptSubmission): Promise<void> {
        if (this.sessionLoading || (!retry && this.imageReadsInFlight > 0)) return;
        const contextSnapshot = this.model.snapshot;
        const composerGate = this.composerGate(contextSnapshot);
        if (composerGate) {
            this.showInlineNotice(`${composerGate.message}。当前输入已作为草稿保留。`);
            return;
        }
        const lane = this.currentPromptLane(true)!;
        if (lane.queue.length + (lane.active ? 1 : 0) >= MAX_QUEUED_PROMPTS_PER_SESSION) {
            this.showInlineNotice(`当前会话最多等待 ${MAX_QUEUED_PROMPTS_PER_SESSION} 条消息，请先取消或等待一条完成。`, 'warning');
            return;
        }
        if (retry && lane.retryable !== retry) {
            this.showInlineNotice('这条重试任务已不属于当前会话。', 'warning');
            return;
        }
        const draftTextAtStart = this.prompt;
        const text = retry?.text.trim() ?? draftTextAtStart.trim();
        const draftImages = retry ? [] : [...this.draftImages];
        const attachments = retry?.attachments ?? draftImages.map(image => ({
            mimeType: image.mimeType,
            data: image.data,
            ...(image.name ? { name: image.name } : {})
        }));
        if (!text && !attachments.length) return;
        const taskMode = retry?.taskMode ?? this.currentComposerTaskMode();
        let resolveCompletion: (() => void) | undefined;
        const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
        this.promptSequence = Number.isSafeInteger(this.promptSequence) ? this.promptSequence + 1 : 1;
        const submission: PromptSubmission = {
            id: `prompt-${Date.now().toString(36)}-${this.promptSequence}`,
            text,
            contextKey: lane.key,
            generation: this.agentContextGeneration,
            workspaceRoot: lane.workspaceRoot,
            providerId: lane.providerId,
            taskMode,
            executionMode: taskMode === 'continuous' ? 'continuous' : 'standard',
            acceptedAt: Date.now(),
            sourceSessionId: lane.sourceSessionId,
            sessionId: retry?.sessionId ?? lane.sessionId,
            attachments,
            state: 'queued',
            completion,
            resolveCompletion,
            ...(!retry && draftImages.length ? { draftAttachmentIds: draftImages.map(image => image.id) } : {})
        };
        lane.retryable = undefined;
        lane.queue.push(submission);
        // Accept locally first. The user can immediately write the next queued
        // message while this lane prepares Save All/runtime work in order.
        if (!retry) {
            if (this.prompt === draftTextAtStart) {
                this.prompt = '';
                this.composerReferences = [];
            }
            if (this.textarea && this.activeComposerLaneKey === lane.key) {
                this.textarea.value = this.prompt;
                this.resizeComposer(this.textarea);
            }
            if (submission.draftAttachmentIds?.length) {
                this.consumeDraftImages(submission.draftAttachmentIds);
                this.imageAnnouncement = '图片已加入等待队列。';
            }
            this.storeActiveComposerDraft();
        }
        this.runtimePrewarmRequested = false;
        this.cancelRuntimePrewarmTimer();
        // Sending is an explicit navigation intent: paint the optimistic user
        // bubble at the bottom immediately, then keep following the reply.
        this.followTranscript(true, true);
        this.syncVisiblePromptLane();
        this.update();
        this.syncComposerSubmitButton();
        this.startPromptLane(lane);
        return completion;
    }

    protected startPromptLane(lane: SessionPromptLane): void {
        if (lane.processing) return;
        const processing = this.processPromptLane(lane).finally(() => {
            if (lane.processing === processing) lane.processing = undefined;
            if (lane.queue.some(item => !item.cancelled)) this.startPromptLane(lane);
        });
        lane.processing = processing;
    }

    protected async processPromptLane(lane: SessionPromptLane): Promise<void> {
        while (lane.queue.length) {
            const next = lane.queue[0];
            // A guidance request races the active turn by design. Never let
            // the FIFO worker also promote that row to session/prompt while
            // Electron is waiting for x.ai/interject to acknowledge it.
            if (next.state === 'guiding' && next.guidanceCompletion) {
                await next.guidanceCompletion;
                continue;
            }
            const submission = lane.queue.shift()!;
            if (submission.cancelled) {
                submission.resolveCompletion?.();
                continue;
            }
            lane.active = submission;
            submission.state = 'preparing';
            this.syncPromptLaneIfVisible(lane);
            try {
                await this.executePromptSubmission(lane, submission);
            } finally {
                submission.resolveCompletion?.();
                if (lane.active === submission) lane.active = undefined;
                this.syncPromptLaneIfVisible(lane);
            }
        }
    }

    protected async executePromptSubmission(lane: SessionPromptLane, submission: PromptSubmission): Promise<void> {
        const saveAllPromise = Promise.resolve()
            .then(() => this.commandService.executeCommand(CommonCommands.SAVE_ALL.id))
            .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        try {
            if (!this.submissionCanContinue(lane, submission)) return;
            const beforePreparation = this.model.snapshot;
            if (!beforePreparation.workspaceAttached
                || !['ready', 'auth-required'].includes(beforePreparation.phase)
                || !(this.providers ?? []).some(provider => provider.id === beforePreparation.providerId)) {
                await this.model.refresh();
                if (!this.submissionCanContinue(lane, submission)) return;
            }
            const root = await this.workspaceRoot();
            if (!root || !this.sameWorkspaceRoot(root, submission.workspaceRoot)) {
                throw new Error(root ? '项目路径已变化，当前任务未发送。' : '请先打开一个文件夹或工作区。');
            }
            const hostRoot = this.model.snapshot.workspaceRoot ?? root;
            let runtime = this.model.snapshot;
            if (!runtime.workspaceAttached) {
                await this.workspaceTrustGuard.selectWorkspaceRoot(hostRoot);
                if (!this.submissionCanContinue(lane, submission)) return;
                await this.model.refresh();
                runtime = this.model.snapshot;
            }
            const runtimeReusable = runtime.workspaceAttached
                && this.sameWorkspaceRoot(runtime.workspaceRoot, hostRoot)
                && runtime.providerId === submission.providerId
                && (runtime.phase === 'ready' || runtime.phase === 'auth-required');
            const runtimePromise = runtimeReusable
                ? Promise.resolve(runtime)
                : this.service.startRuntime({ workspaceRoot: hostRoot, providerId: submission.providerId });
            const [saveAll, preparedRuntime] = await Promise.all([saveAllPromise, runtimePromise]);
            if (!saveAll.ok) throw saveAll.error;
            if (!this.submissionCanContinue(lane, submission)) return;
            runtime = preparedRuntime;
            if (runtime.phase !== 'ready') {
                if (!await this.authenticateRuntime(runtime, () =>
                    this.isSubmissionContextCurrent(submission) && !submission.cancelled)) return;
                if (!this.submissionCanContinue(lane, submission)) return;
                runtime = this.model.snapshot;
            }
            let sessionId = lane.sessionId ?? submission.sessionId ?? submission.sourceSessionId;
            if (!sessionId) {
                const laneWasVisible = this.activeComposerLaneKey === lane.key;
                if (laneWasVisible) this.model.startNewSession();
                const modelId = this.newSessionModel ?? this.model.snapshot.selectedModel;
                const session = await this.service.createSession({
                    workspaceRoot: hostRoot,
                    providerId: submission.providerId,
                    model: modelId,
                    reasoningEffort: this.newSessionReasoningEffortForRequest(modelId),
                    title: submission.text.slice(0, 64)
                        || (submission.attachments.length === 1 ? '图片任务' : `${submission.attachments.length} 张图片`),
                    additionalDirectories: this.roots.filter(candidate => !this.sameWorkspaceRoot(candidate, hostRoot)),
                });
                if (!this.submissionCanContinue(lane, submission)) return;
                sessionId = session.appSessionId;
                submission.sessionId = sessionId;
                this.bindPromptLaneToSession(lane, session);
                if (laneWasVisible && this.activeComposerLaneKey === lane.key) this.model.setSession(session);
                else this.model.updateSession(session);
                this.rememberOpenSessionTab(sessionId);
                this.hydratedSessionKeyState().add(this.agentContextKey(hostRoot, submission.providerId, sessionId));
            } else {
                const hydrationKey = this.agentContextKey(hostRoot, submission.providerId, sessionId);
                await this.ensureSessionHydrated(sessionId, hydrationKey);
                if (!this.submissionCanContinue(lane, submission)) return;
            }
            await this.ensureSubmissionSessionMode(sessionId);
            if (!this.submissionCanContinue(lane, submission)) return;
            submission.sessionId = sessionId;
            submission.state = 'running';
            this.syncPromptLaneIfVisible(lane);
            await this.service.sendPrompt({
                sessionId,
                text: submission.text,
                executionMode: submission.executionMode,
                attachments: submission.attachments
            });
        } catch (error) {
            const cancelled = submission.cancelled
                || (submission.sessionId ? this.cancelRequested.has(submission.sessionId) : false)
                || this.isCancellationError(error);
            if (!cancelled && this.isSubmissionContextCurrent(submission)) {
                const message = friendlyAgentErrorMessage(error);
                lane.retryable = { ...submission, message };
                if (this.activeComposerLaneKey === lane.key) {
                    this.showInlineNotice(`任务发送失败：${message}`, 'error');
                }
            }
        } finally {
            if (submission.sessionId) this.cancelRequested.delete(submission.sessionId);
        }
    }

    protected submissionCanContinue(lane: SessionPromptLane, submission: PromptSubmission): boolean {
        if (submission.cancelled) return false;
        if (this.isSubmissionContextCurrent(submission)) return true;
        // A global project/Provider change must not replay the old operation,
        // but its text is still valuable. It belongs only to the lane that
        // accepted it; never write it through the global textarea after the
        // user has moved to another conversation or Provider.
        const drafts = this.composerDraftState();
        const oldDraft = drafts.get(lane.key) ?? {
            text: '',
            references: [],
            images: [],
            imageAnnouncement: ''
        };
        if (!oldDraft.text.trim()) {
            drafts.set(lane.key, { ...oldDraft, text: submission.text });
            if (this.activeComposerLaneKey === lane.key && !this.prompt.trim()) {
                this.prompt = submission.text;
                if (this.textarea) {
                    this.textarea.value = submission.text;
                    this.resizeComposer(this.textarea);
                }
            }
        } else {
            lane.retryable = { ...submission, message: '项目或模型服务已变化，请确认后重试。' };
        }
        if (this.activeComposerLaneKey === lane.key) {
            const imageHint = submission.attachments.length ? '；图片没有带入新服务，请重新添加图片' : '';
            this.showInlineNotice(`项目或模型服务已变化，任务未发送；文字草稿已保留${imageHint}。`, 'warning');
        }
        return false;
    }

    protected async ensureSubmissionSessionMode(sessionId: string): Promise<void> {
        const session = this.model.snapshot.sessions.find(candidate => candidate.appSessionId === sessionId);
        if (!session) return;
        // Releases before 0.2.4 could persist a session in Grok's optional
        // Plan mode. The composer no longer exposes that fragile mode, so the
        // next ordinary/continuous prompt returns the session to its normal
        // executable mode when Grok advertises one.
        const targetModeId = this.sessionModeIsPlan(session) ? this.sessionModeId(session, 'code') : undefined;
        if (!targetModeId || targetModeId === session.currentModeId) return;
        const updated = await this.service.setSessionMode(sessionId, targetModeId);
        this.model.updateSession(updated);
    }

    protected bindPromptLaneToSession(lane: SessionPromptLane, session: SessionRecord): void {
        const oldKey = lane.key;
        const nextKey = this.promptLaneKey(session.workspaceRoot, this.model.snapshot.providerId, session.appSessionId);
        this.promptLaneState().delete(oldKey);
        lane.key = nextKey;
        lane.sourceSessionId = session.appSessionId;
        lane.sessionId = session.appSessionId;
        for (const queued of lane.queue) queued.sessionId = session.appSessionId;
        this.promptLaneState().set(nextKey, lane);
        const draft = this.composerDraftState().get(oldKey);
        if (draft) {
            this.composerDraftState().delete(oldKey);
            this.composerDraftState().set(nextKey, draft);
        }
        const taskMode = this.composerTaskModeState().get(oldKey);
        if (taskMode) {
            this.composerTaskModeState().delete(oldKey);
            this.composerTaskModeState().set(nextKey, taskMode);
        }
        if (this.activeComposerLaneKey === oldKey) {
            this.activeComposerLaneKey = nextKey;
            this.observedAgentContextKey = nextKey;
        }
    }

    protected syncPromptLaneIfVisible(lane: SessionPromptLane): void {
        if (this.activeComposerLaneKey !== lane.key) return;
        this.syncVisiblePromptLane();
        this.update();
        this.syncComposerSubmitButton();
    }

    protected retry(retry: RetryablePrompt): void {
        const lane = this.currentPromptLane(false);
        if (!lane || lane.retryable !== retry) return;
        void this.send(retry);
    }

    protected dismissRetry(): void {
        const lane = this.currentPromptLane(false);
        if (!lane?.retryable) return;
        lane.retryable = undefined;
        this.syncVisiblePromptLane();
        this.update();
    }

    protected async guidePromptItem(promptId: string): Promise<void> {
        const lane = [...this.promptLaneState().values()]
            .find(candidate => candidate.queue.some(item => item.id === promptId));
        const submission = lane?.queue.find(item => item.id === promptId);
        if (!lane || !submission || submission.cancelled || submission.state !== 'queued') return;
        const runningSessionId = lane.active?.state === 'running' ? lane.active.sessionId : undefined;
        if (!runningSessionId) {
            if (this.activeComposerLaneKey === lane.key) {
                this.showInlineNotice('当前任务刚刚结束，这条消息会继续按队列发送。');
            }
            return;
        }

        let resolveGuidance: (() => void) | undefined;
        submission.guidanceCompletion = new Promise<void>(resolve => { resolveGuidance = resolve; });
        submission.resolveGuidance = resolveGuidance;
        submission.state = 'guiding';
        this.syncPromptLaneIfVisible(lane);
        let accepted = false;
        try {
            const result = await this.service.guidePrompt({
                sessionId: runningSessionId,
                text: submission.text,
                attachments: submission.attachments
            });
            if (result.status !== 'accepted') {
                if (this.activeComposerLaneKey === lane.key) {
                    this.showInlineNotice('当前任务刚刚结束，这条消息会继续按队列发送。');
                }
                return;
            }
            accepted = true;
            const currentIndex = lane.queue.indexOf(submission);
            if (currentIndex >= 0) lane.queue.splice(currentIndex, 1);
            submission.resolveCompletion?.();
            // The acknowledged guidance event is published by Electron main;
            // keep following the current turn without resetting its progress.
            if (this.activeComposerLaneKey === lane.key) this.followTranscript(true, true);
        } catch (error) {
            if (this.activeComposerLaneKey === lane.key) {
                const unsupported = /method not found|not supported|unknown method/i.test(
                    error instanceof Error ? error.message : String(error));
                this.showInlineNotice(unsupported
                    ? '当前 Grok Build 不支持任务引导；消息已保留在队列。'
                    : '暂时无法引导当前任务；消息已保留在队列。', 'warning');
            }
        } finally {
            // On success the row has left the FIFO; on failure it resumes its
            // original queued state and is sent normally when the turn ends.
            submission.state = 'queued';
            submission.resolveGuidance?.();
            submission.guidanceCompletion = undefined;
            submission.resolveGuidance = undefined;
            this.syncPromptLaneIfVisible(lane);
        }
    }

    protected async cancelPromptItem(promptId: string): Promise<void> {
        for (const lane of this.promptLaneState().values()) {
            const queuedIndex = lane.queue.findIndex(item => item.id === promptId);
            if (queuedIndex >= 0) {
                const [queued] = lane.queue.splice(queuedIndex, 1);
                queued.cancelled = true;
                queued.resolveCompletion?.();
                this.syncPromptLaneIfVisible(lane);
                return;
            }
            if (lane.active?.id !== promptId) continue;
            lane.active.cancelled = true;
            if (lane.active.sessionId) await this.cancel(lane.active.sessionId);
            this.syncPromptLaneIfVisible(lane);
            return;
        }
    }

    protected async cancel(sessionId: string): Promise<void> {
        if (this.cancelRequested.has(sessionId)) return;
        const lane = this.findPromptLaneBySession(sessionId);
        if (lane?.active) lane.active.cancelled = true;
        this.cancelRequested.add(sessionId);
        this.update();
        try {
            await this.service.cancel(sessionId);
        } catch (error) {
            this.cancelRequested.delete(sessionId);
            if (lane?.active) lane.active.cancelled = false;
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
        if (changedSessionId) {
            this.sessionHistoryCatchup?.get(changedSessionId)?.push(event);
            const page = this.sessionHistoryPageState().get(changedSessionId);
            if (page) page.events = this.mergeHistoryCatchup(page.events, [event]);
        }
        if (changedSessionId) this.sessionHistoryCacheState().delete(changedSessionId);
        if (event.kind === 'turn-completed' && event.stopReason === 'cancelled') {
            const lane = this.findPromptLaneBySession(event.sessionId);
            if (lane?.retryable?.sessionId === event.sessionId) lane.retryable = undefined;
            if (lane) this.syncPromptLaneIfVisible(lane);
            this.update();
            return;
        }
        const lane = 'sessionId' in event && typeof event.sessionId === 'string'
            ? this.findPromptLaneBySession(event.sessionId)
            : undefined;
        const submission = lane?.active;
        if (event.kind === 'text-delta' && event.role === 'user' && submission
            && submission.sessionId === event.sessionId) {
            submission.userEventReceived = true;
            if (lane) this.syncPromptLaneIfVisible(lane);
            return;
        }
        if (event.kind !== 'error' || !event.recoverable || !submission) return;
        if (!this.isSubmissionContextCurrent(submission)) return;
        if (event.sessionId && submission.sessionId && event.sessionId !== submission.sessionId) return;
        if ((submission.sessionId && this.cancelRequested.has(submission.sessionId))
            || this.isCancellationMessage(event.code, event.message)) return;
        lane.retryable = { ...submission, message: friendlyAgentErrorMessage(event.message) };
        this.syncPromptLaneIfVisible(lane);
    }

    protected findPromptLaneBySession(sessionId: string): SessionPromptLane | undefined {
        for (const lane of this.promptLaneState().values()) {
            if (lane.sessionId === sessionId || lane.sourceSessionId === sessionId) return lane;
        }
        return undefined;
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
        this.resetSessionRenameComposition();
        this.renamingSessionId = session.appSessionId;
        this.renameDraft = session.title || '';
        this.update();
    }

    protected beginSessionRenameComposition(): void {
        this.renameImeComposing = true;
        this.renameImeCompositionJustEnded = false;
        if (this.renameImeCompositionGuardTimer !== undefined) {
            window.clearTimeout(this.renameImeCompositionGuardTimer);
            this.renameImeCompositionGuardTimer = undefined;
        }
    }

    protected endSessionRenameComposition(value: string): void {
        this.renameDraft = value;
        this.renameImeComposing = false;
        this.renameImeCompositionJustEnded = true;
        if (this.renameImeCompositionGuardTimer !== undefined) {
            window.clearTimeout(this.renameImeCompositionGuardTimer);
        }
        this.renameImeCompositionGuardTimer = window.setTimeout(() => {
            this.renameImeCompositionJustEnded = false;
            this.renameImeCompositionGuardTimer = undefined;
        }, 0);
    }

    protected handleSessionRenameKeyDown(event: React.KeyboardEvent<HTMLInputElement>, appSessionId: string): void {
        const nativeEvent = event.nativeEvent as KeyboardEvent;
        const composing = this.renameImeComposing
            || this.renameImeCompositionJustEnded
            || nativeEvent.isComposing
            || nativeEvent.keyCode === 229;
        if (shouldCommitRenameOnEnter({
            key: event.key,
            widgetComposing: this.renameImeComposing,
            nativeComposing: nativeEvent.isComposing,
            nativeKeyCode: nativeEvent.keyCode,
            compositionJustEnded: this.renameImeCompositionJustEnded
        })) {
            event.preventDefault();
            event.stopPropagation();
            void this.commitSessionRename(appSessionId);
        } else if (event.key === 'Escape' && !composing) {
            event.preventDefault();
            event.stopPropagation();
            this.cancelSessionRename();
        }
    }

    protected cancelSessionRename(): void {
        this.renamingSessionId = undefined;
        this.renameDraft = '';
        this.resetSessionRenameComposition();
        this.update();
    }

    protected resetSessionRenameComposition(): void {
        this.renameImeComposing = false;
        this.renameImeCompositionJustEnded = false;
        if (this.renameImeCompositionGuardTimer !== undefined) {
            window.clearTimeout(this.renameImeCompositionGuardTimer);
            this.renameImeCompositionGuardTimer = undefined;
        }
    }

    protected async commitSessionRename(appSessionId: string): Promise<void> {
        if (this.renamingSessionId !== appSessionId) return;
        const title = this.renameDraft.trim();
        this.renamingSessionId = undefined;
        this.renameDraft = '';
        this.resetSessionRenameComposition();
        // Leave edit mode before crossing Electron IPC. This also makes the
        // blur triggered by unmount a harmless no-op instead of a second RPC.
        this.update();
        if (!title) {
            return;
        }
        try {
            const updated = await this.service.renameSession(appSessionId, title);
            const current = this.model.snapshot.sessions.find(session => session.appSessionId === appSessionId);
            // Session status can advance while the rename RPC is crossing IPC.
            // Never overwrite a newer running/completed record with the older
            // metadata returned by renameSession.
            const currentTimestamp = current ? Date.parse(current.updatedAt) : Number.NEGATIVE_INFINITY;
            const updatedTimestamp = Date.parse(updated.updatedAt);
            if (!current || !Number.isFinite(currentTimestamp) || !Number.isFinite(updatedTimestamp)
                || updatedTimestamp > currentTimestamp) {
                this.model.updateSession(updated);
            }
            this.rememberOpenSessionTab(appSessionId);
            this.update();
        } catch (error) {
            this.showInlineNotice(`无法重命名会话：${friendlyAgentErrorMessage(error)}`, 'error');
            this.update();
        }
    }

    protected async deleteSession(session: SessionRecord): Promise<void> {
        if (session.status === 'running' || this.sessionHasPromptLaneWork(session.appSessionId)) {
            this.showInlineNotice('请先取消或等待该会话中的任务完成，再删除会话。', 'warning');
            return;
        }
        try {
            // Direct delete — no confirmation dialog; history is local-only and the
            // action is already an explicit trash-button click in the session list.
            await this.service.deleteSession(session.appSessionId);
            this.sessionHistoryCacheState().delete(session.appSessionId);
            this.sessionHistoryPageState().delete(session.appSessionId);
            for (const key of this.hydratedSessionKeyState()) {
                if (key.endsWith(`\u0000${session.appSessionId}`)) this.hydratedSessionKeyState().delete(key);
            }
            for (const [key, lane] of [...this.promptLaneState()]) {
                if (lane.sessionId === session.appSessionId || lane.sourceSessionId === session.appSessionId) {
                    this.disposePromptLane(key);
                }
            }
            for (const key of [...this.composerDraftState().keys()]) {
                if (key.endsWith(`\u0000${session.appSessionId}`)) this.disposePromptLane(key);
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
        const uri = await this.resolveWorkspaceFileUri(filePath);
        if (!uri) {
            this.showInlineNotice(`无法定位 ${this.fileLabel(filePath)}：文件不存在、存在多个同名匹配，或不在当前访问范围内。`, 'error');
            return;
        }
        try {
            const target = options?.line && options.line > 0
                ? uri.withFragment(`L${options.line}`)
                : uri;
            await open(this.openerService, target);
            if (options?.reveal !== false && this.uriIsInWorkspace(uri)) {
                await this.commandService.executeCommand(FileNavigatorCommands.REVEAL_IN_NAVIGATOR.id, uri);
            }
        } catch (error) {
            this.showInlineNotice(`无法打开 ${this.fileLabel(filePath)}：${error instanceof Error ? error.message : String(error)}`, 'error');
        }
    }

    protected sessionHistoryCacheState(): Map<string, { updatedAt: string; events: AgentHostEvent[] }> {
        return this.sessionHistoryCache ?? (this.sessionHistoryCache = new Map());
    }

    protected sessionHistoryPageState(): Map<string, {
        events: AgentHostEvent[];
        before?: string;
        hasMore: boolean;
    }> {
        return this.sessionHistoryPages ?? (this.sessionHistoryPages = new Map());
    }

    protected async readSessionHistoryPage(
        appSessionId: string,
        request: SessionHistoryPageRequest = {}
    ): Promise<SessionHistoryPage> {
        // Browser fixtures and third-party embedders compiled against the
        // earlier RPC surface remain usable. Packaged Xora always provides the
        // paged method; the fallback simply cannot expose records older than
        // that host's bounded history response.
        const service = this.service as AgentHostService & {
            getSessionHistoryPage?: AgentHostService['getSessionHistoryPage'];
        };
        if (typeof service.getSessionHistoryPage === 'function') {
            return service.getSessionHistoryPage(appSessionId, request);
        }
        return { events: await service.getSessionHistory(appSessionId), hasMore: false };
    }

    /** Merge events which crossed IPC during the local history read. Backend
     * delivery precedes JSONL append, so a caught event may or may not already
     * be present in the returned tail. Exact tail multiset matching preserves
     * order without duplicating either case. */
    protected mergeHistoryCatchup(history: AgentHostEvent[], caught: AgentHostEvent[]): AgentHostEvent[] {
        if (!caught.length) return history;
        const tailSize = Math.max(64, caught.length * 4);
        const fingerprints = new Map<string, number>();
        for (const event of history.slice(-tailSize)) {
            const fingerprint = JSON.stringify(event);
            fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
        }
        const missing: AgentHostEvent[] = [];
        for (const event of caught) {
            const fingerprint = JSON.stringify(event);
            const count = fingerprints.get(fingerprint) ?? 0;
            if (count > 0) fingerprints.set(fingerprint, count - 1);
            else missing.push(event);
        }
        return missing.length ? [...history, ...missing] : history;
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
        const openingSnapshot = this.model.snapshot;
        const visibleHydrationKey = openingSnapshot.workspaceRoot
            ? this.agentContextKey(
                openingSnapshot.workspaceRoot,
                openingSnapshot.providerId,
                session.appSessionId
            )
            : undefined;
        if (openingSnapshot.phase === 'ready'
            && openingSnapshot.activeSessionId === session.appSessionId
            && !this.sessionLoading
            && visibleHydrationKey
            && this.hydratedSessionKeyState().has(visibleHydrationKey)) {
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
        this.storeActiveComposerDraft();
        const generation = ++this.sessionLoadGeneration;
        this.openPopover = undefined;
        this.sessionLoading = true;
        this.resetTranscriptWindow();
        const cachedHistory = this.cachedSessionHistory(session);
        // Select the requested conversation synchronously. This immediately
        // removes the previous transcript; cached local content can paint in
        // the same browser frame and a first-time disk read fills it next.
        this.observedAgentContextKey = targetContextKey;
        this.activateComposerLane(targetContextKey);
        this.model.showSessionHistory(session, cachedHistory ?? []);
        if (cachedHistory && !this.sessionHistoryPageState().has(session.appSessionId)) {
            this.sessionHistoryPageState().set(session.appSessionId, {
                events: cachedHistory,
                hasMore: false
            });
        }
        this.stickToBottom = true;
        this.followTranscript();
        this.update();
        try {
            if (!cachedHistory) {
                const catchup: AgentHostEvent[] = [];
                this.sessionHistoryCatchup.set(session.appSessionId, catchup);
                try {
                    const page = await this.readSessionHistoryPage(session.appSessionId, {
                        limit: MAX_RENDERED_TRANSCRIPT_ENTRIES
                    });
                    if (generation !== this.sessionLoadGeneration || this.imageDraftContextKey() !== targetContextKey) return;
                    const completeHistory = this.mergeHistoryCatchup(page.events, catchup);
                    this.sessionHistoryPageState().set(session.appSessionId, {
                        events: completeHistory,
                        before: page.before,
                        hasMore: page.hasMore
                    });
                    this.cacheSessionHistory(session, completeHistory);
                    this.model.showSessionHistory(session, completeHistory);
                    this.stickToBottom = true;
                    this.followTranscript();
                } finally {
                    if (this.sessionHistoryCatchup.get(session.appSessionId) === catchup) {
                        this.sessionHistoryCatchup.delete(session.appSessionId);
                    }
                }
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
        if (contextIsCurrent && !contextIsCurrent()) return false;
        let flight = this.runtimeAuthenticationInFlight;
        if (!flight || flight.providerId !== runtime.providerId) {
            const promise = this.authenticateRuntimeOnce(runtime);
            flight = { providerId: runtime.providerId, promise };
            this.runtimeAuthenticationInFlight = flight;
            const clear = (): void => {
                if (this.runtimeAuthenticationInFlight?.promise === promise) {
                    this.runtimeAuthenticationInFlight = undefined;
                }
            };
            void promise.then(clear, clear);
        }
        const authenticated = await flight.promise;
        return authenticated && (!contextIsCurrent || contextIsCurrent());
    }

    protected async authenticateRuntimeOnce(runtime: RuntimeSnapshot): Promise<boolean> {
        const provider = this.providers.find(candidate => candidate.id === runtime.providerId);
        const methodId = provider?.kind === 'grok-subscription'
            ? runtime.capabilities?.authMethods.find(method => method.id !== 'xai.api_key'
                && method.id === runtime.capabilities?.defaultAuthMethodId)?.id
                ?? runtime.capabilities?.authMethods.find(method => method.id === 'grok.com')?.id
            : runtime.capabilities?.authMethods.find(method => method.id === 'xai.api_key')?.id
                ?? runtime.capabilities?.defaultAuthMethodId
                ?? runtime.capabilities?.authMethods[0]?.id;
        if (!methodId) throw new Error('Grok Build 未提供兼容的认证方式。');
        const result = await this.service.authenticate(methodId);
        if (result.status === 'authenticated') return true;
        const warning = provider?.kind === 'grok-subscription'
            ? '首次使用当前 Grok 订阅需要确认。登录或切换账号会共用 ~/.grok，并影响外部 Grok CLI 和其他 Xora Code 窗口；相同配置后续不再提示。'
            : provider?.kind === 'xai-api-key'
                ? provider.model
                    ? `是否允许 Agent 使用已加密保存的凭据连接 ${provider.baseUrl ?? '当前 API 服务'}？相同配置后续不再提示。`
                    : '首次恢复旧版 API 服务需要确认。建议在设置中迁移到自定义模型服务；相同配置后续不再提示。'
                : `是否使用“${provider?.name ?? '当前服务'}”已配置的凭据继续？只有当前服务的凭据会注入 Agent 进程，相同配置后续不再提示。`;
        const choice = await this.messages.warn(warning, '继续');
        if (choice !== '继续') return false;
        const confirmed = await this.service.authenticate(methodId, true);
        return confirmed.status === 'authenticated';
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
        const refresh = (this.providerRefreshTail ?? Promise.resolve()).then(async (): Promise<void> => {
            try {
                this.providers = await this.service.listProviders();
                this.requestRuntimePrewarm(true);
                this.update();
            } catch (error) {
                this.showInlineNotice(`无法加载模型服务：${friendlyAgentErrorMessage(error)}`, 'error');
            }
        });
        // `refresh` handles its own read error, so this tail always remains a
        // usable queue for the next revision.
        this.providerRefreshTail = refresh;
        return refresh;
    }

    protected async refreshRoots(): Promise<void> {
        const roots = await this.workspaceService.roots;
        this.activateWorkspace(roots.map(root => FileUri.fsPath(root.resource)));
    }

    protected async openDiff(diff: DiffEvent): Promise<void> {
        const after = diff.newPath
            ? new URI(VSCodeURI.file(diff.newPath))
            : await this.resolveWorkspaceFileUri(diff.path);
        if (!diff.oldPath || !after) {
            this.showInlineNotice('无法查看差异：原始文件快照已不可用。', 'error');
            return;
        }
        const before = new URI(VSCodeURI.file(diff.oldPath));
        try {
            await this.diffService.openDiffEditor(before, after, `${this.fileLabel(diff.path)}（Agent 修改）`);
        } catch (error) {
            this.showInlineNotice(`无法查看 ${this.fileLabel(diff.path)} 的差异：${error instanceof Error ? error.message : String(error)}`, 'error');
        }
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
