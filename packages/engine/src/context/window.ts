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
/**
 * Room the conversation keeps below the compaction line however large the system prompt and the tool definitions:
 * no compaction shrinks those, and a working set they fill would compact at every step.
 */
export const MIN_ROOM = 32_000;

/** What every request carries besides the conversation: the system prompt and the tool definitions, estimated. */
export function fixedTokens(system: readonly string[], tools: readonly unknown[] = []): number {
    return estimateTokens(system.join('\n')) + (tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0);
}

/**
 * The budget: the working set, made larger when the fixed part leaves the conversation less than MIN_ROOM, never more
 * than the window and the cost cap; minus room for the reply. `fixed`: see {@link fixedTokens}.
 */
export function contextBudget(session: EngineSession, target: ResolvedTarget, fixed = 0): number {
    const hard = Math.min(target.model.contextWindow, session.config.softContextWindow ?? Number.POSITIVE_INFINITY);
    const soft = session.config.workingSet ?? DEFAULT_WORKING_SET;
    // Room for the reply, but never most of a small window: a 32k cap with a 32k reserve left nothing and the
    // context was compacted before every request.
    const reserve = Math.min(
        target.model.maxOutput,
        session.config.maxOutputTokens ?? 32_000,
        Math.floor(Math.min(hard, soft) / 4),
    );
    const wanted = Math.max(soft, Math.ceil((fixed + MIN_ROOM) / COMPACT_AT) + reserve);
    return Math.max(8_000, Math.min(hard, wanted) - reserve);
}

/** The context messages, estimated from their characters. */
export function messageTokens(session: EngineSession): number {
    return contextMessages(session).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** The whole request as the engine estimates it: the fixed part and the context messages. */
export function estimatedContextTokens(session: EngineSession, fixed: number): number {
    return fixed + messageTokens(session);
}

/**
 * Tokens the next request will carry. The vendor counted the last request exactly, tool definitions included, so
 * only what was added since is estimated; after masking or compaction the estimate is scaled by how far off it was.
 */
export function currentContextTokens(session: EngineSession, fixed: number): number {
    const estimate = estimatedContextTokens(session, fixed);
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
