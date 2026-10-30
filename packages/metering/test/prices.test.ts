import { describe, expect, it } from 'vitest';
import { findPriceTableForModel, getPriceTable, PRICE_TABLES, type PriceTable, periodAt } from '../src/index.ts';
import { followsChineseStyle } from './helpers.ts';

describe('built-in price tables', () => {
    it('have unique ids and give every model at most one table', () => {
        const ids = PRICE_TABLES.map((table) => table.id);
        const models = PRICE_TABLES.flatMap((table) => table.models);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(models).size).toBe(models.length);
        for (const id of ids) {
            expect(id).toMatch(/^[a-z0-9.-]+@\d{4}-\d{2}$/);
        }
    });

    it('record where and when every table was checked', () => {
        for (const table of PRICE_TABLES) {
            expect(table.verified, table.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(table.source, table.id).toBeTruthy();
        }
    });

    it('have well-formed peak rules', () => {
        const at = new Date('2026-10-26T10:00:00+08:00');
        for (const table of PRICE_TABLES.filter((candidate) => candidate.period)) {
            expect(() => periodAt(table.period as NonNullable<PriceTable['period']>, at)).not.toThrow();
        }
    });

    it('keep unknown prices unknown instead of guessing', () => {
        expect(getPriceTable('kimi-k3@2026-10')).toMatchObject({ output: null, cacheWrite: null, cacheWrite1h: null });
        for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
            expect(findPriceTableForModel(id)).toMatchObject({ currency: 'USD', cacheWrite: null, cacheWrite1h: null });
        }
        expect(findPriceTableForModel('claude-haiku-5-5')).toMatchObject({
            cachedInput: null,
            contextTiers: [{ aboveInputTokens: 100_000, input: 0.5, cachedInput: null, output: 2.5 }],
        });
    });

    it('leave the holiday list empty for the user to fill in', () => {
        expect(getPriceTable('deepseek-flash@2026-10')?.period?.holidays).toEqual([]);
    });

    it('write their notes in the Chinese UI style', () => {
        for (const table of PRICE_TABLES) {
            expect(followsChineseStyle(table.notes ?? ''), table.id).toBe(true);
        }
    });
});

describe('table lookup', () => {
    it('finds tables by id and by model', () => {
        expect(getPriceTable('glm-5.3@2026-10')?.models).toEqual(['glm-5.3']);
        expect(findPriceTableForModel('deepseek-flash')?.id).toBe('deepseek-flash@2026-10');
        expect(getPriceTable('glm-5.3@2025-01')).toBeUndefined();
        expect(findPriceTableForModel('kimi-k3.1-pro')).toBeUndefined();
    });

    it('searches a caller-supplied list, first match first', () => {
        const custom: PriceTable[] = [
            {
                id: 'local@1',
                models: ['qwen'],
                currency: 'CNY',
                unit: 'per_million_tokens',
                input: 0,
                cachedInput: 0,
                output: 0,
            },
            {
                id: 'local@2',
                models: ['qwen'],
                currency: 'CNY',
                unit: 'per_million_tokens',
                input: 1,
                cachedInput: 1,
                output: 1,
            },
        ];
        expect(findPriceTableForModel('qwen', custom)?.id).toBe('local@1');
        expect(getPriceTable('local@2', custom)?.input).toBe(1);
        expect(findPriceTableForModel('deepseek-flash', custom)).toBeUndefined();
    });
});
