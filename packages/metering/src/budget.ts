import { roundAmount } from './cost.ts';
import type { Currency } from './prices.ts';
import { addDays, type CivilDate, civilDay, epochOf, zonedEpoch, zonedTime } from './zone.ts';

export type BudgetScope = 'global' | 'project' | 'agent' | 'workflow' | 'thread' | 'turn';
/** `run` budgets cover one workflow run, thread or turn each, instead of a calendar window. */
export type BudgetPeriod = 'day' | 'month' | 'run';
export type CalendarPeriod = 'day' | 'week' | 'month';

export interface Budget {
    readonly id: string;
    readonly scope: BudgetScope;
    /** Project, agent, workflow … id; absent for `global` and for budgets that apply to every thread or turn. */
    readonly scopeId?: string;
    readonly period: BudgetPeriod;
    readonly limit: number;
    readonly currency: Currency;
    /** Share of the limit at which to warn; {@link DEFAULT_WARN_RATIO} when absent. */
    readonly warnRatio?: number;
    /** What happens at 100%: pause and ask, or stop outright. */
    readonly onExceed: 'pause' | 'stop';
}

export const DEFAULT_WARN_RATIO = 0.8;

export type BudgetState = 'ok' | 'warn' | 'exceeded';
/** What the host should do about a budget: nothing, warn, or the budget's `onExceed`. */
export type BudgetAction = 'none' | 'warn' | 'pause' | 'stop';

export interface BudgetEvaluation {
    readonly state: BudgetState;
    /** `spent / limit`. */
    readonly ratio: number;
    readonly remaining: number;
}

export interface BudgetHit extends BudgetEvaluation {
    readonly budget: Budget;
    readonly spent: number;
    readonly action: BudgetAction;
}

export interface BudgetCheck {
    /** State and action of the most severe hit; `ok` and `none` when there is none. */
    readonly state: BudgetState;
    readonly action: BudgetAction;
    readonly worst?: BudgetHit;
    /** Every budget at `warn` or `exceeded`, most severe first. */
    readonly hits: readonly BudgetHit[];
}

/** `[start, end)` */
export interface TimeWindow {
    readonly start: Date;
    readonly end: Date;
}

const SEVERITY: Readonly<Record<BudgetAction, number>> = { none: 0, warn: 1, pause: 2, stop: 3 };

/** `spent` is in the budget's currency. A limit of 0 or less is exceeded from the start. */
export function evaluateBudget(budget: Pick<Budget, 'limit' | 'warnRatio'>, spent: number): BudgetEvaluation {
    const used = Number.isFinite(spent) && spent > 0 ? spent : 0;
    if (!(budget.limit > 0)) {
        return { state: 'exceeded', ratio: 1, remaining: 0 };
    }
    const ratio = used / budget.limit;
    let state: BudgetState = 'ok';
    if (ratio >= 1) {
        state = 'exceeded';
    } else if (ratio >= (budget.warnRatio ?? DEFAULT_WARN_RATIO)) {
        state = 'warn';
    }
    return { state, ratio, remaining: roundAmount(Math.max(0, budget.limit - used)) };
}

/**
 * Key under which {@link checkBudgets} looks up a budget's spending, e.g. `agent:coder-1:day:CNY`;
 * `*` stands for a missing `scopeId`.
 */
export function budgetKey(budget: Pick<Budget, 'scope' | 'scopeId' | 'period' | 'currency'>): string {
    return [budget.scope, budget.scopeId ?? '*', budget.period, budget.currency].join(':');
}

/**
 * Evaluates every budget against `spentByKey[budgetKey(budget)]` (missing keys mean nothing was spent).
 * Severity: stop > pause > warn, then the higher ratio.
 */
export function checkBudgets(budgets: readonly Budget[], spentByKey: Readonly<Record<string, number>>): BudgetCheck {
    const hits: BudgetHit[] = [];
    for (const budget of budgets) {
        const key = budgetKey(budget);
        const spent = Object.hasOwn(spentByKey, key) ? (spentByKey[key] ?? 0) : 0;
        const evaluation = evaluateBudget(budget, spent);
        if (evaluation.state !== 'ok') {
            const action = evaluation.state === 'warn' ? 'warn' : budget.onExceed;
            hits.push({ ...evaluation, budget, spent, action });
        }
    }
    hits.sort((a, b) => SEVERITY[b.action] - SEVERITY[a.action] || b.ratio - a.ratio);
    const worst = hits[0];
    return worst ? { state: worst.state, action: worst.action, worst, hits } : { state: 'ok', action: 'none', hits };
}

/**
 * The calendar window containing `at` in `timezone`: a local day, an ISO week starting on Monday, or a month.
 * `run` has no calendar window.
 */
export function periodWindow(period: CalendarPeriod, at: Date, timezone: string): TimeWindow;
export function periodWindow(period: BudgetPeriod | CalendarPeriod, at: Date, timezone: string): TimeWindow | undefined;
export function periodWindow(
    period: BudgetPeriod | CalendarPeriod,
    at: Date,
    timezone: string,
): TimeWindow | undefined {
    if (period === 'run') {
        return undefined;
    }
    const today = zonedTime(timezone, epochOf(at));
    let start: CivilDate = today;
    let end: CivilDate;
    if (period === 'day') {
        end = addDays(today, 1);
    } else if (period === 'week') {
        start = addDays(today, 1 - today.weekday);
        end = addDays(start, 7);
    } else {
        start = civilDay(today.year, today.month, 1);
        end = civilDay(today.year, today.month + 1, 1);
    }
    return { start: new Date(zonedEpoch(timezone, start)), end: new Date(zonedEpoch(timezone, end)) };
}
