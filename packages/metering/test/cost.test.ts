import { describe, expect, it } from 'vitest';
import { convert, MissingRateError, type PriceTable, priceUsage, sumCosts } from '../src/index.ts';
import { table, usage } from './helpers.ts';

const deepseek = table('deepseek-flash@2026-10');
const MONDAY_PEAK = new Date('2026-10-26T10:00:00+08:00');
const MONDAY_LUNCH = new Date('2026-10-26T12:30:00+08:00');
const SATURDAY = new Date('2026-10-31T10:00:00+08:00');

function customTable(fields: Partial<PriceTable>): PriceTable {
    return {
        id: 'custom@1',
        models: ['custom'],
        currency: 'CNY',
        unit: 'per_million_tokens',
        input: 1,
        cachedInput: 0.1,
        output: 8,
        ...fields,
    };
}

describe('priceUsage: deepseek peak and off-peak', () => {
    const tokens = usage({
        inputTokens: 1_000_000,
        cachedTokens: 200_000,
        outputTokens: 100_000,
        reasoningTokens: 20_000,
    });

    it('bills cache misses, cache hits and output at peak prices', () => {
        expect(priceUsage(deepseek, tokens, { at: MONDAY_PEAK })).toEqual({
            amount: 2.408,
            currency: 'CNY',
            period: 'peak',
            tableId: 'deepseek-flash@2026-10',
            complete: true,
            missing: [],
            lines: { input: 1.6, cachedInput: 0.008, cacheWrite: 0, output: 0.8, serverTools: 0 },
        });
    });

    it('halves every token price off-peak, on weekends and between the weekday windows', () => {
        const halved = {
            amount: 1.204,
            period: 'offpeak',
            lines: { input: 0.8, cachedInput: 0.004, cacheWrite: 0, output: 0.4, serverTools: 0 },
        };
        expect(priceUsage(deepseek, tokens, { at: SATURDAY })).toMatchObject(halved);
        expect(priceUsage(deepseek, tokens, { at: MONDAY_LUNCH })).toMatchObject(halved);
    });

    it('prices a request served entirely from cache', () => {
        const hits = usage({ inputTokens: 500_000, cachedTokens: 500_000 });
        expect(priceUsage(deepseek, hits, { at: MONDAY_PEAK }).amount).toBe(0.02);
        expect(priceUsage(deepseek, hits, { at: SATURDAY }).amount).toBe(0.01);
    });

    it('is flat for tables without a peak rule', () => {
        const glm = priceUsage(table('glm-5.3@2026-10'), usage({ inputTokens: 1_000_000, cachedTokens: 250_000 }), {
            at: MONDAY_PEAK,
        });
        expect(glm).toMatchObject({ amount: 6.5, period: 'flat', complete: true });
    });
});

describe('priceUsage: context tiers', () => {
    const haiku = table('claude-haiku-5-5@2026-10');

    it('uses the base prices up to the threshold and the tier above it', () => {
        const atThreshold = priceUsage(haiku, usage({ inputTokens: 100_000, outputTokens: 10_000 }), {
            at: MONDAY_PEAK,
        });
        expect(atThreshold).toMatchObject({ amount: 0.015, complete: true });
        expect(atThreshold.tier).toBeUndefined();

        const above = priceUsage(haiku, usage({ inputTokens: 150_000, outputTokens: 10_000 }), { at: MONDAY_PEAK });
        expect(above).toMatchObject({
            amount: 0.1,
            tier: 0,
            currency: 'USD',
            period: 'flat',
            lines: { input: 0.075, output: 0.025 },
        });
    });

    it('picks the highest threshold exceeded even when tiers are unsorted', () => {
        const tiered = customTable({
            contextTiers: [
                { aboveInputTokens: 200_000, input: 3, cachedInput: 0.3, output: 30 },
                { aboveInputTokens: 100_000, input: 2, cachedInput: 0.2, output: 20 },
            ],
        });
        expect(priceUsage(tiered, usage({ inputTokens: 250_000 }), { at: MONDAY_PEAK })).toMatchObject({
            tier: 0,
            amount: 0.75,
        });
        expect(priceUsage(tiered, usage({ inputTokens: 150_000 }), { at: MONDAY_PEAK })).toMatchObject({
            tier: 1,
            amount: 0.3,
        });
    });
});

