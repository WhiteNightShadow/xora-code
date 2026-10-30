import { type FrontmatterMap, type FrontmatterValue, isFrontmatterMap } from './frontmatter.ts';

/** A string field: numbers and booleans are accepted as their text (`version: 1.2` reads as a number). */
export function scalarString(value: FrontmatterValue | undefined): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return undefined;
}

/** Splits at commas and whitespace outside parentheses, so `Bash(git add:*), Read` gives two tools. */
function splitTools(text: string): string[] {
    const tools: string[] = [];
    let current = '';
    let depth = 0;
    for (const char of text) {
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth = Math.max(0, depth - 1);
        }
        if (depth === 0 && (char === ',' || /\s/.test(char))) {
            if (current !== '') {
                tools.push(current);
            }
            current = '';
            continue;
        }
        current += char;
    }
    if (current !== '') {
        tools.push(current);
    }
    return tools;
}

/**
 * A tool list as skills (`allowed-tools: Bash(git:*) Read`), commands and agents (`tools: Read, Grep` or a YAML
 * list) write it. `undefined` when the field is absent; an empty list when it is present but empty.
 */
export function parseToolList(value: FrontmatterValue | undefined): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const parts = Array.isArray(value) ? value.map((item) => scalarString(item) ?? '') : [scalarString(value) ?? ''];
    return [...new Set(parts.flatMap(splitTools))];
}

/** A string-to-string map such as skill `metadata`; non-scalar values are dropped. */
export function stringMap(value: FrontmatterValue | undefined): Record<string, string> | undefined {
    if (!isFrontmatterMap(value)) {
        return undefined;
    }
    const entries: [string, string][] = [];
    for (const [key, item] of Object.entries(value)) {
        const text = scalarString(item);
        if (text !== undefined) {
            entries.push([key, text]);
        }
    }
    return Object.fromEntries(entries);
}

/** First non-empty line of a markdown body without heading marks, for commands that have no description. */
export function firstLine(body: string, max = 200): string | undefined {
    for (const line of body.split('\n')) {
        const text = line.replace(/^#+\s*/, '').trim();
        if (text !== '') {
            return text.length > max ? `${text.slice(0, max - 1)}…` : text;
        }
    }
    return undefined;
}

export function field(data: FrontmatterMap, ...keys: string[]): FrontmatterValue | undefined {
    for (const key of keys) {
        if (Object.hasOwn(data, key)) {
            return data[key];
        }
    }
    return undefined;
}

/** Replaces `${NAME}` placeholders whose name is in `values`; other text is left alone. */
export function substitute(text: string, values: Readonly<Record<string, string | undefined>>): string {
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
        Object.hasOwn(values, name) ? (values[name] ?? match) : match,
    );
}

/** {@link substitute} applied to every string inside a JSON-like value. */
export function substituteDeep(value: unknown, values: Readonly<Record<string, string | undefined>>): unknown {
    if (typeof value === 'string') {
        return substitute(value, values);
    }
    if (Array.isArray(value)) {
        return value.map((item) => substituteDeep(item, values));
    }
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteDeep(item, values)]));
    }
    return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
