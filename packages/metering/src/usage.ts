import { type CostPeriod, convertExact, type ExchangeRates, roundAmount, type TokenUsage } from './cost.ts';
import type { Currency } from './prices.ts';
import { zonedTime } from './zone.ts';

/** Estimated cost recorded on a usage event, with the price table version so it can be recomputed. */
export interface UsageEventCost {
    readonly amount: number;
    readonly currency: Currency;
    readonly tableId: string;
    readonly period: CostPeriod;
    /** Context tier that applied, as in `UsageCost`. */
    readonly tier?: number;
    readonly complete: boolean;
}

/** Subscription quota consumed by a request. */
export interface UsageQuota {
    /** e.g. `points` for the glm coding plan. */
    readonly unit: string;
    readonly amount: number;
    /** Window the consumption counts against, e.g. `5h` or `week`. */
    readonly window?: string;
    /** False for estimates from unverified formulas. */
    readonly verified?: boolean;
}

/** One finished model request, as the host stores it (11 §3). Metering fields only, never prompt content. */
export interface UsageEvent extends TokenUsage {
    readonly id: string;
    /** Epoch milliseconds. */
    readonly ts: number;
    readonly projectId: string;
    readonly threadId: string;
    readonly turnId: string;
    /** `main` for the thread itself, `main/sub-2` for a subagent. */
    readonly agentPath: string;
    readonly agentId?: string;
    readonly taskId?: string;
    readonly workflowRunId?: string;
    /** Team role (06 §2), e.g. `supervisor`, `executor`, `reviewer`. */
    readonly role?: string;
    /** Model tier (06 §3): `flagship`, `standard`, `economy` or `fast`. */
    readonly tier?: string;
    readonly template?: string;
    /** `xora` or the name of an external agent. */
    readonly engine: string;
    readonly provider: string;
    readonly channel: string;
    readonly region?: string;
    readonly model: string;
    readonly requests: number;
    /** Vendor-billed tool calls by tool name. */
    readonly serverToolCalls?: Readonly<Record<string, number>>;
    readonly latencyMs: number;
    readonly ttftMs?: number;
    readonly cost?: UsageEventCost;
    readonly quota?: UsageQuota;
    readonly status: 'ok' | 'error';
    readonly errorClass?: string;
    /** Vendor-reported usage, a local estimate, or an acp `usage_update`. */
    readonly source: 'vendor' | 'estimate' | 'acp';
}

/** Event fields that can be grouped on (the string-valued ones), plus the local `day`. */
export type UsageDimension =
    | 'day'
    | { [K in keyof UsageEvent]-?: NonNullable<UsageEvent[K]> extends string ? K : never }[keyof UsageEvent];

export interface AggregateOptions {
    /** Currency of the `cost` column; costs in other currencies are converted with `rates`. */
    readonly currency: Currency;
    readonly rates?: ExchangeRates;
    /** Time zone of the `day` dimension. */
    readonly timezone: string;
}

export interface UsageRow {
    /** Value of each grouped dimension, '' when events lack it; `day` is the local `YYYY-MM-DD`. */
    readonly key: Readonly<Partial<Record<UsageDimension, string>>>;
    readonly events: number;
    readonly requests: number;
    readonly inputTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly serverToolCalls: Readonly<Record<string, number>>;
    readonly cost: number;
    readonly currency: Currency;
    /** False when some event had no cost or an incomplete one. */
    readonly complete: boolean;
    /** Share of prompt tokens read from the cache. */
    readonly cacheHitRate: number;
}

interface Group {
    readonly key: Partial<Record<UsageDimension, string>>;
    events: number;
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    readonly serverToolCalls: Record<string, number>;
    cost: number;
    complete: boolean;
}

function dimensionValue(event: UsageEvent, dimension: UsageDimension, timezone: string): string {
    return dimension === 'day' ? zonedTime(timezone, event.ts).date : (event[dimension] ?? '');
}

/**
 * Groups events by `by` (an empty list gives one total row) and sorts the rows by cost, highest first.
 * Throws `MissingRateError` when costs in another currency meet a missing exchange rate.
 */
export function aggregate(
    events: readonly UsageEvent[],
    by: readonly UsageDimension[],
    options: AggregateOptions,
): UsageRow[] {
    const groups = new Map<string, Group>();
    for (const event of events) {
        const values = by.map((dimension) => dimensionValue(event, dimension, options.timezone));
        const id = JSON.stringify(values);
        let group = groups.get(id);
        if (!group) {
            group = {
                key: Object.fromEntries(by.map((dimension, index) => [dimension, values[index] ?? ''])),
                events: 0,
                requests: 0,
                inputTokens: 0,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                serverToolCalls: {},
                cost: 0,
                complete: true,
            };
            groups.set(id, group);
        }
        group.events += 1;
        group.requests += event.requests;
        group.inputTokens += event.inputTokens;
        group.cachedTokens += event.cachedTokens;
        group.cacheWriteTokens += event.cacheWriteTokens;
        group.outputTokens += event.outputTokens;
        group.reasoningTokens += event.reasoningTokens;
        for (const [name, calls] of Object.entries(event.serverToolCalls ?? {})) {
            group.serverToolCalls[name] = (group.serverToolCalls[name] ?? 0) + calls;
        }
        if (event.cost) {
            group.cost += convertExact(event.cost.amount, event.cost.currency, options.currency, options.rates);
            group.complete &&= event.cost.complete;
        } else {
            group.complete = false;
        }
    }
    const rows = [...groups.values()].map(
        (group): UsageRow => ({
            ...group,
            cost: roundAmount(group.cost),
            currency: options.currency,
            cacheHitRate: group.inputTokens > 0 ? group.cachedTokens / group.inputTokens : 0,
        }),
    );
    // Array#sort is stable, so equal costs keep the order in which their groups first appeared.
    return rows.sort((a, b) => b.cost - a.cost);
}

/**
 * Share of cost spent by the `supervisor` role (06 §5): the supervision overhead of a team. 0 when nothing
 * was spent. Events in several currencies need `rates`.
 */
export function supervisionShare(events: readonly UsageEvent[], rates?: ExchangeRates): number {
    const currency = events.find((event) => event.cost)?.cost?.currency;
    if (!currency) {
        return 0;
    }
    let total = 0;
    let supervisor = 0;
    for (const event of events) {
        if (event.cost) {
            const amount = convertExact(event.cost.amount, event.cost.currency, currency, rates);
            total += amount;
            if (event.role === 'supervisor') {
                supervisor += amount;
            }
        }
    }
    return total > 0 ? supervisor / total : 0;
}
