/**
 * Vendor price tables. Prices are per million tokens in the table's currency. `null` means the price is not
 * known: costs that need it are reported as incomplete instead of guessed. Table ids carry a version
 * (`deepseek-flash@2026-10`), so recorded costs can be recomputed after a price change.
 */

export type Currency = 'CNY' | 'USD';

/** A recurring peak window `[from, to)` in the rule's time zone. Windows cannot cross midnight; split them. */
export interface PeakWindow {
    /** ISO weekdays: 1 = Monday … 7 = Sunday. */
    readonly days: readonly number[];
    /** `HH:MM`, inclusive. */
    readonly from: string;
    /** `HH:MM`, exclusive; `24:00` ends the window at midnight. */
    readonly to: string;
}

/** Peak hours of a vendor; everything outside the peak windows is off-peak. */
export interface PeriodRule {
    /** IANA time zone of the windows and dates, e.g. `Asia/Shanghai`. */
    readonly timezone: string;
    readonly peak: readonly PeakWindow[];
    /** Price factor outside peak hours, e.g. 0.5 for half price. */
    readonly offPeakMultiplier: number;
    /** Local dates (`YYYY-MM-DD`) that are off-peak all day, such as public holidays. */
    readonly holidays?: readonly string[];
    /** Local dates (`YYYY-MM-DD`) of weekend days worked in exchange for a holiday; they follow the weekday windows. */
    readonly workdays?: readonly string[];
}

/** Prices that replace the base prices once a request's prompt exceeds `aboveInputTokens`. */
export interface ContextTier {
    readonly aboveInputTokens: number;
    readonly input: number | null;
    readonly cachedInput: number | null;
    readonly output: number | null;
    /** Absent counts as unknown once the table lists any write price; 1-hour writes are always unknown in a tier. */
    readonly cacheWrite?: number | null;
}

export interface ServerToolPrice {
    readonly perThousand: number;
    /** First billed day: `YYYY-MM-DD` in the table's peak-rule zone (UTC without one), or an ISO instant. */
    readonly since?: string;
}

