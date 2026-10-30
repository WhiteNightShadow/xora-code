/**
 * Finding JSON in free-form model output: fenced blocks first, then balanced `{…}` spans in the prose, the
 * last one first because agents put their structured result at the end of the final message.
 */

/** Longer inputs are cut from the front: the structured result sits at the end. */
const MAX_TEXT = 200_000;
/** Upper bound on `{` positions scanned, so a pathological input stays linear-ish. */
const MAX_STARTS = 2_000;

const FENCE = /```[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)```/g;
const JSON_LANGS = new Set(['', 'json', 'jsonc', 'json5']);

export type RelaxedParse =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: string };

/** Candidate JSON texts in order of preference, without duplicates. */
export function jsonCandidates(input: string): string[] {
    const text = input.length > MAX_TEXT ? input.slice(-MAX_TEXT) : input;
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (candidate: string): void => {
        const trimmed = candidate.trim();
        if (trimmed.startsWith('{') && !seen.has(trimmed)) {
            seen.add(trimmed);
            candidates.push(trimmed);
        }
    };
    const fenced: string[] = [];
    for (const match of text.matchAll(FENCE)) {
        if (JSON_LANGS.has((match[1] ?? '').toLowerCase())) {
            fenced.push(match[2] ?? '');
        }
    }
    for (const body of fenced.reverse()) {
        add(body);
    }
    for (const span of objectSpans(text)) {
        add(span);
    }
    return candidates;
}

/** `JSON.parse`, retried once without comments and trailing commas, which models often add. */
export function relaxedJsonParse(source: string): RelaxedParse {
    try {
        return { ok: true, value: JSON.parse(source) };
    } catch (error) {
        try {
            return { ok: true, value: JSON.parse(stripJsonNoise(source)) };
        } catch {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Span {
    readonly start: number;
    readonly end: number;
}

/** Balanced `{…}` spans: outermost ones first (last first), then nested ones (last first). */
function objectSpans(text: string): string[] {
    const outer: Span[] = [];
    const nested: Span[] = [];
    let outerEnd = -1;
    let starts = 0;
    for (let index = text.indexOf('{'); index >= 0 && starts < MAX_STARTS; index = text.indexOf('{', index + 1)) {
        starts += 1;
        const end = matchingBrace(text, index);
        if (end < 0) {
            continue;
        }
        // Starts only grow, so a span that starts inside the last outer span is nested in it.
        if (index > outerEnd) {
            outer.push({ start: index, end });
            outerEnd = end;
        } else {
            nested.push({ start: index, end });
        }
    }
    return [...outer.reverse(), ...nested.reverse()].map((span) => text.slice(span.start, span.end + 1));
}

function matchingBrace(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
        } else if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

/** Drops `//` and `/* *\/` comments and trailing commas outside strings. */
function stripJsonNoise(source: string): string {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source.charAt(index);
        if (inString) {
            out += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        const next = source.charAt(index + 1);
        if (char === '"') {
            inString = true;
            out += char;
        } else if (char === '/' && next === '/') {
            const newline = source.indexOf('\n', index);
            index = newline < 0 ? source.length : newline - 1;
        } else if (char === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close < 0 ? source.length : close + 1;
        } else if (char !== ',' || !closesNext(source, index + 1)) {
            out += char;
        }
    }
    return out;
}

/** Whether the next non-whitespace character closes an object or array, making a comma before it trailing. */
function closesNext(source: string, from: number): boolean {
    let index = from;
    while (index < source.length && /\s/.test(source.charAt(index))) {
        index += 1;
    }
    const char = source.charAt(index);
    return char === '}' || char === ']';
}
