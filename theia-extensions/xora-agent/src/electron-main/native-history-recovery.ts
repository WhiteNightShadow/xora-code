import { createHash } from 'node:crypto';
import { AgentHostEvent, AgentThoughtEvent, ToolCallEvent } from '../common/agent-protocol';

/** Display history only: none of these events carries execution authority. */
export type RecoveredNativeHistoryEvent = Extract<AgentHostEvent, {
    kind: 'text-delta' | 'thought-delta' | 'tool-call' | 'turn-completed';
}>;

export interface TimestampedNativeHistoryEvent {
    timestamp: string;
    event: RecoveredNativeHistoryEvent;
}

export interface NativeHistoryRecoveryTarget {
    nativeSessionId: string;
    appSessionId: string;
}

interface RecoveredTool {
    event: ToolCallEvent;
    terminal: boolean;
}

/**
 * Convert an explicitly selected Grok updates.jsonl into inert local history.
 * This function has no filesystem, host-service or runtime dependency. It does
 * not scan profiles, append events, update an index or replay any request.
 * Callers own backup/exclusive-create policy and must redact the resulting
 * host events before saving them. The native log is never modified.
 *
 * Invalid rows, other sessions and every non-display protocol event are
 * ignored. Unfinished tool calls are omitted rather than restored as live
 * operations. IDs are deterministic for the same source, including when the
 * caller runs recovery again; callers should create one new file, not append
 * the returned stream onto existing history.
 */
