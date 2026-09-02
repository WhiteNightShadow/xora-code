import { Emitter, Event } from '@theia/core/lib/common';
import { Path } from '@theia/core/lib/common/path';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    AgentAttachmentSummary,
    DiffEvent,
    AgentGoalStateEvent,
    AgentHostEvent,
    AgentHostService,
    AgentPlanApprovalRequestEvent,
    AgentTaskContractEvent,
    PermissionDecision,
    PermissionRequestEvent,
    PlanApprovalDecision,
    RuntimeSnapshot,
    SessionRecord,
    ToolCallEvent
} from '../common/agent-protocol';
import { AgentHostClientImpl } from './agent-client';
import { isMachineToolTitle } from './agent-display-helpers';
import { friendlyAgentErrorMessage } from './agent-error-labels';

export interface TranscriptEntry {
    id: string;
    kind: 'user' | 'assistant' | 'system' | 'thought' | 'plan' | 'plan-approval' | 'tool' | 'permission' | 'diff' | 'error';
    text?: string;
    payload?: AgentHostEvent;
    /** Stable grouping key for every visible event produced by one prompt. */
    activityTurnId?: string;
    /** Completion metadata attached to the final Agent reply for this turn. */
    turnElapsedMs?: number;
    turnStopReason?: string;
    /** Thought streams remain expanded only while the provider is producing them. */
    thoughtStreaming?: boolean;
    thoughtElapsedMs?: number;
}

@injectable()
export class AgentViewModel {
    @inject(AgentHostService)
    protected readonly service!: AgentHostService;

    @inject(AgentHostClientImpl)
    protected readonly client!: AgentHostClientImpl;

    protected readonly changeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.changeEmitter.event;

    /**
     * ACP can deliver many text and tool updates between two browser paints.
     * Keep their state reduction synchronous, but publish at most one renderer
     * notification per frame. The token also makes the Promise fallback used
     * by Node tests cancellable without depending on browser globals.
     */
    protected pendingChangeNotification: object | undefined;
    protected pendingChangeFrame: number | undefined;

    snapshot: RuntimeSnapshot = {
        phase: 'stopped',
        workspaceAttached: false,
        workspaceTrusted: false,
        providerId: 'grok-subscription',
        grokSubscriptionAuthStatus: 'unknown',
        models: [],
        sessions: [],
        permissionMode: 'request-approval'
    };
    transcript: TranscriptEntry[] = [];
    protected readonly toolEntries = new Map<string, TranscriptEntry>();
    protected readonly diffEntries = new Map<string, TranscriptEntry>();
    protected readonly thoughtEntries = new Map<string, TranscriptEntry>();
    /** Latest persisted native Goal projection for each conversation. Goal
     * state is task metadata, not another chat message. */
    protected readonly goalStates = new Map<string, AgentGoalStateEvent>();
    /** User-approved Plan contracts are kept separately from conversation
     * text so restoring them never creates a synthetic user bubble. */
    protected readonly taskContracts = new Map<string, AgentTaskContractEvent>();
    /** Suppresses a stale, unchanged plan snapshot after its turn was
     * cancelled. Grok may repeat the last session plan at the start of the
     * next prompt; it becomes visible again only when its structure or
     * completed progress changes, or an item actually resumes. */
    protected readonly cancelledPlanSignatures = new Map<string, Map<string, number>>();
    /**
     * Histories created before turn IDs were persisted are reconstructed from
     * their user/turn-completed boundaries. Ordinals are reset for each replay,
     * which keeps the derived keys deterministic across session switches.
     */
    protected readonly legacyActivityTurnIds = new Map<string, string>();
    protected readonly legacyActivityTurnOrdinals = new Map<string, number>();
    pendingPermissions = new Map<string, PermissionRequestEvent>();
    pendingPlanApprovals = new Map<string, AgentPlanApprovalRequestEvent>();
    /**
     * `undefined` follows the backend's initial selection, `null` represents a
     * user-selected new session, and a string pins the visible conversation.
     * Keeping this separate from runtime snapshots prevents late status and
     * restore events from stealing the user's current selection.
     */
    protected selectedSessionOverride: string | null | undefined;
    /** Last Electron-host sequence applied across event and RPC channels. */
    protected appliedSnapshotRevision = -1;
    /**
     * A `session/new` RPC result can cross the event channel before the
     * snapshot emitted by the same Electron transaction. Only those freshly
     * created records may be carried across a snapshot which does not contain
     * them yet. The protection ends as soon as one authoritative snapshot
     * advertises the id.
     */
    protected readonly unconfirmedCreatedSessions = new Set<string>();
    /**
     * Exact Electron revision which already contained the locally-created
     * record. Any missing snapshot at or below this fence predates creation;
     * a higher missing revision is an authoritative deletion. Undefined is
     * retained only for compatibility with pre-fence hosts.
     */
    protected readonly unconfirmedSessionAuthorityRevisions = new Map<string, number | undefined>();
    /** Bounded fallback used only with an older host that cannot return the
     * exact create authority revision. Packaged v0.2.6 never takes this path. */
    protected readonly legacyUnconfirmedOmissionRevisions = new Map<string, number>();
    /** Last authoritative snapshot revision which contained each session. */
    protected readonly sessionAuthorityRevisions = new Map<string, number>();
    /** Rejects late snapshots/RPC completions after Electron has explicitly
     * reported that a local session no longer exists. Session ids are UUIDs
     * and cannot be legitimately reused except by a new session/create result. */
    protected readonly missingSessionTombstones = new Set<string>();

    @postConstruct()
    protected init(): void {
        this.client.onEvent(event => this.accept(event));
        void this.refresh();
    }

    async refresh(): Promise<void> {
        this.applySnapshot(await this.service.getSnapshot());
        this.notifyChangeImmediately();
    }

