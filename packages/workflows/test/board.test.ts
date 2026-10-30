import { describe, expect, it } from 'vitest';
import {
    type BoardEvent,
    type BoardResult,
    type BoardTask,
    checkCard,
    findDependencyCycle,
    outOfOwnership,
    shouldEscalate,
    TaskBoard,
} from '../src/index.ts';
import { card, cardInput, deliverable, fakeClock } from './helpers.ts';

function value<T>(result: BoardResult<T>): T {
    if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    return result.value;
}

function errorCode<T>(result: BoardResult<T>): string | undefined {
    return result.ok ? undefined : result.error.code;
}

function board(): TaskBoard {
    return new TaskBoard({ clock: fakeClock() });
}

/** Runs a claimed task through delivery to review. */
function deliver(target: TaskBoard, taskId: string, agentId: string, fields = {}): BoardTask {
    value(target.start(taskId, agentId));
    return value(target.submit(taskId, agentId, deliverable({ taskId, ...fields })));
}

describe('quality gate', () => {
    it('rejects a card without acceptance criteria', () => {
        const result = board().add(cardInput({ acceptance: [] }));
        expect(errorCode(result)).toBe('missing_acceptance');
        expect(!result.ok && result.error.message).toContain('no acceptance criteria');
        expect(errorCode(checkCard(cardInput({ acceptance: undefined })))).toBe('missing_acceptance');
    });

    it('rejects malformed cards with readable issues', () => {
        const result = board().add({ ...cardInput(), tier: 'premium', goal: '' });
        expect(errorCode(result)).toBe('invalid_card');
        expect(!result.ok && result.error.details).toEqual([
            expect.stringContaining('goal:'),
            expect.stringContaining('tier:'),
        ]);
    });

    it('rejects duplicates, unknown dependencies and self-dependencies', () => {
        const tasks = board();
        value(tasks.add(cardInput()));
        expect(errorCode(tasks.add(cardInput()))).toBe('duplicate_task');
        expect(errorCode(tasks.add(cardInput({ id: 'T2', dependsOn: ['T9'] })))).toBe('unknown_dependency');
        expect(errorCode(tasks.add(cardInput({ id: 'T3', dependsOn: ['T3'] })))).toBe('dependency_cycle');
        expect(tasks.list()).toHaveLength(1);
    });
});

describe('dependencies', () => {
    it('keeps a task pending until its dependencies are done', () => {
        const tasks = board();
        value(
            tasks.addMany([
                cardInput({ id: 'T1' }),
                cardInput({ id: 'T2', dependsOn: ['T1'], ownership: ['src/b/**'] }),
            ]),
        );
        expect(tasks.ready().map((task) => task.card.id)).toEqual(['T1']);
        expect(tasks.get('T2')?.status).toBe('pending');
        expect(tasks.waitingOn('T2')).toEqual(['T1']);
        expect(errorCode(tasks.claim('T2', 'coder-1'))).toBe('invalid_transition');

        value(tasks.claim('T1', 'coder-1'));
        deliver(tasks, 'T1', 'coder-1');
        value(tasks.accept('T1'));
        expect(tasks.get('T2')?.status).toBe('ready');
        expect(tasks.waitingOn('T2')).toEqual([]);
    });

    it('detects cycles in a batch and on update, all or nothing', () => {
        const tasks = board();
        const result = tasks.addMany([
            cardInput({ id: 'A', dependsOn: ['C'] }),
            cardInput({ id: 'B', dependsOn: ['A'] }),
            cardInput({ id: 'C', dependsOn: ['B'] }),
        ]);
        expect(errorCode(result)).toBe('dependency_cycle');
        expect(!result.ok && result.error.details).toEqual(['A', 'C', 'B', 'A']);
        expect(tasks.list()).toEqual([]);

        value(tasks.addMany([cardInput({ id: 'A' }), cardInput({ id: 'B', dependsOn: ['A'] })]));
        expect(errorCode(tasks.update('A', { dependsOn: ['B'] }))).toBe('dependency_cycle');
        expect(
            findDependencyCycle([
                { id: 'x', dependsOn: ['y'] },
                { id: 'y', dependsOn: [] },
            ]),
        ).toBeUndefined();
    });

    it('orders tasks for integration and moves a ready task back to pending on a new dependency', () => {
        const tasks = board();
        value(
            tasks.addMany([
                cardInput({ id: 'T3', dependsOn: ['T2'] }),
                cardInput({ id: 'T2', dependsOn: ['T1'] }),
                cardInput({ id: 'T1' }),
                cardInput({ id: 'T4' }),
            ]),
        );
        expect(tasks.topologicalOrder()).toEqual(['T1', 'T2', 'T3', 'T4']);
        value(tasks.update('T4', { dependsOn: ['T3'] }));
        expect(tasks.get('T4')?.status).toBe('pending');
    });
});