export function recoverNativeSessionHistory(
    jsonl: string,
    target: NativeHistoryRecoveryTarget
): TimestampedNativeHistoryEvent[] {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.appSessionId)
        || !target.nativeSessionId || target.nativeSessionId.length > 512
        || /[\u0000-\u001f\u007f]/.test(target.nativeSessionId)) {
        throw new Error('A valid explicit native/local session mapping is required for history recovery.');
    }
    const recovered: TimestampedNativeHistoryEvent[] = [];
    const tools = new Map<string, RecoveredTool>();
    let turnId: string | undefined;
    let turnOrdinal = 0;
    let userChunksOpen = false;
    let userMessageId: string | undefined;
    let thoughtOrdinal = 0;
    let thought: { id: string; startedAt: string; last: AgentThoughtEvent } | undefined;
    const stableId = (kind: string, parts: unknown[]): string => `${kind}-${createHash('sha256')
        .update(JSON.stringify([target.appSessionId, target.nativeSessionId, ...parts])).digest('hex').slice(0, 32)}`;
    const closeThought = (): void => {
        // A historical thought must not display as still running. Only mutate
        // the newly constructed output, never a parsed native update.
        if (thought) thought.last.completed = true;
        thought = undefined;
    };

    for (const line of jsonl.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row: Record<string, unknown> | undefined;
        try { row = record(JSON.parse(line)); } catch { continue; }
        const params = record(row?.params);
        if ((row?.method !== 'session/update' && row?.method !== '_x.ai/session/update')
            || params?.sessionId !== target.nativeSessionId) continue;
        const timestamp = nativeTimestamp(row.timestamp);
        if (!timestamp) continue;
        const update = record(params.update);
        if (!update) continue;
        const type = string(update.sessionUpdate);

        if (type === 'user_message_chunk' || type === 'agent_message_chunk') {
            const text = contentText(update.content);
            if (!text) continue;
            closeThought();
            if (type === 'user_message_chunk') {
                const messageId = string(update.messageId) ?? string(update.message_id);
                if (!userChunksOpen || (messageId && messageId !== userMessageId)) {
                    turnOrdinal += 1;
                    turnId = stableId('recovered-turn', [turnOrdinal, timestamp, messageId ?? null]);
                }
                userChunksOpen = true;
                userMessageId = messageId ?? userMessageId;
            } else {
                userChunksOpen = false;
            }
            recovered.push({ timestamp, event: {
                kind: 'text-delta', sessionId: target.appSessionId,
                ...(turnId ? { turnId } : {}),
                role: type === 'user_message_chunk' ? 'user' : 'assistant', text
            } });
            continue;
        }

        if (type === 'agent_thought_chunk') {
            const text = contentText(update.content);
            if (!text) continue;
            userChunksOpen = false;
            if (!thought) {
                thoughtOrdinal += 1;
                const id = stableId('recovered-thought', [turnId ?? null, thoughtOrdinal, timestamp]);
                const event: AgentThoughtEvent = {
                    kind: 'thought-delta', sessionId: target.appSessionId,
                    ...(turnId ? { turnId } : {}), thoughtId: id, text, startedAt: timestamp
                };
                thought = { id, startedAt: timestamp, last: event };
            } else {
                thought.last = {
                    kind: 'thought-delta', sessionId: target.appSessionId,
                    ...(turnId ? { turnId } : {}), thoughtId: thought.id, text, startedAt: thought.startedAt
                };
            }
            recovered.push({ timestamp, event: thought.last });
            continue;
        }

        if (type === 'tool_call' || type === 'tool_call_update') {
            const toolCallId = string(update.toolCallId);
            if (!toolCallId) continue;
            closeThought();
            userChunksOpen = false;
            let tool = tools.get(toolCallId);
            if (!tool || (type === 'tool_call' && tool.event.turnId !== turnId)) {
                tool = { terminal: false, event: {
                    kind: 'tool-call', sessionId: target.appSessionId,
                    ...(turnId ? { turnId } : {}), toolCallId,
                    title: toolCallId, toolName: 'tool', status: 'pending', startedAt: timestamp
                } };
                tools.set(toolCallId, tool);
            }
            // Metadata is descriptive only; executable plan/goal/permission
            // fields, tool diffs and arbitrary nested event envelopes are not
            // projected into the output event union.
            const canonical = record(record(update._meta)?.['x.ai/tool']);
            const title = string(update.title);
            const name = string(canonical?.name) ?? string(update.toolName) ?? string(update.kind);
            const kind = string(canonical?.kind) ?? string(update.kind);
            const namespace = string(canonical?.namespace);
            const output = toolOutput(update);
            if (title) tool.event.title = title;
            if (name) tool.event.toolName = name;
            if (kind) tool.event.toolKind = kind;
            if (namespace) tool.event.toolNamespace = namespace;
            if (update.rawInput !== undefined) tool.event.input = update.rawInput;
            if (output !== undefined) tool.event.output = output;
            if (update.status === 'completed' || update.status === 'failed' || update.status === 'rejected') {
                tool.event.status = update.status;
                tool.terminal = true;
            }
            if (tool.terminal) recovered.push({ timestamp, event: { ...tool.event } });
            continue;
        }

        if (type === 'turn_completed') {
            closeThought();
            userChunksOpen = false;
            userMessageId = undefined;
            const stopReason = string(update.stopReason) ?? string(update.stop_reason);
            recovered.push({ timestamp, event: {
                kind: 'turn-completed', sessionId: target.appSessionId,
                ...(turnId ? { turnId } : {}), ...(stopReason ? { stopReason } : {})
            } });
        }
    }
    closeThought();
    return recovered;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function nativeTimestamp(value: unknown): string | undefined {
    // Grok 1.x journals use Unix seconds; older exports can contain ISO text.
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799) {
        return new Date(value * 1000).toISOString();
    }
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
        ? value : undefined;
}

function contentText(value: unknown): string | undefined {
    const content = record(value);
    return content?.type === 'text' ? string(content.text) : undefined;
}

function toolOutput(update: Record<string, unknown>): string | undefined {
    if (Array.isArray(update.content)) {
        const pieces = update.content.flatMap(value => {
            const item = record(value);
            const text = contentText(item?.content) ?? contentText(item);
            return text !== undefined ? [text] : [];
        });
        if (pieces.length) return pieces.join('\n');
    }
    return update.rawOutput === undefined ? undefined
        : typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
}
