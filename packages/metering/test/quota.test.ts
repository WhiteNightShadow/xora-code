import { describe, expect, it } from 'vitest';
import { estimateGlmPoints } from '../src/index.ts';
import { usage } from './helpers.ts';

// 8 000 uncached × 6.9 + 2 000 cached × 1.7 + 1 000 output × 24 = 82 600 → 8.26 points at full price.
const tokens = usage({ inputTokens: 10_000, cachedTokens: 2_000, outputTokens: 1_000, reasoningTokens: 400 });

describe('estimateGlmPoints', () => {
    it('charges full points on weekday afternoons in Beijing', () => {
        expect(estimateGlmPoints(tokens, new Date('2026-10-26T15:00:00+08:00'))).toEqual({
            points: 8.26,
            period: 'peak',
            verified: false,
        });
        // 06:00 UTC is 14:00 in Beijing: the window starts inclusive.
        expect(estimateGlmPoints(tokens, new Date('2026-10-26T06:00:00Z')).points).toBe(8.26);
    });

    it('halves the points outside 14:00–18:00 and at weekends', () => {
        for (const at of ['2026-10-26T10:00:00+08:00', '2026-10-26T18:00:00+08:00', '2026-10-31T15:00:00+08:00']) {
            expect(estimateGlmPoints(tokens, new Date(at))).toEqual({
                points: 4.13,
                period: 'offpeak',
                verified: false,
            });
        }
    });

    it('never counts negative uncached input', () => {
        const inconsistent = usage({ inputTokens: 1_000, cachedTokens: 2_000 });
        expect(estimateGlmPoints(inconsistent, new Date('2026-10-26T15:00:00+08:00')).points).toBe(0.34);
    });
});
