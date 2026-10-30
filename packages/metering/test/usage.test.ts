import { describe, expect, it } from 'vitest';
import { aggregate, MissingRateError, priceUsage, supervisionShare, type UsageEvent } from '../src/index.ts';
import { table, usageEvent } from './helpers.ts';

const SHANGHAI = { currency: 'CNY' as const, rates: { USD_CNY: 7 }, timezone: 'Asia/Shanghai' };
const cny = (amount: number, complete = true) => ({
    amount,
    currency: 'CNY' as const,
    tableId: 'deepseek-flash@2026-10',
    period: 'peak' as const,
    complete,
});
const usd = (amount: number, complete = true) => ({
    amount,
    currency: 'USD' as const,
    tableId: 'kimi-k3@2026-10',
    period: 'flat' as const,
    complete,
});

function sample(): UsageEvent[] {
    return [
        usageEvent({
            provider: 'deepseek',
            agentId: 'coder-1',
            ts: Date.parse('2026-10-30T10:00:00+08:00'),
            inputTokens: 1000,
            cachedTokens: 600,
            outputTokens: 200,
            reasoningTokens: 50,
            serverToolCalls: { search: 2 },
            cost: cny(2),
        }),
        usageEvent({
            provider: 'deepseek',
            agentId: 'coder-1',
            // Friday in UTC, already Saturday in Beijing.
            ts: Date.parse('2026-10-30T17:00:00Z'),
            inputTokens: 1000,
            outputTokens: 100,
            requests: 2,
            serverToolCalls: { search: 1, fetch: 4 },
            cost: cny(1),
        }),
        usageEvent({
            provider: 'kimi',
            model: 'kimi-k3',
            role: 'supervisor',
            inputTokens: 500,
            cachedTokens: 500,
            cost: usd(0.5, false),
        }),
        usageEvent({ provider: 'glm', model: 'glm-5.3', inputTokens: 300 }),
    ];
}

describe('aggregate', () => {
    it('groups, converts currencies and sorts by cost', () => {
        const rows = aggregate(sample(), ['provider'], SHANGHAI);
        expect(rows.map((row) => [row.key.provider, row.cost, row.complete])).toEqual([
            ['kimi', 3.5, false],
            ['deepseek', 3, true],
            ['glm', 0, false],
        ]);
        const deepseek = rows[1];
        expect(deepseek).toMatchObject({
            events: 2,
            requests: 3,
            inputTokens: 2000,
            cachedTokens: 600,
            outputTokens: 300,
            reasoningTokens: 50,
            serverToolCalls: { search: 3, fetch: 4 },
            currency: 'CNY',
            cacheHitRate: 0.3,
        });
    });

    it('groups by local day in the given time zone', () => {
        const deepseekOnly = sample().slice(0, 2);
        const beijing = aggregate(deepseekOnly, ['day'], SHANGHAI);
        expect(beijing.map((row) => [row.key.day, row.cost])).toEqual([
            ['2026-10-30', 2],
            ['2026-10-31', 1],
        ]);
        const utc = aggregate(deepseekOnly, ['day'], { ...SHANGHAI, timezone: 'UTC' });
        expect(utc.map((row) => [row.key.day, row.cost])).toEqual([['2026-10-30', 3]]);
    });

    it('combines several dimensions and fills missing values with an empty string', () => {
        const rows = aggregate(sample(), ['agentId', 'day'], SHANGHAI);
        expect(rows.map((row) => row.key)).toEqual([
            { agentId: '', day: '2026-10-30' },
            { agentId: 'coder-1', day: '2026-10-30' },
            { agentId: 'coder-1', day: '2026-10-31' },
        ]);
        expect(rows[0]).toMatchObject({ events: 2, cost: 3.5, complete: false });
    });

    it('gives a single total row without dimensions', () => {
        const [total, ...rest] = aggregate(sample(), [], SHANGHAI);
        expect(rest).toEqual([]);
        expect(total).toMatchObject({
            key: {},
            events: 4,
            requests: 5,
            inputTokens: 2800,
            cachedTokens: 1100,
            cost: 6.5,
        });
        expect(total?.cacheHitRate).toBeCloseTo(1100 / 2800, 12);
    });

    it('needs a rate only when currencies actually differ', () => {
        expect(() => aggregate(sample(), ['provider'], { currency: 'CNY', timezone: 'UTC' })).toThrow(MissingRateError);
        const dollars = aggregate(sample().slice(2, 3), [], { currency: 'USD', timezone: 'UTC' });
        expect(dollars[0]).toMatchObject({ cost: 0.5, currency: 'USD', cacheHitRate: 1 });
    });

    it('returns no rows for no events and accepts costs straight from priceUsage', () => {
        expect(aggregate([], ['provider'], SHANGHAI)).toEqual([]);
        const at = new Date('2026-10-26T10:00:00+08:00');
        const tokens = {
            inputTokens: 1_000_000,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
        };
        const priced = usageEvent({ ...tokens, cost: priceUsage(table('deepseek-flash@2026-10'), tokens, { at }) });
        expect(aggregate([priced], ['model'], SHANGHAI)[0]).toMatchObject({
            key: { model: 'deepseek-flash' },
            cost: 2,
        });
    });
});

describe('supervisionShare', () => {
    it('is the supervisor share of total cost', () => {
        const events = [
            usageEvent({ role: 'supervisor', cost: cny(3) }),
            usageEvent({ role: 'executor', cost: cny(6) }),
            usageEvent({ role: 'reviewer', cost: cny(3) }),
            usageEvent({ role: 'supervisor' }),
        ];
        expect(supervisionShare(events)).toBe(0.25);
    });

    it('converts mixed currencies', () => {
        const events = [
            usageEvent({ role: 'supervisor', cost: usd(1) }),
            usageEvent({ role: 'executor', cost: cny(21) }),
        ];
        expect(supervisionShare(events, { USD_CNY: 7 })).toBeCloseTo(0.25, 12);
        expect(() => supervisionShare(events)).toThrow(MissingRateError);
    });

    it('is 0 when nothing was spent', () => {
        expect(supervisionShare([])).toBe(0);
        expect(supervisionShare([usageEvent({ role: 'supervisor' })])).toBe(0);
        expect(supervisionShare([usageEvent({ role: 'supervisor', cost: cny(0) })])).toBe(0);
    });
});