    protected accept(event: AgentHostEvent, notify = true): void {
        if (event.kind === 'session' && this.missingSessionTombstones.has(event.session.appSessionId)) return;
        if (event.kind !== 'snapshot'
            && 'sessionId' in event
            && typeof event.sessionId === 'string'
            && this.missingSessionTombstones.has(event.sessionId)) return;
        let liveActivityStarted = false;
        if (event.kind === 'snapshot') {
            this.applySnapshot(event.snapshot);
            if (event.snapshot.phase === 'crashed') {
                this.clearPendingPermissions();
                this.clearPendingPlanApprovals();
            }
        } else if (event.kind === 'session') {
            this.upsertSession(event.session);
            if (['completed', 'cancelled', 'failed', 'read-only'].includes(event.session.status)) {
                this.finalizeSessionActivity(event.session.appSessionId, event.session.status);
                this.clearPendingPermissions(event.session.appSessionId);
                this.clearPendingPlanApprovals(event.session.appSessionId);
            }
        } else if (event.kind === 'thought-delta') {
            if (!this.isVisibleSession(event.sessionId)) return;
            const key = `${event.sessionId}:${event.thoughtId}`;
            const existing = this.thoughtEntries.get(key);
            if (existing) {
                existing.text = `${existing.text ?? ''}${event.text}`;
                existing.payload = event;
                existing.thoughtStreaming = !event.completed;
                if (event.elapsedMs !== undefined) existing.thoughtElapsedMs = Math.round(event.elapsedMs);
            } else {
                const entry: TranscriptEntry = {
                    id: key,
                    kind: 'thought',
                    text: event.text,
                    payload: event,
                    activityTurnId: this.activityTurnId(event),
                    thoughtStreaming: !event.completed,
                    ...(event.elapsedMs !== undefined ? { thoughtElapsedMs: Math.round(event.elapsedMs) } : {})
                };
                this.transcript.push(entry);
                this.thoughtEntries.set(key, entry);
            }
        } else if (event.kind === 'text-delta') {
            if (!this.isVisibleSession(event.sessionId)) return;
            if (event.role === 'assistant') this.finishThoughtsForTurn(event.sessionId, event.turnId);
            // Older builds persisted protocol-extension diagnostics into the
            // user conversation. Keep those legacy records out of the chat;
            // unknown ACP extensions are compatibility details, not messages.
            if (event.role === 'system' && event.text.startsWith('Ignored compatible ACP extension:')) return;
            const activityTurnId = event.role === 'user' && !event.turnId
                ? this.startLegacyActivityTurn(event.sessionId)
                : this.activityTurnId(event);
            const last = this.transcript[this.transcript.length - 1];
            const lastHasAttachments = last?.payload?.kind === 'text-delta'
                && Boolean(last.payload.attachments?.length);
            const lastIsGuidance = last?.payload?.kind === 'text-delta' && last.payload.guidance === true;
            const eventHasAttachments = Boolean(event.attachments?.length);
            if (!event.guidance
                && !lastIsGuidance
                && !eventHasAttachments
                && !lastHasAttachments
                && last?.kind === event.role
                && last.payload
                && 'sessionId' in last.payload
                && last.payload.sessionId === event.sessionId
                && last.activityTurnId === activityTurnId) {
                last.text = `${last.text ?? ''}${event.text}`;
            } else {
                this.transcript.push({
                    id: this.id('text'),
                    kind: event.role,
                    text: event.text,
                    payload: event,
                    activityTurnId
                });
            }
        } else if (event.kind === 'permission-request') {
            // Permission prompts must surface even for background multi-session
            // tabs; otherwise a concurrent turn can stall forever.
            this.pendingPermissions.set(event.requestId, event);
            if (this.isVisibleSession(event.sessionId)) {
                this.transcript.push({
                    id: event.requestId,
                    kind: 'permission',
                    payload: event,
                    activityTurnId: this.activityTurnId(event)
                });
            }
        } else if (event.kind === 'plan-approval-request') {
            // Like tool permissions, Plan approval can block a background
            // session and therefore remains globally reachable from the dock.
            this.pendingPlanApprovals.set(event.requestId, event);
            if (this.isVisibleSession(event.sessionId)) {
                this.transcript.push({
                    id: event.requestId,
                    kind: 'plan-approval',
                    payload: event,
                    activityTurnId: this.activityTurnId(event)
                });
            }
        } else if (event.kind === 'tool-call') {
            if (!this.isVisibleSession(event.sessionId)) return;
            liveActivityStarted = this.upsertTool(event);
        } else if (event.kind === 'plan') {
            if (!this.isVisibleSession(event.sessionId)) return;
            liveActivityStarted = this.upsertPlan(event);
        } else if (event.kind === 'goal-state') {
            const previous = this.goalStates.get(event.sessionId);
            this.goalStates.set(event.sessionId, event);
            if (this.goalState(event.sessionId) === event && event.verificationStatus === 'verified') {
                this.finalizeVerifiedSessionPlan(event.sessionId, event.turnId);
                const planTurnId = this.taskContract(event.sessionId)?.turnId;
                if (planTurnId && planTurnId !== event.turnId) {
                    this.finalizeVerifiedSessionPlan(event.sessionId, planTurnId);
                }
            }
            liveActivityStarted = previous?.verificationStatus !== 'verifying'
                && event.verificationStatus === 'verifying';
        } else if (event.kind === 'task-contract') {
            this.taskContracts.set(event.sessionId, event);
        } else if (event.kind === 'supervision-shadow') {
            // Persisted for local evaluation only. Shadow eligibility neither
            // changes behavior nor appears in the product UI.
            return;
        } else if (event.kind === 'diff') {
            if (!this.isVisibleSession(event.sessionId)) return;
            this.upsertDiff(event);
        } else if (event.kind === 'context-usage') {
            if (!this.isVisibleSession(event.sessionId)) return;
            this.snapshot.sessionContexts = {
                ...(this.snapshot.sessionContexts ?? {}),
                [event.sessionId]: event.context
            };
        } else if (event.kind === 'turn-completed') {
            this.finishThoughtsForTurn(event.sessionId, event.turnId);
            const activityTurnId = this.activityTurnId(event);
            const outcome = event.stopReason === 'cancelled'
                ? 'cancelled' : event.stopReason === 'error' ? 'failed' : 'completed';
            this.finalizeSessionActivity(
                event.sessionId,
                outcome,
                activityTurnId,
                this.planFinalizationMode(event.sessionId)
            );
            const contract = this.taskContract(event.sessionId);
            if (contract?.turnId
                && contract.turnId !== event.turnId
                && (contract.lifecycle === 'verified' || contract.lifecycle === 'interrupted')) {
                this.finalizeSessionPlans(event.sessionId, outcome, contract.turnId);
            }
            if (this.isVisibleSession(event.sessionId) && Number.isFinite(event.elapsedMs) && (event.elapsedMs ?? -1) >= 0) {
                const finalReply = [...this.transcript].reverse().find(entry =>
                    entry.kind === 'assistant'
                    && entry.payload?.kind === 'text-delta'
                    && entry.payload.sessionId === event.sessionId
                    && entry.activityTurnId === activityTurnId
                    && entry.turnElapsedMs === undefined
                );
                if (finalReply) {
                    finalReply.turnElapsedMs = Math.round(event.elapsedMs!);
                    finalReply.turnStopReason = event.stopReason;
                }
            }
            this.finishLegacyActivityTurn(event.sessionId);
            this.clearPendingPermissions(event.sessionId);
            this.clearPendingPlanApprovals(event.sessionId);
        } else if (event.kind === 'error') {
            if (event.sessionId && !this.isVisibleSession(event.sessionId)) return;
            this.transcript.push({
                id: this.id('error'),
                kind: 'error',
                text: friendlyAgentErrorMessage(event.message),
                payload: event,
                ...(event.sessionId ? { activityTurnId: this.activityTurnId({
                    sessionId: event.sessionId,
                    turnId: event.turnId
                }) } : {})
            });
            if (event.code === 'SIDECAR_CRASHED') {
                this.clearPendingPermissions();
                this.clearPendingPlanApprovals();
            }
        }
        if (notify) {
            if (liveActivityStarted) {
                // A new running operation is a user-visible lifecycle edge,
                // not output noise. Publish it immediately; subsequent text,
                // parameter and terminal updates can stay frame-batched.
                this.notifyChangeImmediately();
            } else if (isFrameBatchedEvent(event)) {
                this.scheduleChangeNotification();
            } else {
                this.notifyChangeImmediately();
            }
        }
    }

