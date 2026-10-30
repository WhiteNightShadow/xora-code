import { describe, expect, it } from 'vitest';
import {
    applyRevocations,
    type BootState,
    type Candidate,
    decideBoot,
    emptyState,
    factoryId,
    type Inventory,
    markBad,
    reconcile,
    recordAborted,
    recordFailure,
    recordGood,
    recordInvalid,
    recordLaunch,
    requestSafeMode,
    rollbackTo,
    slotId,
    stagePending,
} from '../src/index.ts';

const MAX = 2;
const factory = { version: '1.0.0' };
const factoryCandidate: Candidate = { id: factoryId('1.0.0'), kind: 'factory', version: '1.0.0' };
const slot = (version: string): Candidate => ({ id: slotId(version), kind: 'slot', version });

function decide(state: BootState, inventory: Inventory) {
    return decideBoot(state, inventory, { maxAttempts: MAX });
}

/** Simulates one launch of whatever the policy picks; `fails` decides the outcome per candidate id. */
function bootOnce(state: BootState, inventory: Inventory, fails: (id: string) => boolean) {
    const { decision, exhausted } = decide(state, inventory);
    let next = exhausted.reduce((current, id) => markBad(current, id, 'exhausted'), state);
    if (decision.kind === 'safe-mode') {
        return { state: next, decision };
    }
    next = recordLaunch(next, decision.candidate.id);
    next = fails(decision.candidate.id)
        ? recordFailure(next, decision.candidate.id, 'host-exit:3', MAX)
        : recordGood(next, decision.candidate);
    return { state: next, decision };
}

describe('decideBoot', () => {
    it('boots the factory bundle on a fresh install', () => {
        const { decision } = decide(emptyState(), { factory, slots: [] });
        expect(decision).toEqual({ kind: 'launch', candidate: factoryCandidate, reason: 'factory' });
    });

    it('prefers pending, then current, then last good, then factory', () => {
        const state: BootState = { ...emptyState(), pending: '1.2.0', current: '1.1.0', lastGood: slotId('1.1.0') };
        const inventory = { factory, slots: ['1.1.0', '1.2.0'] };
        expect(decide(state, inventory).decision).toMatchObject({ candidate: slot('1.2.0'), reason: 'pending' });
        expect(decide({ ...state, pending: undefined }, inventory).decision).toMatchObject({ reason: 'current' });
    });

    it('skips slots that are not installed', () => {
        const state: BootState = { ...emptyState(), pending: '9.9.9' };
        expect(decide(state, { factory, slots: [] }).decision).toMatchObject({ reason: 'factory' });
    });

    it('honours a safe mode request', () => {
        expect(decide(requestSafeMode(emptyState()), { factory, slots: [] }).decision).toEqual({
            kind: 'safe-mode',
            reason: 'requested',
        });
    });

    it('enters safe mode when nothing can be launched', () => {
        expect(decide(emptyState(), { slots: [] }).decision).toEqual({ kind: 'safe-mode', reason: 'all-failed' });
    });

    it('reports candidates whose attempts are exhausted so the caller can mark them bad', () => {
        const state: BootState = { ...emptyState(), pending: '1.2.0', attempts: { [slotId('1.2.0')]: MAX } };
        const result = decide(state, { factory, slots: ['1.2.0'] });
        expect(result.exhausted).toEqual([slotId('1.2.0')]);
        expect(result.decision).toMatchObject({ reason: 'factory' });
    });
});

