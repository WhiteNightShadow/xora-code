import { type PeakPeriod, periodAt } from './period.ts';
import type { ContextTier, Currency, PriceTable } from './prices.ts';
import { epochOf, zonedTime } from './zone.ts';

/** Token counts of one request; same shape as `Usage` in `@xora/providers`. */
export interface TokenUsage {
    /** All prompt tokens, cache reads and cache writes included. */
    readonly inputTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    /** All completion tokens, reasoning included. */
    readonly outputTokens: number;
    readonly reasoningTokens: number;
}

/** `flat` when the price table has no peak rule. */
export type CostPeriod = PeakPeriod | 'flat';

export interface CostLines {
    readonly input: number;
    readonly cachedInput: number;
    readonly cacheWrite: number;
    /** Output tokens, reasoning included. */
    readonly output: number;
    readonly serverTools: number;
}

export type CostLine = keyof CostLines;

export interface UsageCost {
    readonly amount: number;
    readonly currency: Currency;
    readonly period: CostPeriod;
    /** Index into the table's `contextTiers` of the tier that applied; absent when the base prices applied. */
    readonly tier?: number;
    readonly tableId: string;
    /** False when a non-zero quantity met an unknown price; that part counted as 0. */
    readonly complete: boolean;
    /** Lines that met an unknown price. */
    readonly missing: readonly CostLine[];
    /** Rounded like `amount`, so their sum can differ from it in the last decimal. */
    readonly lines: CostLines;
}

export interface PriceOptions {
    /** When the request ran: picks the peak period and the server-tool start dates. */
    readonly at: Date;
    /** Vendor-billed tool calls by tool name, e.g. `{search: 3}`. */
    readonly serverToolCalls?: Readonly<Record<string, number>>;
    /** Cache lifetime the request asked for; `1h` bills writes at `cacheWrite1h`. Defaults to `5m`. */
    readonly cacheWriteTtl?: '5m' | '1h';
}

export interface Money {
    readonly amount: number;
    readonly currency: Currency;
}

export interface CostTotal extends Money {
    readonly complete: boolean;
}

/** Exchange rates set by the user for totals across currencies. */
export interface ExchangeRates {
    /** Yuan per US dollar. */
    readonly USD_CNY?: number;
}

export class MissingRateError extends Error {
    readonly from: Currency;
    readonly to: Currency;

    constructor(from: Currency, to: Currency) {
        super(`converting ${from} to ${to} needs the USD_CNY exchange rate`);
        this.name = 'MissingRateError';
        this.from = from;
        this.to = to;
    }
}

