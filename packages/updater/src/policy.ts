import type { BootState } from './state.ts';

/**
 * Pure boot decisions. The bootstrap records every launch before it starts, so a candidate that crashes the
 * whole app still accumulates attempts. A candidate that fails `maxAttempts` times in a row is marked bad and
 * the next one is tried: pending → current → last good → factory → safe mode.
 */

export interface Candidate {
    readonly id: string;
    readonly kind: 'slot' | 'factory';
    readonly version: string;
}

export interface Inventory {
    /** The bundle shipped inside the installer, if it is present. */
    readonly factory?: { readonly version: string };
    /** Versions installed under `app/slots/`. */
    readonly slots: readonly string[];
}

export type SafeModeReason = 'requested' | 'all-failed' | 'boot-loop';

export type BootDecision =
    | {
          readonly kind: 'launch';
          readonly candidate: Candidate;
          readonly reason: 'pending' | 'current' | 'last-good' | 'factory';
      }
    | { readonly kind: 'safe-mode'; readonly reason: SafeModeReason };

export interface DecideOptions {
    readonly maxAttempts: number;
    readonly forceSafeMode?: boolean;
}

export const slotId = (version: string): string => `slot:${version}`;
export const factoryId = (version: string): string => `factory:${version}`;

export function parseCandidateId(id: string): Omit<Candidate, 'id'> | undefined {
    const separator = id.indexOf(':');
    if (separator <= 0) {
        return undefined;
    }
    const kind = id.slice(0, separator);
    const version = id.slice(separator + 1);
    if ((kind !== 'slot' && kind !== 'factory') || version.length === 0) {
        return undefined;
    }
    return { kind, version };
}

const now = (): string => new Date().toISOString();

export function isBad(state: BootState, id: string): boolean {
    return state.bad.some((mark) => mark.id === id);
}

function withoutAttempts(state: BootState, id: string): BootState['attempts'] {
    const { [id]: _removed, ...rest } = state.attempts;
    return rest;
}

/** Drops references to slots that are no longer installed and to factory bundles that were replaced. */
export function reconcile(state: BootState, inventory: Inventory): BootState {
    const installed = (version: string | undefined) =>
        version !== undefined && inventory.slots.includes(version) ? version : undefined;
    let lastGood = state.lastGood;
    const parsed = lastGood ? parseCandidateId(lastGood) : undefined;
    if (
        !parsed ||
        (parsed.kind === 'slot' && !inventory.slots.includes(parsed.version)) ||
        (parsed.kind === 'factory' && inventory.factory?.version !== parsed.version)
    ) {
        lastGood = undefined;
    }
    return {
        ...state,
        current: installed(state.current),
        previous: installed(state.previous),
        pending: installed(state.pending),
        lastGood,
    };
}

export function decideBoot(
    state: BootState,
    inventory: Inventory,
    options: DecideOptions,
): { readonly decision: BootDecision; readonly exhausted: readonly string[] } {
    if (options.forceSafeMode || state.safeModeRequested) {
        return { decision: { kind: 'safe-mode', reason: 'requested' }, exhausted: [] };
    }
    const exhausted: string[] = [];
    const seen = new Set<string>();
    const order: ReadonlyArray<{
        readonly id: string | undefined;
        readonly reason: 'pending' | 'current' | 'last-good' | 'factory';
    }> = [
        { id: state.pending ? slotId(state.pending) : undefined, reason: 'pending' },
        { id: state.current ? slotId(state.current) : undefined, reason: 'current' },
        { id: state.lastGood, reason: 'last-good' },
        { id: inventory.factory ? factoryId(inventory.factory.version) : undefined, reason: 'factory' },
    ];
    for (const { id, reason } of order) {
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        const parsed = parseCandidateId(id);
        if (!parsed) {
            continue;
        }
        if (parsed.kind === 'slot' && !inventory.slots.includes(parsed.version)) {
            continue;
        }
        if (parsed.kind === 'factory' && inventory.factory?.version !== parsed.version) {
            continue;
        }
        if (isBad(state, id)) {
            continue;
        }
        if ((state.attempts[id] ?? 0) >= options.maxAttempts) {
            exhausted.push(id);
            continue;
        }
        return { decision: { kind: 'launch', candidate: { id, ...parsed }, reason }, exhausted };
    }
    return { decision: { kind: 'safe-mode', reason: 'all-failed' }, exhausted };
}

