import type { Message } from '@xora/providers';
import type { EngineSession } from '../session.ts';
import { callsOf, placeholder } from './outputs.ts';

/** How a compaction message of this engine begins; anything else is a summary written before it (or the host's). */
export const STATE_TAG = '<task_state>';

interface Built {
    readonly length: number;
    /** The last message: a rewind and new messages can bring the history back to the same length. */
    readonly tail: Message | undefined;
    readonly start: number;
    readonly pruned: number;
    readonly summary: string | undefined;
    readonly messages: readonly Message[];
}

/** The latest messages built for each session: a request estimates and sends them several times over. */
const built = new WeakMap<EngineSession, Built>();

/**
 * Messages sent to the model: the state of the work that replaced the compacted turns, then the kept history with
 * older tool output masked to one-line references. A message is never changed once in the history, which only grows
 * or goes back to a turn: what was built stays right while its length, last message and the rest stay the same.
 */
export function contextMessages(session: EngineSession): Message[] {
    const last = built.get(session);
    if (
        last &&
        last.length === session.history.length &&
        last.tail === session.history.at(-1) &&
        last.start === session.contextStart &&
        last.pruned === session.prunedUpTo &&
        last.summary === session.summary
    ) {
        return [...last.messages];
    }
    const messages: Message[] = [];
    if (session.summary) {
        const text = session.summary.startsWith(STATE_TAG)
            ? session.summary
            : `<conversation_summary>\n${session.summary}\n</conversation_summary>\nEarlier turns of this conversation were compacted into the summary above. Continue from the current state.`;
        messages.push({ role: 'user', content: [{ type: 'text', text }] });
    }
    const calls = session.prunedUpTo > session.contextStart ? callsOf(session.history) : undefined;
    for (let index = session.contextStart; index < session.history.length; index++) {
        const message = session.history[index];
        if (!message) {
            continue;
        }
        if (message.role === 'tool' && index < session.prunedUpTo) {
            messages.push({
                ...message,
                content: [{ type: 'text', text: placeholder(index, message, calls?.get(index)) }],
            });
        } else {
            messages.push(message);
        }
    }
    built.set(session, {
        length: session.history.length,
        tail: session.history.at(-1),
        start: session.contextStart,
        pruned: session.prunedUpTo,
        summary: session.summary,
        messages,
    });
    return [...messages];
}