describe('claims', () => {
    it('gives each task one owner; a second claim fails', () => {
        const tasks = board();
        value(tasks.add(cardInput()));
        expect(value(tasks.claim('T1', 'coder-1'))).toMatchObject({ status: 'assigned', owner: 'coder-1' });
        expect(errorCode(tasks.claim('T1', 'coder-2'))).toBe('already_claimed');
        expect(tasks.claim('T1', 'coder-1').ok).toBe(true);
        expect(errorCode(tasks.start('T1', 'coder-2'))).toBe('not_owner');
        expect(errorCode(tasks.submit('T1', 'coder-2', deliverable()))).toBe('not_owner');
    });

    it('needs ownership before a writable task is dispatched', () => {
        const tasks = board();
        value(tasks.add(cardInput({ ownership: [] })));
        expect(errorCode(tasks.claim('T1', 'coder-1'))).toBe('missing_ownership');
        value(tasks.add(cardInput({ id: 'S1', ownership: [], workspace: 'readonly' })));
        expect(tasks.claim('S1', 'scout-1').ok).toBe(true);
    });

    it('keeps parallel executors off the same files', () => {
        const tasks = board();
        value(
            tasks.addMany([
                cardInput({ id: 'T1', ownership: ['src/auth/**'] }),
                cardInput({ id: 'T2', ownership: ['src/auth/sms/verify.ts'] }),
                cardInput({ id: 'T3', ownership: ['src/routes/**'] }),
                cardInput({ id: 'S1', ownership: [], workspace: 'readonly', priority: 'critical' }),
            ]),
        );
        expect(tasks.dispatchable().map((task) => task.card.id)).toEqual(['S1', 'T1', 'T3']);
        value(tasks.claim('T1', 'coder-1'));
        expect(tasks.conflicts('T2')).toEqual([{ taskId: 'T1', globs: [['src/auth/sms/verify.ts', 'src/auth/**']] }]);
        const conflict = tasks.claim('T2', 'coder-2');
        expect(errorCode(conflict)).toBe('ownership_conflict');
        expect(!conflict.ok && conflict.error.details).toEqual(['T1: src/auth/sms/verify.ts ~ src/auth/**']);
        expect(tasks.dispatchable().map((task) => task.card.id)).toEqual(['S1', 'T3']);
        expect(tasks.claim('T3', 'coder-3').ok).toBe(true);
        expect(tasks.claim('T2', 'coder-2', { allowOverlap: true }).ok).toBe(true);
    });

    it('lists what an idle agent still holds', () => {
        const tasks = board();
        value(tasks.add(cardInput()));
        value(tasks.claim('T1', 'coder-1'));
        expect(tasks.unfinishedFor('coder-1').map((task) => task.card.id)).toEqual(['T1']);
        deliver(tasks, 'T1', 'coder-1');
        expect(tasks.unfinishedFor('coder-1')).toEqual([]);
    });
});

