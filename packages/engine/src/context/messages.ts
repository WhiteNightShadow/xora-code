import type { Message } from '@xora/providers';
import type { EngineSession } from '../session.ts';
import { callsOf, placeholder } from './outputs.ts';

/** How a compaction message of this engine begins; anything else is a summary written before it (or the host's). */
export const STATE_TAG = '<task_state>';

/**
 * Messages sent to the model: the state of the work that replaced the compacted turns, then the kept history with
 * older tool output masked to one-line references.
 */
export function contextMessages(session: EngineSession): Message[] {
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
    return messages;
}
