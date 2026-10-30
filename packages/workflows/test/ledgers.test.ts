import { describe, expect, it } from 'vitest';
import {
    detectLoop,
    isStalled,
    type ProgressEntry,
    ProgressLedger,
    stallCount,
    TaskBoard,
    TaskLedger,
    taskGraph,
} from '../src/index.ts';
import { card, cardInput, fakeClock } from './helpers.ts';

describe('TaskLedger', () => {
    it('versions every revision with time, reason and author', () => {
        const ledger = new TaskLedger('add sms login', { clock: fakeClock(), author: 'supervisor' });
        expect(ledger.version).toBe(1);
        expect(ledger.current).toMatchObject({ goal: 'add sms login', facts: [], plan: '', tasks: [] });

        const second = ledger.revise(
            { facts: ['sms is sent from src/infra/sms.ts'], plan: 'two endpoints behind the rate limiter' },
            'scouting done',
            'supervisor',
        );
        expect(second).toMatchObject({ version: 2, reason: 'scouting done', author: 'supervisor' });
        expect(second.ts).toBeGreaterThan(ledger.at(1)?.ts ?? Number.POSITIVE_INFINITY);

        ledger.revise({ risks: ['vendor error codes are unmapped'] }, 'plan review');
        expect(ledger.version).toBe(3);
        expect(ledger.at(1)?.content.facts).toEqual([]);
        expect(ledger.at(2)?.content.risks).toEqual([]);
        expect(ledger.changes(1)).toEqual(['facts', 'plan', 'risks']);
        expect(ledger.changes(2, 3)).toEqual(['risks']);
        expect(ledger.revisions).toHaveLength(3);
    });

    it('skips revisions that change nothing and requires a reason', () => {
        const ledger = new TaskLedger({ goal: 'g', facts: ['a'] });
        expect(ledger.revise({ facts: ['a'] }, 'same').version).toBe(1);
        expect(() => ledger.revise({ facts: ['b'] }, ' ')).toThrow(/reason/);
    });

    it('appends without duplicates', () => {
        const ledger = new TaskLedger({ goal: 'g', decisions: ['use redis'] });
        ledger.append('decisions', ['use redis', 'expire after 5 minutes', 'expire after 5 minutes', ' '], 'decided');
        expect(ledger.current.decisions).toEqual(['use redis', 'expire after 5 minutes']);
        expect(ledger.version).toBe(2);
    });

    it('keeps old versions intact and round-trips a snapshot', () => {
        const ledger = new TaskLedger({ goal: 'g', facts: ['a'] }, { clock: fakeClock() });
        const facts = [...ledger.current.facts, 'b'];
        ledger.revise({ facts }, 'more facts');
        facts.push('mutated later');
        expect(ledger.current.facts).toEqual(['a', 'b']);
        expect(Object.isFrozen(ledger.current)).toBe(true);

        const restored = TaskLedger.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
        expect(restored.revisions).toEqual(ledger.revisions);
        expect(() => TaskLedger.restore({ kind: 'task_ledger', revisions: [] })).toThrow();
    });

    it('snapshots the task graph from cards or board tasks', () => {
        const board = new TaskBoard();
        board.addMany([cardInput({ id: 'T1', assignee: 'coder-1' }), cardInput({ id: 'T2', dependsOn: ['T1'] })]);
        expect(taskGraph(board.list())).toEqual([
            {
                id: 'T1',
                title: 'Add the sms endpoints',
                dependsOn: [],
                tier: 'economy',
                assignee: 'coder-1',
                status: 'ready',
            },
            { id: 'T2', title: 'Add the sms endpoints', dependsOn: ['T1'], tier: 'economy', status: 'pending' },
        ]);
        expect(taskGraph([card()])).toEqual([
            { id: 'T1', title: 'Add the sms endpoints', dependsOn: [], tier: 'economy' },
        ]);
    });
});

const step = (fields: Partial<ProgressEntry>): Omit<ProgressEntry, 'ts'> => ({
    complete: false,
    progressing: true,
    looping: false,
    reason: 'step',
    ...fields,
});

describe('ProgressLedger', () => {
    it('stalls after three entries in a row without progress', () => {
        const ledger = new ProgressLedger({ clock: fakeClock() });
        ledger.record(step({ nextAssignee: 'coder-1', instruction: 'implement T1' }));
        ledger.record(step({ progressing: false }));
        ledger.record(step({ progressing: false }));
        expect(ledger.stalled()).toBe(false);
        ledger.record(step({ progressing: true, looping: true }));
        expect(stallCount(ledger.entries)).toBe(3);
        expect(ledger.stalled()).toBe(true);
        expect(ledger.stalled(4)).toBe(false);
    });

    it('resets the count on progress and after a replan', () => {
        const ledger = new ProgressLedger();
        for (let index = 0; index < 3; index += 1) {
            ledger.record(step({ progressing: false }));
        }
        expect(ledger.stalled()).toBe(true);
        ledger.markReplanned();
        expect(ledger.replans).toBe(1);
        ledger.record(step({ progressing: false }));
        expect(ledger.stalled()).toBe(false);
        expect(ledger.current).toHaveLength(1);
        expect(ledger.entries).toHaveLength(4);

        const restored = ProgressLedger.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
        expect(restored.current).toHaveLength(1);
        expect(restored.replans).toBe(1);
    });

    it('never counts a complete entry as a stall', () => {
        expect(
            isStalled(
                [step({ progressing: false }), step({ progressing: false }), step({ complete: true })].map(
                    (entry, ts) => ({ ...entry, ts }),
                ),
            ),
        ).toBe(false);
        expect(isStalled([], 3)).toBe(false);
    });
});

describe('detectLoop', () => {
    it('spots the same action repeated without new information', () => {
        expect(detectLoop(['read src/a.ts', 'grep sms', 'grep sms', 'grep  sms '])).toEqual({
            looping: true,
            period: 1,
            repeats: 3,
            actions: ['grep sms'],
        });
    });

    it('spots alternating actions', () => {
        const actions = ['run tests', 'edit a.ts', 'run tests', 'edit a.ts', 'run tests', 'edit a.ts'];
        expect(detectLoop(actions)).toMatchObject({ looping: true, period: 2, repeats: 3 });
    });

    it('is not a loop when the observation changes or the actor differs', () => {
        expect(
            detectLoop([
                { action: 'pnpm test', observation: '3 failed' },
                { action: 'pnpm test', observation: '2 failed' },
                { action: 'pnpm test', observation: '1 failed' },
            ]).looping,
        ).toBe(false);
        expect(
            detectLoop([
                { actor: 'coder-1', action: 'pnpm test' },
                { actor: 'coder-2', action: 'pnpm test' },
                { actor: 'coder-1', action: 'pnpm test' },
            ]).looping,
        ).toBe(false);
        expect(detectLoop(['a', 'a']).looping).toBe(false);
        expect(detectLoop(['a', 'a'], { minRepeats: 2 }).looping).toBe(true);
    });
});
