import type { AssistantPart, Message, UserPart } from '@xora/providers';
import { sliceText } from '../deps.ts';

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

export function partText(part: UserPart | AssistantPart): string {
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

export function messageText(message: Message): string {
    return message.content.map(partText).join('\n');
}

/** Text parts the engine and the host add to a message: never the words of whoever wrote it. */
const ADDED = /^\s*<(environment|system-reminder|hook_context|hook_feedback|host_note)[\s>]/;
const REMINDER = /^\s*<system-reminder>/;
/** An attached file, which the message names without repeating its content. */
const ATTACHED = /^\s*<file uri="([^"]*)">/;

/**
 * What a message to the model says: its text without what the engine and the host add to it (the environment,
 * reminders, hook output, host notes), attached files by name only. In work the host hands a thread (a task card, a
 * workflow step) the host's words are the request.
 */
export function userWords(content: readonly (UserPart | AssistantPart)[]): string {
    return content
        .flatMap((part) => {
            if (part.type !== 'text' || ADDED.test(part.text)) return [];
            const file = ATTACHED.exec(part.text);
            return [file ? `[attached file ${file[1]}]` : part.text];
        })
        .join('\n')
        .trim();
}

/** A message as it was, for `tool_output`: every text of it, without the reminders the engine added at its end. */
export function fullText(message: Message): string {
    return message.content
        .flatMap((part) => (part.type === 'text' && !REMINDER.test(part.text) ? [part.text] : []))
        .join('\n')
        .trim();
}

/** The longest start of `text` that stays within `tokens`, never splitting a surrogate pair. */
export function clipTokens(text: string, tokens: number): string {
    if (estimateTokens(text) <= tokens) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(text.slice(0, mid)) <= tokens) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return sliceText(text, low);
}

export function estimateMessageTokens(message: Message): number {
    const images = message.content.filter((part) => part.type === 'image').length;
    return estimateTokens(messageText(message)) + images * 1000 + 4;
}
