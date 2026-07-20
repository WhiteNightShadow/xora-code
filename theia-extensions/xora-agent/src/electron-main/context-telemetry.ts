/**
 * Narrow, fail-closed parsing for the context metadata published by the
 * pinned Grok Build 0.2.102 sidecar. Unknown extension payloads never cross
 * the Electron/renderer boundary.
 */

export interface ParsedSessionContextEnvelope {
    sessionId: string;
    update: Record<string, unknown>;
    meta: Record<string, unknown>;
    replay: boolean;
    eventSequence?: number;
}

export interface PromptContextFallback {
    /** ACP session id, when Grok echoed it. */
    sessionId?: string;
    /** Live conversation size. This is deliberately the sibling field. */
    totalTokens?: number;
    modelId?: string;
    /**
     * Signals that billing data was present so callers cannot accidentally
     * reinterpret its token totals as live context usage.
     */
    billedUsagePresent: boolean;
}

export type ParsedAutoCompaction =
    | {
        kind: 'started';
        tokensUsed: number;
        contextWindow: number;
        percentage: number;
    }
    | {
        kind: 'completed';
        tokensBefore?: number;
        tokensAfter: number;
        elapsedMs?: number;
    }
    | { kind: 'failed' }
    | { kind: 'cancelled' };

const XAI_SESSION_NOTIFICATION = 'x.ai/session_notification';
const XAI_SESSION_UPDATE = 'x.ai/session/update';

/** Parses direct extension notifications and the ACP-compatible wrapper. */
export function parseXaiSessionContextEnvelope(method: string, params: unknown): ParsedSessionContextEnvelope | undefined {
    let effectiveMethod = method;
    let payload = record(params);
    if (!payload) return undefined;

    if (method === `_${XAI_SESSION_NOTIFICATION}` || method === `_${XAI_SESSION_UPDATE}`) {
        effectiveMethod = string(payload.method) ?? '';
        payload = record(payload.params);
        if (!payload) return undefined;
    }
    if (effectiveMethod !== XAI_SESSION_NOTIFICATION && effectiveMethod !== XAI_SESSION_UPDATE) {
        return undefined;
    }
    const sessionId = string(payload.sessionId);
    const update = record(payload.update);
    if (!sessionId || !update) return undefined;
    const meta = record(payload._meta) ?? {};
    return {
        sessionId,
        update,
        meta,
        replay: meta.isReplay === true,
        eventSequence: eventSequence(meta.eventId)
    };
}

/** Parses standard ACP `session/update` metadata without accepting extensions. */
export function parseAcpSessionContextEnvelope(params: unknown): ParsedSessionContextEnvelope | undefined {
    const payload = record(params);
    const sessionId = string(payload?.sessionId);
    const update = record(payload?.update);
    if (!payload || !sessionId || !update) return undefined;
    const meta = record(payload._meta) ?? {};
    return {
        sessionId,
        update,
        meta,
        replay: meta.isReplay === true,
        eventSequence: eventSequence(meta.eventId)
    };
}

/**
 * `_meta.totalTokens` is Grok's live context count. `_meta.usage` is billing
 * for the whole prompt and is intentionally reduced to a presence bit.
 */
export function parsePromptContextFallback(result: unknown): PromptContextFallback | undefined {
    const meta = record(record(result)?._meta);
    if (!meta) return undefined;
    const sessionId = string(meta.sessionId);
    const totalTokens = unsignedInteger(meta.totalTokens);
    const modelId = string(meta.modelId);
    const billedUsagePresent = record(meta.usage) !== undefined;
    if (!sessionId && totalTokens === undefined && !modelId && !billedUsagePresent) return undefined;
    return { sessionId, totalTokens, modelId, billedUsagePresent };
}

/** Parses only the four native automatic-compaction lifecycle variants. */
export function parseAutoCompaction(update: Record<string, unknown>): ParsedAutoCompaction | undefined {
    switch (string(update.sessionUpdate)) {
        case 'auto_compact_started': {
            const tokensUsed = unsignedInteger(update.tokens_used);
            const contextWindow = positiveInteger(update.context_window);
            const percentage = boundedPercentage(update.percentage);
            if (tokensUsed === undefined || contextWindow === undefined || percentage === undefined) return undefined;
            return { kind: 'started', tokensUsed, contextWindow, percentage };
        }
        case 'auto_compact_completed': {
            const tokensAfter = unsignedInteger(update.tokens_after);
            if (tokensAfter === undefined) return undefined;
            return {
                kind: 'completed',
                tokensBefore: unsignedInteger(update.tokens_before),
                tokensAfter,
                elapsedMs: unsignedInteger(update.elapsed_ms)
            };
        }
        case 'auto_compact_failed':
            return { kind: 'failed' };
        case 'auto_compact_cancelled':
            return { kind: 'cancelled' };
        default:
            return undefined;
    }
}

/** Reads only Grok's authoritative context-count sibling. */
export function contextTotalTokens(meta: Record<string, unknown>): number | undefined {
    return unsignedInteger(meta.totalTokens);
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unsignedInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
    const parsed = unsignedInteger(value);
    return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function boundedPercentage(value: unknown): number | undefined {
    const parsed = unsignedInteger(value);
    return parsed !== undefined && parsed <= 255 ? parsed : undefined;
}

function eventSequence(value: unknown): number | undefined {
    const id = string(value);
    if (!id) return undefined;
    const suffix = id.slice(id.lastIndexOf('-') + 1);
    if (!/^\d+$/.test(suffix)) return undefined;
    const parsed = Number(suffix);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
