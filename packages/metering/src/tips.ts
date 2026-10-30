import type { Currency } from './prices.ts';

/** Requests whose prompt exceeds this many tokens count as long-context requests. */
export const LONG_CONTEXT_TOKENS = 128_000;

const CACHE_MIN_REQUESTS = 20;
const CACHE_LOW_RATE = 0.3;
const LONG_CONTEXT_SHARE = 0.4;
const PEAK_SHARE = 0.5;

/** Figures over the window being judged (a thread, an agent, a day …). Tips whose figures are absent are skipped. */
export interface SavingStats {
    readonly requests?: number;
    /** All prompt tokens, cached ones included. */
    readonly inputTokens?: number;
    readonly cachedTokens?: number;
    /** Prompt tokens of the requests whose prompt exceeded {@link LONG_CONTEXT_TOKENS}. */
    readonly longContextInputTokens?: number;
    /** Cost of scheduled and triggered runs, and the part of it billed at peak prices, in `currency`. */
    readonly scheduledCost?: number;
    readonly scheduledPeakCost?: number;
    /** Defaults to CNY. */
    readonly currency?: Currency;
}

export type SavingTip =
    | {
          readonly kind: 'low_cache_hit_rate';
          readonly message: string;
          readonly cacheHitRate: number;
          readonly requests: number;
      }
    | { readonly kind: 'long_context'; readonly message: string; readonly share: number }
    | {
          readonly kind: 'peak_scheduled';
          readonly message: string;
          readonly peakShare: number;
          readonly peakCost: number;
          readonly currency: Currency;
      };

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

function money(amount: number, currency: Currency): string {
    const value = amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2);
    return currency === 'CNY' ? `${value}元` : `$${value}`;
}

/** Concrete suggestions with the numbers behind them (11 §7). Messages follow the Chinese UI style. */
export function savingTips(stats: SavingStats): SavingTip[] {
    const tips: SavingTip[] = [];
    const requests = stats.requests ?? 0;
    const input = stats.inputTokens ?? 0;

    if (requests >= CACHE_MIN_REQUESTS && input > 0) {
        const cacheHitRate = (stats.cachedTokens ?? 0) / input;
        if (cacheHitRate < CACHE_LOW_RATE) {
            tips.push({
                kind: 'low_cache_hit_rate',
                cacheHitRate,
                requests,
                message:
                    `最近${requests}次请求的缓存命中率只有${percent(cacheHitRate)}。` +
                    '常见原因是会话中途改了思考强度或换了模型，会话内保持这些设置不变能提高命中率。',
            });
        }
    }

    if (input > 0 && stats.longContextInputTokens !== undefined) {
        const share = stats.longContextInputTokens / input;
        if (share > LONG_CONTEXT_SHARE) {
            tips.push({
                kind: 'long_context',
                share,
                message:
                    `超过${LONG_CONTEXT_TOKENS / 1000}k的长上下文请求占了输入token的${percent(share)}。` +
                    '建议及时压缩上下文，或者把探索类的工作交给子agent。',
            });
        }
    }

    const scheduledCost = stats.scheduledCost ?? 0;
    if (scheduledCost > 0 && stats.scheduledPeakCost !== undefined) {
        const peakShare = stats.scheduledPeakCost / scheduledCost;
        if (peakShare > PEAK_SHARE) {
            const currency = stats.currency ?? 'CNY';
            tips.push({
                kind: 'peak_scheduled',
                peakShare,
                peakCost: stats.scheduledPeakCost,
                currency,
                message:
                    `定时任务有${percent(peakShare)}的花费（${money(stats.scheduledPeakCost, currency)}）` +
                    '发生在高峰时段，改到空闲时段大约能省一半。',
            });
        }
    }
    return tips;
}
