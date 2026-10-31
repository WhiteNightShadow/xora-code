import { describe, expect, it } from 'vitest';
import {
    type AttemptRecord,
    budgetPressure,
    type ConnectedModel,
    DEFAULT_ORG,
    downgradeSuggestion,
    firstPassStats,
    lowerTier,
    modelChain,
    nextTier,
    type Organization,
    pickReviewerModel,
    resolveTier,
    shouldEscalate,
    tierUnderPressure,
} from '../src/index.ts';
import { card, followsChineseStyle } from './helpers.ts';

describe('resolveTier', () => {
    it('uses the role default, or the tier of the agent that would do the card', () => {
        expect(resolveTier('supervisor', undefined, DEFAULT_ORG)).toEqual({ tier: 'flagship', source: 'agent' });
        expect(resolveTier('executor', card({ category: 'bugfix', tier: 'standard' }), DEFAULT_ORG)).toEqual({
            tier: 'standard',
            source: 'agent',
        });
        const empty: Organization = { ...DEFAULT_ORG, roster: [] };
        expect(resolveTier('scout', undefined, empty)).toEqual({ tier: 'fast', source: 'role' });
    });

    it('allows a cheaper tier and a stronger one only with a reason', () => {
        expect(resolveTier('executor', card({ tier: 'fast' }), DEFAULT_ORG)).toEqual({ tier: 'fast', source: 'card' });
        expect(resolveTier('executor', card({ tier: 'flagship' }), DEFAULT_ORG)).toEqual({
            tier: 'economy',
            source: 'agent',
            rejected: { tier: 'flagship', reason: 'a tier above economy needs a tierReason' },
        });
        expect(
            resolveTier(
                'executor',
                card({ tier: 'flagship', tierReason: 'concurrency bug in the queue' }),
                DEFAULT_ORG,
            ),
        ).toEqual({ tier: 'flagship', source: 'card' });
    });

    it('takes the assignee into account', () => {
        expect(resolveTier('executor', card({ assignee: 'debugger-1', tier: 'standard' }), DEFAULT_ORG).tier).toBe(
            'standard',
        );
    });
});

describe('modelChain', () => {
    const available: ConnectedModel[] = [
        { connectionId: 'glm-cn', model: 'glm-5.3', channel: 'api' },
        { connectionId: 'kimi-code', model: 'kimi-k3.1-pro', family: 'kimi', channel: 'subscription_key' },
        { connectionId: 'relay', model: 'glm-5.3', channel: 'api' },
        { connectionId: 'deepseek', model: 'deepseek-flash', channel: 'api' },
    ];

    it('keeps the tier order and drops models the user does not have', () => {
        expect(modelChain('flagship', DEFAULT_ORG, available)).toEqual([
            {
                connectionId: 'kimi-code',
                model: 'kimi-k3.1-pro',
                family: 'kimi',
                effort: 'high',
                channel: 'subscription_key',
            },
            { connectionId: 'glm-cn', model: 'glm-5.3', family: 'glm', effort: 'high', channel: 'api' },
            { connectionId: 'relay', model: 'glm-5.3', family: 'glm', effort: 'high', channel: 'api' },
        ]);
        expect(modelChain('fast', DEFAULT_ORG, available).map((model) => [model.model, model.effort])).toEqual([
            ['deepseek-flash', 'off'],
        ]);
    });

    it('leaves subscription quotas out of unattended runs', () => {
        expect(
            modelChain('flagship', DEFAULT_ORG, available, { unattended: true }).map((model) => model.connectionId),
        ).toEqual(['glm-cn', 'relay']);
        const local: ConnectedModel[] = [
            ...available,
            { connectionId: 'ollama', model: 'kimi-k3.1-pro', family: 'kimi', channel: 'local' },
        ];
        expect(
            modelChain('flagship', DEFAULT_ORG, local, { unattended: true }).map((model) => model.connectionId),
        ).toEqual(['ollama', 'glm-cn', 'relay']);
    });

    it('honours connections pinned in the tier table', () => {
        const org: Organization = {
            ...DEFAULT_ORG,
            tiers: {
                ...DEFAULT_ORG.tiers,
                standard: { effort: 'max', models: [{ model: 'glm-5.3', connectionId: 'relay' }] },
            },
        };
        expect(modelChain('standard', org, available)).toEqual([
            { connectionId: 'relay', model: 'glm-5.3', family: 'glm', effort: 'max', channel: 'api' },
        ]);
    });
});

describe('pickReviewerModel', () => {
    const chain = modelChain('standard', DEFAULT_ORG, [
        { connectionId: 'deepseek', model: 'deepseek-v4-pro' },
        { connectionId: 'glm', model: 'glm-5.3' },
    ]);

    it('prefers a family other than the executor', () => {
        expect(pickReviewerModel('deepseek', chain)).toMatchObject({ model: { model: 'glm-5.3' }, crossFamily: true });
        expect(pickReviewerModel('glm', chain)).toMatchObject({
            model: { model: 'deepseek-v4-pro' },
            crossFamily: true,
        });
    });

    it('falls back to the first model', () => {
        expect(pickReviewerModel('deepseek', chain.slice(0, 1))).toMatchObject({
            model: { model: 'deepseek-v4-pro' },
            crossFamily: false,
        });
        expect(pickReviewerModel(undefined, chain)).toMatchObject({ crossFamily: false });
        expect(pickReviewerModel('kimi', [])).toBeUndefined();
    });
});

