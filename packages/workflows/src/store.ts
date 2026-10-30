import type { AutonomyLevel } from './autonomy.ts';
import { type BoardEvent, type BoardSnapshot, TaskBoard } from './board.ts';
import { ProgressLedger, type ProgressLedgerSnapshot, TaskLedger, type TaskLedgerSnapshot } from './ledgers.ts';
import type { Currency } from './schemas.ts';
import type { Clock } from './util.ts';

/**
 * Persistence of team runs. The host implements {@link TeamStore} on its own storage; the run's state is a board
 * snapshot plus the board events after it, and the two ledgers, so a run resumes after a restart without
 * redoing finished tasks (06 §9).
 */

export const TEAM_RUN_STATUSES = ['running', 'paused', 'waiting_user', 'completed', 'failed', 'cancelled'] as const;
export type TeamRunStatus = (typeof TEAM_RUN_STATUSES)[number];

/** Steps of the supervisor flow (06 §5); `execute` covers dispatch, execution, acceptance and progress checks. */
export const TEAM_RUN_PHASES = [
    'clarify',
    'scout',
    'plan',
    'plan_review',
    'plan_approval',
    'execute',
    'integrate',
    'report',
    'done',
] as const;
export type TeamRunPhase = (typeof TEAM_RUN_PHASES)[number];

/** One team run: one goal handed to one organization. */
export interface TeamRun {
    readonly id: string;
    readonly goal: string;
    readonly orgId: string;
    readonly projectId?: string;
    readonly status: TeamRunStatus;
    readonly phase: TeamRunPhase;
    readonly autonomy: AutonomyLevel;
    readonly budget?: { readonly limit: number; readonly currency: Currency };
    /** Epoch milliseconds. */
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly finishedAt?: number;
    /** Why the run is paused, waiting for the user or failed. */
    readonly note?: string;
}

export interface TeamRunFilter {
    readonly orgId?: string;
    readonly projectId?: string;
    readonly status?: TeamRunStatus | readonly TeamRunStatus[];
}

export interface TeamStore {
    saveRun(run: TeamRun): Promise<void>;
    loadRun(runId: string): Promise<TeamRun | undefined>;
    /** Newest first. */
    listRuns(filter?: TeamRunFilter): Promise<TeamRun[]>;
    /** Removes the run and everything stored for it. */
    deleteRun(runId: string): Promise<void>;
    saveBoard(runId: string, snapshot: BoardSnapshot): Promise<void>;
    loadBoard(runId: string): Promise<BoardSnapshot | undefined>;
    appendBoardEvents(runId: string, events: readonly BoardEvent[]): Promise<void>;
    /** Events with `seq > afterSeq`, oldest first. */
    loadBoardEvents(runId: string, afterSeq?: number): Promise<BoardEvent[]>;
    saveTaskLedger(runId: string, snapshot: TaskLedgerSnapshot): Promise<void>;
    loadTaskLedger(runId: string): Promise<TaskLedgerSnapshot | undefined>;
    saveProgressLedger(runId: string, snapshot: ProgressLedgerSnapshot): Promise<void>;
    loadProgressLedger(runId: string): Promise<ProgressLedgerSnapshot | undefined>;
}

/** A new run at the start of the flow: running, clarifying, L1 unless said otherwise. */
export function createTeamRun(
    fields: Pick<TeamRun, 'id' | 'goal' | 'orgId'> & Partial<Omit<TeamRun, 'id' | 'goal' | 'orgId'>>,
    now: number = Date.now(),
): TeamRun {
    return { status: 'running', phase: 'clarify', autonomy: 'L1', createdAt: now, updatedAt: now, ...fields };
}

interface StoredRun {
    run: TeamRun;
    board?: BoardSnapshot;
    events: BoardEvent[];
    taskLedger?: TaskLedgerSnapshot;
    progress?: ProgressLedgerSnapshot;
}

/** {@link TeamStore} in memory, for tests and short-lived hosts. Values are copied in and out. */
export class MemoryTeamStore implements TeamStore {
    readonly #runs = new Map<string, StoredRun>();

    async saveRun(run: TeamRun): Promise<void> {
        const stored = this.#runs.get(run.id);
        if (stored) {
            stored.run = structuredClone(run);
        } else {
            this.#runs.set(run.id, { run: structuredClone(run), events: [] });
        }
    }