    protected scheduleChangeNotification(): void {
        if (this.pendingChangeNotification) return;
        const token = {};
        this.pendingChangeNotification = token;
        const notify = (): void => {
            if (this.pendingChangeNotification !== token) return;
            this.pendingChangeNotification = undefined;
            this.pendingChangeFrame = undefined;
            this.changeEmitter.fire();
        };
        const frame = this.requestChangeFrame(notify);
        if (frame !== undefined) {
            this.pendingChangeFrame = frame;
        } else {
            // Browser-less consumers still coalesce synchronous bursts while
            // preserving deterministic notification order in Node tests.
            void Promise.resolve().then(notify);
        }
    }

    protected notifyChangeImmediately(): void {
        this.cancelScheduledChangeNotification();
        this.changeEmitter.fire();
    }

    protected cancelScheduledChangeNotification(): void {
        if (!this.pendingChangeNotification) return;
        this.pendingChangeNotification = undefined;
        if (this.pendingChangeFrame !== undefined) {
            this.cancelChangeFrame(this.pendingChangeFrame);
            this.pendingChangeFrame = undefined;
        }
    }

    protected requestChangeFrame(callback: FrameRequestCallback): number | undefined {
        return typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame(callback)
            : undefined;
    }

    protected cancelChangeFrame(frame: number): void {
        if (typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(frame);
        }
    }

    protected upsertTool(event: ToolCallEvent): boolean {
        const activityTurnId = this.activityTurnId(event);
        const key = this.toolEntryKey(event.sessionId, event.toolCallId, activityTurnId);
        const existing = this.toolEntries.get(key);
        if (existing) {
            const previous = existing.payload?.kind === 'tool-call' ? existing.payload : undefined;
            if (!previous) {
                existing.payload = event;
                return isActiveToolStatus(event.status);
            }
            const previouslyActive = isActiveToolStatus(previous.status);
            const toolKind = (!event.toolKind || event.toolKind === 'other') && previous.toolKind && previous.toolKind !== 'other'
                ? previous.toolKind
                : event.toolKind;
            const toolNamespace = event.toolNamespace ?? previous.toolNamespace;
            const presentation = mergeToolPresentation(previous.presentation, event.presentation);
            const locations = event.locations ?? previous.locations;
            const status = monotonicToolStatus(previous.status, event.status);
            const startedAt = event.startedAt ?? previous.startedAt;
            const elapsedMs = this.resolveToolElapsedMs(status, startedAt, event.elapsedMs ?? previous.elapsedMs);
            existing.payload = {
                ...previous,
                ...event,
                status,
                title: isMachineToolTitle(event.title, event.toolCallId)
                    && !isMachineToolTitle(previous.title, previous.toolCallId)
                    ? previous.title
                    : event.title,
                toolName: event.toolName === 'tool' && previous.toolName !== 'tool'
                    ? previous.toolName
                    : event.toolName,
                ...(toolKind ? { toolKind } : {}),
                ...(toolNamespace ? { toolNamespace } : {}),
                ...(presentation ? { presentation } : {}),
                ...(locations ? { locations } : {}),
                ...(startedAt ? { startedAt } : {}),
                ...(elapsedMs !== undefined ? { elapsedMs } : {}),
                input: event.input ?? previous.input,
                output: event.output ?? previous.output
            };
            const next = existing.payload as ToolCallEvent;
            return !previouslyActive && isActiveToolStatus(next.status);
        } else {
            const elapsedMs = this.resolveToolElapsedMs(event.status, event.startedAt, event.elapsedMs);
            const normalized = elapsedMs === undefined ? event : { ...event, elapsedMs };
            const entry: TranscriptEntry = { id: key, kind: 'tool', payload: normalized, activityTurnId };
            this.transcript.push(entry);
            this.toolEntries.set(key, entry);
            return isActiveToolStatus(event.status);
        }
    }

    protected resolveToolElapsedMs(
        status: ToolCallEvent['status'],
        startedAt: string | undefined,
        elapsedMs: number | undefined
    ): number | undefined {
        if (Number.isFinite(elapsedMs) && (elapsedMs ?? -1) >= 0) return Math.round(elapsedMs!);
        if (!isTerminalToolStatus(status) || !startedAt) return undefined;
        const startedAtMs = Date.parse(startedAt);
        return Number.isFinite(startedAtMs) ? Math.max(0, Math.round(this.now() - startedAtMs)) : undefined;
    }

    /** Test seam for deterministic lifecycle durations. */
    protected now(): number {
        return Date.now();
    }

