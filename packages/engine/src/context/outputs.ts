import type { AssistantPart, Message } from '@xora/providers';
import { backgroundJobOf, clipText, sliceText } from '../deps.ts';
import type { EngineSession } from '../session.ts';
import { estimateMessageTokens, estimateTokens, fullText, messageText } from './tokens.ts';

/**
 * Tool output out of the context but never lost (20 §4.3): an older result is masked to one line that says what it
 * was and where to get it, and `tool_output` returns it from the session as it was. Outputs over `SPILL_AT_CHARS` are
 * spilled to `<session>/outputs/R<index>.txt` as soon as they arrive and enter the context as a structured preview
 * (head, middle diagnostics and tail), keeping the prefix stable for provider prompt caching.
 */

/** Tool results that stay whole when older ones are masked. */
export const KEEP_RESULTS = 12;
/**
 * Masking happens only when it frees this share of the budget: each masking edits history, and the provider's cache
 * misses from the first edited message on. Few large maskings cost less than one small one per request.
 */
export const MASK_MIN_FREE = 0.2;
/** Single tool outputs beyond this size spill to disk on arrival and show a structured preview in context. */
export const SPILL_AT_CHARS = 24_000;

/** Tools whose caller explicitly paged into a slice of text: their output is kept as requested. */
const PAGED_TOOLS: ReadonlySet<string> = new Set(['read', 'tool_output']);
const PREVIEW_HEAD_LINES = 80;
const PREVIEW_HEAD_CHARS = 3_600;
const PREVIEW_TAIL_LINES = 60;
const PREVIEW_TAIL_CHARS = 3_600;
const PREVIEW_LINE_CHARS = 500;
const PREVIEW_NOTABLE_MAX = 12;
const PREVIEW_DIAGNOSTIC =
    /error|fail|exception|traceback|denied|not found|cannot|panic|fatal|warn|err!|错误|失败|异常/i;

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
    // A command left running: what is masked is its output so far, not a result.
    const job = !failed && message.toolName === 'bash' ? backgroundJobOf(text) : undefined;
    const parts = [
        `#${refOf(index)} ${message.toolName}${what ? ` ${what}` : ''}`,
        job ? `running on as ${job}, no result yet` : failed ? 'failed' : 'ok',
        sizeOf(text.length),
    ];
    const line = notableLine(text, failed);
    if (line) parts.push(line);
    return `[${parts.join(' · ')} — masked to save context; tool_output("${refOf(index)}") returns it]`;
}

function sliceTail(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    let at = Math.max(0, text.length - Math.floor(maxChars));
    const code = text.charCodeAt(at);
    if (code >= 0xdc00 && code <= 0xdfff && at < text.length) at += 1;
    return text.slice(at);
}

/**
 * Builds a deterministic structured preview (head + middle diagnostic lines + tail + `#R<index>` pointer) for a large
 * tool output whose full text was spilled to `outputs/R<index>.txt`.
 */
export function structuredPreview(index: number, raw: string): string {
    const ref = refOf(index);
    const lines = raw.split('\n');
    let headEnd = 0;
    let headChars = 0;
    while (headEnd < lines.length && headEnd < PREVIEW_HEAD_LINES) {
        const len = Math.min(lines[headEnd]?.length ?? 0, PREVIEW_LINE_CHARS) + 1;
        if (headEnd > 0 && headChars + len > PREVIEW_HEAD_CHARS) break;
        headChars += len;
        headEnd++;
    }
    let tailStart = lines.length;
    let tailChars = 0;
    while (tailStart > headEnd && lines.length - tailStart < PREVIEW_TAIL_LINES) {
        const len = Math.min(lines[tailStart - 1]?.length ?? 0, PREVIEW_LINE_CHARS) + 1;
        if (tailStart < lines.length && tailChars + len > PREVIEW_TAIL_CHARS) break;
        tailChars += len;
        tailStart--;
    }
    const footer = `[Full output saved as #${ref} (${lines.length} lines · ${sizeOf(raw.length)}) — use tool_output({ ref: "${ref}", offset, limit }), tool_output({ ref: "${ref}", tail: 100 }) or tool_output({ ref: "${ref}", grep: "...", context: 3 }) to inspect without re-running]`;
    // Single-line or ultra-wide few-line blobs (e.g. minified JSON): show safe head and tail slices directly.
    if (headEnd >= tailStart) {
        const head = sliceText(raw, PREVIEW_HEAD_CHARS);
        const tail = sliceTail(raw, PREVIEW_TAIL_CHARS);
        const omitted = Math.max(0, raw.length - head.length - tail.length);
        return `${head}\n[... ${sizeOf(omitted)} spilled to #${ref} ...]\n${tail}\n${footer}`;
    }
    const trimLine = (line: string) => clipText(line, PREVIEW_LINE_CHARS);
    const headBlock = lines.slice(0, headEnd).map(trimLine).join('\n');
    const tailBlock = lines.slice(tailStart).map(trimLine).join('\n');
    const seen = new Set<string>();
    const diagnostics: string[] = [];
    for (let i = headEnd; i < tailStart && diagnostics.length < PREVIEW_NOTABLE_MAX; i++) {
        const line = (lines[i] ?? '').trim();
        if (!line || !PREVIEW_DIAGNOSTIC.test(line)) continue;
        const key = line.slice(0, 120).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push(`  L${i + 1}: ${clipText(line, 200)}`);
    }
    const omittedChars = lines.slice(headEnd, tailStart).reduce((sum, line) => sum + line.length + 1, 0);
    const middle =
        diagnostics.length > 0
            ? `[... ${tailStart - headEnd} middle lines (${sizeOf(omittedChars)}) spilled to #${ref}; notable lines in omitted range:\n${diagnostics.join('\n')}\n...]`
            : `[... ${tailStart - headEnd} middle lines (${sizeOf(omittedChars)}) spilled to #${ref} ...]`;
    return [headBlock, middle, tailBlock, footer].join('\n');
}

/**
 * Spills a large tool output to `<session>/outputs/R<index>.txt` on arrival and returns its structured preview for
 * `session.history`, leaving normal-sized outputs and explicit paged reads (`read`, `tool_output`) untouched.
 */
export function spillToolOutput(
    session: EngineSession,
    index: number,
    toolName: string,
    content: string,
    fullContent?: string,
): string {
    const raw = fullContent !== undefined && fullContent.length > content.length ? fullContent : content;
    if (PAGED_TOOLS.has(toolName) || raw.length <= SPILL_AT_CHARS) {
        return content;
    }
    try {
        session.saveSpilledOutput(index, raw);
    } catch {
        return content;
    }
    return structuredPreview(index, raw);
}

/** The message a reference names, as it was: a tool's output, a message to the model, or one of its replies. */
export function readOutput(session: EngineSession, ref: string): { tool: string; text: string } | undefined {
    const match = /^R(\d+)$/.exec(ref.trim().replace(/^#/, '').toUpperCase());
    if (!match) return undefined;
    const index = Number(match[1]);
    const message = session.history[index];
    if (!message) return undefined;
    if (message.role === 'tool') {
        const spilled = session.readSpilledOutput(index);
        return { tool: message.toolName, text: spilled ?? fullText(message) };
    }
    const text = fullText(message);
    switch (message.role) {
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
