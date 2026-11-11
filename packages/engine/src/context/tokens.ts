import type { AssistantPart, Message, UserPart } from '@xora/providers';

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

/**
 * What the user wrote in a message: their text, without the environment block, reminders or hook output the engine
 * and host add to it.
 */
export function userWords(content: readonly (UserPart | AssistantPart)[]): string {
    return content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .filter((text) => !/^\s*<(environment|system-reminder|hook_context|hook_feedback|host_note)[\s>]/.test(text))
        .join('\n')
        .trim();
}

/** The longest start of `text` that stays within `tokens`. */
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
    return text.slice(0, low);
}

export function estimateMessageTokens(message: Message): number {
    const images = message.content.filter((part) => part.type === 'image').length;
    return estimateTokens(messageText(message)) + images * 1000 + 4;
}