const PER_MILLION = 1_000_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Rounds money to the 6 decimals every amount in this package is reported with. */
export function roundAmount(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

/** A token or call count; negative and non-finite values count as 0. */
export function tokenCount(value: number | undefined): number {
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The tier with the highest threshold below the prompt size; thresholds need not be sorted. */
function pickTier(tiers: readonly ContextTier[] | undefined, inputTokens: number): number | undefined {
    let picked: number | undefined;
    let threshold = Number.NEGATIVE_INFINITY;
    for (const [index, tier] of (tiers ?? []).entries()) {
        if (inputTokens > tier.aboveInputTokens && tier.aboveInputTokens > threshold) {
            picked = index;
            threshold = tier.aboveInputTokens;
        }
    }
    return picked;
}

interface UnitPrices {
    readonly input: number | null;
    readonly cachedInput: number | null;
    readonly cacheWrite: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
}

function unitPrices(table: PriceTable, tier: ContextTier | undefined, ttl: '5m' | '1h'): UnitPrices {
    const base = tier ?? table;
    const listsWrites =
        table.cacheWrite !== undefined || table.cacheWrite1h !== undefined || tier?.cacheWrite !== undefined;
    let cacheWrite: number | null;
    if (!listsWrites) {
        cacheWrite = base.input;
    } else if (tier) {
        // Tiers only carry the default-lifetime write price.
        cacheWrite = ttl === '5m' ? (tier.cacheWrite ?? null) : null;
    } else {
        cacheWrite = (ttl === '5m' ? table.cacheWrite : table.cacheWrite1h) ?? null;
    }
    return {
        input: base.input,
        cachedInput: base.cachedInput,
        cacheWrite,
        output: base.output,
        // A separate reasoning price belongs to the base prices; inside a tier reasoning bills as output.
        reasoning: tier || table.reasoning === undefined ? base.output : table.reasoning,
    };
}

/** Whether `at` has reached `since`: a calendar date in `timezone`, or an ISO instant. */
function hasStarted(since: string, at: number, timezone: string): boolean {
    if (DATE_ONLY.test(since)) {
        return zonedTime(timezone, at).date >= since;
    }
    const start = Date.parse(since);
    if (Number.isNaN(start)) {
        throw new RangeError(`invalid server tool start "${since}"`);
    }
    return at >= start;
}

function serverToolCost(
    table: PriceTable,
    calls: Readonly<Record<string, number>> | undefined,
    at: number,
    missing: Set<CostLine>,
): number {
    let total = 0;
    for (const [name, value] of Object.entries(calls ?? {})) {
        const count = tokenCount(value);
        if (count === 0) {
            continue;
        }
        const price = table.serverTools && Object.hasOwn(table.serverTools, name) ? table.serverTools[name] : undefined;
        if (!price) {
            missing.add('serverTools');
        } else if (price.since === undefined || hasStarted(price.since, at, table.period?.timezone ?? 'UTC')) {
            total += (count / 1000) * price.perThousand;
        }
    }
    return total;
}

/**
 * Prices one request. Uncached input is `inputTokens - cachedTokens - cacheWriteTokens` (at least 0); reasoning
 * bills at the output price unless the table prices it separately; the context tier is picked by
 * `inputTokens`; off-peak, every token price is multiplied by the rule's factor.
 */
export function priceUsage(table: PriceTable, usage: TokenUsage, options: PriceOptions): UsageCost {
    const at = epochOf(options.at);
    const input = tokenCount(usage.inputTokens);
    const cached = tokenCount(usage.cachedTokens);
    const written = tokenCount(usage.cacheWriteTokens);
    const output = tokenCount(usage.outputTokens);
    const reasoning = Math.min(tokenCount(usage.reasoningTokens), output);
    const uncached = Math.max(0, input - cached - written);

    const tier = pickTier(table.contextTiers, input);
    const prices = unitPrices(
        table,
        tier === undefined ? undefined : table.contextTiers?.[tier],
        options.cacheWriteTtl ?? '5m',
    );
    const period: CostPeriod = table.period ? periodAt(table.period, options.at) : 'flat';
    const factor = period === 'offpeak' ? (table.period?.offPeakMultiplier ?? 1) : 1;

    const missing = new Set<CostLine>();
    const charge = (line: CostLine, tokens: number, price: number | null): number => {
        if (tokens === 0) {
            return 0;
        }
        if (price === null) {
            missing.add(line);
            return 0;
        }
        return (tokens * price * factor) / PER_MILLION;
    };
    const lines: CostLines = {
        input: charge('input', uncached, prices.input),
        cachedInput: charge('cachedInput', cached, prices.cachedInput),
        cacheWrite: charge('cacheWrite', written, prices.cacheWrite),
        output: charge('output', output - reasoning, prices.output) + charge('output', reasoning, prices.reasoning),
        serverTools: serverToolCost(table, options.serverToolCalls, at, missing),
    };
    const amount = lines.input + lines.cachedInput + lines.cacheWrite + lines.output + lines.serverTools;
    return {
        amount: roundAmount(amount),
        currency: table.currency,
        period,
        ...(tier === undefined ? {} : { tier }),
        tableId: table.id,
        complete: missing.size === 0,
        missing: [...missing],
        lines: {
            input: roundAmount(lines.input),
            cachedInput: roundAmount(lines.cachedInput),
            cacheWrite: roundAmount(lines.cacheWrite),
            output: roundAmount(lines.output),
            serverTools: roundAmount(lines.serverTools),
        },
    };
}

/** Converts without rounding; used where several amounts are summed. */
export function convertExact(amount: number, from: Currency, to: Currency, rates: ExchangeRates | undefined): number {
    if (from === to) {
        return amount;
    }
    const usdCny = rates?.USD_CNY;
    if (usdCny === undefined || !Number.isFinite(usdCny) || usdCny <= 0) {
        throw new MissingRateError(from, to);
    }
    return from === 'USD' ? amount * usdCny : amount / usdCny;
}

/** Throws {@link MissingRateError} when the currencies differ and no usable rate is set. */
export function convert(amount: number, from: Currency, to: Currency, rates?: ExchangeRates): number {
    return roundAmount(convertExact(amount, from, to, rates));
}

/** Sums costs in `target`. Costs without a `complete` flag count as complete. */
export function sumCosts(
    costs: readonly (Money & { readonly complete?: boolean })[],
    target: Currency,
    rates?: ExchangeRates,
): CostTotal {
    let amount = 0;
    let complete = true;
    for (const cost of costs) {
        amount += convertExact(cost.amount, cost.currency, target, rates);
        complete &&= cost.complete !== false;
    }
    return { amount: roundAmount(amount), currency: target, complete };
}
