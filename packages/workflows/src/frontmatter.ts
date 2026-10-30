/**
 * A small frontmatter parser for `org.md` and `agents/*.md`, so the package needs no YAML dependency.
 *
 * Supported: `key: value` with strings (plain or quoted), numbers, booleans and null; inline lists
 * `[a, b]`; block lists (`- item` lines under a key); one level of nesting, either as an indented block or as
 * a dotted key (`tiers.flagship: kimi-k3.1-pro, deepseek-v4-pro`); `#` comments. Anything else is reported
 * in `errors` and skipped, never thrown.
 */

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterList = FrontmatterScalar[];
export type FrontmatterMap = { [key: string]: FrontmatterScalar | FrontmatterList };
export type FrontmatterValue = FrontmatterScalar | FrontmatterList | FrontmatterMap;

export interface Frontmatter {
    readonly data: Record<string, FrontmatterValue>;
    /** Everything after the closing `---`, or the whole text when there is no frontmatter. */
    readonly body: string;
    readonly errors: readonly string[];
    readonly hasFrontmatter: boolean;
}

interface Line {
    readonly indent: number;
    readonly text: string;
    /** 1-based line number in the source, for error messages. */
    readonly number: number;
}

const PAIR = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

export function parseFrontmatter(source: string): Frontmatter {
    const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') {
        return { data: {}, body: text, errors: [], hasFrontmatter: false };
    }
    const end = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
    if (end < 0) {
        return { data: {}, body: text, errors: ['frontmatter is not closed with ---'], hasFrontmatter: false };
    }
    const errors: string[] = [];
    const content: Line[] = [];
    for (let index = 1; index < end; index += 1) {
        const raw = lines[index] ?? '';
        const stripped = stripComment(raw.trim());
        if (stripped !== '') {
            content.push({ indent: raw.length - raw.trimStart().length, text: stripped, number: index + 1 });
        }
    }
    const data: Record<string, FrontmatterValue> = {};
    let index = 0;
    while (index < content.length) {
        const line = content[index] as Line;
        index += 1;
        const pair = PAIR.exec(line.text);
        if (line.indent > 0 || !pair) {
            errors.push(`line ${line.number}: expected "key: value"`);
            continue;
        }
        const key = pair[1] as string;
        const inline = pair[2]?.trim() ?? '';
        const block: Line[] = [];
        while (index < content.length && (content[index] as Line).indent > 0) {
            block.push(content[index] as Line);
            index += 1;
        }
        if (inline !== '') {
            if (block.length > 0) {
                errors.push(`line ${block[0]?.number}: unexpected indentation after "${key}"`);
            }
            assign(data, key, parseValue(inline, line.number, errors), line.number, errors);
        } else if (block.length === 0) {
            assign(data, key, null, line.number, errors);
        } else if (isListItem(block[0] as Line)) {
            assign(data, key, parseList(block, errors), line.number, errors);
        } else {
            assign(data, key, parseMap(block, errors), line.number, errors);
        }
    }
    return { data, body: lines.slice(end + 1).join('\n'), errors, hasFrontmatter: true };
}

/** Drops a `#` comment: a whole-line one, or one preceded by whitespace outside quotes. */
function stripComment(text: string): string {
    if (text.startsWith('#')) {
        return '';
    }
    let quote = '';
    for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (quote !== '') {
            if (char === quote) {
                quote = '';
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '#' && /\s/.test(text.charAt(index - 1))) {
            return text.slice(0, index).trimEnd();
        }
    }
    return text;
}

function isListItem(line: Line): boolean {
    return line.text === '-' || line.text.startsWith('- ');
}

function parseList(block: readonly Line[], errors: string[]): FrontmatterList {
    const items: FrontmatterList = [];
    const indent = block[0]?.indent ?? 0;
    for (const line of block) {
        if (line.indent !== indent || !isListItem(line)) {
            errors.push(`line ${line.number}: expected a "- item" list entry`);
            continue;
        }
        const value = parseValue(line.text.slice(1).trim(), line.number, errors);
        if (Array.isArray(value)) {
            errors.push(`line ${line.number}: nested lists are not supported`);
        } else {
            items.push(value);
        }
    }
    return items;
}

