import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentHostEvent, SessionRecord } from '../common/agent-protocol';

interface SessionIndex {
    schemaVersion: 1;
    sessions: SessionRecord[];
}

interface PendingEventBatch {
    lines: string[];
    events: AgentHostEvent[];
    bytes: number;
}

interface EventFileCache {
    device: number;
    inode: number;
    /** Number of file bytes represented by events/trailingPartial. */
    size: number;
    events: AgentHostEvent[];
    /** A cross-process append can be observed between write syscalls. */
    trailingPartial: string;
}

interface DiffImagePathCache {
    /** Identity of the containing directory; additions/removals invalidate paths. */
    directorySignature: string;
    paths: Map<string, string | undefined>;
}

const MAX_EVENT_LOG_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_EVENTS = 5000;
const MAX_CACHED_SESSIONS = 12;
const MAX_CACHED_DIFF_PATHS = MAX_CACHED_EVENTS * 2;

/** Crash-safe, renderer-independent index plus redacted append-only event logs. */
export class AgentSessionRepository {
    protected readonly root: string;
    protected readonly indexPath: string;
    protected readonly lockPath: string;
    protected readonly pendingEvents = new Map<string, PendingEventBatch>();
    /**
     * Parsed JSONL belongs in the Electron backend, but reparsing up to 16 MiB
     * on every history switch blocks the renderer RPC. Cache only the durable
     * file prefix and validate it with inode + size on every read. Pending
     * events stay separate so a history read never has to force an fsync.
     */
    protected readonly eventCache = new Map<string, EventFileCache>();
    /**
     * Diff history can contain hundreds of repeated cards. Resolving both
     * snapshots with lstat on every cached history read made session switches
     * synchronously scale with the number of cards. Keep the hash-derived
     * result per session and invalidate it when the private diff directory
     * changes, so a read performs at most one directory lstat before using the
     * already validated paths.
     */
    protected readonly diffImagePathCache = new Map<string, DiffImagePathCache>();
    protected flushTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Runtime snapshots are emitted frequently while an Agent is streaming.
     * Keep the parsed index in memory and use the atomic file's identity as a
     * cheap cross-window invalidation signal. Atomic replacement changes the
     * inode even on file systems whose mtime resolution is coarse.
     */
    protected indexCache: { signature: string; index: SessionIndex } | undefined;

    constructor(root = path.join(app.getPath('userData'), 'agent-sessions')) {
        this.root = root;
        this.indexPath = path.join(root, 'index.json');
        this.lockPath = path.join(root, '.index.lock');
    }

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
                throw new Error('Unknown Xora Code session.');
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

    /**
     * Permanently retires every ACP binding owned by a Provider.
     *
     * A Provider configuration or credential change is an isolation boundary:
     * an ACP session created with the previous runtime identity must never be
     * loaded under the new credentials. The local conversation stays visible
     * and can later be rebound to a fresh ACP session without replaying stored
     * prompts. Keep the original timestamps and index order so invalidation
     * does not make old conversations look newly active.
     */
    markProviderSessionsReadOnly(providerId: string): SessionRecord[] {
        if (!providerId.trim()) {
            throw new Error('A Provider identifier is required to retire Agent sessions.');
        }
        return this.withIndexLock(() => {
            const index = this.readIndex();
            const matching: SessionRecord[] = [];
            let changed = false;
            for (let position = 0; position < index.sessions.length; position += 1) {
                const previous = index.sessions[position];
                if (previous.providerId !== providerId) continue;
                const next: SessionRecord = previous.status === 'read-only'
                    ? previous
                    : { ...previous, status: 'read-only' };
                if (next !== previous) {
                    index.sessions[position] = next;
                    changed = true;
                }
                matching.push({ ...next });
            }
            // Avoid replacing index.json on a repeated invalidation. Besides
            // making the operation idempotent, this leaves the cache signature
            // stable for every other Xora Code window.
            if (changed) this.writeIndex(index);
            return matching;
        });
    }

    get(appSessionId: string): SessionRecord | undefined {
        const record = this.readIndex().sessions.find(session => session.appSessionId === appSessionId);
        return record ? { ...record } : undefined;
    }

