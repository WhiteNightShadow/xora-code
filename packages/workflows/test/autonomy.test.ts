import { describe, expect, it } from 'vitest';
import {
    AUTONOMY_LEVELS,
    type AutonomyAction,
    confirmationPoints,
    countsAsApproval,
    HIGH_RISK_ACTIONS,
    needsHuman,
    validateAutonomy,
} from '../src/index.ts';

describe('needsHuman', () => {
    const actions: AutonomyAction[] = ['every_step', 'plan_approval', 'high_risk', 'final_delivery'];

    it.each([
        ['L0', [true, true, true, true]],
        ['L1', [false, true, true, true]],
        ['L2', [false, false, true, true]],
        ['L3', [false, false, true, false]],
    ] as const)('%s confirms the actions of 06 §8', (level, expected) => {
        expect(actions.map((action) => needsHuman(level, action))).toEqual(expected);
    });

    it('always asks a person for push, publish, delete, external messages and payments', () => {
        for (const level of AUTONOMY_LEVELS) {
            for (const action of HIGH_RISK_ACTIONS) {
                expect(needsHuman(level, action), `${level} ${action}`).toBe(true);
            }
        }
    });

    it('lists the confirmation points of a level', () => {
        expect(confirmationPoints('L1')).toEqual(['plan_approval', 'high_risk', 'final_delivery']);
    });
});

describe('countsAsApproval', () => {
    it('never takes a message from an agent as approval', () => {
        expect(countsAsApproval('agent', 'plan_approval')).toBe(false);
        expect(countsAsApproval('agent', 'push')).toBe(false);
    });

    it('lets policy settle routine points but not high-risk actions', () => {
        expect(countsAsApproval('policy', 'plan_approval')).toBe(true);
        expect(countsAsApproval('policy', 'high_risk')).toBe(false);
        expect(countsAsApproval('policy', 'payment')).toBe(false);
        expect(countsAsApproval('user', 'payment')).toBe(true);
    });
});

describe('validateAutonomy', () => {
    it('accepts L3 with api channels, a budget and restricted permissions', () => {
        expect(validateAutonomy('L3', { channels: ['api', 'api'], budget: 20, modes: ['plan', 'auto_edit'] })).toEqual({
            ok: true,
        });
    });

    it('lists every problem of an L3 run', () => {
        const result = validateAutonomy('L3', {
            channels: ['api', 'subscription_key', 'local', 'subscription_key'],
            modes: ['auto_edit', 'full'],
        });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.problems.map((problem) => problem.code)).toEqual([
            'channel_not_api',
            'missing_budget',
            'full_permission',
        ]);
        expect(!result.ok && result.problems[0]?.message).toBe(
            'L3 runs only on api channels; not allowed: subscription_key, local',
        );
        expect(validateAutonomy('L3', { channels: ['api'], budget: 0 }).ok).toBe(false);
    });

    it('does not restrict the levels with a person in the loop', () => {
        for (const level of ['L0', 'L1', 'L2'] as const) {
            expect(validateAutonomy(level, { channels: ['subscription_key'], modes: ['full'] })).toEqual({ ok: true });
        }
    });
});
