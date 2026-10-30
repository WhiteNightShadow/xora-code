import { getPriceTable, type PeriodRule, type PriceTable, type TokenUsage, type UsageEvent } from '../src/index.ts';

export function table(id: string): PriceTable {
    const found = getPriceTable(id);
    if (!found) {
        throw new Error(`no built-in price table ${id}`);
    }
    return found;
}

export function deepseekRule(): PeriodRule {
    const rule = table('deepseek-flash@2026-10').period;
    if (!rule) {
        throw new Error('deepseek has no peak rule');
    }
    return rule;
}

export function usage(tokens: Partial<TokenUsage>): TokenUsage {
    return { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, ...tokens };
}

let nextId = 0;

export function usageEvent(fields: Partial<UsageEvent>): UsageEvent {
    nextId += 1;
    return {
        id: `event-${nextId}`,
        ts: Date.parse('2026-10-30T10:00:00+08:00'),
        projectId: 'project-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        agentPath: 'main',
        engine: 'xora',
        provider: 'deepseek',
        channel: 'api',
        model: 'deepseek-flash',
        inputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        requests: 1,
        latencyMs: 1000,
        status: 'ok',
        source: 'vendor',
        ...fields,
    };
}

/** Chinese UI style: English in lower case and no space between Chinese and English or digits. */
export function followsChineseStyle(text: string): boolean {
    const spaced = /[　-鿿＀-￯] [A-Za-z0-9$]|[A-Za-z0-9%] [　-鿿＀-￯]/;
    return !/[A-Z]/.test(text) && !spaced.test(text);
}