describe('escalation', () => {
    it('orders tiers from fast to flagship', () => {
        expect(nextTier('fast')).toBe('economy');
        expect(nextTier('economy')).toBe('standard');
        expect(nextTier('standard')).toBe('flagship');
        expect(nextTier('flagship')).toBeUndefined();
        expect(lowerTier('economy')).toBe('fast');
        expect(lowerTier('fast')).toBeUndefined();
    });

    it('walks economy → standard → flagship → supervisor → human', () => {
        const history: AttemptRecord[] = [];
        const decisions: string[] = [];
        const record = (attempt: AttemptRecord) => {
            history.push(attempt);
            const decision = shouldEscalate(history);
            decisions.push(decision.action === 'escalate' ? `escalate:${decision.to}` : decision.action);
        };
        record({ tier: 'economy', outcome: 'fail' });
        record({ tier: 'economy', outcome: 'fail' });
        record({ tier: 'standard', outcome: 'fail' });
        record({ tier: 'standard', outcome: 'fail' });
        record({ tier: 'flagship', outcome: 'fail' });
        record({ tier: 'flagship', outcome: 'fail' });
        record({ tier: 'flagship', outcome: 'fail', by: 'supervisor' });
        expect(decisions).toEqual([
            'retry',
            'escalate:standard',
            'retry',
            'escalate:flagship',
            'retry',
            'supervisor',
            'human',
        ]);
    });

    it('escalates at once when the executor asks, honouring a higher target', () => {
        expect(shouldEscalate([{ tier: 'economy', outcome: 'escalate' }])).toEqual({
            action: 'escalate',
            from: 'economy',
            to: 'standard',
            reason: 'requested',
        });
        expect(shouldEscalate([{ tier: 'economy', outcome: 'escalate', escalateTo: 'flagship' }])).toMatchObject({
            to: 'flagship',
        });
        expect(shouldEscalate([{ tier: 'standard', outcome: 'escalate', escalateTo: 'fast' }])).toMatchObject({
            to: 'flagship',
        });
        expect(shouldEscalate([{ tier: 'flagship', outcome: 'escalate' }])).toEqual({
            action: 'supervisor',
            reason: 'requested',
        });
    });

    it('needs failures in a row at the same tier', () => {
        expect(shouldEscalate([])).toEqual({ action: 'none' });
        expect(
            shouldEscalate([
                { tier: 'economy', outcome: 'fail' },
                { tier: 'economy', outcome: 'pass' },
            ]),
        ).toEqual({ action: 'none' });
        expect(
            shouldEscalate([
                { tier: 'economy', outcome: 'fail' },
                { tier: 'standard', outcome: 'fail' },
            ]),
        ).toEqual({ action: 'retry', failures: 1 });
        expect(shouldEscalate([{ tier: 'economy', outcome: 'fail' }], 1)).toMatchObject({ action: 'escalate' });
    });
});

describe('downgradeSuggestion', () => {
    it('suggests one tier cheaper from 90% first-pass over 10 tasks', () => {
        const suggestion = downgradeSuggestion({ category: 'Docs', tier: 'standard', tasks: 20, firstPass: 19 });
        expect(suggestion).toMatchObject({ category: 'docs', from: 'standard', to: 'economy', firstPassRate: 0.95 });
        expect(suggestion?.message).toBe(
            'docs类任务在标准档的一次通过率是95%（共20个），可以考虑改用经济档。这只是建议，不会自动修改。',
        );
        expect(followsChineseStyle(suggestion?.message ?? '')).toBe(true);
        expect(downgradeSuggestion({ category: 'docs', tier: 'standard', tasks: 10, firstPass: 9 })).toBeDefined();
    });

    it('stays quiet below the thresholds or at the cheapest tier', () => {
        expect(downgradeSuggestion({ category: 'docs', tier: 'standard', tasks: 9, firstPass: 9 })).toBeUndefined();
        expect(downgradeSuggestion({ category: 'docs', tier: 'standard', tasks: 20, firstPass: 17 })).toBeUndefined();
        expect(downgradeSuggestion({ category: 'docs', tier: 'fast', tasks: 50, firstPass: 50 })).toBeUndefined();
    });

    it('counts first passes per category and starting tier', () => {
        const coding = card();
        expect(
            firstPassStats([
                { card: coding, attempts: [{ tier: 'economy', outcome: 'pass' }] },
                {
                    card: coding,
                    attempts: [
                        { tier: 'economy', outcome: 'fail' },
                        { tier: 'economy', outcome: 'pass' },
                    ],
                },
                { card: coding, attempts: [] },
            ]),
        ).toEqual([{ category: 'coding', tier: 'economy', tasks: 2, firstPass: 1 }]);
    });
});

describe('budget pressure', () => {
    it('is tight from 80% and exhausted at 100%', () => {
        expect(budgetPressure(7.9, 10).state).toBe('ok');
        expect(budgetPressure(8, 10)).toEqual({ ratio: 0.8, state: 'tight' });
        expect(budgetPressure(10, 10).state).toBe('exhausted');
        expect(budgetPressure(0, 0).state).toBe('exhausted');
        expect(budgetPressure(Number.NaN, 10).state).toBe('ok');
    });

    it('drops non-critical tasks one tier, never writable work to fast', () => {
        const tight = budgetPressure(9, 10);
        expect(tierUnderPressure('standard', card(), tight)).toBe('economy');
        expect(tierUnderPressure('standard', card({ priority: 'critical' }), tight)).toBe('standard');
        expect(tierUnderPressure('economy', card(), tight)).toBe('economy');
        expect(tierUnderPressure('economy', card({ workspace: 'readonly' }), tight)).toBe('fast');
        expect(tierUnderPressure('standard', card(), budgetPressure(1, 10))).toBe('standard');
    });
});
