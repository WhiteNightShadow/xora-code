import { convert, priceTableFor, priceUsage } from '@xora/metering';
import type { Money, Settings, UsageRequest, UsageRow, UsageTotals } from '@xora/protocol';
import type { XoraDatabase } from '@xora/storage';
import { newId } from './ids.ts';

export interface TokenUsage {
    readonly inputTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
}

/** One model request as reported by an engine (xora `_meta.xora.request`, or an ACP `usage_update`). */
export interface RequestReport {
    readonly projectId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly agentPath?: string;
    readonly agentId?: string;
    readonly taskId?: string;
    readonly workflowRunId?: string;
    readonly role?: string;
    readonly tier?: string;
    readonly engine: string;
    readonly provider: string;
    readonly channel?: string;
    readonly model: string;
    readonly pricing?: string;
    readonly usage: TokenUsage | null;
    readonly latencyMs: number;
    readonly ttftMs?: number;
    readonly status: 'ok' | 'error';
    readonly errorClass?: string;
    readonly stopReason?: string;
    readonly source: 'vendor' | 'estimate' | 'acp';
    /** Cost reported by an external agent (ACP `usage_update.cost`), used when xora has no price table. */
    readonly reportedCost?: Money;
}

interface UsageRowDb {
    id: string;
    ts: number;
    turn_id: string | null;
    provider: string;
    model: string;
    agent_path: string;
    input_tokens: number;
    cached_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    latency_ms: number;
    ttft_ms: number | null;
    cost_amount: number | null;
    cost_currency: string | null;
    cost_period: string | null;
    cost_complete: number;
    status: string;
    error_class: string | null;
    stop_reason: string | null;
}

const EMPTY_USAGE: TokenUsage = {
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
};

function rangeStart(range: 'today' | 'week' | 'month' | 'all', now = new Date()): number {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (range === 'today') return start.getTime();
    if (range === 'week') return start.getTime() - 6 * 86_400_000;
    if (range === 'month') return new Date(start.getFullYear(), start.getMonth(), 1).getTime();
    return 0;
}

/**
 * User-side cost accounting (11): every model request becomes a usage event priced with the vendor's table
 * (peak/off-peak, context tiers). Only counts and costs are stored, never prompt content.
 */
export class UsageService {
    readonly #db: XoraDatabase;
    readonly #settings: () => Settings;

    constructor(db: XoraDatabase, settings: () => Settings) {
        this.#db = db;
        this.#settings = settings;
    }

    #rates(): { USD_CNY: number } {
        return { USD_CNY: this.#settings().usdToCny };
    }

