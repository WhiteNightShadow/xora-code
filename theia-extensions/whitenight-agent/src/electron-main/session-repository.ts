import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentHostEvent, SessionRecord } from '../common/agent-protocol';

interface SessionIndex {
    schemaVersion: 1;
    sessions: SessionRecord[];
}

/** Crash-safe, renderer-independent index plus redacted append-only event logs. */
export class AgentSessionRepository {
    protected readonly root = path.join(app.getPath('userData'), 'agent-sessions');
    protected readonly indexPath = path.join(this.root, 'index.json');
    protected readonly lockPath = path.join(this.root, '.index.lock');
    protected readonly pendingEvents = new Map<string, { lines: string[]; bytes: number }>();
    protected flushTimer: ReturnType<typeof setTimeout> | undefined;

    list(): SessionRecord[] {
        return this.readIndex().sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    create(input: Omit<SessionRecord, 'appSessionId' | 'createdAt' | 'updatedAt' | 'status'>): SessionRecord {
        const now = new Date().toISOString();
        const record: SessionRecord = {
            ...input,
            appSessionId: crypto.randomUUID(),
            createdAt: now,
            updatedAt: now,
            status: 'idle'
        };
        this.withIndexLock(() => {
            const index = this.readIndex();
            index.sessions.push(record);
            this.writeIndex(index);
        });
        return { ...record };
    }

    update(appSessionId: string, patch: Partial<SessionRecord>): SessionRecord {
        return this.withIndexLock(() => {
            const index = this.readIndex();
            const position = index.sessions.findIndex(session => session.appSessionId === appSessionId);
            if (position < 0) {
                throw new Error('Unknown WhiteNight Code session.');
            }
            const previous = index.sessions[position];
            const next: SessionRecord = {
                ...previous,
                ...patch,
                appSessionId: previous.appSessionId,
                createdAt: previous.createdAt,
                updatedAt: new Date().toISOString()
            };
            index.sessions.splice(position, 1, next);
            this.writeIndex(index);
            return { ...next };
        });
    }

    get(appSessionId: string): SessionRecord | undefined {
        const record = this.readIndex().sessions.find(session => session.appSessionId === appSessionId);
        return record ? { ...record } : undefined;
    }

    appendEvent(appSessionId: string, event: AgentHostEvent): void {
        if (!/^[0-9a-f-]{36}$/i.test(appSessionId)) {
            throw new Error('Unsafe session identifier.');
        }
        const redacted = deepRedact(event);
        const line = `${JSON.stringify({
            schemaVersion: 1,
            timestamp: new Date().toISOString(),
            event: redacted
        })}\n`;
        const pending = this.pendingEvents.get(appSessionId) ?? { lines: [], bytes: 0 };
        pending.lines.push(line);
        pending.bytes += Buffer.byteLength(line);
        this.pendingEvents.set(appSessionId, pending);
        if (pending.lines.length >= 64 || pending.bytes >= 64 * 1024 || !['text-delta', 'plan', 'tool-call'].includes(event.kind)) {
            this.flushEvents(appSessionId);
        } else {
            this.scheduleFlush();
        }
    }

    flushEvents(appSessionId?: string): void {
        const ids = appSessionId ? [appSessionId] : [...this.pendingEvents.keys()];
        for (const id of ids) {
            const pending = this.pendingEvents.get(id);
            if (!pending?.lines.length) continue;
            fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
            const target = path.join(this.root, `${id}.jsonl`);
            try {
                const stat = fs.lstatSync(target);
                if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing an unsafe Agent history path.');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
            const descriptor = fs.openSync(target, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, 0o600);
            try {
                fs.writeFileSync(descriptor, pending.lines.join(''), 'utf8');
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            fs.chmodSync(target, 0o600);
            if (this.pendingEvents.get(id) === pending) this.pendingEvents.delete(id);
        }
        if (!this.pendingEvents.size && this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
    }

    dispose(): void {
        this.flushEvents();
    }

    readEvents(appSessionId: string): AgentHostEvent[] {
        if (!/^[0-9a-f-]{36}$/i.test(appSessionId)) throw new Error('Unsafe session identifier.');
        this.flushEvents(appSessionId);
        const target = path.join(this.root, `${appSessionId}.jsonl`);
        try {
            const stat = fs.statSync(target);
            const maximum = 16 * 1024 * 1024;
            const start = Math.max(0, stat.size - maximum);
            const length = stat.size - start;
            const descriptor = fs.openSync(target, 'r');
            let contents: string;
            try {
                const buffer = Buffer.alloc(length);
                fs.readSync(descriptor, buffer, 0, length, start);
                contents = buffer.toString('utf8');
            } finally {
                fs.closeSync(descriptor);
            }
            if (start > 0) contents = contents.slice(contents.indexOf('\n') + 1);
            return contents.split('\n').flatMap(line => {
                if (!line.trim()) return [];
                try {
                    const envelope = JSON.parse(line) as { event?: unknown };
                    return isStoredEvent(envelope.event, appSessionId) ? [envelope.event] : [];
                } catch {
                    return [];
                }
            }).slice(-5000);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
    }

    saveBeforeImage(appSessionId: string, relativePath: string, contents: string): { path: string; hash: string } {
        if (!/^[0-9a-f-]{36}$/i.test(appSessionId)) {
            throw new Error('Unsafe session identifier.');
        }
        const hash = crypto.createHash('sha256').update(contents).digest('hex');
        const extension = path.extname(relativePath).replace(/[^.A-Za-z0-9_-]/g, '').slice(0, 16);
        const directory = path.join(this.root, 'diffs', appSessionId);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const target = path.join(directory, `${hash}${extension || '.before'}`);
        if (!fs.existsSync(target)) {
            const descriptor = fs.openSync(target, 'wx', 0o600);
            try {
                fs.writeFileSync(descriptor, contents, 'utf8');
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
        } else {
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing an unsafe Agent diff history path.');
        }
        return { path: target, hash };
    }

    protected readIndex(): SessionIndex {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as SessionIndex;
            if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) {
                throw new Error('Invalid Agent session index.');
            }
            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { schemaVersion: 1, sessions: [] };
            }
            throw error;
        }
    }

    protected writeIndex(index: SessionIndex): void {
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const temporary = `${this.indexPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        const descriptor = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, `${JSON.stringify(index, undefined, 2)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        try {
            fs.renameSync(temporary, this.indexPath);
            fs.chmodSync(this.indexPath, 0o600);
            fsyncDirectory(this.root);
        } catch (error) {
            try { fs.unlinkSync(temporary); } catch { /* already moved */ }
            throw error;
        }
    }

    protected scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            try {
                this.flushEvents();
            } catch {
                // Keep the queued batch and retry. Explicit turn/shutdown
                // flushes still surface persistent storage failures.
                this.scheduleFlush();
            }
        }, 250);
        this.flushTimer.unref?.();
    }

    protected withIndexLock<T>(operation: () => T): T {
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        let descriptor: number;
        try {
            descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs <= 30_000) {
                throw new Error('Another WhiteNight Code process is updating the session index. Please retry.');
            }
            fs.unlinkSync(this.lockPath);
            descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        }
        try {
            fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
            fs.fsyncSync(descriptor);
            return operation();
        } finally {
            fs.closeSync(descriptor);
            try { fs.unlinkSync(this.lockPath); } catch { /* already removed */ }
        }
    }
}