describe('lifecycle', () => {
    it('goes pending → ready → assigned → in_progress → in_review → done', () => {
        const tasks = board();
        const statuses: string[] = [];
        tasks.onEvent((event) => {
            if (event.type === 'status') {
                statuses.push(event.to);
            }
        });
        value(tasks.add(cardInput()));
        value(tasks.claim('T1', 'coder-1'));
        const reviewed = deliver(tasks, 'T1', 'coder-1');
        expect(reviewed.deliverable?.summary).toContain('5 minutes');
        const done = value(tasks.accept('T1'));
        expect(statuses).toEqual(['ready', 'assigned', 'in_progress', 'in_review', 'done']);
        expect(done).toMatchObject({ status: 'done', owner: 'coder-1', retries: 0 });
        expect(done.attempts).toEqual([
            { tier: 'economy', outcome: 'pass', by: 'executor', agentId: 'coder-1', ts: expect.any(Number) },
        ]);
        expect(tasks.isComplete()).toBe(true);
        expect(errorCode(tasks.cancel('T1', 'too late'))).toBe('invalid_transition');
    });

    it('sends a failed deliverable back, then escalates after two failures', () => {
        const tasks = board();
        value(tasks.add(cardInput()));
        value(tasks.claim('T1', 'coder-1'));
        deliver(tasks, 'T1', 'coder-1');
        const retried = value(tasks.reject('T1', '`pnpm test src/auth` exited with 1'));
        expect(retried).toMatchObject({ status: 'in_progress', owner: 'coder-1', retries: 1 });
        expect(shouldEscalate(retried.attempts)).toEqual({ action: 'retry', failures: 1 });

        value(tasks.submit('T1', 'coder-1', deliverable()));
        const failedTwice = value(tasks.reject('T1', 'still failing'));
        const decision = shouldEscalate(failedTwice.attempts);
        expect(decision).toEqual({ action: 'escalate', from: 'economy', to: 'standard', reason: 'failed_acceptance' });

        const escalated = value(tasks.escalate('T1', 'standard', 'failed acceptance twice'));
        expect(escalated).toMatchObject({ status: 'ready', tier: 'standard', retries: 0 });
        expect(escalated.owner).toBeUndefined();
        expect(errorCode(tasks.escalate('T1', 'economy', 'down'))).toBe('invalid_transition');
        value(tasks.claim('T1', 'debugger-1'));
        expect(errorCode(tasks.escalate('T1', 'economy', 'down'))).toBe('invalid_tier');
    });

    it('records an executor escalation and hands flagship failures to the supervisor', () => {
        const tasks = board();
        value(tasks.add(cardInput({ tier: 'flagship' })));
        value(tasks.claim('T1', 'specialist-1'));
        const escalated = deliver(tasks, 'T1', 'specialist-1', {
            status: 'escalate',
            escalate: { to: 'flagship', reason: 'beyond me', findings: ['race in queue.ts'] },
        });
        expect(escalated.attempts.at(-1)).toMatchObject({
            outcome: 'escalate',
            tier: 'flagship',
            escalateTo: 'flagship',
        });
        expect(errorCode(tasks.accept('T1'))).toBe('invalid_transition');
        expect(shouldEscalate(escalated.attempts)).toEqual({ action: 'supervisor', reason: 'requested' });

        const handed = value(tasks.escalate('T1', 'supervisor', 'flagship escalated'));
        expect(handed).toMatchObject({ status: 'ready', handler: 'supervisor' });
        value(tasks.claim('T1', 'supervisor'));
        deliver(tasks, 'T1', 'supervisor');
        const failed = value(tasks.reject('T1', 'still broken'));
        expect(failed.attempts.at(-1)).toMatchObject({ by: 'supervisor' });
        expect(shouldEscalate(failed.attempts)).toEqual({ action: 'human', reason: 'supervisor_failed' });
        expect(errorCode(tasks.escalate('T1', 'supervisor', 'again'))).toBe('invalid_tier');
    });

    it('blocks, unblocks, fails, retries and cancels', () => {
        const tasks = board();
        value(tasks.addMany([cardInput({ id: 'T1' }), cardInput({ id: 'T2', dependsOn: ['T1'] })]));
        value(tasks.claim('T1', 'coder-1'));
        value(tasks.start('T1', 'coder-1'));
        expect(value(tasks.block('T1', 'waiting for the sms key'))).toMatchObject({
            status: 'blocked',
            owner: 'coder-1',
            note: 'waiting for the sms key',
        });
        expect(errorCode(tasks.claim('T1', 'coder-1'))).toBe('invalid_transition');
        expect(errorCode(tasks.claim('T1', 'coder-2'))).toBe('already_claimed');
        expect(value(tasks.unblock('T1'))).toMatchObject({ status: 'in_progress', owner: 'coder-1' });
        const failed = value(tasks.fail('T1', 'gave up'));
        expect(failed).toMatchObject({ status: 'failed', note: 'gave up' });
        expect(failed.owner).toBeUndefined();
        expect(value(tasks.retry('T1')).status).toBe('ready');
        expect(value(tasks.cancel('T2', 'not needed')).status).toBe('cancelled');
        expect(errorCode(tasks.unblock('T1'))).toBe('invalid_transition');
        expect(errorCode(tasks.accept('T9'))).toBe('unknown_task');
    });

    it('validates deliverables on submit', () => {
        const tasks = board();
        value(tasks.add(cardInput()));
        value(tasks.claim('T1', 'coder-1'));
        expect(errorCode(tasks.submit('T1', 'coder-1', deliverable({ taskId: 'T2' })))).toBe('invalid_deliverable');
        expect(errorCode(tasks.submit('T1', 'coder-1', { taskId: 'T1' } as never))).toBe('invalid_deliverable');
        expect(value(tasks.submit('T1', 'coder-1', deliverable())).status).toBe('in_review');
    });

    it('edits only tasks that are not running', () => {
        const tasks = board();
        value(tasks.add(cardInput()));
        expect(value(tasks.update('T1', { tier: 'standard', tierReason: 'tricky', id: 'X' } as never))).toMatchObject({
            tier: 'standard',
            card: { id: 'T1', tier: 'standard' },
        });
        expect(errorCode(tasks.update('T1', { acceptance: [] }))).toBe('missing_acceptance');
        value(tasks.claim('T1', 'coder-1'));
        expect(errorCode(tasks.update('T1', { goal: 'other' }))).toBe('invalid_transition');
    });
});