    /**
     * ACP implementations occasionally omit a terminal tool update, or send
     * a content-only update after completion. A terminal turn/session is the
     * final authority that no pending activity remains visible.
     */
    protected finalizeSessionActivity(
        sessionId: string,
        outcome: SessionRecord['status'],
        activityTurnId?: string,
        planMode: 'terminal' | 'proposal' | 'preserve' = this.planFinalizationMode(sessionId)
    ): void {
        const terminalToolStatus: ToolCallEvent['status'] = outcome === 'completed'
            ? 'completed'
            : outcome === 'cancelled' || outcome === 'read-only'
                ? 'rejected'
                : 'failed';
        for (const entry of this.toolEntries.values()) {
            const tool = entry.payload?.kind === 'tool-call' ? entry.payload : undefined;
            if (!tool
                || tool.sessionId !== sessionId
                || (activityTurnId !== undefined && entry.activityTurnId !== activityTurnId)
                || !['pending', 'running'].includes(tool.status)) continue;
            const elapsedMs = this.resolveToolElapsedMs(terminalToolStatus, tool.startedAt, tool.elapsedMs);
            entry.payload = {
                ...tool,
                status: terminalToolStatus,
                ...(elapsedMs !== undefined ? { elapsedMs } : {})
            };
        }
        if (planMode === 'preserve') return;
        if (planMode === 'proposal') {
            for (const entry of this.transcript) {
                const plan = entry.payload?.kind === 'plan' ? entry.payload : undefined;
                if (!plan
                    || plan.sessionId !== sessionId
                    || (activityTurnId !== undefined && entry.activityTurnId !== activityTurnId)) continue;
                entry.payload = {
                    ...plan,
                    outcome: undefined,
                    entries: plan.entries.map(item => item.status === 'in-progress'
                        ? { ...item, status: 'pending' as const }
                        : item)
                };
            }
            return;
        }
        this.finalizeSessionPlans(sessionId, outcome, activityTurnId);
    }

    protected finalizeSessionPlans(sessionId: string, outcome: SessionRecord['status'], turnId?: string): void {
        const activityTurnId = turnId?.startsWith('activity:')
            ? turnId
            : turnId ? `activity:${sessionId}:${turnId}` : undefined;
        for (const entry of this.transcript) {
            const plan = entry.payload?.kind === 'plan' ? entry.payload : undefined;
            if (!plan
                || plan.sessionId !== sessionId
                || (activityTurnId !== undefined && entry.activityTurnId !== activityTurnId)
                || !plan.entries.some(item => item.status === 'pending' || item.status === 'in-progress')) continue;
            const planOutcome = outcome === 'completed'
                ? 'completed' as const
                : outcome === 'cancelled' || outcome === 'read-only'
                    ? 'cancelled' as const
                    : 'failed' as const;
            if (planOutcome === 'cancelled') this.rememberCancelledPlan(plan);
            entry.payload = {
                ...plan,
                outcome: planOutcome,
                entries: plan.entries.map(item => item.status === 'in-progress'
                    || item.status === 'pending'
                    ? {
                        ...item,
                        status: planOutcome === 'completed' && item.status === 'pending'
                            ? 'pending' as const
                            : planOutcome
                    }
                    : item)
            };
        }
    }

    /** Native Goal verification is stronger than an ordinary end_turn. Every
     * frozen step in the approved Plan has passed Xora's acceptance contract,
     * so the original Plan card may settle completely even when the Goal turn
     * has a different turn id after session/load. */
    protected finalizeVerifiedSessionPlan(sessionId: string, turnId?: string): void {
        const activityTurnId = turnId?.startsWith('activity:')
            ? turnId
            : turnId ? `activity:${sessionId}:${turnId}` : undefined;
        for (const entry of this.transcript) {
            const plan = entry.payload?.kind === 'plan' ? entry.payload : undefined;
            if (!plan
                || plan.sessionId !== sessionId
                || (activityTurnId !== undefined && entry.activityTurnId !== activityTurnId)) continue;
            entry.payload = {
                ...plan,
                outcome: 'completed',
                entries: plan.entries.map(item => item.status === 'pending' || item.status === 'in-progress'
                    ? { ...item, status: 'completed' as const }
                    : item)
            };
        }
    }

    protected planFinalizationMode(sessionId: string): 'terminal' | 'proposal' | 'preserve' {
        const contract = this.taskContract(sessionId);
        // A frozen contract is terminal once Xora has either verified it or
        // interrupted it. Restoring an idle/failed Plan-mode session must not
        // reinterpret that durable outcome as a fresh read-only proposal.
        if (contract?.lifecycle === 'verified' || contract?.lifecycle === 'interrupted') return 'terminal';
        const goal = this.goalState(sessionId);
        if (goal && goal.status !== 'cleared'
            && !(goal.status === 'complete' && goal.verificationStatus === 'verified')) return 'preserve';
        const session = this.snapshot.sessions.find(candidate => candidate.appSessionId === sessionId);
        // Between approving x.ai/exit_plan_mode and receiving the first native
        // goal_updated there is intentionally no synthetic Goal. The durable
        // contract is the authority for this short handoff window, but a
        // restored idle/failed session must never look as if it is still live.
        if (session?.status === 'running' && contract
            && ['approved', 'goal-starting', 'goal-active'].includes(contract.lifecycle)) {
            return 'preserve';
        }
        const currentMode = session?.availableModes?.find(mode => mode.id === session.currentModeId);
        return session?.currentModeId?.toLowerCase() === 'plan'
            || /(?:^|\s)plan(?:ning)?(?:\s|$)/i.test(currentMode?.name ?? '')
            ? 'proposal'
            : 'terminal';
    }

    goalState(sessionId: string | undefined): AgentGoalStateEvent | undefined {
        if (!sessionId) return undefined;
        const goal = this.goalStates.get(sessionId);
        if (!goal?.providerRuntimeEpoch) return goal;
        const session = this.snapshot.sessions.find(candidate => candidate.appSessionId === sessionId);
        if (!session?.providerRuntimeEpoch || session.providerRuntimeEpoch !== goal.providerRuntimeEpoch) return undefined;
        return goal;
    }

    taskContract(sessionId: string | undefined): AgentTaskContractEvent | undefined {
        if (!sessionId) return undefined;
        const contract = this.taskContracts.get(sessionId);
        if (!contract?.providerRuntimeEpoch) return contract;
        const session = this.snapshot.sessions.find(candidate => candidate.appSessionId === sessionId);
        if (!session?.providerRuntimeEpoch || session.providerRuntimeEpoch !== contract.providerRuntimeEpoch) return undefined;
        return contract;
    }