    async loadRun(runId: string): Promise<TeamRun | undefined> {
        const stored = this.#runs.get(runId);
        return stored ? structuredClone(stored.run) : undefined;
    }

    async listRuns(filter: TeamRunFilter = {}): Promise<TeamRun[]> {
        const statuses = filter.status === undefined ? undefined : new Set([filter.status].flat());
        return [...this.#runs.values()]
            .map((stored) => stored.run)
            .filter(
                (run) =>
                    (filter.orgId === undefined || run.orgId === filter.orgId) &&
                    (filter.projectId === undefined || run.projectId === filter.projectId) &&
                    (statuses === undefined || statuses.has(run.status)),
            )
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((run) => structuredClone(run));
    }

    async deleteRun(runId: string): Promise<void> {
        this.#runs.delete(runId);
    }

    async saveBoard(runId: string, snapshot: BoardSnapshot): Promise<void> {
        this.#stored(runId).board = structuredClone(snapshot);
    }

    async loadBoard(runId: string): Promise<BoardSnapshot | undefined> {
        const board = this.#runs.get(runId)?.board;
        return board ? structuredClone(board) : undefined;
    }

    async appendBoardEvents(runId: string, events: readonly BoardEvent[]): Promise<void> {
        this.#stored(runId).events.push(...structuredClone([...events]));
    }

    async loadBoardEvents(runId: string, afterSeq = 0): Promise<BoardEvent[]> {
        const events = this.#runs.get(runId)?.events ?? [];
        return structuredClone(events.filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq));
    }

    async saveTaskLedger(runId: string, snapshot: TaskLedgerSnapshot): Promise<void> {
        this.#stored(runId).taskLedger = structuredClone(snapshot);
    }

    async loadTaskLedger(runId: string): Promise<TaskLedgerSnapshot | undefined> {
        const ledger = this.#runs.get(runId)?.taskLedger;
        return ledger ? structuredClone(ledger) : undefined;
    }

    async saveProgressLedger(runId: string, snapshot: ProgressLedgerSnapshot): Promise<void> {
        this.#stored(runId).progress = structuredClone(snapshot);
    }

    async loadProgressLedger(runId: string): Promise<ProgressLedgerSnapshot | undefined> {
        const progress = this.#runs.get(runId)?.progress;
        return progress ? structuredClone(progress) : undefined;
    }

    #stored(runId: string): StoredRun {
        const stored = this.#runs.get(runId);
        if (!stored) {
            throw new Error(`unknown team run ${runId}; save the run first`);
        }
        return stored;
    }
}

export interface TeamState {
    readonly run: TeamRun;
    readonly board: TaskBoard;
    /** Absent until the supervisor has written a plan. */
    readonly taskLedger?: TaskLedger;
    readonly progress: ProgressLedger;
}

/** Saves the run, a board snapshot and both ledgers. Board events already persisted stay valid after it. */
export async function saveTeamState(store: TeamStore, state: TeamState): Promise<void> {
    await store.saveRun(state.run);
    await store.saveBoard(state.run.id, state.board.snapshot());
    if (state.taskLedger) {
        await store.saveTaskLedger(state.run.id, state.taskLedger.snapshot());
    }
    await store.saveProgressLedger(state.run.id, state.progress.snapshot());
}

/**
 * Restores a run after a restart (06 §9): the board from its snapshot plus the events after it, and both
 * ledgers. Finished tasks stay done and are not run again. `undefined` for an unknown run.
 */
export async function loadTeamState(
    store: TeamStore,
    runId: string,
    options: { readonly clock?: Clock } = {},
): Promise<TeamState | undefined> {
    const run = await store.loadRun(runId);
    if (!run) {
        return undefined;
    }
    const snapshot = await store.loadBoard(runId);
    const board = snapshot ? TaskBoard.restore(snapshot, options) : new TaskBoard(options);
    board.replayEvents(await store.loadBoardEvents(runId, board.seq));
    const ledger = await store.loadTaskLedger(runId);
    const progress = await store.loadProgressLedger(runId);
    return {
        run,
        board,
        ...(ledger ? { taskLedger: TaskLedger.restore(ledger, options) } : {}),
        progress: progress ? ProgressLedger.restore(progress, options) : new ProgressLedger(options),
    };
}
