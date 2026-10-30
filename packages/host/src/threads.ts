import { rmSync } from 'node:fs';
import path from 'node:path';
import {
    type Effort,
    type EventEnvelope,
    type Goal,
    type Item,
    type ModelRef,
    type Money,
    type PermissionMode,
    RpcError,
    RpcErrorCode,
    type ThreadEventKind,
    type ThreadEventPayload,
    type ThreadLocation,
    type ThreadMeta,
    type ThreadStatus,
} from '@xora/protocol';
import { EventLog, fromJson, toJson, type XoraDatabase } from '@xora/storage';
import type { Bus } from './bus.ts';
import { newId } from './ids.ts';

interface ThreadRow {
    id: string;
    project_id: string;
    title: string;
    created_at: number;
    updated_at: number;
    status: string;
    needs_review: number;
    unread: number;
    engine: string;
    model_json: string | null;
    mode: string;
    effort: string;
    location_json: string;
    pinned: number;
    archived: number;
    last_seq: number;
    turns: number;
    cost_amount: number | null;
    cost_currency: string | null;
    context_json: string | null;
    session_id: string | null;
    session_prompt: string | null;
    extra_json: string | null;
}

export interface ThreadExtra {
    parent?: { threadId: string; turnId: string };
    agentId?: string;
    taskId?: string;
    teamRunId?: string;
    role?: string;
    tier?: string;
    group?: string;
    goal?: Goal;
}

function toMeta(row: ThreadRow): ThreadMeta {
    const extra = fromJson<ThreadExtra>(row.extra_json, {});
    return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status as ThreadStatus,
        needsReview: row.needs_review === 1,
        unread: row.unread === 1,
        engine: row.engine,
        model: fromJson<ModelRef | null>(row.model_json, null),
        mode: row.mode as PermissionMode,
        effort: row.effort as Effort,
        location: fromJson<ThreadLocation>(row.location_json, { kind: 'local' }),
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        lastSeq: row.last_seq,
        turns: row.turns,
        cost: row.cost_amount === null ? null : { amount: row.cost_amount, currency: row.cost_currency ?? 'CNY' },
        context: fromJson<{ used: number; size: number } | null>(row.context_json, null),
        ...(extra.parent ? { parent: extra.parent } : {}),
        ...(extra.agentId ? { agentId: extra.agentId } : {}),
        ...(extra.taskId ? { taskId: extra.taskId } : {}),
        ...(extra.teamRunId ? { teamRunId: extra.teamRunId } : {}),
        ...(extra.role ? { role: extra.role } : {}),
        ...(extra.tier ? { tier: extra.tier } : {}),
        ...(extra.group ? { group: extra.group } : {}),
        ...(extra.goal ? { goal: extra.goal } : {}),
    };
}

export interface NewThread {
    readonly projectId: string;
    readonly title: string;
    readonly engine: string;
    readonly model: ModelRef | null;
    readonly mode: PermissionMode;
    readonly effort: Effort;
    readonly location?: ThreadLocation;
    readonly sessionPrompt?: string;
    readonly extra?: ThreadExtra;
}

/**
 * Thread rows (index) plus their append-only event logs (history). Every appended event is pushed to the
 * UIs subscribed to the thread; metadata changes are broadcast to all UIs for the sidebar.
 */
export class ThreadStore {
    readonly #db: XoraDatabase;
    readonly #bus: Bus;
    readonly #threadsDir: string;
    readonly #logs = new Map<string, EventLog>();

    constructor(db: XoraDatabase, bus: Bus, threadsDir: string) {
        this.#db = db;
        this.#bus = bus;
        this.#threadsDir = threadsDir;
    }

    dir(threadId: string): string {
        return path.join(this.#threadsDir, threadId);
    }

    #row(threadId: string): ThreadRow {
        const row = this.#db.get<ThreadRow>('select * from threads where id = ?', [threadId]);
        if (!row) {
            throw new RpcError(RpcErrorCode.NotFound, `thread not found: ${threadId}`);
        }
        return row;
    }

