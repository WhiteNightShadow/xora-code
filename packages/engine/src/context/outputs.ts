import type { AssistantPart, Message } from '@xora/providers';
import { clipText } from '../deps.ts';
import type { EngineSession } from '../session.ts';
import { estimateMessageTokens, estimateTokens, fullText, messageText } from './tokens.ts';

/**
 * Tool output out of the context but never lost (20 §4.3): an older result is masked to one line that says what it
 * was and where to get it, and `tool_output` returns it from the session as it was.
 */

/** Tool results that stay whole when older ones are masked. */
export const KEEP_RESULTS = 8;
/**
 * Masking happens only when it frees this share of the budget: each masking edits history, and the provider's cache
 * misses from the first edited message on. Few large maskings cost less than one small one per request.
 */
export const MASK_MIN_FREE = 0.2;

type ToolCall = Extract<AssistantPart, { type: 'tool_call' }>;
type ToolResult = Extract<Message, { role: 'tool' }>;

/**
 * The call behind each tool result, by the result's index in the history: the call with its id in the latest model
 * reply before it. Not by id alone — some providers number calls afresh in every reply (`call_0`, `call_1`…).
 */
export function callsOf(history: readonly Message[]): Map<number, ToolCall> {
    const calls = new Map<number, ToolCall>();
    let latest = new Map<string, ToolCall>();
    history.forEach((message, index) => {
        if (message.role === 'assistant') {
            latest = new Map();
            for (const part of message.content) {
                if (part.type === 'tool_call') latest.set(part.id, part);
            }
        } else if (message.role === 'tool') {
            const call = latest.get(message.toolCallId);
            if (call) calls.set(index, call);
        }
    });
    return calls;
}

/** The reference of the message at `index` of the history: stable, as the history only grows. */
export const refOf = (index: number): string => `R${index}`;

/** A call's arguments, or nothing when they are not an object of JSON. */
export function argsOf(call: ToolCall | undefined): Record<string, unknown> {
    if (!call) return {};
    try {
        const parsed: unknown = JSON.parse(call.arguments);
        return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** What a call worked on, in a few words: its command, path, pattern, address or query. */
export function describeCall(call: ToolCall | undefined): string {
    const args = argsOf(call);
    const pick = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
    const shown = (
        pick('command') ??
        pick('path') ??
        pick('pattern') ??
        pick('url') ??
        pick('query') ??
        pick('ref') ??
        pick('title') ??
        pick('name') ??
        ''
    )
        .replace(/\s+/g, ' ')
        .trim();
    return shown ? JSON.stringify(clipText(shown, 80)) : '';
}

const NOTABLE = /error|fail|exception|traceback|denied|not found|cannot|panic|fatal|错误|失败/i;

/** The line of an output worth keeping in its place: the first error of a failure, else the first line. */
export function notableLine(text: string, failed: boolean): string {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('<system-reminder>'));
    const line = (failed ? lines.find((item) => NOTABLE.test(item)) : undefined) ?? lines[0] ?? '';
    return clipText(line, 120);
}

function sizeOf(chars: number): string {
    return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`;
}

/** The line a masked tool result shows in place of its output. */
export function placeholder(index: number, message: ToolResult, call: ToolCall | undefined): string {
    const text = messageText(message);
    const what = describeCall(call);
    const failed = message.isError === true;
    const parts = [
        `#${refOf(index)} ${message.toolName}${what ? ` ${what}` : ''}`,
        failed ? 'failed' : 'ok',
        sizeOf(text.length),
    ];
    const line = notableLine(text, failed);
    if (line) parts.push(line);
    return `[${parts.join(' · ')} — masked to save context; tool_output("${refOf(index)}") returns it]`;
}

/** The message a reference names, as it was: a tool's output, a message to the model, or one of its replies. */
export function readOutput(session: EngineSession, ref: string): { tool: string; text: string } | undefined {
    const match = /^R(\d+)$/.exec(ref.trim().replace(/^#/, '').toUpperCase());
    if (!match) return undefined;
    const message = session.history[Number(match[1])];
    if (!message) return undefined;
    const text = fullText(message);
    switch (message.role) {
        case 'tool':
            return { tool: message.toolName, text };
        case 'user':
            return { tool: 'message', text };
        case 'assistant':
            return text ? { tool: 'your reply', text } : undefined;
    }
}

/**
 * Masks older tool results all at once: every one but the latest `keep`, and only when that frees at least
 * MASK_MIN_FREE of the budget. Afterwards nothing more is masked until the next compaction. `force`: mask whatever
 * there is, frozen or not (when a compaction could not run).
 */
export function maskToolResults(
    session: EngineSession,
    budget: number,
    options: { readonly keep?: number; readonly force?: boolean } = {},
): boolean {
    if (session.maskFrozen && !options.force) return false;
    const keep = options.keep ?? KEEP_RESULTS;
    let seen = 0;
    let upTo = session.prunedUpTo;
    for (let index = session.history.length - 1; index >= session.contextStart; index--) {
        if (session.history[index]?.role === 'tool' && ++seen > keep) {
            upTo = Math.max(upTo, index + 1);
            break;
        }
    }
    if (upTo <= session.prunedUpTo) return false;
    if (!options.force) {
        const calls = callsOf(session.history);
        let freed = 0;
        for (let index = Math.max(session.prunedUpTo, session.contextStart); index < upTo; index++) {
            const message = session.history[index];
            if (message?.role !== 'tool') continue;
            freed += estimateMessageTokens(message) - estimateTokens(placeholder(index, message, calls.get(index)));
        }
        if (freed < budget * MASK_MIN_FREE) return false;
    }
    session.prunedUpTo = upTo;
    session.maskFrozen = true;
    session.file.append({ t: 'prune', ts: Date.now(), upTo });
    return true;
}
