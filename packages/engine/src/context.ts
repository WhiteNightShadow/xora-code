import type { AssistantPart, Message, UserPart } from '@xora/providers';
import { completeModel } from './deps.ts';
import type { EngineSession, ResolvedTarget } from './session.ts';

/**
 * Context budget and compaction (08 §2–§3). Level 1 (truncating large tool output) happens in the tools;
 * this module does level 2 (placeholders for old tool results) and level 3 (summarising older turns).
 * Nothing is deleted: the session file keeps the full history and only records where the context starts.
 */

const PRUNED_PLACEHOLDER = '[Earlier tool output removed to save context. Run the tool again if you need it.]';

/** Rough token count: about four ASCII characters per token, one per CJK or other wide character. */
export function estimateTokens(text: string): number {
    let ascii = 0;
    let wide = 0;
    for (const char of text) {
        if (char.charCodeAt(0) < 128) {
            ascii++;
        } else {
            wide++;
        }
    }
    return Math.ceil(ascii / 4 + wide);
}

function partText(part: UserPart | AssistantPart): string {
    switch (part.type) {
        case 'text':
            return part.text;
        case 'reasoning':
            return part.text;
        case 'tool_call':
            return part.name + part.arguments;
        case 'image':
            return '';
    }
}

export function estimateMessageTokens(message: Message): number {
    const images = message.content.filter((part) => part.type === 'image').length;
    return estimateTokens(message.content.map(partText).join('\n')) + images * 1000 + 4;
}

/** Messages sent to the model: the summary of compacted turns, then the kept tail with pruned tool output. */
export function contextMessages(session: EngineSession): Message[] {
    const messages: Message[] = [];
    if (session.summary) {
        messages.push({
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: `<conversation_summary>\n${session.summary}\n</conversation_summary>\nEarlier turns of this conversation were compacted into the summary above. Continue from the current state.`,
                },
            ],
        });
    }
    for (let index = session.contextStart; index < session.history.length; index++) {
        const message = session.history[index];
        if (!message) {
            continue;
        }
        if (message.role === 'tool' && index < session.prunedUpTo) {
            messages.push({ ...message, content: [{ type: 'text', text: PRUNED_PLACEHOLDER }] });
        } else {
            messages.push(message);
        }
    }
    return messages;
}

