import type { PermissionMode } from './org.ts';

/** Autonomy levels (06 §8): how far a team may go before a person confirms. */
export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const DEFAULT_AUTONOMY: AutonomyLevel = 'L1';

/** Points of a team run at which a person may have to confirm. */
export type AutonomyAction = 'every_step' | 'plan_approval' | 'high_risk' | 'final_delivery';

/** Actions that need a person at every level, whoever asks for them (06 §8). */
export const HIGH_RISK_ACTIONS = ['push', 'publish', 'delete', 'external_message', 'payment'] as const;
export type HighRiskAction = (typeof HIGH_RISK_ACTIONS)[number];

const CONFIRMED: Readonly<Record<AutonomyLevel, readonly AutonomyAction[]>> = {
    L0: ['every_step', 'plan_approval', 'high_risk', 'final_delivery'],
    L1: ['plan_approval', 'high_risk', 'final_delivery'],
    L2: ['high_risk', 'final_delivery'],
    // L3 people only read the delivery report.
    L3: ['high_risk'],
};

export function isHighRiskAction(action: string): action is HighRiskAction {
    return (HIGH_RISK_ACTIONS as readonly string[]).includes(action);
}

/** Whether `action` waits for a person at `level`. A concrete high-risk action counts as `high_risk`. */
export function needsHuman(level: AutonomyLevel, action: AutonomyAction | HighRiskAction): boolean {
    if (action === 'high_risk' || isHighRiskAction(action)) {
        return true;
    }
    return CONFIRMED[level].includes(action);
}

/** What a person confirms at `level`, in the order a run meets them. */
export function confirmationPoints(level: AutonomyLevel): readonly AutonomyAction[] {
    return CONFIRMED[level];
}

/** Who said yes. Only a person's approval counts for anything a person must confirm (06 §7). */
export type ApprovalSource = 'user' | 'agent' | 'policy';

/**
 * Whether an approval from `source` settles `action`. Messages from agents never do, and host policy (allow
 * rules, autonomy) never settles a high-risk action.
 */
export function countsAsApproval(source: ApprovalSource, action: AutonomyAction | HighRiskAction): boolean {
    if (source === 'user') {
        return true;
    }
    if (source === 'agent') {
        return false;
    }
    return action !== 'high_risk' && !isHighRiskAction(action);
}

export interface AutonomyContext {
    /** Channels of every connection the run may use, e.g. `api`, `subscription_key`, `local`. */
    readonly channels: readonly string[];
    /** Budget limit of the run; L3 needs a positive one. */
    readonly budget?: number;
    /** Permission modes of the agents that will run. */
    readonly modes?: readonly PermissionMode[];
}

export type AutonomyProblemCode = 'channel_not_api' | 'missing_budget' | 'full_permission';

export interface AutonomyProblem {
    readonly code: AutonomyProblemCode;
    readonly message: string;
}

export type AutonomyValidation =
    | { readonly ok: true }
    | { readonly ok: false; readonly problems: readonly AutonomyProblem[] };

/**
 * L3 runs unattended: only api channels (subscriptions are for interactive use, 07 §10), a budget, and
 * restricted permissions (no agent in `full` mode). Lower levels have a person in the loop and always pass.
 */
export function validateAutonomy(level: AutonomyLevel, context: AutonomyContext): AutonomyValidation {
    if (level !== 'L3') {
        return { ok: true };
    }
    const problems: AutonomyProblem[] = [];
    const others = [...new Set(context.channels.filter((channel) => channel !== 'api'))];
    if (others.length > 0) {
        problems.push({
            code: 'channel_not_api',
            message: `L3 runs only on api channels; not allowed: ${others.join(', ')}`,
        });
    }
    if (!(context.budget !== undefined && Number.isFinite(context.budget) && context.budget > 0)) {
        problems.push({ code: 'missing_budget', message: 'L3 needs a budget for the run' });
    }
    if (context.modes?.includes('full')) {
        problems.push({ code: 'full_permission', message: 'L3 does not allow agents in full permission mode' });
    }
    return problems.length > 0 ? { ok: false, problems } : { ok: true };
}
