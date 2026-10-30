import { describe, expect, it } from 'vitest';
import { type Budget, budgetKey, checkBudgets, evaluateBudget, periodWindow } from '../src/index.ts';

function budget(fields: Partial<Budget>): Budget {
    return { id: 'b', scope: 'global', period: 'day', limit: 10, currency: 'CNY', onExceed: 'pause', ...fields };
}

describe('evaluateBudget', () => {
    it.each([
        [0, 'ok', 0, 10],
        [7.99, 'ok', 0.799, 2.01],
        [8, 'warn', 0.8, 2],
        [9.5, 'warn', 0.95, 0.5],
        [10, 'exceeded', 1, 0],
        [12, 'exceeded', 1.2, 0],
    ])('spent %d of 10 is %s', (spent, state, ratio, remaining) => {
        const result = evaluateBudget(budget({}), spent);
        expect(result.state).toBe(state);
        expect(result.ratio).toBeCloseTo(ratio, 9);
        expect(result.remaining).toBe(remaining);
    });

    it('honours a custom warn ratio', () => {
        expect(evaluateBudget(budget({ warnRatio: 0.5 }), 5).state).toBe('warn');
        expect(evaluateBudget(budget({ warnRatio: 0.5 }), 4.99).state).toBe('ok');
    });

    it('treats a zero limit as exceeded and bad spending as nothing spent', () => {
        expect(evaluateBudget(budget({ limit: 0 }), 0)).toEqual({ state: 'exceeded', ratio: 1, remaining: 0 });
        expect(evaluateBudget(budget({}), Number.NaN)).toEqual({ state: 'ok', ratio: 0, remaining: 10 });
        expect(evaluateBudget(budget({}), -3)).toEqual({ state: 'ok', ratio: 0, remaining: 10 });
    });
});

describe('checkBudgets', () => {
    const monthly = budget({ id: 'month', period: 'month', limit: 300, onExceed: 'pause' });
    const coder = budget({ id: 'coder', scope: 'agent', scopeId: 'coder-1', limit: 5, onExceed: 'stop' });
    const project = budget({ id: 'project', scope: 'project', scopeId: 'p1', limit: 20, onExceed: 'pause' });
    const perRun = budget({
        id: 'run',
        scope: 'workflow',
        scopeId: 'nightly',
        period: 'run',
        limit: 20,
        onExceed: 'pause',
    });

    it('keys spending by scope, scope id, period and currency', () => {
        expect(budgetKey(coder)).toBe('agent:coder-1:day:CNY');
        expect(budgetKey(monthly)).toBe('global:*:month:CNY');
    });

    it('reports every hit, most severe first: stop, then pause, then warn', () => {
        const result = checkBudgets([project, monthly, coder, perRun], {
            [budgetKey(project)]: 17,
            [budgetKey(monthly)]: 320,
            [budgetKey(coder)]: 5.2,
            [budgetKey(perRun)]: 3,
        });
        expect(result.state).toBe('exceeded');
        expect(result.action).toBe('stop');
        expect(result.worst?.budget.id).toBe('coder');
        expect(result.hits.map((hit) => [hit.budget.id, hit.state, hit.action])).toEqual([
            ['coder', 'exceeded', 'stop'],
            ['month', 'exceeded', 'pause'],
            ['project', 'warn', 'warn'],
        ]);
    });

    it('pauses when the only exceeded budget asks to pause', () => {
        const result = checkBudgets([monthly, coder], { [budgetKey(monthly)]: 301, [budgetKey(coder)]: 4 });
        expect(result).toMatchObject({ state: 'exceeded', action: 'pause' });
        expect(result.hits.map((hit) => hit.action)).toEqual(['pause', 'warn']);
    });

    it('orders hits of equal severity by ratio', () => {
        const other = budget({ id: 'other', scope: 'project', scopeId: 'p2', limit: 10 });
        const result = checkBudgets([project, other], { [budgetKey(project)]: 16, [budgetKey(other)]: 9 });
        expect(result.hits.map((hit) => hit.budget.id)).toEqual(['other', 'project']);
        expect(result.action).toBe('warn');
    });

    it('is ok when nothing is near a limit or nothing was recorded', () => {
        expect(checkBudgets([monthly, coder], {})).toEqual({ state: 'ok', action: 'none', hits: [] });
        expect(checkBudgets([], { anything: 1 })).toEqual({ state: 'ok', action: 'none', hits: [] });
    });
});

describe('periodWindow', () => {
    const windowOf = (period: 'day' | 'week' | 'month', at: string, timezone = 'Asia/Shanghai') => {
        const result = periodWindow(period, new Date(at), timezone);
        return [result.start.toISOString(), result.end.toISOString()];
    };

    it('uses the local day, which can differ from the UTC one', () => {
        // 2026-10-31 16:30 UTC is already 2026-11-01 00:30 in Beijing.
        expect(windowOf('day', '2026-10-31T16:30:00Z')).toEqual([
            '2026-10-31T16:00:00.000Z',
            '2026-11-01T16:00:00.000Z',
        ]);
        expect(windowOf('day', '2026-10-31T16:30:00Z', 'UTC')).toEqual([
            '2026-10-31T00:00:00.000Z',
            '2026-11-01T00:00:00.000Z',
        ]);
    });

    it('rolls over to the next month at local midnight', () => {
        expect(windowOf('month', '2026-10-31T15:59:59Z')).toEqual([
            '2026-09-30T16:00:00.000Z',
            '2026-10-31T16:00:00.000Z',
        ]);
        expect(windowOf('month', '2026-10-31T16:00:00Z')).toEqual([
            '2026-10-31T16:00:00.000Z',
            '2026-11-30T16:00:00.000Z',
        ]);
        expect(windowOf('month', '2026-12-31T16:00:00Z')).toEqual([
            '2026-12-31T16:00:00.000Z',
            '2027-01-31T16:00:00.000Z',
        ]);
    });

    it('handles short months and leap years', () => {
        expect(windowOf('month', '2028-02-15T00:00:00Z')).toEqual([
            '2028-01-31T16:00:00.000Z',
            '2028-02-29T16:00:00.000Z',
        ]);
    });

    it('starts weeks on Monday', () => {
        // Friday 2026-10-30 in Beijing.
        expect(windowOf('week', '2026-10-30T10:00:00+08:00')).toEqual([
            '2026-10-25T16:00:00.000Z',
            '2026-11-01T16:00:00.000Z',
        ]);
    });

    it('follows daylight saving time', () => {
        // New York leaves daylight saving time on 2026-11-01, so that day lasts 25 hours.
        expect(windowOf('day', '2026-11-01T12:00:00-05:00', 'America/New_York')).toEqual([
            '2026-11-01T04:00:00.000Z',
            '2026-11-02T05:00:00.000Z',
        ]);
    });

    it('has no calendar window for per-run budgets', () => {
        expect(periodWindow('run', new Date('2026-10-30T10:00:00Z'), 'Asia/Shanghai')).toBeUndefined();
    });
});
