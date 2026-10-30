import type { Effort, ModelInfo, ModelRequest, Quirks, ReasoningEffort, ToolChoiceKind } from './types.ts';

const LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

/** The supported level closest to `effort`; on a tie the stronger level wins (vendors round `medium` up too). */
export function nearestEffort(
    effort: ReasoningEffort,
    supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
    const rank = LEVELS.indexOf(effort);
    let best: ReasoningEffort | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of supported) {
        const distance = Math.abs(LEVELS.indexOf(candidate) - rank);
        if (
            distance < bestDistance ||
            (distance === bestDistance && best !== undefined && LEVELS.indexOf(candidate) > LEVELS.indexOf(best))
        ) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

/** The weakest setting a model accepts: `off` when reasoning can be turned off, else its lowest effort. */
export function lowestEffort(model: ModelInfo): Effort | undefined {
    switch (model.reasoning.mode) {
        case 'none':
            return undefined;
        case 'toggle':
            return 'off';
        default:
            return model.reasoning.efforts[0];
    }
}

export interface ThinkingPlan {
    /** Whether the model reasons in this request. */
    readonly on: boolean;
    /** xora level in effect, after `off` on an always-reasoning model became its weakest level. */
    readonly effort?: ReasoningEffort;
    /** Value sent to the vendor; absent when the model has no effort knob. */
    readonly vendorEffort?: string;
}

/**
 * Decides whether the model thinks and at which vendor effort. An unset effort means the model's default; `off`
 * on a model that always reasons means its weakest level, and on a model that never reasons nothing is sent.
 */
export function planThinking(model: ModelInfo, quirks: Quirks, requested: Effort | undefined): ThinkingPlan {
    const { reasoning } = model;
    if (reasoning.mode === 'none') {
        return { on: false };
    }
    const wanted = requested ?? reasoning.defaultEffort;
    let effort: ReasoningEffort | undefined;
    if (wanted === 'off') {
        if (reasoning.mode === 'toggle') {
            return { on: false };
        }
        effort = reasoning.efforts[0];
    } else {
        effort = wanted;
    }
    if (effort === undefined) {
        return { on: true };
    }
    const mapped = quirks.effortMap?.[effort];
    if (mapped !== undefined) {
        return { on: true, effort, vendorEffort: mapped };
    }
    const nearest = nearestEffort(effort, reasoning.efforts);
    if (nearest === undefined) {
        return { on: true };
    }
    return { on: true, effort: nearest, vendorEffort: quirks.effortMap?.[nearest] ?? nearest };
}

export interface ToolChoicePlan {
    readonly kind: ToolChoiceKind;
    /** Function name when `kind` is `function`. */
    readonly name?: string;
}

/**
 * Applies the vendor's `tool_choice` whitelist. Unsupported values become `auto`; while thinking is on the
 * `toolChoiceWhenThinking` list narrows it further. Returns `undefined` when nothing should be sent.
 */
export function planToolChoice(
    choice: ModelRequest['toolChoice'],
    quirks: Quirks,
    thinking: boolean,
): ToolChoicePlan | undefined {
    if (choice === undefined) {
        return undefined;
    }
    const allowed = (kind: ToolChoiceKind): boolean =>
        (quirks.toolChoice?.includes(kind) ?? true) &&
        (!thinking || (quirks.toolChoiceWhenThinking?.includes(kind) ?? true));
    const plan: ToolChoicePlan =
        typeof choice === 'string' ? { kind: choice } : { kind: 'function', name: choice.name };
    if (allowed(plan.kind)) {
        return plan;
    }
    return allowed('auto') ? { kind: 'auto' } : undefined;
}

/** Removes body fields the vendor must not receive. */
export function omitParams(body: Record<string, unknown>, names: readonly string[] | undefined): void {
    for (const name of names ?? []) {
        delete body[name];
    }
}
