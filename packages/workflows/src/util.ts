/** Freezes `value` and everything reachable from it, so shared defaults and stored records cannot be mutated. */
export function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
    }
    return value;
}

export type Clock = () => number;

/** Text with `\n` line ends, no trailing blanks on lines and no blank lines around it; stable for prompt caching. */
export function tidyText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .trim();
}