function parseMap(block: readonly Line[], errors: string[]): FrontmatterMap {
    const map: FrontmatterMap = {};
    const indent = block[0]?.indent ?? 0;
    let index = 0;
    while (index < block.length) {
        const line = block[index] as Line;
        index += 1;
        const pair = PAIR.exec(line.text);
        if (line.indent !== indent || !pair) {
            errors.push(`line ${line.number}: expected "key: value" (one level of nesting)`);
            continue;
        }
        const key = pair[1] as string;
        const inline = pair[2]?.trim() ?? '';
        const nested: Line[] = [];
        while (index < block.length && (block[index] as Line).indent > indent) {
            nested.push(block[index] as Line);
            index += 1;
        }
        if (inline !== '') {
            if (nested.length > 0) {
                errors.push(`line ${nested[0]?.number}: unexpected indentation after "${key}"`);
            }
            map[key] = parseValue(inline, line.number, errors);
        } else if (nested.length === 0) {
            map[key] = null;
        } else if (isListItem(nested[0] as Line)) {
            map[key] = parseList(nested, errors);
        } else {
            errors.push(`line ${line.number}: "${key}" nests deeper than one level`);
        }
    }
    return map;
}

function assign(
    data: Record<string, FrontmatterValue>,
    key: string,
    value: FrontmatterValue,
    lineNumber: number,
    errors: string[],
): void {
    const dot = key.indexOf('.');
    if (dot < 0) {
        const existing = data[key];
        if (isMap(value) && isMap(existing)) {
            data[key] = { ...existing, ...value };
            return;
        }
        if (existing !== undefined) {
            errors.push(`line ${lineNumber}: "${key}" is set twice; the last value wins`);
        }
        data[key] = value;
        return;
    }
    const outer = key.slice(0, dot);
    const inner = key.slice(dot + 1);
    if (inner.includes('.') || isMap(value)) {
        errors.push(`line ${lineNumber}: "${key}" nests deeper than one level`);
        return;
    }
    const existing = data[outer];
    if (existing !== undefined && !isMap(existing)) {
        errors.push(`line ${lineNumber}: "${outer}" is not a map`);
        return;
    }
    data[outer] = { ...(existing ?? {}), [inner]: value };
}

function isMap(value: FrontmatterValue | undefined): value is FrontmatterMap {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseValue(raw: string, lineNumber: number, errors: string[]): FrontmatterScalar | FrontmatterList {
    if (raw.startsWith('[')) {
        if (!raw.endsWith(']')) {
            errors.push(`line ${lineNumber}: unclosed inline list`);
            return raw;
        }
        const inner = raw.slice(1, -1).trim();
        return inner === '' ? [] : splitTopLevel(inner).map((item) => parseScalar(item.trim()));
    }
    if (raw === '|' || raw === '>' || /^[|>][+-]?$/.test(raw)) {
        errors.push(`line ${lineNumber}: block scalars are not supported; put long text in the body`);
        return null;
    }
    return parseScalar(raw);
}

/** Splits on commas that are outside quotes. */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let quote = '';
    let current = '';
    for (const char of text) {
        if (quote !== '') {
            if (char === quote) {
                quote = '';
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === ',') {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

function parseScalar(raw: string): FrontmatterScalar {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        try {
            return JSON.parse(raw) as string;
        } catch {
            return raw.slice(1, -1);
        }
    }
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
        return raw.slice(1, -1).replaceAll("''", "'");
    }
    if (/^(true|false)$/i.test(raw)) {
        return raw.toLowerCase() === 'true';
    }
    if (raw === 'null' || raw === '~') {
        return null;
    }
    if (NUMBER.test(raw)) {
        return Number(raw);
    }
    return raw;
}
