import { describe, expect, it } from 'vitest';
import {
    type BoardEvent,
    createTeamRun,
    loadTeamState,
    MemoryTeamStore,
    ProgressLedger,
    saveTeamState,
    TaskBoard,
    TaskLedger,
} from '../src/index.ts';
import { cardInput, deliverable, fakeClock } from './helpers.ts';

describe('createTeamRun', () => {
    it('starts running in the clarify phase at L1', () => {
        expect(createTeamRun({ id: 'run-1', goal: 'add sms login', orgId: 'default' }, 1000)).toEqual({
            id: 'run-1',
            goal: 'add sms login',
            orgId: 'default',
            status: 'running',
            phase: 'clarify',
            autonomy: 'L1',
            createdAt: 1000,
            updatedAt: 1000,
        });
    });
});

describe('MemoryTeamStore', () => {
    it('copies values in and out', async () => {
        const store = new MemoryTeamStore();
        const run = createTeamRun({ id: 'run-1', goal: 'g', orgId: 'default' }, 1);
        await store.saveRun(run);
        const loaded = await store.loadRun('run-1');
        expect(loaded).toEqual(run);
        expect(loaded).not.toBe(run);
        expect(await store.loadRun('missing')).toBeUndefined();
        await expect(store.saveBoard('missing', new TaskBoard().snapshot())).rejects.toThrow(/save the run first/);
    });

    it('lists runs newest first, filtered', async () => {
        const store = new MemoryTeamStore();
        await store.saveRun(createTeamRun({ id: 'a', goal: 'g', orgId: 'default', projectId: 'p1' }, 1));
        await store.saveRun(createTeamRun({ id: 'b', goal: 'g', orgId: 'acme', projectId: 'p1', status: 'paused' }, 2));
        await store.saveRun(createTeamRun({ id: 'c', goal: 'g', orgId: 'default', projectId: 'p2' }, 3));
        expect((await store.listRuns()).map((run) => run.id)).toEqual(['c', 'b', 'a']);
        expect((await store.listRuns({ projectId: 'p1' })).map((run) => run.id)).toEqual(['b', 'a']);
        expect((await store.listRuns({ status: ['paused', 'failed'] })).map((run) => run.id)).toEqual(['b']);
        expect((await store.listRuns({ orgId: 'default', status: 'running' })).map((run) => run.id)).toEqual([
            'c',
            'a',
        ]);
        await store.deleteRun('b');
        expect((await store.listRuns()).map((run) => run.id)).toEqual(['c', 'a']);
    });
});

describe('saveTeamState and loadTeamState', () => {
    it('resumes a run from a snapshot plus later events without redoing finished tasks', async () => {
        const store = new MemoryTeamStore();
        const clock = fakeClock();
        const run = createTeamRun({ id: 'run-1', goal: 'add sms login', orgId: 'default', phase: 'execute' }, clock());
        const board = new TaskBoard({ clock });
        const pending: BoardEvent[] = [];
        board.onEvent((event) => {
            pending.push(event);
        });
        const taskLedger = new TaskLedger('add sms login', { clock });
        const progress = new ProgressLedger({ clock });

        board.addMany([cardInput({ id: 'T1' }), cardInput({ id: 'T2', dependsOn: ['T1'], ownership: ['src/b/**'] })]);
        board.claim('T1', 'coder-1');
        board.submit('T1', 'coder-1', deliverable());
        board.accept('T1');
        taskLedger.revise({ plan: 'two cards' }, 'planned');
        progress.record({ complete: false, progressing: true, looping: false, reason: 'T1 done' });
        await saveTeamState(store, { run, board, taskLedger, progress });
        pending.length = 0;

        board.claim('T2', 'coder-2');
        await store.appendBoardEvents(run.id, pending);

        const state = await loadTeamState(store, run.id, { clock });
        expect(state?.run).toEqual(run);
        expect(state?.board.snapshot()).toEqual(board.snapshot());
        expect(state?.board.get('T1')?.status).toBe('done');
        expect(state?.board.get('T2')).toMatchObject({ status: 'assigned', owner: 'coder-2' });
        expect(state?.taskLedger?.current.plan).toBe('two cards');
        expect(state?.taskLedger?.version).toBe(2);
        expect(state?.progress.entries).toHaveLength(1);
    });

    it('loads a run that has no board or ledgers yet', async () => {
        const store = new MemoryTeamStore();
        await store.saveRun(createTeamRun({ id: 'run-2', goal: 'g', orgId: 'default' }, 1));
        const state = await loadTeamState(store, 'run-2');
        expect(state?.board.list()).toEqual([]);
        expect(state?.taskLedger).toBeUndefined();
        expect(state?.progress.entries).toEqual([]);
        expect(await loadTeamState(store, 'missing')).toBeUndefined();
    });
});