describe('priceUsage: unknown prices', () => {
    const kimi = table('kimi-k3@2026-10');

    it('counts unknown prices as 0 and marks the cost incomplete', () => {
        const cost = priceUsage(kimi, usage({ inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 2_000 }), {
            at: MONDAY_PEAK,
        });
        expect(cost).toMatchObject({ amount: 1.92, currency: 'USD', complete: false, missing: ['output'] });
        expect(cost.lines).toEqual({ input: 1.8, cachedInput: 0.12, cacheWrite: 0, output: 0, serverTools: 0 });
    });

    it('stays complete when the unknown price meets no tokens', () => {
        const cost = priceUsage(kimi, usage({ inputTokens: 1_000_000, cachedTokens: 400_000 }), { at: MONDAY_PEAK });
        expect(cost).toMatchObject({ amount: 1.92, complete: true, missing: [] });
    });

    it('flags unknown cache read and cache write prices', () => {
        const haiku = priceUsage(
            table('claude-haiku-5-5@2026-10'),
            usage({ inputTokens: 10_000, cachedTokens: 8_000 }),
            {
                at: MONDAY_PEAK,
            },
        );
        expect(haiku).toMatchObject({ complete: false, missing: ['cachedInput'], amount: 0.0002 });

        const opus = priceUsage(
            table('claude-opus-5-5@2026-10'),
            usage({ inputTokens: 300_000, cacheWriteTokens: 100_000, outputTokens: 1_000 }),
            { at: MONDAY_PEAK },
        );
        expect(opus).toMatchObject({ complete: false, missing: ['cacheWrite'], amount: 0.82 });
    });
});

