import type { EngineSession, ResolvedTarget } from '../session.ts';
import { contextMessages } from './messages.ts';
import { estimateMessageTokens, estimateTokens } from './tokens.ts';

/**
 * How much context the engine works in (08 §2, 20 §4.4). The window is the model's, capped by the user's cost cap
 * and by the working set: models get worse as the context grows, long before it is full, so the work is kept in
 * the working set whatever the window.
 */

/** The working set when the host sets none. */
export const DEFAULT_WORKING_SET = 160_000;
/** Share of the budget at which older tool output is masked, all at once. */
export const MASK_AT = 0.6;
/** Share of the budget at which older turns are compacted. */
export const COMPACT_AT = 0.8;

/** The budget: the smallest of window, cost cap and working set, minus room for the reply. */
export function contextBudget(session: EngineSession, target: ResolvedTarget): number {
    const window = Math.min(
        target.model.contextWindow,
        session.config.softContextWindow ?? Number.POSITIVE_INFINITY,
        session.config.workingSet ?? DEFAULT_WORKING_SET,
    );
    // Room for the reply, but never most of a small window: a 32k cap with a 32k reserve left nothing and the
    // context was compacted before every request.
    const reserve = Math.min(target.model.maxOutput, session.config.maxOutputTokens ?? 32_000, Math.floor(window / 4));
    return Math.max(8_000, window - reserve);
}

/** The system prompt and context messages, estimated from their characters. */
export function estimatedContextTokens(session: EngineSession, system: readonly string[]): number {
    return (
        estimateTokens(system.join('\n')) +
        contextMessages(session).reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    );
}

/**
 * Tokens the next request will carry. The vendor counted the last request exactly, so only what was added since is
 * estimated; after masking or compaction the estimate is scaled by how far off it was for that request.
 */
export function currentContextTokens(session: EngineSession, system: readonly string[]): number {
    const estimate = estimatedContextTokens(session, system);
    const counted = session.lastPromptTokens;
    const estimatedThen = session.lastPromptEstimate;
    if (counted <= 0 || estimatedThen <= 0) {
        return estimate;
    }
    if (estimate >= estimatedThen) {
        return counted + (estimate - estimatedThen);
    }
    return Math.round(estimate * Math.min(3, Math.max(0.3, counted / estimatedThen)));
}
