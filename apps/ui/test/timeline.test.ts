import type { EventEnvelope } from '@xora/protocol';
import { describe, expect, it } from 'vitest';
import { applyDelta, applyEvent, latestPlan, viewFromSnapshot } from '../src/timeline.ts';

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