    /** Converts to the user's display currency. */
    toDisplay(money: Money): Money {
        const target = this.#settings().currency;
        if (money.currency === target) {
            return money;
        }
        try {
            return {
                amount: convert(money.amount, money.currency as 'CNY' | 'USD', target, this.#rates()),
                currency: target,
            };
        } catch {
            return money;
        }
    }

    /** Records a request and returns its cost in the display currency (null when the price is unknown). */
    record(report: RequestReport, at = new Date()): { cost: Money | null; complete: boolean } {
        const usage = report.usage ?? EMPTY_USAGE;
        const table = priceTableFor({ id: report.model, pricing: report.pricing, channel: report.channel });
        let cost: Money | null = null;
        let complete = false;
        let period: string | null = null;
        let tableId: string | null = null;
        if (table && report.usage) {
            const priced = priceUsage(table, usage, { at });
            cost = { amount: priced.amount, currency: priced.currency };
            complete = priced.complete;
            period = priced.period;
            tableId = priced.tableId;
        } else if (report.reportedCost) {
            cost = report.reportedCost;
            complete = true;
        } else if (report.status === 'error' || !report.usage) {
            cost = null;
            complete = report.status === 'error';
        }
        this.#db.run(
            `insert into usage_events (id, ts, project_id, thread_id, turn_id, agent_path, agent_id, task_id, workflow_run_id, role, tier,
                engine, provider, channel, model, input_tokens, cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
                latency_ms, ttft_ms, cost_amount, cost_currency, cost_table, cost_period, cost_complete, status, error_class, stop_reason, source)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                newId('u'),
                at.getTime(),
                report.projectId,
                report.threadId,
                report.turnId,
                report.agentPath ?? 'main',
                report.agentId ?? null,
                report.taskId ?? null,
                report.workflowRunId ?? null,
                report.role ?? null,
                report.tier ?? null,
                report.engine,
                report.provider,
                report.channel ?? null,
                report.model,
                usage.inputTokens,
                usage.cachedTokens,
                usage.cacheWriteTokens,
                usage.outputTokens,
                usage.reasoningTokens,
                Math.round(report.latencyMs),
                report.ttftMs === undefined ? null : Math.round(report.ttftMs),
                cost?.amount ?? null,
                cost?.currency ?? null,
                tableId,
                period,
                complete ? 1 : 0,
                report.status,
                report.errorClass ?? null,
                report.stopReason ?? null,
                report.source,
            ],
        );
        return { cost: cost ? this.toDisplay(cost) : null, complete };
    }

    #totals(rows: readonly UsageRowDb[]): UsageTotals {
        const currency = this.#settings().currency;
        let amount = 0;
        let complete = true;
        const totals = { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
        for (const row of rows) {
            totals.requests++;
            totals.inputTokens += row.input_tokens;
            totals.cachedTokens += row.cached_tokens;
            totals.outputTokens += row.output_tokens;
            totals.reasoningTokens += row.reasoning_tokens;
            if (row.cost_amount === null) {
                if (row.status === 'ok') complete = false;
                continue;
            }
            if (row.cost_complete !== 1) complete = false;
            amount += this.toDisplay({ amount: row.cost_amount, currency: row.cost_currency ?? 'CNY' }).amount;
        }
        return { ...totals, cost: { amount: Math.round(amount * 1e6) / 1e6, currency }, complete };
    }

    thread(threadId: string): { totals: UsageTotals; requests: UsageRequest[] } {
        const rows = this.#db.all<UsageRowDb>('select * from usage_events where thread_id = ? order by ts', [threadId]);
        return {
            totals: this.#totals(rows),
            requests: rows.map((row) => ({
                id: row.id,
                ts: row.ts,
                turnId: row.turn_id ?? '',
                provider: row.provider,
                model: row.model,
                agentPath: row.agent_path,
                inputTokens: row.input_tokens,
                cachedTokens: row.cached_tokens,
                cacheWriteTokens: row.cache_write_tokens,
                outputTokens: row.output_tokens,
                reasoningTokens: row.reasoning_tokens,
                latencyMs: row.latency_ms,
                ...(row.ttft_ms !== null ? { ttftMs: row.ttft_ms } : {}),
                cost:
                    row.cost_amount === null
                        ? null
                        : this.toDisplay({ amount: row.cost_amount, currency: row.cost_currency ?? 'CNY' }),
                ...(row.cost_period ? { period: row.cost_period } : {}),
                complete: row.cost_complete === 1,
                status: row.status === 'error' ? 'error' : 'ok',
                ...(row.error_class ? { errorClass: row.error_class } : {}),
                ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
            })),
        };
    }

    /** Spend in the display currency since `since`, for budget checks. */
    spentSince(since: number): number {
        const rows = this.#db.all<UsageRowDb>('select * from usage_events where ts >= ?', [since]);
        return this.#totals(rows).cost.amount;
    }

    summary(
        range: 'today' | 'week' | 'month' | 'all',
        groupBy: 'model' | 'provider' | 'project' | 'thread' | 'day',
        labels: { project(id: string): string; thread(id: string): string },
    ): { totals: UsageTotals; rows: UsageRow[] } {
        const rows = this.#db.all<UsageRowDb & { project_id: string | null; thread_id: string | null }>(
            'select * from usage_events where ts >= ? order by ts',
            [rangeStart(range)],
        );
        const groups = new Map<string, Array<(typeof rows)[number]>>();
        for (const row of rows) {
            const key =
                groupBy === 'model'
                    ? `${row.provider}/${row.model}`
                    : groupBy === 'provider'
                      ? row.provider
                      : groupBy === 'project'
                        ? (row.project_id ?? '-')
                        : groupBy === 'thread'
                          ? (row.thread_id ?? '-')
                          : new Date(row.ts).toISOString().slice(0, 10);
            const group = groups.get(key) ?? [];
            group.push(row);
            groups.set(key, group);
        }
        const result: UsageRow[] = [...groups.entries()].map(([key, group]) => {
            const totals = this.#totals(group);
            const label = groupBy === 'project' ? labels.project(key) : groupBy === 'thread' ? labels.thread(key) : key;
            return {
                key,
                label,
                totals,
                cacheHitRate: totals.inputTokens > 0 ? totals.cachedTokens / totals.inputTokens : 0,
            };
        });
        result.sort((a, b) => b.totals.cost.amount - a.totals.cost.amount);
        return { totals: this.#totals(rows), rows: result };
    }
}