    protected upsertPlan(event: Extract<AgentHostEvent, { kind: 'plan' }>): boolean {
        const activityTurnId = this.activityTurnId(event);
        const nextActive = event.entries.some(item => item.status === 'in-progress');
        const signature = this.planSignature(event);
        const cancelledProgress = this.cancelledPlanSignatures.get(event.sessionId)?.get(signature);
        const completed = event.entries.filter(item => item.status === 'completed').length;
        if (cancelledProgress !== undefined) {
            if (!nextActive && completed <= cancelledProgress) return false;
            this.cancelledPlanSignatures.get(event.sessionId)?.delete(signature);
        }
        const existing = this.transcript.find(entry =>
            entry.kind === 'plan'
            && entry.payload?.kind === 'plan'
            && entry.payload.sessionId === event.sessionId
            && entry.activityTurnId === activityTurnId
        );
        if (existing) {
            const previous = existing.payload as Extract<AgentHostEvent, { kind: 'plan' }>;
            const previousActive = previous.entries.some(item => item.status === 'in-progress');
            const previousOpen = previous.entries.some(item => item.status === 'pending' || item.status === 'in-progress');
            const incomingOnlyCompletes = event.entries.length > 0
                && event.entries.every(item => item.status === 'completed');
            const goal = this.goalState(event.sessionId);
            const goalAwaitingVerification = !!goal
                && goal.status !== 'cleared'
                && goal.verificationStatus !== 'verified';
            if (goalAwaitingVerification && previousOpen && incomingOnlyCompletes
                && this.planSignature(previous) === signature) {
                // Grok may close a worker round with a cosmetic all-completed
                // Plan snapshot before its Goal verifier runs. Keep the last
                // meaningful progress visible until goal-state says verified.
                return false;
            }
            existing.payload = {
                ...event,
                ...(event.title ? {} : { title: previous.title })
            };
            return !previousActive && nextActive;
        } else {
            this.transcript.push({ id: this.id('plan'), kind: 'plan', payload: event, activityTurnId });
            return nextActive;
        }
    }

    protected planSignature(plan: Extract<AgentHostEvent, { kind: 'plan' }>): string {
        return JSON.stringify([
            plan.title ?? '',
            plan.entries.map(item => [item.id, item.text])
        ]);
    }

    protected rememberCancelledPlan(plan: Extract<AgentHostEvent, { kind: 'plan' }>): void {
        let plans = this.cancelledPlanSignatures.get(plan.sessionId);
        if (!plans) {
            plans = new Map();
            this.cancelledPlanSignatures.set(plan.sessionId, plans);
        }
        const signature = this.planSignature(plan);
        plans.delete(signature);
        plans.set(signature, plan.entries.filter(item => item.status === 'completed').length);
        while (plans.size > 32) {
            const oldest = plans.keys().next().value as string | undefined;
            if (!oldest) break;
            plans.delete(oldest);
        }
    }

    protected upsertDiff(event: DiffEvent): void {
        const activityTurnId = this.activityTurnId(event);
        const key = this.diffEntryKey(event, activityTurnId);
        const existing = this.diffEntries.get(key);
        if (existing) {
            // ACP commonly reports the same file content once while a tool is
            // running and once again when it completes. Preserve the latest
            // event (and therefore its current revert handle) without adding
            // a duplicate card. This also repairs already-persisted history.
            existing.payload = event;
            return;
        }
        const entry: TranscriptEntry = { id: this.id('diff'), kind: 'diff', payload: event, activityTurnId };
        this.transcript.push(entry);
        this.diffEntries.set(key, entry);
    }

    protected clearPendingPermissions(sessionId?: string): void {
        if (!sessionId) {
            this.pendingPermissions.clear();
            return;
        }
        for (const [requestId, request] of this.pendingPermissions) {
            if (request.sessionId === sessionId) {
                this.pendingPermissions.delete(requestId);
            }
        }
    }

    protected clearPendingPlanApprovals(sessionId?: string): void {
        if (!sessionId) {
            this.pendingPlanApprovals.clear();
            return;
        }
        for (const [requestId, request] of this.pendingPlanApprovals) {
            if (request.sessionId === sessionId) this.pendingPlanApprovals.delete(requestId);
        }
    }

    async decide(decision: PermissionDecision): Promise<void> {
        await this.service.respondPermission(decision);
        this.pendingPermissions.delete(decision.requestId);
        this.notifyChangeImmediately();
    }

    async decidePlan(decision: PlanApprovalDecision): Promise<void> {
        await this.service.respondPlanApproval(decision);
        this.pendingPlanApprovals.delete(decision.requestId);
        this.notifyChangeImmediately();
    }

    addUserMessage(sessionId: string, text: string, attachments?: AgentAttachmentSummary[]): void {
        if (!this.isVisibleSession(sessionId)) return;
        const activityTurnId = this.startLegacyActivityTurn(sessionId);
        this.transcript.push({
            id: this.id('user'),
            kind: 'user',
            text,
            payload: { kind: 'text-delta', sessionId, role: 'user', text, attachments },
            activityTurnId
        });
        this.notifyChangeImmediately();
    }

    setSession(session: SessionRecord, locallyCreated = false): void {
        if (this.missingSessionTombstones.has(session.appSessionId) && !locallyCreated) return;
        if (locallyCreated) this.markCreatedSessionUnconfirmed(session);
        this.selectedSessionOverride = session.appSessionId;
        this.upsertSession(session);
        this.snapshot.activeSessionId = session.appSessionId;
        this.clearTranscript();
        // Permission requests belong to running turns, not to the currently
        // visible transcript. Keep background-session requests in the global
        // permission dock when the user changes tabs.
        this.notifyChangeImmediately();
    }

    updateSession(session: SessionRecord, locallyCreated = false): void {
        if (this.missingSessionTombstones.has(session.appSessionId) && !locallyCreated) return;
        if (locallyCreated) this.markCreatedSessionUnconfirmed(session);
        this.upsertSession(session);
        if (this.selectedSessionOverride === session.appSessionId) {
            this.snapshot.activeSessionId = session.appSessionId;
        }
        this.notifyChangeImmediately();
    }

    /**
     * Drops renderer state for a session which Electron has explicitly
     * rejected as missing. This never deletes durable history: the backend is
     * already authoritative that the index record no longer exists.
     */
    forgetMissingSession(sessionId: string): void {
        this.tombstoneMissingSession(sessionId);
        this.notifyChangeImmediately();
    }