    get(threadId: string): ThreadMeta {
        return toMeta(this.#row(threadId));
    }

    find(threadId: string): ThreadMeta | undefined {
        const row = this.#db.get<ThreadRow>('select * from threads where id = ?', [threadId]);
        return row ? toMeta(row) : undefined;
    }

    sessionId(threadId: string): string | undefined {
        return this.#row(threadId).session_id ?? undefined;
    }

    sessionPrompt(threadId: string): string {
        return this.#row(threadId).session_prompt ?? '';
    }

    list(options: { projectId?: string; includeArchived?: boolean } = {}): ThreadMeta[] {
        const where: string[] = [];
        const params: string[] = [];
        if (options.projectId) {
            where.push('project_id = ?');
            params.push(options.projectId);
        }
        if (!options.includeArchived) {
            where.push('archived = 0');
        }
        const sql = `select * from threads ${where.length > 0 ? `where ${where.join(' and ')}` : ''} order by pinned desc, updated_at desc`;
        return this.#db.all<ThreadRow>(sql, params).map(toMeta);
    }

    create(input: NewThread): ThreadMeta {
        const id = newId('t');
        const now = Date.now();
        this.#db.run(
            `insert into threads (id, project_id, title, created_at, updated_at, status, engine, model_json, mode, effort, location_json, session_prompt, extra_json)
             values (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                input.projectId,
                input.title,
                now,
                now,
                input.engine,
                toJson(input.model),
                input.mode,
                input.effort,
                JSON.stringify(input.location ?? { kind: 'local' }),
                input.sessionPrompt ?? null,
                toJson(input.extra ?? null),
            ],
        );
        const meta = this.get(id);
        this.append(id, 'thread.created', { thread: meta });
        return this.get(id);
    }

    /** Applies a metadata patch and broadcasts the new metadata. */
    update(
        threadId: string,
        patch: Partial<{
            title: string;
            status: ThreadStatus;
            needsReview: boolean;
            unread: boolean;
            model: ModelRef | null;
            mode: PermissionMode;
            effort: Effort;
            pinned: boolean;
            archived: boolean;
            sessionId: string | null;
            sessionPrompt: string;
            cost: Money | null;
            context: { used: number; size: number } | null;
            turns: number;
            location: ThreadLocation;
            goal: Goal | null;
        }>,
        options: { touch?: boolean } = {},
    ): ThreadMeta {
        const sets: string[] = [];
        const params: Array<string | number | null> = [];
        const set = (column: string, value: string | number | null) => {
            sets.push(`${column} = ?`);
            params.push(value);
        };
        if (patch.title !== undefined) set('title', patch.title);
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.needsReview !== undefined) set('needs_review', patch.needsReview ? 1 : 0);
        if (patch.unread !== undefined) set('unread', patch.unread ? 1 : 0);
        if (patch.model !== undefined) set('model_json', toJson(patch.model));
        if (patch.mode !== undefined) set('mode', patch.mode);
        if (patch.effort !== undefined) set('effort', patch.effort);
        if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0);
        if (patch.archived !== undefined) set('archived', patch.archived ? 1 : 0);
        if (patch.sessionId !== undefined) set('session_id', patch.sessionId);
        if (patch.sessionPrompt !== undefined) set('session_prompt', patch.sessionPrompt);
        if (patch.cost !== undefined) {
            set('cost_amount', patch.cost?.amount ?? null);
            set('cost_currency', patch.cost?.currency ?? null);
        }
        if (patch.context !== undefined) set('context_json', toJson(patch.context));
        if (patch.turns !== undefined) set('turns', patch.turns);
        if (patch.location !== undefined) set('location_json', JSON.stringify(patch.location));
        if (patch.goal !== undefined) {
            const extra = fromJson<ThreadExtra>(this.#row(threadId).extra_json, {});
            if (patch.goal) extra.goal = patch.goal;
            else delete extra.goal;
            set('extra_json', JSON.stringify(extra));
        }
        if (options.touch !== false) set('updated_at', Date.now());
        if (sets.length > 0) {
            this.#db.run(`update threads set ${sets.join(', ')} where id = ?`, [...params, threadId]);
        }
        const meta = this.get(threadId);
        this.#bus.broadcast('thread.meta', { thread: meta });
        return meta;
    }

    #log(threadId: string): EventLog {
        let log = this.#logs.get(threadId);
        if (!log) {
            log = EventLog.open(this.dir(threadId));
            this.#logs.set(threadId, log);
        }
        return log;
    }

    /** Appends a persisted event, records the new `seq` and pushes it to subscribed UIs. */
    append<K extends ThreadEventKind>(
        threadId: string,
        kind: K,
        payload: ThreadEventPayload<K>,
        refs: { turnId?: string; itemId?: string } = {},
    ): EventEnvelope {
        const logged = this.#log(threadId).append({ ts: Date.now(), kind, payload, ...refs });
        this.#db.run('update threads set last_seq = ? where id = ?', [logged.seq, threadId]);
        const envelope: EventEnvelope = { threadId, ...logged };
        this.#bus.toThread(threadId, 'thread.event', { event: envelope });
        if (kind === 'item.completed') {
            this.#index(threadId, (payload as ThreadEventPayload<'item.completed'>).item);
        } else if (kind === 'turn.started') {
            this.#index(threadId, (payload as ThreadEventPayload<'turn.started'>).input);
        }
        return envelope;
    }

    events(threadId: string, afterSeq = 0): EventEnvelope[] {
        this.#row(threadId);
        return this.#log(threadId)
            .read(afterSeq)
            .events.map((event) => ({ threadId, ...event }));
    }

    #index(threadId: string, item: Item): void {
        if (item.type !== 'user_message' && item.type !== 'agent_message') {
            return;
        }
        if (item.text.trim().length === 0) {
            return;
        }
        const title = this.#row(threadId).title;
        this.#db.run('insert into thread_text (thread_id, turn_id, title, body) values (?, ?, ?, ?)', [
            threadId,
            item.turnId,
            title,
            item.text.slice(0, 20_000),
        ]);
    }

    search(query: string): Array<{ threadId: string; title: string; snippet: string }> {
        // Trigram tokens: a quoted phrase matches substrings of three or more characters, CJK included.
        const escaped = `"${query.replaceAll('"', '""')}"`;
        try {
            // Shorter queries (two-character Chinese words) are below the trigram size: fall back to a scan.
            const rows =
                [...query].length >= 3
                    ? this.#db.all<{ thread_id: string; title: string; snippet: string }>(
                          `select thread_id, title, snippet(thread_text, 3, '[', ']', '…', 12) as snippet
                           from thread_text where thread_text match ? order by rank limit 200`,
                          [escaped],
                      )
                    : this.#db.all<{ thread_id: string; title: string; snippet: string }>(
                          `select thread_id, title, substr(body, 1, 80) as snippet from thread_text
                           where body like ? escape '\\' or title like ? escape '\\' limit 200`,
                          [
                              `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`,
                              `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`,
                          ],
                      );
            const seen = new Set<string>();
            const hits: Array<{ threadId: string; title: string; snippet: string }> = [];
            for (const row of rows) {
                if (seen.has(row.thread_id) || !this.find(row.thread_id)) continue;
                seen.add(row.thread_id);
                hits.push({ threadId: row.thread_id, title: row.title, snippet: row.snippet });
                if (hits.length >= 50) break;
            }
            return hits;
        } catch {
            return [];
        }
    }

    delete(threadId: string): void {
        this.#row(threadId);
        this.#logs.get(threadId)?.close();
        this.#logs.delete(threadId);
        this.#db.transaction(() => {
            this.#db.run('delete from threads where id = ?', [threadId]);
            this.#db.run('delete from turns where thread_id = ?', [threadId]);
            this.#db.run('delete from thread_text where thread_id = ?', [threadId]);
        });
        rmSync(this.dir(threadId), { recursive: true, force: true });
        this.#bus.broadcast('thread.removed', { threadId });
    }

    /** Threads left `running` or `awaiting_approval` by a crash are marked failed on startup. */
    recoverInterrupted(): string[] {
        const rows = this.#db.all<{ id: string }>(
            `select id from threads where status in ('running', 'awaiting_approval')`,
        );
        for (const row of rows) {
            this.#db.run(`update threads set status = 'failed' where id = ?`, [row.id]);
        }
        return rows.map((row) => row.id);
    }

    // Turn bookkeeping ------------------------------------------------------------------------------------

    startTurn(threadId: string, turnId: string, checkpointBefore: string | undefined): void {
        this.#db.run(
            `insert into turns (thread_id, turn_id, started_at, status, checkpoint_before) values (?, ?, ?, 'running', ?)`,
            [threadId, turnId, Date.now(), checkpointBefore ?? null],
        );
    }

    setTurnCheckpoint(
        threadId: string,
        turnId: string,
        column: 'checkpoint_before' | 'checkpoint_after',
        tree: string,
    ): void {
        this.#db.run(`update turns set ${column} = ? where thread_id = ? and turn_id = ?`, [tree, threadId, turnId]);
    }

    endTurn(threadId: string, turnId: string, status: string, checkpointAfter: string | undefined): void {
        this.#db.run(
            'update turns set ended_at = ?, status = ?, checkpoint_after = coalesce(?, checkpoint_after) where thread_id = ? and turn_id = ?',
            [Date.now(), status, checkpointAfter ?? null, threadId, turnId],
        );
    }

    turn(threadId: string, turnId: string): { before?: string; after?: string; status: string } | undefined {
        const row = this.#db.get<{ checkpoint_before: string | null; checkpoint_after: string | null; status: string }>(
            'select checkpoint_before, checkpoint_after, status from turns where thread_id = ? and turn_id = ?',
            [threadId, turnId],
        );
        if (!row) {
            return undefined;
        }
        return {
            status: row.status,
            ...(row.checkpoint_before ? { before: row.checkpoint_before } : {}),
            ...(row.checkpoint_after ? { after: row.checkpoint_after } : {}),
        };
    }

    close(): void {
        for (const log of this.#logs.values()) {
            log.close();
        }
        this.#logs.clear();
    }
}
