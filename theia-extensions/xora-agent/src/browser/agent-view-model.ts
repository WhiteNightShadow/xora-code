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

export interface TranscriptEntry {
    id: string;
    kind: 'user' | 'assistant' | 'system' | 'plan' | 'tool' | 'permission' | 'diff' | 'error';
    text?: string;
    payload?: AgentHostEvent;
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
    pendingPermissions = new Map<string, PermissionRequestEvent>();
    /**
     * `undefined` follows the backend's initial selection, `null` represents a
     * user-selected new session, and a string pins the visible conversation.
     * Keeping this separate from runtime snapshots prevents late status and
     * restore events from stealing the user's current selection.
     */
    protected selectedSessionOverride: string | null | undefined;

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
        if (event.kind === 'snapshot') {
            this.applySnapshot(event.snapshot);
            if (event.snapshot.phase === 'crashed') {
                this.clearPendingPermissions();
            }
        } else if (event.kind === 'session') {
            this.upsertSession(event.session);
            if (['completed', 'cancelled', 'failed', 'read-only'].includes(event.session.status)) {
                this.clearPendingPermissions(event.session.appSessionId);
            }
        } else if (event.kind === 'text-delta') {
            if (!this.isVisibleSession(event.sessionId)) return;
            // Older builds persisted protocol-extension diagnostics into the
            // user conversation. Keep those legacy records out of the chat;
            // unknown ACP extensions are compatibility details, not messages.
            if (event.role === 'system' && event.text.startsWith('Ignored compatible ACP extension:')) return;
            const last = this.transcript[this.transcript.length - 1];
            const lastHasAttachments = last?.payload?.kind === 'text-delta'
                && Boolean(last.payload.attachments?.length);
            const eventHasAttachments = Boolean(event.attachments?.length);
            if (!eventHasAttachments
                && !lastHasAttachments
                && last?.kind === event.role
                && last.payload
                && 'sessionId' in last.payload
                && last.payload.sessionId === event.sessionId) {
                last.text = `${last.text ?? ''}${event.text}`;
            } else {
                this.transcript.push({ id: this.id('text'), kind: event.role, text: event.text, payload: event });
            }
        } else if (event.kind === 'permission-request') {
            if (!this.isVisibleSession(event.sessionId)) return;
            this.pendingPermissions.set(event.requestId, event);
            this.transcript.push({ id: event.requestId, kind: 'permission', payload: event });
        } else if (event.kind === 'tool-call') {
            if (!this.isVisibleSession(event.sessionId)) return;
            this.upsertTool(event);
        } else if (event.kind === 'plan') {
            if (!this.isVisibleSession(event.sessionId)) return;
            this.upsertPlan(event);
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
            this.clearPendingPermissions(event.sessionId);
        } else if (event.kind === 'error') {
            if (event.sessionId && !this.isVisibleSession(event.sessionId)) return;
            this.transcript.push({ id: this.id('error'), kind: 'error', text: event.message, payload: event });
            if (event.code === 'SIDECAR_CRASHED') {
                this.clearPendingPermissions();
            }
        }
        if (notify) {
            if (isFrameBatchedEvent(event)) {
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

    protected upsertTool(event: ToolCallEvent): void {
        const key = this.toolEntryKey(event.sessionId, event.toolCallId);
        const existing = this.toolEntries.get(key);
        if (existing) {
            const previous = existing.payload?.kind === 'tool-call' ? existing.payload : undefined;
            if (!previous) {
                existing.payload = event;
                return;
            }
            const toolKind = (!event.toolKind || event.toolKind === 'other') && previous.toolKind && previous.toolKind !== 'other'
                ? previous.toolKind
                : event.toolKind;
            const toolNamespace = event.toolNamespace ?? previous.toolNamespace;
            const presentation = mergeToolPresentation(previous.presentation, event.presentation);
            const locations = event.locations ?? previous.locations;
            existing.payload = {
                ...previous,
                ...event,
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
                input: event.input ?? previous.input,
                output: event.output ?? previous.output
            };
        } else {
            const entry: TranscriptEntry = { id: key, kind: 'tool', payload: event };
            this.transcript.push(entry);
            this.toolEntries.set(key, entry);
        }
    }

    protected upsertPlan(event: Extract<AgentHostEvent, { kind: 'plan' }>): void {
        const existing = this.transcript.find(entry =>
            entry.kind === 'plan' && entry.payload?.kind === 'plan' && entry.payload.sessionId === event.sessionId
        );
        if (existing) {
            const previous = existing.payload as Extract<AgentHostEvent, { kind: 'plan' }>;
            existing.payload = {
                ...event,
                ...(event.title ? {} : { title: previous.title })
            };
        } else {
            this.transcript.push({ id: this.id('plan'), kind: 'plan', payload: event });
        }
    }

    protected upsertDiff(event: DiffEvent): void {
        const key = this.diffEntryKey(event);
        const existing = this.diffEntries.get(key);
        if (existing) {
            // ACP commonly reports the same file content once while a tool is
            // running and once again when it completes. Preserve the latest
            // event (and therefore its current revert handle) without adding
            // a duplicate card. This also repairs already-persisted history.
            existing.payload = event;
            return;
        }
        const entry: TranscriptEntry = { id: this.id('diff'), kind: 'diff', payload: event };
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
        this.transcript.push({
            id: this.id('user'),
            kind: 'user',
            text,
            payload: { kind: 'text-delta', sessionId, role: 'user', text, attachments }
        });
        this.notifyChangeImmediately();
    }

    setSession(session: SessionRecord): void {
        this.selectedSessionOverride = session.appSessionId;
        this.upsertSession(session);
        this.snapshot.activeSessionId = session.appSessionId;
        this.clearTranscript();
        this.pendingPermissions.clear();
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
        this.pendingPermissions.clear();
        this.notifyChangeImmediately();
    }

    loadHistory(events: AgentHostEvent[]): void {
        this.clearTranscript();
        this.pendingPermissions.clear();
        for (const event of events) {
            this.accept(event, false);
            if (event.kind === 'permission-request') this.pendingPermissions.delete(event.requestId);
        }
        this.notifyChangeImmediately();
    }

    showSessionHistory(session: SessionRecord, events: AgentHostEvent[]): void {
        this.selectedSessionOverride = session.appSessionId;
        this.upsertSession(session);
        this.snapshot.activeSessionId = session.appSessionId;
        this.clearTranscript();
        this.pendingPermissions.clear();
        for (const event of events) {
            this.accept(event, false);
            if (event.kind === 'permission-request') this.pendingPermissions.delete(event.requestId);
        }
        this.notifyChangeImmediately();
    }

    protected applySnapshot(snapshot: RuntimeSnapshot): void {
        const previousWorkspaceRoot = this.snapshot.workspaceRoot;
        const previousProviderId = this.snapshot.providerId;
        this.snapshot = {
            ...snapshot,
            sessionContexts: {
                ...(this.snapshot.sessionContexts ?? {}),
                ...(snapshot.sessionContexts ?? {})
            }
        };
        if (this.selectedSessionOverride === null) {
            this.snapshot.activeSessionId = undefined;
        } else if (this.selectedSessionOverride !== undefined) {
            const selected = snapshot.sessions.find(session => session.appSessionId === this.selectedSessionOverride);
            if (selected
                && selected.workspaceRoot === snapshot.workspaceRoot
                && selected.providerId === snapshot.providerId) {
                this.snapshot.activeSessionId = this.selectedSessionOverride;
            } else {
                // A project-root or Provider change is a real isolation
                // boundary. Pin the UI to a new session instead of falling back
                // to a stale backend activeSessionId from an older snapshot.
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

    protected toolEntryKey(sessionId: string, toolCallId: string): string {
        return `${sessionId}:${toolCallId}`;
    }

    protected diffEntryKey(event: DiffEvent): string {
        if (event.sessionId && event.toolCallId && event.path && event.oldHash && event.newHash) {
            const normalizedPath = new Path(event.path).normalize().toString();
            return `content:${JSON.stringify([
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
        return `identity:${JSON.stringify([event.sessionId, event.diffId])}`;
    }

    protected clearTranscript(): void {
        this.transcript = [];
        this.toolEntries.clear();
        this.diffEntries.clear();
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