    /** Applies the session-scoped half of an authoritative deletion without
     * publishing a nested notification while a snapshot is being reduced. */
    protected tombstoneMissingSession(sessionId: string): void {
        const wasVisible = this.snapshot.activeSessionId === sessionId
            || this.selectedSessionOverride === sessionId;
        this.missingSessionTombstones.add(sessionId);
        this.snapshot.sessions = this.snapshot.sessions.filter(session => session.appSessionId !== sessionId);
        if (this.snapshot.sessionContexts?.[sessionId]) {
            const { [sessionId]: _removed, ...remaining } = this.snapshot.sessionContexts;
            this.snapshot.sessionContexts = remaining;
        }
        this.unconfirmedCreatedSessions.delete(sessionId);
        this.unconfirmedSessionAuthorityRevisions.delete(sessionId);
        this.legacyUnconfirmedOmissionRevisions.delete(sessionId);
        this.sessionAuthorityRevisions.delete(sessionId);
        this.goalStates.delete(sessionId);
        this.taskContracts.delete(sessionId);
        this.cancelledPlanSignatures.delete(sessionId);
        this.clearPendingPermissions(sessionId);
        this.clearPendingPlanApprovals(sessionId);
        if (wasVisible) {
            this.selectedSessionOverride = null;
            this.snapshot.activeSessionId = undefined;
            this.clearTranscript();
        }
    }

    startNewSession(): void {
        this.selectedSessionOverride = null;
        this.snapshot.activeSessionId = undefined;
        this.clearTranscript();
        // A new conversation must not strand a permission request issued by
        // another session which is still running in the background.
        this.notifyChangeImmediately();
    }

    loadHistory(events: AgentHostEvent[]): void {
        this.clearTranscript();
        const livePermissionIds = new Set(this.pendingPermissions.keys());
        const livePlanApprovalIds = new Set(this.pendingPlanApprovals.keys());
        for (const event of events) {
            this.accept(event, false);
            if (event.kind === 'permission-request' && !livePermissionIds.has(event.requestId)) {
                this.pendingPermissions.delete(event.requestId);
            }
            if (event.kind === 'plan-approval-request' && !livePlanApprovalIds.has(event.requestId)) {
                this.pendingPlanApprovals.delete(event.requestId);
            }
        }
        this.reconcileRestoredTaskContractPlans(events);
        this.notifyChangeImmediately();
    }

    showSessionHistory(session: SessionRecord, events: AgentHostEvent[]): void {
        if (this.missingSessionTombstones.has(session.appSessionId)) return;
        this.selectedSessionOverride = session.appSessionId;
        this.upsertSession(session);
        this.snapshot.activeSessionId = session.appSessionId;
        this.clearTranscript();
        const livePermissionIds = new Set(this.pendingPermissions.keys());
        const livePlanApprovalIds = new Set(this.pendingPlanApprovals.keys());
        for (const event of events) {
            this.accept(event, false);
            if (event.kind === 'permission-request' && !livePermissionIds.has(event.requestId)) {
                this.pendingPermissions.delete(event.requestId);
            }
            if (event.kind === 'plan-approval-request' && !livePlanApprovalIds.has(event.requestId)) {
                this.pendingPlanApprovals.delete(event.requestId);
            }
        }
        this.reconcileRestoredTaskContractPlans(events);
        this.notifyChangeImmediately();
    }

    /**
     * A crash can leave the durable task-contract as the final history event,
     * without a later turn-completed marker. Replaying events one-by-one cannot
     * settle the earlier Plan card in that ordering, so reconcile only after
     * the complete history has established the final contract lifecycle.
     */
    protected reconcileRestoredTaskContractPlans(events: AgentHostEvent[]): void {
        const finalContracts = new Map<string, AgentTaskContractEvent>();
        for (const event of events) {
            if (event.kind === 'task-contract') finalContracts.set(event.sessionId, event);
        }
        for (const contract of finalContracts.values()) {
            if (contract.lifecycle === 'verified') {
                this.finalizeVerifiedSessionPlan(contract.sessionId, contract.turnId);
            } else if (contract.lifecycle === 'interrupted') {
                const session = this.snapshot.sessions.find(candidate => candidate.appSessionId === contract.sessionId);
                this.finalizeSessionPlans(
                    contract.sessionId,
                    session?.status === 'failed' ? 'failed' : 'cancelled',
                    contract.turnId
                );
            }
        }
    }