export function recordLaunch(state: BootState, id: string): BootState {
    return { ...state, attempts: { ...state.attempts, [id]: (state.attempts[id] ?? 0) + 1 } };
}

/** A launch the user ended before it could prove itself, for example by closing the window, does not count. */
export function recordAborted(state: BootState, id: string): BootState {
    const attempts = state.attempts[id] ?? 0;
    return attempts <= 1
        ? { ...state, attempts: withoutAttempts(state, id) }
        : { ...state, attempts: { ...state.attempts, [id]: attempts - 1 } };
}

export function markBad(state: BootState, id: string, reason: string): BootState {
    if (isBad(state, id)) {
        return state;
    }
    const parsed = parseCandidateId(id);
    let { current, previous, pending, lastGood } = state;
    if (parsed?.kind === 'slot') {
        if (pending === parsed.version) {
            pending = undefined;
        }
        if (current === parsed.version) {
            current = previous && !isBad(state, slotId(previous)) ? previous : undefined;
            previous = undefined;
        }
        if (previous === parsed.version) {
            previous = undefined;
        }
    }
    if (lastGood === id) {
        lastGood = undefined;
    }
    return {
        ...state,
        current,
        previous,
        pending,
        lastGood,
        bad: [...state.bad, { id, reason, at: now() }],
        attempts: withoutAttempts(state, id),
    };
}

export function recordGood(state: BootState, candidate: Candidate): BootState {
    let { current, previous, pending } = state;
    if (candidate.kind === 'slot' && current !== candidate.version) {
        previous = current;
        current = candidate.version;
    }
    if (pending === candidate.version && candidate.kind === 'slot') {
        pending = undefined;
    }
    return {
        ...state,
        current,
        previous,
        pending,
        lastGood: candidate.id,
        attempts: withoutAttempts(state, candidate.id),
    };
}

export function recordFailure(state: BootState, id: string, reason: string, maxAttempts: number): BootState {
    const failed: BootState = { ...state, lastFailure: { id, reason, at: now() } };
    return (failed.attempts[id] ?? 0) >= maxAttempts ? markBad(failed, id, reason) : failed;
}

/** A candidate that fails verification is never retried. */
export function recordInvalid(state: BootState, id: string, reason: string): BootState {
    return markBad({ ...state, lastFailure: { id, reason: `verify:${reason}`, at: now() } }, id, `verify:${reason}`);
}

export function stagePending(state: BootState, version: string): BootState {
    const id = slotId(version);
    return {
        ...state,
        pending: version,
        bad: state.bad.filter((mark) => mark.id !== id),
        attempts: withoutAttempts(state, id),
    };
}

export function requestSafeMode(state: BootState): BootState {
    return { ...state, safeModeRequested: true };
}

export function consumeSafeModeRequest(state: BootState, reason: string): BootState {
    return { ...state, safeModeRequested: false, lastSafeMode: { reason, at: now() } };
}

/** Explicit user choice in safe mode: forget past failures of `target` and make it the next candidate. */
export function rollbackTo(state: BootState, target: Candidate): BootState {
    const cleared: BootState = {
        ...state,
        pending: undefined,
        safeModeRequested: false,
        bad: state.bad.filter((mark) => mark.id !== target.id),
        attempts: withoutAttempts(state, target.id),
    };
    if (target.kind === 'factory') {
        return { ...cleared, current: undefined, lastGood: cleared.lastGood === target.id ? target.id : undefined };
    }
    if (cleared.current === target.version) {
        return cleared;
    }
    return { ...cleared, previous: cleared.current, current: target.version };
}

/** Versions withdrawn by the release channel are never launched again. */
export function applyRevocations(state: BootState, revokedVersions: readonly string[]): BootState {
    return revokedVersions.reduce((next, version) => markBad(next, slotId(version), 'revoked'), state);
}