    /**
     * Permanently removes a session index entry and its local event/diff files.
     * Returns false when the session id was already absent.
     */
    delete(appSessionId: string): boolean {
        if (!/^[0-9a-f-]{36}$/i.test(appSessionId)) {
            throw new Error('Unsafe session identifier.');
        }
        this.flushEvents(appSessionId);
        this.pendingEvents.delete(appSessionId);
        let removed = false;
        this.withIndexLock(() => {
            const index = this.readIndex();
            const position = index.sessions.findIndex(session => session.appSessionId === appSessionId);
            if (position < 0) return;
            index.sessions.splice(position, 1);
            this.writeIndex(index);
            removed = true;
        });
        if (!removed) return false;
        this.eventCache.delete(appSessionId);
        this.diffImagePathCache.delete(appSessionId);
        const historyPath = path.join(this.root, `${appSessionId}.jsonl`);
        try {
            fs.rmSync(historyPath, { force: true });
        } catch {
            // Best-effort cleanup; index removal is authoritative.
        }
        const diffDirectory = path.join(this.root, 'diffs', appSessionId);
        try {
            fs.rmSync(diffDirectory, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup.
        }
        return true;
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
        const pending = this.pendingEvents.get(appSessionId) ?? { lines: [], events: [], bytes: 0 };
        pending.lines.push(line);
        pending.events.push(redacted);
        pending.bytes += Buffer.byteLength(line);
        this.pendingEvents.set(appSessionId, pending);
        if (pending.lines.length >= 64 || pending.bytes >= 64 * 1024
            || !['text-delta', 'thought-delta', 'plan', 'tool-call', 'goal-state', 'supervision-shadow'].includes(event.kind)) {
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
        const target = path.join(this.root, `${appSessionId}.jsonl`);
        let durable: AgentHostEvent[] = [];
        try {
            const stat = fs.statSync(target);
            const cached = this.eventCache.get(appSessionId);
            const canReadIncrementally = !!cached
                && cached.device === stat.dev
                && cached.inode === stat.ino
                && stat.size >= cached.size
                && stat.size - cached.size <= MAX_EVENT_LOG_BYTES;
            if (canReadIncrementally && cached) {
                const appended = this.readEventFileRange(target, cached.size, stat.size - cached.size);
                const parsed = parseStoredEventChunk(
                    `${cached.trailingPartial}${appended}`,
                    appSessionId,
                    false
                );
                cached.size = stat.size;
                cached.events = [...cached.events, ...parsed.events].slice(-MAX_CACHED_EVENTS);
                cached.trailingPartial = parsed.trailingPartial;
                durable = cached.events;
                this.touchEventCache(appSessionId, cached);
            } else {
                const start = Math.max(0, stat.size - MAX_EVENT_LOG_BYTES);
                const contents = this.readEventFileRange(target, start, stat.size - start);
                const parsed = parseStoredEventChunk(contents, appSessionId, start > 0);
                const next: EventFileCache = {
                    device: stat.dev,
                    inode: stat.ino,
                    size: stat.size,
                    events: parsed.events.slice(-MAX_CACHED_EVENTS),
                    trailingPartial: parsed.trailingPartial
                };
                durable = next.events;
                this.touchEventCache(appSessionId, next);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            this.eventCache.delete(appSessionId);
        }
        // A renderer history read is not a durability boundary. The scheduled
        // 250 ms append remains crash-safe (write + fsync), while the user can
        // immediately see this process's latest stream fragment without a disk
        // flush on the latency-sensitive session-switch path.
        const pending = this.pendingEvents.get(appSessionId)?.events ?? [];
        const visible = [...durable, ...pending].slice(-MAX_CACHED_EVENTS);
        const diffCache = visible.some(event => event.kind === 'diff')
            ? this.prepareDiffImagePathCache(appSessionId)
            : undefined;
        return visible.map(event => this.restoreDiffImagePaths(appSessionId, event, diffCache));
    }

    protected readEventFileRange(target: string, start: number, length: number): string {
        if (length <= 0) return '';
        const descriptor = fs.openSync(target, 'r');
        try {
            const buffer = Buffer.allocUnsafe(length);
            let offset = 0;
            while (offset < length) {
                const bytesRead = fs.readSync(descriptor, buffer, offset, length - offset, start + offset);
                if (bytesRead <= 0) break;
                offset += bytesRead;
            }
            return buffer.subarray(0, offset).toString('utf8');
        } finally {
            fs.closeSync(descriptor);
        }
    }

    protected touchEventCache(appSessionId: string, cache: EventFileCache): void {
        this.eventCache.delete(appSessionId);
        this.eventCache.set(appSessionId, cache);
        while (this.eventCache.size > MAX_CACHED_SESSIONS) {
            const oldest = this.eventCache.keys().next().value as string | undefined;
            if (!oldest) break;
            this.eventCache.delete(oldest);
        }
    }

    saveBeforeImage(appSessionId: string, relativePath: string, contents: string): { path: string; hash: string } {
        if (!/^[0-9a-f-]{36}$/i.test(appSessionId)) {
            throw new Error('Unsafe session identifier.');
        }
        const hash = crypto.createHash('sha256').update(contents).digest('hex');
        const extension = this.diffImageExtension(relativePath);
        const directory = path.join(this.root, 'diffs', appSessionId);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        // A bare SHA-256 immediately following the UUID directory can form one
        // long Base64-shaped run (`uuid-tail/<hash>`). The generic diagnostic
        // redactor correctly removes that run, but doing so used to corrupt the
        // renderer's Diff URI. A non-Base64 separator keeps the trusted digest
        // independently recognizable and therefore intact after redaction.
        const target = path.join(directory, `before-${hash}${extension}`);
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
            if (this.fileSha256(target) !== hash) {
                throw new Error('Refusing a corrupted Agent diff history snapshot.');
            }
        }
        // A newly written immutable snapshot changes the set of valid paths.
        // The next history read will rebuild only this session's path cache.
        this.diffImagePathCache.delete(appSessionId);
        return { path: target, hash };
    }

    /**
     * Rebuild content-addressed Diff paths instead of trusting a path stored in
     * JSONL. Besides keeping history portable across the redaction boundary,
     * this repairs v0.2.0 events whose bare hash filename was replaced with
     * `[REDACTED_BINARY_PAYLOAD]`. Legacy snapshots remain readable in place.
     */
    protected restoreDiffImagePaths(
        appSessionId: string,
        event: AgentHostEvent,
        cache: DiffImagePathCache | undefined
    ): AgentHostEvent {
        if (event.kind !== 'diff') return { ...event };
        const oldPath = event.oldHash
            ? this.findDiffImage(appSessionId, event.path, event.oldHash, cache)
            : undefined;
        const newPath = event.newHash
            ? this.findDiffImage(appSessionId, event.path, event.newHash, cache)
            : undefined;
        const { oldPath: _storedOldPath, newPath: _storedNewPath, ...safeEvent } = event;
        return {
            ...safeEvent,
            ...(oldPath ? { oldPath } : {}),
            ...(newPath ? { newPath } : {})
        };
    }

    protected findDiffImage(
        appSessionId: string,
        relativePath: string,
        hash: string,
        cache: DiffImagePathCache | undefined
    ): string | undefined {
        if (!/^[0-9a-f]{64}$/i.test(hash)) return undefined;
        const extension = this.diffImageExtension(relativePath);
        const cacheKey = `${hash.toLowerCase()}\0${extension}`;
        if (cache?.paths.has(cacheKey)) {
            const cached = cache.paths.get(cacheKey);
            this.touchDiffImagePath(cache, cacheKey, cached);
            return cached;
        }
        const directory = path.join(this.root, 'diffs', appSessionId);
        let resolved: string | undefined;
        for (const filename of [`before-${hash}${extension}`, `${hash}${extension}`]) {
            const candidate = path.join(directory, filename);
            try {
                const stat = fs.lstatSync(candidate);
                if (!stat.isSymbolicLink() && stat.isFile() && this.fileSha256(candidate) === hash.toLowerCase()) {
                    resolved = candidate;
                    break;
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        if (cache) this.touchDiffImagePath(cache, cacheKey, resolved);
        return resolved;
    }

    protected prepareDiffImagePathCache(appSessionId: string): DiffImagePathCache {
        const directory = path.join(this.root, 'diffs', appSessionId);
        let directorySignature = 'missing';
        try {
            const stat = fs.lstatSync(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error('Refusing an unsafe Agent diff history directory.');
            }
            directorySignature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const previous = this.diffImagePathCache.get(appSessionId);
        const cache = previous?.directorySignature === directorySignature
            ? previous
            : { directorySignature, paths: new Map<string, string | undefined>() };
        this.diffImagePathCache.delete(appSessionId);
        this.diffImagePathCache.set(appSessionId, cache);
        while (this.diffImagePathCache.size > MAX_CACHED_SESSIONS) {
            const oldest = this.diffImagePathCache.keys().next().value as string | undefined;
            if (!oldest) break;
            this.diffImagePathCache.delete(oldest);
        }
        return cache;
    }

    protected touchDiffImagePath(cache: DiffImagePathCache, key: string, value: string | undefined): void {
        cache.paths.delete(key);
        cache.paths.set(key, value);
        while (cache.paths.size > MAX_CACHED_DIFF_PATHS) {
            const oldest = cache.paths.keys().next().value as string | undefined;
            if (!oldest) break;
            cache.paths.delete(oldest);
        }
    }

    protected diffImageExtension(relativePath: string): string {
        return path.extname(relativePath).replace(/[^.A-Za-z0-9_-]/g, '').slice(0, 16) || '.before';
    }

    protected fileSha256(target: string): string {
        return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    }

    protected readIndex(): SessionIndex {
        try {
            const signature = this.indexSignature();
            if (this.indexCache?.signature === signature) {
                return cloneIndex(this.indexCache.index);
            }
            const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as SessionIndex;
            if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) {
                throw new Error('Invalid Agent session index.');
            }
            this.indexCache = { signature, index: cloneIndex(parsed) };
            return cloneIndex(parsed);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.indexCache = undefined;
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
            this.indexCache = {
                signature: this.indexSignature(),
                index: cloneIndex(index)
            };
        } catch (error) {
            try { fs.unlinkSync(temporary); } catch { /* already moved */ }
            throw error;
        }
    }

    protected indexSignature(): string {
        const stat = fs.statSync(this.indexPath);
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
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
                throw new Error('Another Xora Code process is updating the session index. Please retry.');
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

function cloneIndex(index: SessionIndex): SessionIndex {
    return {
        schemaVersion: 1,
        sessions: index.sessions.map(session => ({ ...session }))
    };
}

export function deepRedact<T>(value: T, exactSecrets: readonly string[] = []): T {
    const secretName = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i;
    // Context accounting uses token-shaped field names too. Keep only the
    // exact numeric lifecycle fields Grok publishes; a string under the same
    // key is still treated as credential-shaped data and removed.
    const safeTokenAccountingNames = new Set(['totaltokens', 'tokensused', 'tokensbefore', 'tokensafter']);
    const secretValue = /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|xai)-[A-Za-z0-9_-]{12,})/gi;
    // A sidecar must not be able to copy an ACP image payload into diagnostic
    // stderr or an error event. Canonical image Base64 is one long opaque run.
    // An exact, standalone 64-character hexadecimal value is retained because
    // component and attachment SHA-256 values are useful diagnostics. Longer
    // hexadecimal runs are opaque data too and must not bypass redaction.
    const opaqueBinaryValue = /[A-Za-z0-9+/]{64,}={0,2}/g;
    const visit = (candidate: unknown, key?: string): unknown => {
        const normalizedKey = key?.toLowerCase().replace(/[^a-z0-9]/g, '');
        const safeTokenAccounting = normalizedKey !== undefined
            && safeTokenAccountingNames.has(normalizedKey)
            && typeof candidate === 'number'
            && Number.isSafeInteger(candidate)
            && candidate >= 0;
        if (key && secretName.test(key) && !safeTokenAccounting) {
            return '[REDACTED]';
        }
        if (typeof candidate === 'string') {
            // Exact runtime credentials must be removed before generic opaque
            // payload matching. Otherwise the generic matcher can replace only
            // the long token body and leave a recognizable credential prefix,
            // preventing the later exact match from ever succeeding.
            let redacted = candidate;
            for (const secret of exactSecrets) {
                if (secret) redacted = redacted.split(secret).join('[REDACTED]');
            }
            redacted = redacted.replace(secretValue, '[REDACTED]');
            redacted = redacted.replace(opaqueBinaryValue, encoded =>
                /^[0-9a-f]{64}$/i.test(encoded) ? encoded : '[REDACTED_BINARY_PAYLOAD]');
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

/**
 * Redacts opaque Base64-shaped stderr values before any prefix is allowed to
 * reach disk. The final length of a token is unknown at a stream boundary, so
 * at most 64 token characters are retained. On the 65th character the marker
 * can be emitted immediately and the rest of that token is discarded.
 */
export class StreamingOpaquePayloadRedactor {
    protected static readonly JSON_DATA_KEY = '"data"';
    protected candidate = '';
    protected discarding = false;
    protected jsonKeyCandidate = '';
    protected jsonDataState: 'normal' | 'after-key' | 'before-value' | 'value' = 'normal';
    protected jsonValueEscaped = false;
    protected ended = false;

    write(chunk: string): string {
        if (!chunk || this.ended) return '';
        let output = '';
        for (const character of chunk) {
            output += this.writeStructuredCharacter(character);
        }
        return output;
    }

    end(chunk = ''): string {
        if (this.ended) return '';
        let output = this.write(chunk);
        if (this.jsonKeyCandidate) {
            output += this.writeOpaqueText(this.jsonKeyCandidate);
            this.jsonKeyCandidate = '';
        }
        output += this.finishCandidate();
        this.jsonDataState = 'normal';
        this.jsonValueEscaped = false;
        this.ended = true;
        return output;
    }

    /** Keeps a JSON data string sensitive even when it contains wrapped lines. */
    protected writeStructuredCharacter(character: string): string {
        if (this.jsonDataState === 'value') {
            if (this.jsonValueEscaped) {
                this.jsonValueEscaped = false;
                return '';
            }
            if (character === '\\') {
                this.jsonValueEscaped = true;
                return '';
            }
            if (character === '"') {
                this.jsonDataState = 'normal';
                return this.writeOpaqueText(character);
            }
            return '';
        }

        if (this.jsonDataState === 'after-key') {
            if (/\s/.test(character)) return this.writeOpaqueText(character);
            if (character === ':') {
                this.jsonDataState = 'before-value';
                return this.writeOpaqueText(character);
            }
            this.jsonDataState = 'normal';
            return this.writeNormalCharacter(character);
        }

        if (this.jsonDataState === 'before-value') {
            if (/\s/.test(character)) return this.writeOpaqueText(character);
            if (character === '"') {
                this.jsonDataState = 'value';
                this.jsonValueEscaped = false;
                return `${this.writeOpaqueText(character)}[REDACTED_BINARY_PAYLOAD]`;
            }
            this.jsonDataState = 'normal';
            return this.writeNormalCharacter(character);
        }

        return this.writeNormalCharacter(character);
    }

    protected writeNormalCharacter(character: string): string {
        if (!this.jsonKeyCandidate) {
            if (character === '"') {
                this.jsonKeyCandidate = character;
                return '';
            }
            return this.writeOpaqueText(character);
        }

        this.jsonKeyCandidate += character;
        if (this.jsonKeyCandidate === StreamingOpaquePayloadRedactor.JSON_DATA_KEY) {
            const key = this.jsonKeyCandidate;
            this.jsonKeyCandidate = '';
            this.jsonDataState = 'after-key';
            return this.writeOpaqueText(key);
        }
        if (StreamingOpaquePayloadRedactor.JSON_DATA_KEY.startsWith(this.jsonKeyCandidate)) return '';

        const failed = this.jsonKeyCandidate;
        const retainQuote = failed.endsWith('"');
        this.jsonKeyCandidate = retainQuote ? '"' : '';
        return this.writeOpaqueText(retainQuote ? failed.slice(0, -1) : failed);
    }

    protected writeOpaqueText(text: string): string {
        let output = '';
        for (const character of text) {
            if (/[A-Za-z0-9+/]/.test(character)) {
                if (this.discarding) continue;
                this.candidate += character;
                if ((this.candidate.length === 64 && !/^[0-9a-f]{64}$/i.test(this.candidate)) || this.candidate.length > 64) {
                    output += '[REDACTED_BINARY_PAYLOAD]';
                    this.candidate = '';
                    this.discarding = true;
                }
                continue;
            }
            output += this.finishCandidate();
            output += character;
        }
        return output;
    }

    protected finishCandidate(): string {
        if (this.discarding) {
            this.discarding = false;
            this.candidate = '';
            return '';
        }
        const candidate = this.candidate;
        this.candidate = '';
        if (candidate.length >= 64 && !/^[0-9a-f]{64}$/i.test(candidate)) {
            return '[REDACTED_BINARY_PAYLOAD]';
        }
        return candidate;
    }
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

function parseStoredEventChunk(
    rawContents: string,
    appSessionId: string,
    discardLeadingPartial: boolean
): { events: AgentHostEvent[]; trailingPartial: string } {
    let contents = rawContents;
    if (discardLeadingPartial) {
        const firstNewline = contents.indexOf('\n');
        contents = firstNewline >= 0 ? contents.slice(firstNewline + 1) : '';
    }
    const terminated = contents.endsWith('\n');
    const lines = contents.split('\n');
    const trailingPartial = terminated ? '' : (lines.pop() ?? '');
    const events: AgentHostEvent[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const envelope = JSON.parse(line) as { event?: unknown };
            if (isStoredEvent(envelope.event, appSessionId)) events.push(envelope.event);
        } catch {
            // A corrupt historical line is isolated; later valid events remain
            // readable and append-only recovery never rewrites the source log.
        }
    }
    return { events, trailingPartial };
}

function isStoredEvent(value: unknown, appSessionId: string): value is AgentHostEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as { kind?: unknown; sessionId?: unknown };
    const kinds = [
        'text-delta',
        'thought-delta',
        'plan',
        'goal-state',
        'task-contract',
        'supervision-shadow',
        'tool-call',
        'permission-request',
        'diff',
        'context-usage',
        'turn-completed',
        'error'
    ];
    return typeof event.kind === 'string' && kinds.includes(event.kind) &&
        (event.sessionId === appSessionId || (event.kind === 'error' && event.sessionId === undefined));
}