    protected applySnapshot(snapshot: RuntimeSnapshot): void {
        const incomingRevision = snapshot.revision;
        if (Number.isSafeInteger(incomingRevision)
            && (incomingRevision as number) < this.appliedSnapshotRevision) {
            return;
        }
        const previousSnapshot = this.snapshot;
        const previousSessions = [...previousSnapshot.sessions];
        const previousWorkspaceRoot = this.snapshot.workspaceRoot;
        const previousProviderId = this.snapshot.providerId;
        if (typeof this.selectedSessionOverride === 'string'
            && this.unconfirmedCreatedSessions.has(this.selectedSessionOverride)) {
            const pending = previousSnapshot.sessions.find(
                session => session.appSessionId === this.selectedSessionOverride
            );
            const revisionCannotSupersede = !Number.isSafeInteger(incomingRevision)
                || (incomingRevision as number) <= (
                    this.unconfirmedSessionAuthorityRevisions.get(this.selectedSessionOverride)
                    ?? this.appliedSnapshotRevision
                );
            if (pending
                && pending.workspaceRoot === snapshot.workspaceRoot
                && pending.providerId !== snapshot.providerId
                && revisionCannotSupersede) {
                return;
            }
        }
        // Electron events and RPC results travel over separate asynchronous
        // paths. Immediately after session/new, a snapshot produced before
        // that transaction can arrive without the new record. Preserve only
        // a locally-created, not-yet-confirmed record. Once a snapshot has
        // advertised it, a later revision which omits it is an authoritative
        // deletion and must never be converted into a ghost conversation.
        // Never retain the transport object's mutable array. Local upserts
        // must not retroactively change a previously delivered snapshot and
        // make a later race appear authoritative.
        const advertisedSessionIds = new Set(snapshot.sessions
            .filter(session => !this.missingSessionTombstones.has(session.appSessionId))
            .map(session => session.appSessionId));
        if (Number.isSafeInteger(incomingRevision)) {
            for (const [sessionId, authorityRevision] of [...this.sessionAuthorityRevisions]) {
                if (!advertisedSessionIds.has(sessionId)
                    && (incomingRevision as number) > authorityRevision) {
                    this.tombstoneMissingSession(sessionId);
                }
            }
        }
        const authoritativeSessions = snapshot.sessions.filter(
            session => !this.missingSessionTombstones.has(session.appSessionId)
        );
        let sessions = [...authoritativeSessions];
        for (const session of authoritativeSessions) {
            this.unconfirmedCreatedSessions.delete(session.appSessionId);
            this.unconfirmedSessionAuthorityRevisions.delete(session.appSessionId);
            this.legacyUnconfirmedOmissionRevisions.delete(session.appSessionId);
            if (Number.isSafeInteger(incomingRevision)) {
                const previous = this.sessionAuthorityRevisions.get(session.appSessionId) ?? -1;
                this.sessionAuthorityRevisions.set(
                    session.appSessionId,
                    Math.max(previous, incomingRevision as number)
                );
            }
        }
        for (const sessionId of [...this.unconfirmedCreatedSessions]) {
            const local = previousSessions.find(session => session.appSessionId === sessionId);
            if (!local
                || local.workspaceRoot !== snapshot.workspaceRoot
                || local.providerId !== snapshot.providerId) {
                this.unconfirmedCreatedSessions.delete(sessionId);
                this.unconfirmedSessionAuthorityRevisions.delete(sessionId);
                this.legacyUnconfirmedOmissionRevisions.delete(sessionId);
                continue;
            }
            if (!sessions.some(session => session.appSessionId === sessionId)) {
                if (Number.isSafeInteger(incomingRevision)) {
                    const authorityRevision = this.unconfirmedSessionAuthorityRevisions.get(sessionId);
                    if (Number.isSafeInteger(authorityRevision)
                        && (incomingRevision as number) > (authorityRevision as number)) {
                        this.tombstoneMissingSession(sessionId);
                        continue;
                    }
                    if (!Number.isSafeInteger(authorityRevision)) {
                        const firstLegacyOmission = this.legacyUnconfirmedOmissionRevisions.get(sessionId);
                        if (firstLegacyOmission === undefined) {
                            this.legacyUnconfirmedOmissionRevisions.set(sessionId, incomingRevision as number);
                        } else if ((incomingRevision as number) > firstLegacyOmission) {
                            this.tombstoneMissingSession(sessionId);
                            continue;
                        }
                    }
                }
                sessions = [...sessions, local];
            }
        }
        if (Number.isSafeInteger(incomingRevision)) {
            for (const local of previousSessions) {
                const lastAuthorityRevision = this.sessionAuthorityRevisions.get(local.appSessionId);
                if (lastAuthorityRevision === undefined
                    || (incomingRevision as number) > lastAuthorityRevision
                    || this.missingSessionTombstones.has(local.appSessionId)
                    || sessions.some(session => session.appSessionId === local.appSessionId)) {
                    continue;
                }
                sessions = [...sessions, local];
            }
        }
        if (typeof this.selectedSessionOverride === 'string'
            && !sessions.some(session => session.appSessionId === this.selectedSessionOverride)) {
            const locallySelected = previousSessions.find(
                session => session.appSessionId === this.selectedSessionOverride
            );
            if (locallySelected && locallySelected.workspaceRoot === snapshot.workspaceRoot) {
                const unconfirmed = this.unconfirmedCreatedSessions.has(locallySelected.appSessionId);
                const lastAuthorityRevision = this.sessionAuthorityRevisions.get(locallySelected.appSessionId);
                const sameOrOlderAuthority = Number.isSafeInteger(incomingRevision)
                    && lastAuthorityRevision !== undefined
                    && (incomingRevision as number) <= lastAuthorityRevision;
                if (sameOrOlderAuthority && locallySelected.providerId !== snapshot.providerId) {
                    return;
                }
                if ((unconfirmed || sameOrOlderAuthority)
                    && locallySelected.providerId === snapshot.providerId) {
                    sessions = [locallySelected, ...sessions];
                }
            }
        }
        if (Number.isSafeInteger(incomingRevision)) {
            this.appliedSnapshotRevision = Math.max(this.appliedSnapshotRevision, incomingRevision as number);
        }
        const sessionContexts = Object.fromEntries(Object.entries(snapshot.sessionContexts ?? {})
            .filter(([sessionId]) => !this.missingSessionTombstones.has(sessionId)));
        this.snapshot = {
            ...snapshot,
            sessions,
            ...(snapshot.activeSessionId && this.missingSessionTombstones.has(snapshot.activeSessionId)
                ? { activeSessionId: undefined }
                : {}),
            sessionContexts: {
                ...(this.snapshot.sessionContexts ?? {}),
                ...sessionContexts
            }
        };
        if (this.selectedSessionOverride === null) {
            this.snapshot.activeSessionId = undefined;
        } else if (this.selectedSessionOverride !== undefined) {
            const selected = sessions.find(session => session.appSessionId === this.selectedSessionOverride);
            if (selected
                && selected.workspaceRoot === snapshot.workspaceRoot) {
                this.snapshot.activeSessionId = this.selectedSessionOverride;
            } else {
                // A project-root change is always an isolation boundary. A
                // missing/deleted record is also cleared. An explicitly chosen
                // history from another Provider remains visible while Electron
                // rebinds it to the application-wide Provider; renderer state
                // can never switch credentials or authorize the old ACP id.
                const missingSelection = this.selectedSessionOverride;
                this.selectedSessionOverride = null;
                this.snapshot.activeSessionId = undefined;
                this.clearTranscript();
                this.clearPendingPermissions(missingSelection);
                this.clearPendingPlanApprovals(missingSelection);
            }
        } else {
            const contextChanged = (previousWorkspaceRoot !== undefined && previousWorkspaceRoot !== snapshot.workspaceRoot)
                || previousProviderId !== snapshot.providerId;
            const activeSessionId = snapshot.activeSessionId;
            const containsAnotherSession = !!activeSessionId && this.transcript.some(entry => {
                const event = entry.payload;
                return event && 'sessionId' in event && typeof event.sessionId === 'string' && event.sessionId !== activeSessionId;
            });
            // Events can race the first backend snapshot. Bind that initial
            // transcript to the snapshot's active session instead of letting
            // an earlier session bleed into the newly selected conversation.
            if (contextChanged || containsAnotherSession) {
                if (contextChanged) {
                    // Workspace activation always starts from a clean page.
                    // History remains in snapshot.sessions and can still be
                    // restored explicitly from the history popover.
                    this.selectedSessionOverride = null;
                    this.snapshot.activeSessionId = undefined;
                }
                this.clearTranscript();
                this.pendingPermissions.clear();
                this.pendingPlanApprovals.clear();
            }
        }
    }

