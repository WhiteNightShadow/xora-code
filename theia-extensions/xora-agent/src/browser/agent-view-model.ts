import { Emitter, Event } from '@theia/core/lib/common';
import { Path } from '@theia/core/lib/common/path';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    AgentAttachmentSummary,
    DiffEvent,
    AgentHostEvent,
    AgentHostService,
    PermissionDecision,
    PermissionRequestEvent,
    RuntimeSnapshot,
    SessionRecord,
    ToolCallEvent
} from '../common/agent-protocol';
import { AgentHostClientImpl } from './agent-client';
import { isMachineToolTitle } from './agent-display-helpers';
import { friendlyAgentErrorMessage } from './agent-error-labels';

export interface TranscriptEntry {
    id: string;
    kind: 'user' | 'assistant' | 'system' | 'plan' | 'tool' | 'permission' | 'diff' | 'error';
    text?: string;
    payload?: AgentHostEvent;
    /** Stable grouping key for every visible event produced by one prompt. */
    activityTurnId?: string;
    /** Completion metadata attached to the final Agent reply for this turn. */
    turnElapsedMs?: number;
    turnStopReason?: string;
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
    /**
     * Histories created before turn IDs were persisted are reconstructed from
     * their user/turn-completed boundaries. Ordinals are reset for each replay,
     * which keeps the derived keys deterministic across session switches.
     */
    protected readonly legacyActivityTurnIds = new Map<string, string>();
    protected readonly legacyActivityTurnOrdinals = new Map<string, number>();
    pendingPermissions = new Map<string, PermissionRequestEvent>();
    /**
     * `undefined` follows the backend's initial selection, `null` represents a
     * user-selected new session, and a string pins the visible conversation.
     * Keeping this separate from runtime snapshots prevents late status and
     * restore events from stealing the user's current selection.
     */
    protected selectedSessionOverride: string | null | undefined;
    /** Last Electron-host sequence applied across event and RPC channels. */
    protected appliedSnapshotRevision = -1;

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
        let liveActivityStarted = false;
        if (event.kind === 'snapshot') {
            this.applySnapshot(event.snapshot);
            if (event.snapshot.phase === 'crashed') {
                this.clearPendingPermissions();
            }
        } else if (event.kind === 'session') {
            this.upsertSession(event.session);
            if (['completed', 'cancelled', 'failed', 'read-only'].includes(event.session.status)) {
                this.finalizeSessionActivity(event.session.appSessionId, event.session.status);
                this.clearPendingPermissions(event.session.appSessionId);
            }
        } else if (event.kind === 'text-delta') {
            if (!this.isVisibleSession(event.sessionId)) return;
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
            const eventHasAttachments = Boolean(event.attachments?.length);
            if (!eventHasAttachments
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
        } else if (event.kind === 'tool-call') {
            if (!this.isVisibleSession(event.sessionId)) return;
            liveActivityStarted = this.upsertTool(event);
        } else if (event.kind === 'plan') {
            if (!this.isVisibleSession(event.sessionId)) return;
            liveActivityStarted = this.upsertPlan(event);
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
            const activityTurnId = this.activityTurnId(event);
            this.finalizeSessionActivity(
                event.sessionId,
                event.stopReason === 'cancelled' ? 'cancelled' : event.stopReason === 'error' ? 'failed' : 'completed',
                activityTurnId
            );
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
        activityTurnId?: string
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
        for (const entry of this.transcript) {
            const plan = entry.payload?.kind === 'plan' ? entry.payload : undefined;
            if (!plan
                || plan.sessionId !== sessionId
                || (activityTurnId !== undefined && entry.activityTurnId !== activityTurnId)
                || !plan.entries.some(item => item.status === 'in-progress')) continue;
            entry.payload = {
                ...plan,
                entries: plan.entries.map(item => item.status === 'in-progress'
                    ? { ...item, status: outcome === 'completed' ? 'completed' as const : 'failed' as const }
                    : item)
            };
        }
    }

    protected upsertPlan(event: Extract<AgentHostEvent, { kind: 'plan' }>): boolean {
        const activityTurnId = this.activityTurnId(event);
        const existing = this.transcript.find(entry =>
            entry.kind === 'plan'
            && entry.payload?.kind === 'plan'
            && entry.payload.sessionId === event.sessionId
            && entry.activityTurnId === activityTurnId
        );
        const nextActive = event.entries.some(item => item.status === 'in-progress');
        if (existing) {
            const previous = existing.payload as Extract<AgentHostEvent, { kind: 'plan' }>;
            const previousActive = previous.entries.some(item => item.status === 'in-progress');
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

    async decide(decision: PermissionDecision): Promise<void> {
        await this.service.respondPermission(decision);
        this.pendingPermissions.delete(decision.requestId);
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

    setSession(session: SessionRecord): void {
        this.selectedSessionOverride = session.appSessionId;
        this.upsertSession(session);
        this.snapshot.activeSessionId = session.appSessionId;
        this.clearTranscript();
        // Permission requests belong to running turns, not to the currently
        // visible transcript. Keep background-session requests in the global
        // permission dock when the user changes tabs.
        this.notifyChangeImmediately();
    }

    updateSession(session: SessionRecord): void {
        this.upsertSession(session);
        if (this.selectedSessionOverride === session.appSessionId) {
            this.snapshot.activeSessionId = session.appSessionId;
        }
        this.notifyChangeImmediately();
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
        for (const event of events) {
            this.accept(event, false);
            if (event.kind === 'permission-request' && !livePermissionIds.has(event.requestId)) {
                this.pendingPermissions.delete(event.requestId);
            }
        }
        this.notifyChangeImmediately();
    }

    showSessionHistory(session: SessionRecord, events: AgentHostEvent[]): void {
        this.selectedSessionOverride = session.appSessionId;
        this.upsertSession(session);
        this.snapshot.activeSessionId = session.appSessionId;
        this.clearTranscript();
        const livePermissionIds = new Set(this.pendingPermissions.keys());
        for (const event of events) {
            this.accept(event, false);
            if (event.kind === 'permission-request' && !livePermissionIds.has(event.requestId)) {
                this.pendingPermissions.delete(event.requestId);
            }
        }
        this.notifyChangeImmediately();
    }

    protected applySnapshot(snapshot: RuntimeSnapshot): void {
        const incomingRevision = snapshot.revision;
        if (Number.isSafeInteger(incomingRevision)
            && (incomingRevision as number) < this.appliedSnapshotRevision) {
            return;
        }
        const previousSnapshot = this.snapshot;
        const previousWorkspaceRoot = this.snapshot.workspaceRoot;
        const previousProviderId = this.snapshot.providerId;
        // Electron events and RPC results travel over separate asynchronous
        // paths. Immediately after setSession(created), an older runtime
        // snapshot can arrive without that just-created record. There is no
        // session-delete API, so preserve the locally selected record on the
        // same workspace until an authoritative newer session/snapshot
        // includes it. Otherwise the composer falls back to “new session” and
        // silently abandons the prompt before sendPrompt is called.
        let sessions = snapshot.sessions;
        if (typeof this.selectedSessionOverride === 'string'
            && !sessions.some(session => session.appSessionId === this.selectedSessionOverride)) {
            const locallySelected = previousSnapshot.sessions.find(
                session => session.appSessionId === this.selectedSessionOverride
            );
            if (locallySelected && locallySelected.workspaceRoot === snapshot.workspaceRoot) {
                // A locally created B session cannot legitimately disappear
                // inside a late A snapshot. This also protects compatibility
                // clients that predate the snapshot revision field.
                if (locallySelected.providerId !== snapshot.providerId) return;
                sessions = [locallySelected, ...sessions];
            }
        }
        if (Number.isSafeInteger(incomingRevision)) {
            this.appliedSnapshotRevision = Math.max(this.appliedSnapshotRevision, incomingRevision as number);
        }
        this.snapshot = {
            ...snapshot,
            sessions,
            sessionContexts: {
                ...(this.snapshot.sessionContexts ?? {}),
                ...(snapshot.sessionContexts ?? {})
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
                this.selectedSessionOverride = null;
                this.snapshot.activeSessionId = undefined;
                this.clearTranscript();
                this.pendingPermissions.clear();
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
            }
        }
    }

    protected upsertSession(session: SessionRecord): void {
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
        this.legacyActivityTurnIds.clear();
        this.legacyActivityTurnOrdinals.clear();
    }

    protected id(prefix: string): string {
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}

function isFrameBatchedEvent(event: AgentHostEvent): boolean {
    return event.kind === 'text-delta'
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
