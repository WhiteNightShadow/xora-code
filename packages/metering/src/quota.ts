import { roundAmount, type TokenUsage, tokenCount } from './cost.ts';
import { type PeakPeriod, periodAt } from './period.ts';
import type { PeriodRule } from './prices.ts';

/** State of one subscription window, such as the glm coding plan's 5-hour points or kimi code's monthly total. */
export interface QuotaWindow {
    /** What is counted, e.g. `points`, `requests` or `tokens`. */
    readonly unit: string;
    readonly used: number;
    readonly limit?: number;
    /** Epoch milliseconds of the next reset. */
    readonly resetsAt?: number;
    /**
     * `vendor`: reported by the vendor; `estimate`: computed locally; `inferred`: deduced from 429 responses
     * and headers; `unavailable`: managed by an official client and not visible to xora.
     */
    readonly source: 'vendor' | 'estimate' | 'inferred' | 'unavailable';
}

/** Full-price hours of glm coding plan points (unverified research): weekdays 14:00–18:00 Beijing time. */
export const GLM_POINTS_RULE: PeriodRule = {
    timezone: 'Asia/Shanghai',
    peak: [{ days: [1, 2, 3, 4, 5], from: '14:00', to: '18:00' }],
    offPeakMultiplier: 0.5,
};

export interface GlmPointsEstimate {
    readonly points: number;
    readonly period: PeakPeriod;
    /** Always false: the formula comes from research and has not been checked against official documentation. */
    readonly verified: false;
}

/**
 * Coding plan points used by one glm-5.3 request (11 §5, unverified):
 * `(input × 6.9 + cached × 1.7 + output × 24) ÷ 10000`, where input is the uncached prompt tokens and output
 * includes reasoning; half price outside {@link GLM_POINTS_RULE}'s peak hours.
 */
export function estimateGlmPoints(usage: TokenUsage, at: Date): GlmPointsEstimate {
    const cached = tokenCount(usage.cachedTokens);
    const input = Math.max(0, tokenCount(usage.inputTokens) - cached);
    const output = tokenCount(usage.outputTokens);
    const period = periodAt(GLM_POINTS_RULE, at);
    const factor = period === 'peak' ? 1 : GLM_POINTS_RULE.offPeakMultiplier;
    const points = ((input * 6.9 + cached * 1.7 + output * 24) / 10_000) * factor;
    return { points: roundAmount(points), period, verified: false };
}