    protected markCreatedSessionUnconfirmed(session: SessionRecord): void {
        // A snapshot can win the race and be applied before session/new's RPC
        // result. In that case the record is already confirmed and requires no
        // temporary renderer protection.
        const sessionId = session.appSessionId;
        this.missingSessionTombstones.delete(sessionId);
        this.legacyUnconfirmedOmissionRevisions.delete(sessionId);
        if (!this.sessionAuthorityRevisions.has(sessionId)) {
            this.unconfirmedCreatedSessions.add(sessionId);
            this.unconfirmedSessionAuthorityRevisions.set(
                sessionId,
                Number.isSafeInteger(session.authorityRevision) ? session.authorityRevision : undefined
            );
        }
    }

    protected upsertSession(session: SessionRecord): void {
        if (this.missingSessionTombstones.has(session.appSessionId)) return;
        const existing = this.snapshot.sessions.findIndex(candidate => candidate.appSessionId === session.appSessionId);
        if (existing >= 0) {
            this.snapshot.sessions.splice(existing, 1, session);
        } else {
            this.snapshot.sessions.unshift(session);
        }
    }

    protected isVisibleSession(sessionId: string): boolean {
        const activeSessionId = this.snapshot.activeSessionId;
        if (activeSessionId) return activeSessionId === sessionId;
        // Before the first backend snapshot, retain the permissive reducer
        // behavior used by tests and initial boot. An explicit "new session"
        // selection must ignore every late event from the previous session.
        return this.selectedSessionOverride === undefined;
    }

    protected toolEntryKey(sessionId: string, toolCallId: string, activityTurnId: string): string {
        return `${activityTurnId}:${sessionId}:${toolCallId}`;
    }

    protected diffEntryKey(event: DiffEvent, activityTurnId: string): string {
        if (event.sessionId && event.toolCallId && event.path && event.oldHash && event.newHash) {
            const normalizedPath = new Path(event.path).normalize().toString();
            return `content:${JSON.stringify([
                activityTurnId,
                event.sessionId,
                event.toolCallId,
                normalizedPath,
                event.oldHash,
                event.newHash
            ])}`;
        }
        // Incomplete legacy events cannot be proven equivalent by content.
        // Fall back to their persisted identity so separate real edits are
        // never swallowed merely because they target the same path.
        return `identity:${JSON.stringify([activityTurnId, event.sessionId, event.diffId])}`;
    }

    /**
     * Returns a persisted turn key when available, otherwise reconstructs one
     * for legacy JSONL streams. A legacy prefix (history beginning mid-turn)
     * is intentionally valid so truncated histories still form one card.
     */
    protected activityTurnId(event: { sessionId: string; turnId?: string }): string {
        if (event.turnId) {
            // Do not let a partially upgraded history leak a preceding legacy
            // orphan into the first explicitly identified turn.
            this.legacyActivityTurnIds.delete(event.sessionId);
            return `activity:${event.sessionId}:${event.turnId}`;
        }
        const current = this.legacyActivityTurnIds.get(event.sessionId);
        if (current) return current;
        return this.startLegacyActivityTurn(event.sessionId);
    }

    protected startLegacyActivityTurn(sessionId: string): string {
        const ordinal = (this.legacyActivityTurnOrdinals.get(sessionId) ?? 0) + 1;
        this.legacyActivityTurnOrdinals.set(sessionId, ordinal);
        const activityTurnId = `activity:${sessionId}:legacy-${ordinal}`;
        this.legacyActivityTurnIds.set(sessionId, activityTurnId);
        return activityTurnId;
    }

    protected finishLegacyActivityTurn(sessionId: string): void {
        this.legacyActivityTurnIds.delete(sessionId);
    }

    protected clearTranscript(): void {
        this.transcript = [];
        this.toolEntries.clear();
        this.diffEntries.clear();
        this.thoughtEntries.clear();
        this.cancelledPlanSignatures.clear();
        this.legacyActivityTurnIds.clear();
        this.legacyActivityTurnOrdinals.clear();
    }

    protected id(prefix: string): string {
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    protected finishThoughtsForTurn(sessionId: string, turnId?: string): void {
        for (const entry of this.thoughtEntries.values()) {
            if (!entry.thoughtStreaming || entry.payload?.kind !== 'thought-delta') continue;
            if (entry.payload.sessionId !== sessionId) continue;
            if (turnId && entry.payload.turnId && entry.payload.turnId !== turnId) continue;
            entry.thoughtStreaming = false;
        }
    }
}

function isFrameBatchedEvent(event: AgentHostEvent): boolean {
    return event.kind === 'text-delta'
        || event.kind === 'thought-delta'
        || event.kind === 'tool-call'
        || event.kind === 'plan'
        || event.kind === 'diff'
        || event.kind === 'context-usage';
}

function isActiveToolStatus(status: ToolCallEvent['status']): boolean {
    return status === 'pending' || status === 'running';
}

function isTerminalToolStatus(status: ToolCallEvent['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'rejected';
}

function monotonicToolStatus(
    previous: ToolCallEvent['status'],
    incoming: ToolCallEvent['status']
): ToolCallEvent['status'] {
    if (previous === 'completed' || previous === 'failed' || previous === 'rejected') return previous;
    if (previous === 'running' && incoming === 'pending') return 'running';
    return incoming;
}

function mergeToolPresentation(
    previous: ToolCallEvent['presentation'],
    incoming: ToolCallEvent['presentation']
): ToolCallEvent['presentation'] {
    if (!previous) return incoming;
    if (!incoming) return previous;
    return {
        ...previous,
        ...incoming,
        action: incoming.action === 'other' && previous.action !== 'other' ? previous.action : incoming.action,
        source: incoming.source === 'builtin' && previous.source !== 'builtin' ? previous.source : incoming.source,
        targetLabel: incoming.targetLabel ?? previous.targetLabel,
        sourceLabel: incoming.sourceLabel ?? previous.sourceLabel,
        operationLabel: incoming.operationLabel ?? previous.operationLabel,
        readOnly: incoming.readOnly ?? previous.readOnly
    };
}