describe('priceUsage: cache writes and reasoning', () => {
    it('bills writes as ordinary input when the table lists no write price', () => {
        const cost = priceUsage(
            table('glm-5.3@2026-10'),
            usage({ inputTokens: 1_000_000, cacheWriteTokens: 100_000 }),
            {
                at: MONDAY_PEAK,
            },
        );
        expect(cost).toMatchObject({ amount: 8, complete: true, lines: { input: 7.2, cacheWrite: 0.8 } });
    });

    it('uses the 1-hour write price when the request asked for it', () => {
        const writes = usage({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
        const both = customTable({ cacheWrite: 1.25, cacheWrite1h: 2 });
        expect(priceUsage(both, writes, { at: MONDAY_PEAK }).lines.cacheWrite).toBe(1.25);
        expect(priceUsage(both, writes, { at: MONDAY_PEAK, cacheWriteTtl: '1h' }).lines.cacheWrite).toBe(2);

        const fiveMinuteOnly = customTable({ cacheWrite: 1.25 });
        expect(priceUsage(fiveMinuteOnly, writes, { at: MONDAY_PEAK, cacheWriteTtl: '1h' })).toMatchObject({
            complete: false,
            missing: ['cacheWrite'],
        });
    });

    it('bills reasoning at the output price unless the table prices it separately', () => {
        const tokens = usage({ outputTokens: 1_000_000, reasoningTokens: 250_000 });
        expect(priceUsage(customTable({}), tokens, { at: MONDAY_PEAK }).lines.output).toBe(8);
        expect(priceUsage(customTable({ reasoning: 16 }), tokens, { at: MONDAY_PEAK }).lines.output).toBe(10);
        // Reasoning never counts for more than the output it is part of.
        const inflated = usage({ outputTokens: 1_000_000, reasoningTokens: 2_000_000 });
        expect(priceUsage(customTable({ reasoning: 16 }), inflated, { at: MONDAY_PEAK }).lines.output).toBe(16);
    });

    it('ignores negative and non-finite counts', () => {
        const garbage = usage({ inputTokens: -5, outputTokens: Number.NaN, cachedTokens: Number.POSITIVE_INFINITY });
        expect(priceUsage(deepseek, garbage, { at: MONDAY_PEAK })).toMatchObject({ amount: 0, complete: true });
    });

    it('rejects an invalid date', () => {
        expect(() => priceUsage(deepseek, usage({}), { at: new Date('not a date') })).toThrow(RangeError);
    });
});

describe('priceUsage: server tools', () => {
    const calls = { search: 10, fetch: 30 };

    it('charges deepseek search and fetch only from 2026-11-01 Beijing time', () => {
        const before = priceUsage(deepseek, usage({}), {
            at: new Date('2026-10-31T23:59:00+08:00'),
            serverToolCalls: calls,
        });
        expect(before).toMatchObject({ amount: 0, complete: true, lines: { serverTools: 0 } });

        // Still 2026-10-31 in UTC, already 2026-11-01 in Beijing. Sunday is off-peak, but tools are not discounted.
        const after = priceUsage(deepseek, usage({}), { at: new Date('2026-10-31T16:30:00Z'), serverToolCalls: calls });
        expect(after).toMatchObject({ amount: 0.2, period: 'offpeak', complete: true, lines: { serverTools: 0.2 } });
    });

    it('accepts an exact start instant', () => {
        const timed = customTable({ serverTools: { browse: { perThousand: 1, since: '2026-11-01T12:00:00Z' } } });
        const options = { serverToolCalls: { browse: 1000 } };
        expect(priceUsage(timed, usage({}), { ...options, at: new Date('2026-11-01T11:59:59Z') }).amount).toBe(0);
        expect(priceUsage(timed, usage({}), { ...options, at: new Date('2026-11-01T12:00:00Z') }).amount).toBe(1);
    });

    it('marks calls to unpriced tools incomplete', () => {
        const unknownTool = priceUsage(deepseek, usage({}), { at: MONDAY_PEAK, serverToolCalls: { browse: 2 } });
        expect(unknownTool).toMatchObject({ complete: false, missing: ['serverTools'] });
        const noTools = priceUsage(table('glm-5.3@2026-10'), usage({}), {
            at: MONDAY_PEAK,
            serverToolCalls: { search: 1 },
        });
        expect(noTools).toMatchObject({ complete: false, missing: ['serverTools'] });
        const prototypeKey = priceUsage(deepseek, usage({}), { at: MONDAY_PEAK, serverToolCalls: { constructor: 1 } });
        expect(prototypeKey).toMatchObject({ amount: 0, complete: false });
        const zero = priceUsage(table('glm-5.3@2026-10'), usage({}), {
            at: MONDAY_PEAK,
            serverToolCalls: { search: 0 },
        });
        expect(zero.complete).toBe(true);
    });
});

describe('currency conversion', () => {
    const rates = { USD_CNY: 7.1 };

    it('converts between dollars and yuan', () => {
        expect(convert(10, 'USD', 'CNY', rates)).toBe(71);
        expect(convert(71, 'CNY', 'USD', rates)).toBe(10);
        expect(convert(1, 'CNY', 'USD', rates)).toBe(0.140845);
        expect(convert(3, 'CNY', 'CNY')).toBe(3);
    });

    it('throws a typed error when the rate is missing', () => {
        for (const missing of [undefined, {}, { USD_CNY: 0 }, { USD_CNY: Number.NaN }]) {
            expect(() => convert(1, 'USD', 'CNY', missing)).toThrow(MissingRateError);
        }
        try {
            convert(1, 'CNY', 'USD');
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(MissingRateError);
            expect(error).toMatchObject({ name: 'MissingRateError', from: 'CNY', to: 'USD' });
        }
    });

    it('sums mixed currencies and keeps track of completeness', () => {
        const costs = [
            { amount: 1.5, currency: 'USD' as const },
            { amount: 2, currency: 'CNY' as const, complete: false },
        ];
        expect(sumCosts(costs, 'CNY', { USD_CNY: 7.2 })).toEqual({ amount: 12.8, currency: 'CNY', complete: false });
        expect(sumCosts([], 'USD')).toEqual({ amount: 0, currency: 'USD', complete: true });
        expect(
            sumCosts(
                [
                    { amount: 0.1, currency: 'CNY' },
                    { amount: 0.2, currency: 'CNY' },
                ],
                'CNY',
            ),
        ).toEqual({
            amount: 0.3,
            currency: 'CNY',
            complete: true,
        });
        expect(() => sumCosts(costs, 'CNY')).toThrow(MissingRateError);
    });
});
