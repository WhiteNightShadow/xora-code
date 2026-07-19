import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    AgentHostEvent,
    AgentHostService,
    PermissionDecision,
    PermissionRequestEvent,
    RuntimeSnapshot,
    SessionRecord,
    ToolCallEvent
} from '../common/agent-protocol';
import { AgentHostClientImpl } from './agent-client';

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

    snapshot: RuntimeSnapshot = {
        phase: 'stopped',
        workspaceTrusted: false,
        providerId: 'grok-subscription',
        models: [],
        sessions: []
    };
    transcript: TranscriptEntry[] = [];
    pendingPermissions = new Map<string, PermissionRequestEvent>();

    @postConstruct()
    protected init(): void {
        this.client.onEvent(event => this.accept(event));
        void this.refresh();
    }

    async refresh(): Promise<void> {
        this.snapshot = await this.service.getSnapshot();
        this.changeEmitter.fire();
    }

    protected accept(event: AgentHostEvent): void {
        if (event.kind === 'snapshot') {
            this.snapshot = event.snapshot;
        } else if (event.kind === 'session') {
            const existing = this.snapshot.sessions.findIndex(session => session.appSessionId === event.session.appSessionId);
            if (existing >= 0) {
                this.snapshot.sessions.splice(existing, 1, event.session);
            } else {
                this.snapshot.sessions.unshift(event.session);
            }
            this.snapshot.activeSessionId = event.session.appSessionId;
        } else if (event.kind === 'text-delta') {
            const last = this.transcript[this.transcript.length - 1];
            if (last?.kind === event.role && last.payload && 'sessionId' in last.payload && last.payload.sessionId === event.sessionId) {
                last.text = `${last.text ?? ''}${event.text}`;
            } else {
                this.transcript.push({ id: this.id('text'), kind: event.role, text: event.text, payload: event });
            }
        } else if (event.kind === 'permission-request') {
            this.pendingPermissions.set(event.requestId, event);
            this.transcript.push({ id: event.requestId, kind: 'permission', payload: event });
        } else if (event.kind === 'tool-call') {
            this.upsertTool(event);
        } else if (event.kind === 'plan') {
            this.transcript.push({ id: this.id('plan'), kind: 'plan', payload: event });
        } else if (event.kind === 'diff') {
            this.transcript.push({ id: this.id('diff'), kind: 'diff', payload: event });
        } else if (event.kind === 'error') {
            this.transcript.push({ id: this.id('error'), kind: 'error', text: event.message, payload: event });
        }
        this.changeEmitter.fire();
    }

    protected upsertTool(event: ToolCallEvent): void {
        const existing = this.transcript.find(entry => entry.kind === 'tool' && entry.id === event.toolCallId);
        if (existing) {
            existing.payload = event;
        } else {
            this.transcript.push({ id: event.toolCallId, kind: 'tool', payload: event });
        }
    }

    async decide(decision: PermissionDecision): Promise<void> {
        await this.service.respondPermission(decision);
        this.pendingPermissions.delete(decision.requestId);
        this.changeEmitter.fire();
    }

    addUserMessage(sessionId: string, text: string): void {
        this.transcript.push({
            id: this.id('user'),
            kind: 'user',
            text,
            payload: { kind: 'text-delta', sessionId, role: 'user', text }
        });
        this.changeEmitter.fire();
    }

    setSession(session: SessionRecord): void {
        this.snapshot.activeSessionId = session.appSessionId;
        this.transcript = [];
        this.changeEmitter.fire();
    }

    loadHistory(events: AgentHostEvent[]): void {
        this.transcript = [];
        this.pendingPermissions.clear();
        for (const event of events) {
            this.accept(event);
            if (event.kind === 'permission-request') this.pendingPermissions.delete(event.requestId);
        }
        this.changeEmitter.fire();
    }

    protected id(prefix: string): string {
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}