export interface PriceTable {
    /** Versioned id, e.g. `deepseek-flash@2026-10`; model presets in `@xora/providers` refer to it. */
    readonly id: string;
    /** Model ids the table applies to. */
    readonly models: readonly string[];
    readonly currency: Currency;
    readonly unit: 'per_million_tokens';
    /** Prompt tokens neither read from nor written to the cache. */
    readonly input: number | null;
    /** Prompt tokens read from the cache. */
    readonly cachedInput: number | null;
    /**
     * Prompt tokens written to the cache with the default (5-minute) and the 1-hour lifetime. A table that lists
     * neither bills written tokens as ordinary input; `null` means writes are billed at an unknown price.
     */
    readonly cacheWrite?: number | null;
    readonly cacheWrite1h?: number | null;
    /** Output tokens, reasoning included unless `reasoning` is set. */
    readonly output: number | null;
    /** Reasoning tokens, when the vendor prices them apart from other output. */
    readonly reasoning?: number | null;
    readonly contextTiers?: readonly ContextTier[];
    readonly period?: PeriodRule;
    /** Vendor-billed tools by name, priced per thousand calls. The off-peak discount does not apply to them. */
    readonly serverTools?: Readonly<Record<string, ServerToolPrice>>;
    /** Date the prices were checked against the source. */
    readonly verified?: string;
    /** Where the prices come from: a link, or a description when no stable link is recorded. */
    readonly source?: string;
    readonly notes?: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
const ANTHROPIC_NOTE = '价格来自anthropic文档（2026-10-06缓存版）。缓存写入单价没有逐条核实，按未知处理。';

/** Built-in tables. Every number here was checked against the source named in the table. */
export const PRICE_TABLES: readonly PriceTable[] = [
    {
        id: 'deepseek-flash@2026-10',
        models: ['deepseek-flash'],
        currency: 'CNY',
        unit: 'per_million_tokens',
        input: 2,
        cachedInput: 0.04,
        output: 8,
        period: {
            timezone: 'Asia/Shanghai',
            peak: [
                { days: WEEKDAYS, from: '09:00', to: '12:00' },
                { days: WEEKDAYS, from: '14:00', to: '18:00' },
            ],
            offPeakMultiplier: 0.5,
            holidays: [],
        },
        serverTools: {
            search: { perThousand: 5, since: '2026-11-01' },
            fetch: { perThousand: 5, since: '2026-11-01' },
        },
        verified: '2026-10-29',
        source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
        notes:
            '表中是高峰单价：工作日9:00–12:00、14:00–18:00（北京时间）为高峰，其余时间（含周末和法定节假日）半价。' +
            '节假日日期没有内置，可以自己加到holidays里。服务端search、fetch从2026-11-01起每千次5元。',
    },
    {
        id: 'glm-5.3@2026-10',
        models: ['glm-5.3'],
        currency: 'CNY',
        unit: 'per_million_tokens',
        input: 8,
        cachedInput: 2,
        output: 28,
        verified: '2026-10-29',
        source: '智谱开放平台官方文档',
        notes: '按量api价格；coding plan套餐按积分消耗，不按这张表计价。',
    },
    {
        id: 'kimi-k3@2026-10',
        models: ['kimi-k3'],
        currency: 'USD',
        unit: 'per_million_tokens',
        input: 3,
        cachedInput: 0.3,
        cacheWrite: null,
        cacheWrite1h: null,
        output: null,
        verified: '2026-10-29',
        source: 'kimi开放平台官方缓存页',
        notes:
            '命中、未命中单价来自官方缓存页；输出单价和缓存写入（5分钟、1小时两档）单价未核实。' +
            'kimi-k3.1-pro的价格也未核实，暂不提供价格表。',
    },
    {
        id: 'claude-opus-5-5@2026-10',
        models: ['claude-opus-5-5'],
        currency: 'USD',
        unit: 'per_million_tokens',
        input: 4,
        cachedInput: 0.2,
        cacheWrite: null,
        cacheWrite1h: null,
        output: 20,
        verified: '2026-10-06',
        source: ANTHROPIC_PRICING,
        notes: `${ANTHROPIC_NOTE}fast模式（价格翻倍）不按这张表计价。`,
    },
    {
        id: 'claude-sonnet-5-5@2026-10',
        models: ['claude-sonnet-5-5'],
        currency: 'USD',
        unit: 'per_million_tokens',
        input: 2,
        cachedInput: 0.2,
        cacheWrite: null,
        cacheWrite1h: null,
        output: 10,
        verified: '2026-10-06',
        source: ANTHROPIC_PRICING,
        notes: ANTHROPIC_NOTE,
    },
    {
        id: 'claude-haiku-5-5@2026-10',
        models: ['claude-haiku-5-5'],
        currency: 'USD',
        unit: 'per_million_tokens',
        input: 0.1,
        cachedInput: null,
        cacheWrite: null,
        cacheWrite1h: null,
        output: 0.5,
        contextTiers: [{ aboveInputTokens: 100_000, input: 0.5, cachedInput: null, output: 2.5, cacheWrite: null }],
        verified: '2026-10-06',
        source: ANTHROPIC_PRICING,
        notes: `${ANTHROPIC_NOTE}提示词超过100k token时整次请求按长上下文价计；缓存命中单价也未核实。`,
    },
    {
        id: 'claude-fable-5-1@2026-10',
        models: ['claude-fable-5-1'],
        currency: 'USD',
        unit: 'per_million_tokens',
        input: 10,
        cachedInput: 0.25,
        cacheWrite: null,
        cacheWrite1h: null,
        output: 50,
        verified: '2026-10-06',
        source: ANTHROPIC_PRICING,
        notes: ANTHROPIC_NOTE,
    },
];

export function getPriceTable(id: string, tables: readonly PriceTable[] = PRICE_TABLES): PriceTable | undefined {
    return tables.find((table) => table.id === id);
}

/** The first table that lists `modelId`. Prefer the preset's explicit `pricing` id when there is one. */
export function findPriceTableForModel(
    modelId: string,
    tables: readonly PriceTable[] = PRICE_TABLES,
): PriceTable | undefined {
    return tables.find((table) => table.models.includes(modelId));
}