describe('boot sequences', () => {
    it('a broken pending update is tried twice, marked bad, and the last good version boots', () => {
        const inventory = { factory, slots: ['1.1.0', '1.2.0'] };
        let state: BootState = { ...emptyState(), current: '1.1.0', lastGood: slotId('1.1.0') };
        state = stagePending(state, '1.2.0');
        const broken = (id: string) => id === slotId('1.2.0');

        const first = bootOnce(state, inventory, broken);
        expect(first.decision).toMatchObject({ candidate: slot('1.2.0') });
        const second = bootOnce(first.state, inventory, broken);
        expect(second.decision).toMatchObject({ candidate: slot('1.2.0') });
        expect(second.state.bad.map((mark) => mark.id)).toEqual([slotId('1.2.0')]);
        expect(second.state.pending).toBeUndefined();

        const third = bootOnce(second.state, inventory, broken);
        expect(third.decision).toMatchObject({ candidate: slot('1.1.0'), reason: 'current' });
        expect(third.state.lastGood).toBe(slotId('1.1.0'));
    });

    it('a whole-app crash still counts: two unfinished launches exhaust the candidate', () => {
        const inventory = { factory, slots: ['1.2.0'] };
        let state = stagePending(emptyState(), '1.2.0');
        state = recordLaunch(state, slotId('1.2.0'));
        state = recordLaunch(state, slotId('1.2.0'));
        const result = decide(state, inventory);
        expect(result.exhausted).toEqual([slotId('1.2.0')]);
        expect(result.decision).toMatchObject({ reason: 'factory' });
    });

    it('falls back to safe mode when the factory bundle fails too', () => {
        const inventory = { factory, slots: [] };
        const failing = () => true;
        let state = emptyState();
        let decision = bootOnce(state, inventory, failing);
        state = decision.state;
        decision = bootOnce(state, inventory, failing);
        state = decision.state;
        expect(state.bad.map((mark) => mark.id)).toEqual([factoryId('1.0.0')]);
        expect(bootOnce(state, inventory, failing).decision).toEqual({ kind: 'safe-mode', reason: 'all-failed' });
    });

    it('promotes a pending update that boots well', () => {
        const inventory = { factory, slots: ['1.1.0', '1.2.0'] };
        const state = stagePending({ ...emptyState(), current: '1.1.0', lastGood: slotId('1.1.0') }, '1.2.0');
        const booted = bootOnce(state, inventory, () => false).state;
        expect(booted).toMatchObject({ current: '1.2.0', previous: '1.1.0', lastGood: slotId('1.2.0') });
        expect(booted.pending).toBeUndefined();
        expect(booted.attempts).toEqual({});
    });

    it('never retries a bundle that fails verification', () => {
        const inventory = { factory, slots: ['1.2.0'] };
        let state = stagePending(emptyState(), '1.2.0');
        state = recordInvalid(state, slotId('1.2.0'), 'hash-mismatch:ui/index.html');
        expect(state.bad[0]).toMatchObject({ id: slotId('1.2.0'), reason: 'verify:hash-mismatch:ui/index.html' });
        expect(decide(state, inventory).decision).toMatchObject({ reason: 'factory' });
    });

    it('marking the current slot bad falls back to the previous slot', () => {
        const state: BootState = { ...emptyState(), current: '1.2.0', previous: '1.1.0' };
        expect(markBad(state, slotId('1.2.0'), 'revoked')).toMatchObject({ current: '1.1.0', previous: undefined });
    });

    it('revocations mark slot versions bad', () => {
        const state: BootState = { ...emptyState(), current: '1.2.0', lastGood: slotId('1.2.0') };
        const revoked = applyRevocations(state, ['1.2.0']);
        expect(revoked.current).toBeUndefined();
        expect(revoked.lastGood).toBeUndefined();
        expect(revoked.bad.map((mark) => mark.reason)).toEqual(['revoked']);
    });
});

describe('recordAborted', () => {
    it('gives back the attempt of a launch the user closed early', () => {
        let state = recordLaunch(emptyState(), slotId('1.2.0'));
        state = recordAborted(state, slotId('1.2.0'));
        expect(state.attempts).toEqual({});
        state = recordLaunch(recordLaunch(state, slotId('1.2.0')), slotId('1.2.0'));
        expect(recordAborted(state, slotId('1.2.0')).attempts).toEqual({ [slotId('1.2.0')]: 1 });
    });
});

describe('rollbackTo', () => {
    it('clears failures of the chosen slot and makes it current', () => {
        let state: BootState = { ...emptyState(), current: '1.2.0' };
        state = markBad(state, slotId('1.1.0'), 'host-exit:1');
        const rolled = rollbackTo(state, slot('1.1.0'));
        expect(rolled).toMatchObject({ current: '1.1.0', previous: '1.2.0', bad: [] });
    });

    it('rolling back to the factory bundle makes it the next candidate', () => {
        const state: BootState = { ...emptyState(), current: '1.2.0', lastGood: slotId('1.2.0') };
        const rolled = rollbackTo(state, factoryCandidate);
        expect(decide(rolled, { factory, slots: ['1.2.0'] }).decision).toMatchObject({ reason: 'factory' });
    });
});

describe('reconcile', () => {
    it('drops references to slots that are gone and to replaced factory bundles', () => {
        const state: BootState = {
            ...emptyState(),
            current: '1.1.0',
            pending: '1.2.0',
            lastGood: factoryId('0.9.0'),
        };
        expect(reconcile(state, { factory, slots: ['1.1.0'] })).toMatchObject({
            current: '1.1.0',
            pending: undefined,
            lastGood: undefined,
        });
    });
});
