import type { EventEnvelope } from '@xora/protocol';
import { describe, expect, it } from 'vitest';
import {
    applyDelta,
    applyEvent,
    latestPlan,
    latestPlanOf,
    planProgress,
    type TurnView,
    viewFromSnapshot,
    visibleItems,
} from '../src/timeline.ts';

function envelope(seq: number, kind: string, payload: unknown, turnId?: string): EventEnvelope {
    return { threadId: 't1', seq, ts: seq, kind, payload, ...(turnId ? { turnId } : {}) };
}

const started = envelope(
    2,
    'turn.started',
    {
        turnId: 'u1',
        input: { id: 'i1', turnId: 'u1', ts: 1, type: 'user_message', text: 'hi', attachments: [] },
        model: null,
        mode: 'ask',
        effort: 'high',
    },
    'u1',
);

describe('timeline', () => {
    it('builds turns from events and keeps item order', () => {
        const view = viewFromSnapshot({
            thread: {} as never,
            events: [
                envelope(1, 'thread.created', {}),
                started,
                envelope(3, 'item.completed', {
                    item: { id: 'a', turnId: 'u1', ts: 3, type: 'agent_message', text: 'hello' },
                }),
                envelope(4, 'item.started', {
                    item: {
                        id: 'b',
                        turnId: 'u1',
                        ts: 4,
                        type: 'tool_call',
                        toolCallId: 'c1',
                        title: 'read',
                        kind: 'read',
                        status: 'pending',
                    },
                }),
                envelope(5, 'item.completed', {
                    item: {
                        id: 'b',
                        turnId: 'u1',
                        ts: 5,
                        type: 'tool_call',
                        toolCallId: 'c1',
                        title: 'read',
                        kind: 'read',
                        status: 'completed',
                    },
                }),
                envelope(6, 'turn.completed', {
                    turnId: 'u1',
                    stopReason: 'end_turn',
                    durationMs: 10,
                    usage: { requests: 1, inputTokens: 1, cachedTokens: 0, outputTokens: 1, cost: null },
                }),
            ],
            live: [],
            lastSeq: 6,
        });
        expect(view.turns).toHaveLength(1);
        const turn = view.turns[0];
        expect(turn?.status).toBe('completed');
        expect(turn?.items.map((item) => item.id)).toEqual(['a', 'b']);
        expect(turn?.items[1]).toMatchObject({ status: 'completed' });
    });

    it('ignores duplicates and reports gaps', () => {
        const view = viewFromSnapshot({
            thread: {} as never,
            events: [envelope(1, 'thread.created', {}), started],
            live: [],
            lastSeq: 2,
        });
        expect(applyEvent(view, started)).toBe(true);
        expect(view.turns).toHaveLength(1);
        expect(applyEvent(view, envelope(5, 'turn.failed', { turnId: 'u1', error: {}, durationMs: 1 }, 'u1'))).toBe(
            false,
        );
    });

    it('streams deltas into in-flight items', () => {
        const view = viewFromSnapshot({
            thread: {} as never,
            events: [envelope(1, 'thread.created', {}), started],
            live: [],
            lastSeq: 2,
        });
        applyDelta(view, { turnId: 'u1', itemId: 'x', stream: 'agent_message', text: '你' });
        applyDelta(view, { turnId: 'u1', itemId: 'x', stream: 'agent_message', text: '好' });
        expect(view.turns[0]?.items).toEqual([
            expect.objectContaining({ id: 'x', type: 'agent_message', text: '你好' }),
        ]);
    });

    it('finds the latest plan', () => {
        const view = viewFromSnapshot({
            thread: {} as never,
            events: [envelope(1, 'thread.created', {}), started],
            live: [],
            lastSeq: 2,
        });
        applyEvent(
            view,
            envelope(3, 'item.completed', {
                item: {
                    id: 'plan-u1',
                    turnId: 'u1',
                    ts: 3,
                    type: 'plan',
                    entries: [{ content: 'step', status: 'pending' }],
                },
            }),
        );
        expect(latestPlan(view)?.entries).toEqual([{ content: 'step', status: 'pending' }]);
    });
});

describe('rewound turns', () => {
    function turnStarted(seq: number, turnId: string) {
        return envelope(
            seq,
            'turn.started',
            {
                turnId,
                input: { id: `i-${turnId}`, turnId, ts: seq, type: 'user_message', text: turnId, attachments: [] },
                model: null,
                mode: 'ask',
                effort: 'high',
            },
            turnId,
        );
    }

    it('marks the rewound turn and the later ones, but not turns after the rewind', () => {
        const view = viewFromSnapshot({
            thread: {} as never,
            events: [
                turnStarted(1, 'a'),
                turnStarted(2, 'b'),
                turnStarted(3, 'c'),
                envelope(4, 'thread.rewound', { turnId: 'b', files: true, paths: [], conflicts: [] }, 'b'),
                turnStarted(5, 'd'),
            ],
            lastSeq: 5,
            live: [],
        } as never);
        expect(view.turns.map((turn) => [turn.turnId, Boolean(turn.rewound)])).toEqual([
            ['a', false],
            ['b', true],
            ['c', true],
            ['d', false],
        ]);
    });
});