describe('events and persistence', () => {
    function busyBoard(): TaskBoard {
        const tasks = board();
        value(
            tasks.addMany([
                cardInput({ id: 'T1' }),
                cardInput({ id: 'T2', dependsOn: ['T1'], ownership: ['src/b/**'] }),
            ]),
        );
        value(tasks.claim('T1', 'coder-1'));
        deliver(tasks, 'T1', 'coder-1');
        value(tasks.reject('T1', 'try again'));
        value(tasks.submit('T1', 'coder-1', deliverable()));
        value(tasks.accept('T1'));
        value(tasks.claim('T2', 'coder-2'));
        return tasks;
    }

    it('numbers events and replays them into the same state', () => {
        const tasks = busyBoard();
        const events = tasks.events();
        expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
        expect(tasks.seq).toBe(events.length);
        const replayed = TaskBoard.replay(JSON.parse(JSON.stringify(events)) as BoardEvent[]);
        expect(replayed.snapshot()).toEqual(tasks.snapshot());
    });

    it('restores from a snapshot plus later events', () => {
        const tasks = busyBoard();
        const snapshot = JSON.parse(JSON.stringify(tasks.snapshot()));
        const restored = TaskBoard.restore(snapshot, { clock: fakeClock() });
        value(tasks.start('T2', 'coder-2'));
        restored.replayEvents(tasks.events(snapshot.seq));
        expect(restored.snapshot()).toEqual(tasks.snapshot());
        expect(restored.get('T1')?.status).toBe('done');
        expect(() => TaskBoard.restore({ version: 2, seq: 0, tasks: [] })).toThrow(/invalid board snapshot/);
    });

    it('keeps records frozen and notifies after the whole command', () => {
        const tasks = board();
        const seen: number[] = [];
        const stop = tasks.onEvent(() => {
            seen.push(tasks.seq);
        });
        value(tasks.add(cardInput()));
        expect(seen).toEqual([2, 2]);
        stop();
        value(tasks.claim('T1', 'coder-1'));
        expect(seen).toHaveLength(2);
        const task = tasks.get('T1');
        expect(Object.isFrozen(task)).toBe(true);
        expect(Object.isFrozen(task?.card.ownership)).toBe(true);
    });

    it('rethrows a listener error after the state is consistent', () => {
        const tasks = board();
        tasks.onEvent(() => {
            throw new Error('disk full');
        });
        expect(() => tasks.add(cardInput())).toThrow('disk full');
        expect(tasks.get('T1')?.status).toBe('ready');
    });
});

describe('outOfOwnership on a card', () => {
    it('flags changes outside the card ownership red', () => {
        expect(outOfOwnership(card(), ['src/auth/sms/send.ts', 'src/db/schema.ts'])).toEqual(['src/db/schema.ts']);
    });
});
