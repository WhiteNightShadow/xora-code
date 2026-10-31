import { bilingual, type UiLanguage } from '@xora/protocol/language';
import { SUBSCRIPTION_CHANNEL } from './autonomy.ts';
import {
    type AgentSpec,
    agentsWithRole,
    findAgent,
    inferFamily,
    type Organization,
    ROLE_TIERS,
    type Role,
    type TierEffort,
} from './org.ts';
import type { TaskCard, Tier } from './schemas.ts';
import { tierLabel } from './style.ts';

/** Tiers from cheapest to strongest. */
export const TIER_ORDER: readonly Tier[] = ['fast', 'economy', 'standard', 'flagship'];

export function tierRank(tier: Tier): number {
    return TIER_ORDER.indexOf(tier);
}

/** The next stronger tier, for escalation; `undefined` above flagship. */
export function nextTier(tier: Tier): Tier | undefined {
    return TIER_ORDER[tierRank(tier) + 1];
}

/** The next cheaper tier; `undefined` below fast. */
export function lowerTier(tier: Tier): Tier | undefined {
    const rank = tierRank(tier);
    return rank > 0 ? TIER_ORDER[rank - 1] : undefined;
}

export interface TierDecision {
    readonly tier: Tier;
    /** `role`: the role's default; `agent`: the roster agent's tier; `card`: the card's request. */
    readonly source: 'role' | 'agent' | 'card';
    /** A request that was not granted, and why. */
    readonly rejected?: { readonly tier: Tier; readonly reason: string };
}

/**
 * The tier a task runs at (06 §3 rule 1). The base is the tier of the roster agent that would do it (the card's
 * assignee, else the first agent of the role and category), else the role's default. A card may ask for a
 * cheaper tier freely, and for a stronger one only with a `tierReason`.
 */
export function resolveTier(
    role: Role,
    card: Pick<TaskCard, 'tier' | 'tierReason' | 'assignee' | 'category'> | undefined,
    org: Organization,
): TierDecision {
    const agent = baseAgent(role, card, org);
    const base = agent?.tier ?? ROLE_TIERS[role];
    const source = agent ? 'agent' : 'role';
    if (!card || card.tier === base) {
        return { tier: base, source };
    }
    if (tierRank(card.tier) < tierRank(base) || (card.tierReason ?? '').trim() !== '') {
        return { tier: card.tier, source: 'card' };
    }
    return {
        tier: base,
        source,
        rejected: { tier: card.tier, reason: `a tier above ${base} needs a tierReason` },
    };
}

function baseAgent(
    role: Role,
    card: Pick<TaskCard, 'assignee' | 'category'> | undefined,
    org: Organization,
): AgentSpec | undefined {
    if (card?.assignee !== undefined) {
        const assignee = findAgent(org, card.assignee);
        if (assignee?.role === role) {
            return assignee;
        }
    }
    return agentsWithRole(org, role, card?.category)[0];
}

/** A model the user has connected, as the host's provider registry knows it. */
export interface ConnectedModel {
    readonly connectionId: string;
    readonly model: string;
    readonly presetId?: string;
    /** From the provider preset's model info. */
    readonly family?: string;
    /** `api`, `subscription_key`, `local`, `custom`; unattended runs leave out `subscription_key` (06 §3 rule 7). */
    readonly channel?: string;
}

/** One usable step of a tier's fallback chain. */
export interface ResolvedModel {
    readonly connectionId: string;
    readonly presetId?: string;
    readonly model: string;
    readonly family?: string;
    readonly effort: TierEffort;
    readonly channel?: string;
}

export interface ModelChainOptions {
    /** Unattended runs (L3, schedules, triggers) do not use subscription quotas: api, local and custom only. */
    readonly unattended?: boolean;
}

/**
 * The tier's chain restricted to models the user actually has, in the tier's order (06 §3 rule 2). A model
 * served by several connections appears once per connection, in the order of `available`.
 */
