import type { Effort, ModelSummary } from '@xora/protocol';

export const EFFORTS: readonly Effort[] = ['off', 'low', 'medium', 'high', 'max'];

/**
 * The thinking levels a model offers, in order: its own, plus "off" when its thinking can be switched off. None
 * for a model without thinking, or one the app knows nothing about.
 */
export function effortsOf(reasoning: ModelSummary['reasoning'] | undefined): Effort[] {
    if (!reasoning || reasoning.mode === 'none') return [];
    return EFFORTS.filter((effort) =>
        effort === 'off' ? reasoning.mode === 'toggle' : reasoning.efforts.includes(effort),
    );
}

/**
 * The level a new conversation starts with: what the user picked here, else the one set for new conversations,
 * else the model's own default; always one the model offers. Undefined when it offers none.
 */
export function startingEffort(
    reasoning: ModelSummary['reasoning'] | undefined,
    usual: Effort | undefined,
    picked: Effort | '',
): Effort | undefined {
    const efforts = effortsOf(reasoning);
    if (efforts.length === 0) return undefined;
    for (const candidate of [picked || undefined, usual, reasoning?.defaultEffort]) {
        if (candidate && efforts.includes(candidate)) return candidate;
    }
    return efforts[0];
}