export function deepRedact<T>(value: T, exactSecrets: readonly string[] = []): T {
    const secretName = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;
    const secretValue = /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|xai)-[A-Za-z0-9_-]{12,})/gi;
    const visit = (candidate: unknown, key?: string): unknown => {
        if (key && secretName.test(key)) {
            return '[REDACTED]';
        }
        if (typeof candidate === 'string') {
            let redacted = candidate.replace(secretValue, '[REDACTED]');
            for (const secret of exactSecrets) {
                if (secret) redacted = redacted.split(secret).join('[REDACTED]');
            }
            return redacted;
        }
        if (Array.isArray(candidate)) {
            return candidate.map(item => visit(item));
        }
        if (candidate && typeof candidate === 'object') {
            return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).map(([name, item]) => [name, visit(item, name)]));
        }
        return candidate;
    };
    return visit(value) as T;
}

function fsyncDirectory(directory: string): void {
    try {
        const descriptor = fs.openSync(directory, 'r');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    } catch {
        // Directory fsync is unavailable on some Windows filesystems. The file
        // itself was still fsynced before the atomic rename.
    }
}

function isStoredEvent(value: unknown, appSessionId: string): value is AgentHostEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as { kind?: unknown; sessionId?: unknown };
    const kinds = ['text-delta', 'plan', 'tool-call', 'permission-request', 'diff', 'turn-completed', 'error'];
    return typeof event.kind === 'string' && kinds.includes(event.kind) &&
        (event.sessionId === appSessionId || (event.kind === 'error' && event.sessionId === undefined));
}