describe('subagent cards', () => {
    const tool = (id: string, toolCallId: string) =>
        ({
            id,
            turnId: 'u1',
            ts: 1,
            type: 'tool_call',
            toolCallId,
            name: 'agent',
            title: 'agent',
            kind: 'other',
            status: 'in_progress',
        }) as const;

    it('show a subagent in place of the tool call that started it', () => {
        const items = [
            tool('a', 'c1'),
            tool('b', 'c2'),
            {
                id: 's1',
                turnId: 'u1',
                ts: 2,
                type: 'subagent',
                taskId: 'c1',
                toolCallId: 'c1',
                title: '查找入口',
                agent: '',
                status: 'running',
                threadId: 't2',
            } as const,
        ];
        // The second call has no card yet (it waits for a slot), so its tool call still shows.
        expect(visibleItems(items).map((item) => item.id)).toEqual(['b', 's1']);
        const plain = items.slice(0, 2);
        expect(visibleItems(plain)).toBe(plain);
    });

    it("show the chief's card of work handed on in place of the tool call (06 §23)", () => {
        const items = [
            { ...tool('a', 'c1'), name: 'team_start', title: 'team_start' },
            {
                id: 'd1',
                turnId: 'u1',
                ts: 2,
                type: 'delegation',
                kind: 'team',
                refId: 'team_1',
                projectId: 'p1',
                title: '做个待办应用',
                status: 'running',
                toolCallId: 'c1',
            } as const,
        ];
        expect(visibleItems(items).map((item) => item.id)).toEqual(['d1']);
    });
});

describe('the plan (03 §4)', () => {
    const plan = (turnId: string, statuses: Array<'pending' | 'in_progress' | 'completed'>) =>
        ({
            id: `plan-${turnId}`,
            turnId,
            ts: 1,
            type: 'plan',
            entries: statuses.map((status, index) => ({ content: `第${index + 1}步`, status })),
        }) as const;
    const todoCall = (id: string) =>
        ({
            id,
            turnId: 'u1',
            ts: 1,
            type: 'tool_call',
            toolCallId: `c-${id}`,
            name: 'todo',
            title: 'Update todos (2)',
            kind: 'think',
            status: 'completed',
        }) as const;
    const turn = (turnId: string, items: TurnView['items'], status: TurnView['status'] = 'completed'): TurnView => ({
        turnId,
        input: { id: `in-${turnId}`, turnId, ts: 1, type: 'user_message', text: '', attachments: [] },
        model: null,
        mode: 'ask',
        effort: 'high',
        startedAt: 1,
        items,
        status,
    });

    it('shows each todo call where it was made, not the plan item, which an engine without them still shows', () => {
        const items = [todoCall('t1'), plan('u1', ['in_progress', 'pending']), todoCall('t2')];
        expect(visibleItems(items).map((item) => item.id)).toEqual(['t1', 't2']);
        const other = [plan('u1', ['in_progress'])];
        expect(visibleItems(other)).toBe(other);
    });

    it('finds the latest plan and the turn it is in, live only while that turn runs', () => {
        const older = turn('u1', [plan('u1', ['completed', 'in_progress'])]);
        const latest = turn('u2', [], 'running');
        expect(latestPlanOf([older, latest])).toMatchObject({ turn: older, plan: { id: 'plan-u1' }, live: false });
        expect(latestPlanOf([latest])).toBeUndefined();
        const working = turn('u2', [plan('u2', ['in_progress'])], 'running');
        expect(latestPlanOf([older, working])).toMatchObject({ turn: working, live: true });
        // A turn gone back from is out of the agent's context: its plan does not count, nor does it count as latest.
        const rewound = { ...turn('u2', [plan('u2', ['in_progress'])]), rewound: true };
        expect(latestPlanOf([older, rewound])).toMatchObject({ turn: older, live: false });
        expect(latestPlanOf([rewound])).toBeUndefined();
    });

    it('says how far along a plan is and the step in hand, or where it stopped', () => {
        const entries = plan('u1', ['completed', 'in_progress', 'pending']).entries;
        expect(planProgress(entries, true)).toEqual({ done: 1, total: 3, step: '第2步', state: 'now' });
        expect(planProgress(entries, false)).toEqual({ done: 1, total: 3, step: '第2步', state: 'stopped' });
        const waiting = plan('u1', ['completed', 'pending']).entries;
        expect(planProgress(waiting, true)).toEqual({ done: 1, total: 2, step: '第2步', state: 'next' });
        expect(planProgress(plan('u1', ['completed']).entries, true)).toEqual({ done: 1, total: 1, state: 'done' });
    });
});
