import { fromJson, type XoraDatabase } from '@xora/storage';
import type {
    BoardEvent,
    BoardSnapshot,
    ProgressLedgerSnapshot,
    TaskLedgerSnapshot,
    TeamRun,
    TeamRunFilter,
    TeamStore,
} from '@xora/workflows';

interface RunRow {
    id: string;
    run_json: string;
    board_json: string | null;
    task_ledger_json: string | null;
    progress_json: string | null;
    host_json: string | null;
}

/**
 * Team runs in the host database (migration 2): one `team_runs` row per run with the run, the board snapshot,
 * both ledgers and the host's own bookkeeping, plus `team_board_events` for the board events after the
 * snapshot. Everything is written synchronously, so a run is as durable as the last change.
 */
export class SqliteTeamStore implements TeamStore {
    readonly #db: XoraDatabase;

    constructor(db: XoraDatabase) {
        this.#db = db;
    }

    writeRun(run: TeamRun): void {
        this.#db.run(
            `insert into team_runs (id, project_id, org_id, goal, status, phase, created_at, updated_at, run_json)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (id) do update set project_id = excluded.project_id, org_id = excluded.org_id,
                 goal = excluded.goal, status = excluded.status, phase = excluded.phase,
                 updated_at = excluded.updated_at, run_json = excluded.run_json`,
            [
                run.id,
                run.projectId ?? null,
                run.orgId,
                run.goal,
                run.status,
                run.phase,
                run.createdAt,
                run.updatedAt,
                JSON.stringify(run),
            ],
        );
    }

    /** Sets one JSON column of an existing run. */
    #set(runId: string, column: string, value: unknown, extra: Record<string, number> = {}): void {
        const sets = [`${column} = ?`, ...Object.keys(extra).map((key) => `${key} = ?`)];
        const result = this.#db.run(`update team_runs set ${sets.join(', ')} where id = ?`, [
            JSON.stringify(value),
            ...Object.values(extra),
            runId,
        ]);
        if (result.changes === 0) {
            throw new Error(`unknown team run ${runId}; save the run first`);
        }
    }

    writeBoard(runId: string, snapshot: BoardSnapshot): void {
        this.#set(runId, 'board_json', snapshot, { board_seq: snapshot.seq });
    }

    writeEvents(runId: string, events: readonly BoardEvent[]): void {
        this.#db.transaction(() => {
            for (const event of events) {
                this.#db.run(
                    `insert or ignore into team_board_events (run_id, seq, ts, task_id, type, event_json)
                     values (?, ?, ?, ?, ?, ?)`,
                    [runId, event.seq, event.ts, event.taskId, event.type, JSON.stringify(event)],
                );
            }
        });
    }

    writeTaskLedger(runId: string, snapshot: TaskLedgerSnapshot): void {
        this.#set(runId, 'task_ledger_json', snapshot);
    }

    writeProgress(runId: string, snapshot: ProgressLedgerSnapshot): void {
        this.#set(runId, 'progress_json', snapshot);
    }

    /** The host's bookkeeping for a run: threads, worktrees, verdicts, report; opaque to the workflows package. */
    writeHost(runId: string, host: unknown): void {
        this.#set(runId, 'host_json', host);
    }

    readHost<T>(runId: string): T | undefined {
        const row = this.#row(runId);
        return row?.host_json ? fromJson<T | undefined>(row.host_json, undefined) : undefined;
    }

    #row(runId: string): RunRow | undefined {
        return this.#db.get<RunRow>(
            'select id, run_json, board_json, task_ledger_json, progress_json, host_json from team_runs where id = ?',
            [runId],
        );
    }

    async saveRun(run: TeamRun): Promise<void> {
        this.writeRun(run);
    }

    async loadRun(runId: string): Promise<TeamRun | undefined> {
        const row = this.#row(runId);
        return row ? fromJson<TeamRun | undefined>(row.run_json, undefined) : undefined;
    }

    async listRuns(filter: TeamRunFilter = {}): Promise<TeamRun[]> {
        const where: string[] = [];
        const params: string[] = [];
        if (filter.orgId !== undefined) {
            where.push('org_id = ?');
            params.push(filter.orgId);
        }
        if (filter.projectId !== undefined) {
            where.push('project_id = ?');
            params.push(filter.projectId);
        }
        if (filter.status !== undefined) {
            const statuses = [filter.status].flat();
            where.push(`status in (${statuses.map(() => '?').join(', ')})`);
            params.push(...statuses);
        }
        const rows = this.#db.all<{ run_json: string }>(
            `select run_json from team_runs ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
             order by created_at desc, id desc`,
            params,
        );
        return rows.flatMap((row) => {
            const run = fromJson<TeamRun | undefined>(row.run_json, undefined);
            return run ? [run] : [];
        });
    }

    async deleteRun(runId: string): Promise<void> {
        this.#db.transaction(() => {
            this.#db.run('delete from team_board_events where run_id = ?', [runId]);
            this.#db.run('delete from team_runs where id = ?', [runId]);
        });
    }

    async saveBoard(runId: string, snapshot: BoardSnapshot): Promise<void> {
        this.writeBoard(runId, snapshot);
    }

    async loadBoard(runId: string): Promise<BoardSnapshot | undefined> {
        const row = this.#row(runId);
        return row?.board_json ? fromJson<BoardSnapshot | undefined>(row.board_json, undefined) : undefined;
    }

    async appendBoardEvents(runId: string, events: readonly BoardEvent[]): Promise<void> {
        this.writeEvents(runId, events);
    }

    async loadBoardEvents(runId: string, afterSeq = 0): Promise<BoardEvent[]> {
        return this.#db
            .all<{ event_json: string }>(
                'select event_json from team_board_events where run_id = ? and seq > ? order by seq',
                [runId, afterSeq],
            )
            .flatMap((row) => {
                const event = fromJson<BoardEvent | undefined>(row.event_json, undefined);
                return event ? [event] : [];
            });
    }

    async saveTaskLedger(runId: string, snapshot: TaskLedgerSnapshot): Promise<void> {
        this.writeTaskLedger(runId, snapshot);
    }

    async loadTaskLedger(runId: string): Promise<TaskLedgerSnapshot | undefined> {
        const row = this.#row(runId);
        return row?.task_ledger_json
            ? fromJson<TaskLedgerSnapshot | undefined>(row.task_ledger_json, undefined)
            : undefined;
    }

    async saveProgressLedger(runId: string, snapshot: ProgressLedgerSnapshot): Promise<void> {
        this.writeProgress(runId, snapshot);
    }

    async loadProgressLedger(runId: string): Promise<ProgressLedgerSnapshot | undefined> {
        const row = this.#row(runId);
        return row?.progress_json
            ? fromJson<ProgressLedgerSnapshot | undefined>(row.progress_json, undefined)
            : undefined;
    }
}