/** Window the engine manages: the model window or the user's cost cap, whichever is smaller, minus output room. */
export function contextBudget(session: EngineSession, target: ResolvedTarget): number {
    const window = Math.min(target.model.contextWindow, session.config.softContextWindow ?? Number.POSITIVE_INFINITY);
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
 * estimated; after pruning or compaction the estimate is scaled by how far off it was for that request.
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

/** Indexes of user messages that start a turn (not tool results). */
function turnStarts(session: EngineSession): number[] {
    const starts: number[] = [];
    session.history.forEach((message, index) => {
        if (message.role === 'user' && index >= session.contextStart) {
            starts.push(index);
        }
    });
    return starts;
}

export interface CompactionResult {
    readonly level: 2 | 3;
    readonly before: number;
    readonly after: number;
    readonly summary?: string;
}

/** Level 2: replace older tool results with placeholders, keeping the latest `keepTools` intact. */
export function pruneToolResults(session: EngineSession, keepTools = 6): boolean {
    let seen = 0;
    let upTo = session.prunedUpTo;
    for (let index = session.history.length - 1; index >= session.contextStart; index--) {
        if (session.history[index]?.role === 'tool') {
            seen++;
            if (seen > keepTools) {
                upTo = Math.max(upTo, index + 1);
                break;
            }
        }
    }
    if (upTo <= session.prunedUpTo) {
        return false;
    }
    session.prunedUpTo = upTo;
    session.file.append({ t: 'prune', ts: Date.now(), upTo });
    return true;
}

const SUMMARY_SYSTEM = `You compress the earlier part of a coding agent's conversation so the agent can continue without it. Write a faithful, specific summary in the language of the conversation with these sections:
1. Goal: what the user asked for, including constraints and preferences they stated.
2. Decisions: choices made and why.
3. Files: paths created, changed or examined, with the essential facts about each.
4. Commands and results: builds, tests and their outcomes.
5. Open items: what is unfinished, known problems, the next step.
Keep identifiers, paths, error messages and numbers exact. Do not invent anything. No preamble.`;

function transcript(messages: readonly Message[]): string {
    return messages
        .map((message) => {
            if (message.role === 'tool') {
                const text = message.content.map(partText).join('\n');
                return `[tool ${message.toolName} result]\n${text.length > 4000 ? `${text.slice(0, 2000)}\n…\n${text.slice(-1500)}` : text}`;
            }
            const text = message.content
                .filter((part) => part.type !== 'reasoning')
                .map((part) =>
                    part.type === 'tool_call' ? `[call ${part.name} ${part.arguments.slice(0, 2000)}]` : partText(part),
                )
                .join('\n');
            return `[${message.role}]\n${text}`;
        })
        .join('\n\n');
}

/** Steps of the turn in progress that stay verbatim when that turn itself is cut (see {@link summaryCut}). */
const KEEP_STEPS = 3;

/** The user message that started the turn in progress, also once it is behind the summary. */
function currentTurnStart(session: EngineSession): number | undefined {
    for (let index = session.history.length - 1; index >= 0; index--) {
        if (session.history[index]?.role === 'user') {
            return index;
        }
    }
    return undefined;
}

/**
 * Where the verbatim context would start after summarising, keeping `keepTurns` turns; `undefined`: nothing to
 * summarise. With too few turns to drop whole ones, a long turn is cut between its own steps, before its last
 * KEEP_STEPS model replies: an agent working through many tool calls in one turn needs this most.
 */
export function summaryCut(session: EngineSession, keepTurns: number): number | undefined {
    const starts = turnStarts(session);
    if (starts.length > keepTurns || session.summary) {
        const keepFrom = starts[Math.max(0, starts.length - keepTurns)] ?? session.history.length;
        if (keepFrom > session.contextStart) {
            return keepFrom;
        }
    }
    const start = currentTurnStart(session);
    if (start === undefined) {
        return undefined;
    }
    const steps: number[] = [];
    for (let index = Math.max(start + 1, session.contextStart); index < session.history.length; index++) {
        if (session.history[index]?.role === 'assistant') {
            steps.push(index);
        }
    }
    const cut = steps.length > KEEP_STEPS ? steps[steps.length - KEEP_STEPS] : undefined;
    return cut !== undefined && cut > session.contextStart ? cut : undefined;
}

/**
 * Level 3: summarise everything before the latest turns and start the context from the summary. `keepTurns`
 * recent turns stay verbatim. When the cut falls inside the turn in progress, its request is kept word for word
 * after the summary, so the goal survives any number of compactions.
 */
export async function summarise(
    session: EngineSession,
    target: ResolvedTarget,
    options: {
        readonly keepTurns?: number;
        readonly focus?: string;
        readonly signal?: AbortSignal;
        readonly userAgent?: string;
    },
): Promise<CompactionResult | undefined> {
    const keepFrom = summaryCut(session, Math.max(1, options.keepTurns ?? 2));
    if (keepFrom === undefined) {
        return undefined;
    }
    const older = session.history.slice(session.contextStart, keepFrom);
    const before = older.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const previous = session.summary ? `Summary of even earlier turns:\n${session.summary}\n\n` : '';
    const focus = options.focus ? `\nThe user asked to keep in particular: ${options.focus}` : '';
    const done = await completeModel(
        target.connection,
        {
            model: target.model.id,
            system: [SUMMARY_SYSTEM],
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `${previous}Conversation to summarise:\n\n${transcript(older)}${focus}` },
                    ],
                },
            ],
            effort: target.model.reasoning.mode === 'none' ? undefined : 'low',
            maxOutputTokens: 4096,
        },
        { ...(options.signal ? { signal: options.signal } : {}), userAgent: options.userAgent ?? 'XoraCode' },
    );
    const summary = done.message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n')
        .trim();
    if (summary.length === 0) {
        return undefined;
    }
    const start = currentTurnStart(session);
    const request = start !== undefined && keepFrom > start ? session.history[start] : undefined;
    const requestText = request ? request.content.map(partText).join('\n').trim() : '';
    const stored = requestText
        ? `${summary}\n\n<request_in_progress>\n${requestText}\n</request_in_progress>`
        : summary;
    const after = estimateTokens(stored);
    session.contextStart = keepFrom;
    session.summary = stored;
    session.prunedUpTo = Math.max(session.prunedUpTo, keepFrom);
    session.lastPromptTokens = 0;
    session.lastPromptEstimate = 0;
    session.file.append({
        t: 'compaction',
        ts: Date.now(),
        level: 3,
        summary: stored,
        keepFrom,
        tokensBefore: before,
        tokensAfter: after,
    });
    return { level: 3, before, after, summary };
}
