import { describe, expect, it } from 'vitest';
import { LONG_CONTEXT_TOKENS, type SavingStats, savingTips } from '../src/index.ts';
import { followsChineseStyle } from './helpers.ts';

const kinds = (stats: SavingStats) => savingTips(stats).map((tip) => tip.kind);

describe('savingTips', () => {
    it('gives nothing without data', () => {
        expect(savingTips({})).toEqual([]);
    });

    it('flags a cache hit rate below 30% over at least 20 requests', () => {
        const [tip] = savingTips({ requests: 40, inputTokens: 100_000, cachedTokens: 12_000 });
        expect(tip).toMatchObject({ kind: 'low_cache_hit_rate', cacheHitRate: 0.12, requests: 40 });
        expect(tip?.message).toContain('缓存命中率只有12%');
        expect(tip?.message).toContain('会话中途改了思考强度');

        expect(kinds({ requests: 20, inputTokens: 1000, cachedTokens: 299 })).toEqual(['low_cache_hit_rate']);
        expect(kinds({ requests: 20, inputTokens: 1000, cachedTokens: 300 })).toEqual([]);
        expect(kinds({ requests: 19, inputTokens: 1000, cachedTokens: 0 })).toEqual([]);
    });

    it('flags long-context requests above 40% of input tokens', () => {
        const [tip] = savingTips({ inputTokens: 1000, longContextInputTokens: 550 });
        expect(tip).toMatchObject({ kind: 'long_context', share: 0.55 });
        expect(tip?.message).toContain(`超过${LONG_CONTEXT_TOKENS / 1000}k的长上下文请求占了输入token的55%`);
        expect(tip?.message).toContain('子agent');

        expect(kinds({ inputTokens: 1000, longContextInputTokens: 401 })).toEqual(['long_context']);
        expect(kinds({ inputTokens: 1000, longContextInputTokens: 400 })).toEqual([]);
    });

    it('flags scheduled runs that spend more than half at peak prices', () => {
        const [tip] = savingTips({ scheduledCost: 18, scheduledPeakCost: 12.3 });
        expect(tip).toMatchObject({ kind: 'peak_scheduled', peakCost: 12.3, currency: 'CNY' });
        expect(tip?.message).toBe('定时任务有68%的花费（12.30元）发生在高峰时段，改到空闲时段大约能省一半。');

        const [dollars] = savingTips({ scheduledCost: 1, scheduledPeakCost: 0.6, currency: 'USD' });
        expect(dollars?.message).toContain('（$0.60）');

        expect(kinds({ scheduledCost: 10, scheduledPeakCost: 5.01 })).toEqual(['peak_scheduled']);
        expect(kinds({ scheduledCost: 10, scheduledPeakCost: 5 })).toEqual([]);
        expect(kinds({ scheduledCost: 0, scheduledPeakCost: 0 })).toEqual([]);
    });

    it('can give every tip at once, all in the Chinese UI style', () => {
        const tips = savingTips({
            requests: 50,
            inputTokens: 1_000_000,
            cachedTokens: 50_000,
            longContextInputTokens: 700_000,
            scheduledCost: 0.004,
            scheduledPeakCost: 0.003,
        });
        expect(tips.map((tip) => tip.kind)).toEqual(['low_cache_hit_rate', 'long_context', 'peak_scheduled']);
        expect(tips[2]?.message).toContain('（0.0030元）');
        for (const tip of tips) {
            expect(followsChineseStyle(tip.message), tip.message).toBe(true);
        }
    });
});