export function modelChain(
    tier: Tier,
    org: Organization,
    available: readonly ConnectedModel[],
    options: ModelChainOptions = {},
): ResolvedModel[] {
    const spec = org.tiers[tier];
    const chain: ResolvedModel[] = [];
    const seen = new Set<string>();
    for (const entry of spec.models) {
        for (const connected of available) {
            if (
                connected.model !== entry.model ||
                (entry.connectionId !== undefined && connected.connectionId !== entry.connectionId) ||
                (entry.presetId !== undefined && connected.presetId !== entry.presetId) ||
                (options.unattended === true && connected.channel === SUBSCRIPTION_CHANNEL)
            ) {
                continue;
            }
            const key = `${connected.connectionId}\u0000${connected.model}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            chain.push({
                connectionId: connected.connectionId,
                presetId: connected.presetId ?? entry.presetId,
                model: connected.model,
                family: connected.family ?? entry.family ?? inferFamily(connected.model),
                effort: entry.effort ?? spec.effort,
                channel: connected.channel,
            });
        }
    }
    return chain;
}

export interface ReviewerPick {
    readonly model: ResolvedModel;
    /** False when the chain had no model of another (known) family. */
    readonly crossFamily: boolean;
}

/**
 * The reviewer's model (06 §3 rule 6): the first model of the reviewer's chain whose family differs from the
 * executor's, else the first model. `undefined` for an empty chain.
 */
export function pickReviewerModel(
    executorFamily: string | undefined,
    chain: readonly ResolvedModel[],
): ReviewerPick | undefined {
    const executor = executorFamily?.toLowerCase();
    if (executor !== undefined) {
        const other = chain.find((model) => {
            const family = (model.family ?? inferFamily(model.model))?.toLowerCase();
            return family !== undefined && family !== executor;
        });
        if (other) {
            return { model: other, crossFamily: true };
        }
    }
    const first = chain[0];
    return first ? { model: first, crossFamily: false } : undefined;
}

export type AttemptOutcome = 'pass' | 'fail' | 'escalate';

/** One dispatch of a task and how acceptance went. */
export interface AttemptRecord {
    readonly tier: Tier;
    readonly outcome: AttemptOutcome;
    /** `supervisor` once the supervisor took the task over; `executor` when absent. */
    readonly by?: 'executor' | 'supervisor';
    /** The tier the executor asked for when it escalated. */
    readonly escalateTo?: Tier;
}

/** Failed acceptances in a row at one tier before the task moves up (06 §3 rule 3). */
export const MAX_FAILED_ACCEPTANCES = 2;

export type EscalationDecision =
    | { readonly action: 'none' }
    /** Send it back to the same executor with feedback. */
    | { readonly action: 'retry'; readonly failures: number }
    | { readonly action: 'escalate'; readonly from: Tier; readonly to: Tier; readonly reason: EscalationReason }
    /** Flagship could not do it: the supervisor takes it over. */
    | { readonly action: 'supervisor'; readonly reason: EscalationReason }
    /** The supervisor could not do it either: ask a person. */
    | { readonly action: 'human'; readonly reason: 'supervisor_failed' };

/** `requested`: the executor escalated; `failed_acceptance`: acceptance failed too often. */
export type EscalationReason = 'requested' | 'failed_acceptance';

/**
 * What to do after the latest attempt (06 §5 ⑧, §9): retry with feedback, then one tier up after
 * {@link MAX_FAILED_ACCEPTANCES} failures in a row or at once when the executor escalates, then the
 * supervisor after flagship, then a person.
 */
export function shouldEscalate(
    history: readonly AttemptRecord[],
    maxFailures: number = MAX_FAILED_ACCEPTANCES,
): EscalationDecision {
    const last = history.at(-1);
    if (!last || last.outcome === 'pass') {
        return { action: 'none' };
    }
    if (last.by === 'supervisor') {
        return { action: 'human', reason: 'supervisor_failed' };
    }
    if (last.outcome === 'escalate') {
        const asked = last.escalateTo;
        const to = asked !== undefined && tierRank(asked) > tierRank(last.tier) ? asked : nextTier(last.tier);
        return to
            ? { action: 'escalate', from: last.tier, to, reason: 'requested' }
            : { action: 'supervisor', reason: 'requested' };
    }
    let failures = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const attempt = history[index];
        if (attempt?.outcome !== 'fail' || attempt.tier !== last.tier || attempt.by === 'supervisor') {
            break;
        }
        failures += 1;
    }
    if (failures < maxFailures) {
        return { action: 'retry', failures };
    }
    const to = nextTier(last.tier);
    return to
        ? { action: 'escalate', from: last.tier, to, reason: 'failed_acceptance' }
        : { action: 'supervisor', reason: 'failed_acceptance' };
}

/** First-pass figures of one category at one tier. */
export interface CategoryTierStats {
    readonly category: string;
    readonly tier: Tier;
    readonly tasks: number;
    /** Tasks accepted on their first attempt. */
    readonly firstPass: number;
}

/**
 * First-pass figures per category and starting tier, from tasks with at least one finished attempt
 * (e.g. board tasks).
 */
export function firstPassStats(
    tasks: readonly { readonly card: Pick<TaskCard, 'category'>; readonly attempts: readonly AttemptRecord[] }[],
): CategoryTierStats[] {
    const groups = new Map<string, { category: string; tier: Tier; tasks: number; firstPass: number }>();
    for (const task of tasks) {
        const first = task.attempts[0];
        if (!first) {
            continue;
        }
        const key = `${task.card.category}\u0000${first.tier}`;
        const group = groups.get(key) ?? { category: task.card.category, tier: first.tier, tasks: 0, firstPass: 0 };
        group.tasks += 1;
        group.firstPass += first.outcome === 'pass' ? 1 : 0;
        groups.set(key, group);
    }
    return [...groups.values()];
}

export const DOWNGRADE_MIN_TASKS = 10;
export const DOWNGRADE_MIN_RATE = 0.9;

export interface DowngradeSuggestion {
    readonly category: string;
    readonly from: Tier;
    readonly to: Tier;
    readonly tasks: number;
    readonly firstPassRate: number;
    /** For the team view. */
    readonly message: string;
}

const TEXT = bilingual(
    {
        downgrade: (category: string, from: Tier, rate: number, tasks: number, to: Tier) =>
            `${category}类任务在${tierLabel(from, 'zh-CN')}档的一次通过率是${rate}%` +
            `（共${tasks}个），可以考虑改用${tierLabel(to, 'zh-CN')}档。这只是建议，不会自动修改。`,
    },
    {
        downgrade: (category, from, rate, tasks, to) =>
            `${category} tasks pass ${rate}% of the time on the first try at the ${tierLabel(from, 'en')} tier ` +
            `(${tasks} tasks); the ${tierLabel(to, 'en')} tier may do. Only a suggestion: nothing changes on its own.`,
    },
);

function textOf(language: UiLanguage) {
    return TEXT[language];
}

/**
 * A suggestion to run a category one tier cheaper when its first-pass rate at a tier is at least 90% over at
 * least 10 tasks (06 §3 rule 4). Only ever a suggestion; nothing changes automatically.
 */
export function downgradeSuggestion(stats: CategoryTierStats, language: UiLanguage): DowngradeSuggestion | undefined {
    const to = lowerTier(stats.tier);
    if (!to || stats.tasks < DOWNGRADE_MIN_TASKS) {
        return undefined;
    }
    const firstPassRate = stats.firstPass / stats.tasks;
    if (firstPassRate < DOWNGRADE_MIN_RATE) {
        return undefined;
    }
    const category = stats.category.toLowerCase();
    return {
        category,
        from: stats.tier,
        to,
        tasks: stats.tasks,
        firstPassRate,
        message: textOf(language).downgrade(category, stats.tier, Math.round(firstPassRate * 100), stats.tasks, to),
    };
}

/** Share of the budget at which non-critical tasks may drop one tier (06 §3 rule 5). */
export const BUDGET_PRESSURE_RATIO = 0.8;

export interface BudgetPressure {
    /** `spent / budget`. */
    readonly ratio: number;
    /** `tight` from {@link BUDGET_PRESSURE_RATIO}; `exhausted` at 100%, when the run pauses and asks (06 §9). */
    readonly state: 'ok' | 'tight' | 'exhausted';
}

/** A budget of 0 or less is exhausted from the start. */
export function budgetPressure(spent: number, budget: number): BudgetPressure {
    if (!(budget > 0)) {
        return { ratio: 1, state: 'exhausted' };
    }
    const ratio = (Number.isFinite(spent) && spent > 0 ? spent : 0) / budget;
    return { ratio, state: ratio >= 1 ? 'exhausted' : ratio >= BUDGET_PRESSURE_RATIO ? 'tight' : 'ok' };
}

/**
 * The tier a task runs at under budget pressure: one lower for non-critical tasks when the budget is tight.
 * Writable work never drops to the fast tier, which runs without thinking and is meant for read-only scouting.
 */
export function tierUnderPressure(
    tier: Tier,
    card: Pick<TaskCard, 'priority' | 'workspace'> | undefined,
    pressure: BudgetPressure,
): Tier {
    if (pressure.state !== 'tight' || card?.priority === 'critical') {
        return tier;
    }
    const lower = lowerTier(tier);
    if (!lower || (lower === 'fast' && card?.workspace !== 'readonly')) {
        return tier;
    }
    return lower;
}
