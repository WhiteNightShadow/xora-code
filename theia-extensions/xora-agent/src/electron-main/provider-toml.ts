// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { isDeepStrictEqual } from 'util';

export const MANAGED_BLOCK_START = '# >>> Xora Code managed providers >>>';
export const MANAGED_BLOCK_END = '# <<< Xora Code managed providers <<<';
export const LEGACY_MANAGED_BLOCK_START = '# >>> WhiteNight Code managed providers >>>';
export const LEGACY_MANAGED_BLOCK_END = '# <<< WhiteNight Code managed providers <<<';

function parseDocument(source: string): Record<string, unknown> {
    try { return parseToml(source); } catch {
        throw new Error('Grok config.toml is invalid or cannot be safely edited. Xora Code left it unchanged.');
    }
}

interface Statement {
    start: number;
    end: number;
    valueStart?: number;
    valueEnd?: number;
    path: string[];
    kind: 'table' | 'array-table' | 'assignment' | 'comment';
    text: string;
}

const OWNED_MODEL_ID = /^(?:xora|wnc)-[a-z0-9][a-z0-9-]{0,48}$/;
const MARKERS = [MANAGED_BLOCK_START, MANAGED_BLOCK_END, LEGACY_MANAGED_BLOCK_START, LEGACY_MANAGED_BLOCK_END];

/** TOML owns the syntax; the scanner only records source spans for minimal edits. */
function statements(source: string): Statement[] {
    const result: Statement[] = [];
    let scope: string[] = [];
    let offset = 0;
    while (offset < source.length) {
        const start = offset;
        while (source[offset] === ' ' || source[offset] === '\t' || source[offset] === '\r') offset++;
        if (source[offset] === '\n') { offset++; continue; }
        if (offset >= source.length) break;
        if (source[offset] === '#') {
            const newline = source.indexOf('\n', offset);
            offset = newline < 0 ? source.length : newline + 1;
            result.push({ start, end: offset, path: [...scope], kind: 'comment', text: source.slice(start, offset).trim() });
            continue;
        }
        const first = offset;
        let quote: string | undefined;
        let multiline = false;
        let depth = 0;
        let equal: number | undefined;
        let lastTokenEnd = first;
        for (; offset < source.length; offset++) {
            const character = source[offset];
            if (quote) {
                lastTokenEnd = offset + 1;
                if (quote === '"' && character === '\\') {
                    offset++;
                    lastTokenEnd = offset + 1;
                } else if (character === quote) {
                    if (!multiline) quote = undefined;
                    else if (source.slice(offset, offset + 3) === quote.repeat(3)) {
                        let count = 3;
                        while (source[offset + count] === quote && count < 5) count++;
                        offset += count - 1;
                        lastTokenEnd = offset + 1;
                        quote = undefined;
                    }
                }
                continue;
            }
            if (character === '#') {
                const newline = source.indexOf('\n', offset);
                offset = newline < 0 ? source.length : newline;
                if (depth === 0 || offset === source.length) break;
                continue;
            }
            if (character === '\n' && depth === 0) break;
            if (!/\s/.test(character)) lastTokenEnd = offset + 1;
            if (character === '"' || character === "'") {
                quote = character;
                multiline = source.slice(offset, offset + 3) === character.repeat(3);
                if (multiline) { offset += 2; lastTokenEnd = offset + 1; }
            } else if (character === '[' || character === '{') depth++;
            else if (character === ']' || character === '}') depth--;
            else if (character === '=' && depth === 0 && equal === undefined) equal = offset;
        }
        if (quote || depth !== 0) throw new Error('Grok configuration has an unfinished TOML value; it was left unchanged.');
        if (source[offset] === '\n') offset++;
        const text = source.slice(start, offset);
        if (source[first] === '[') {
            const kind = source[first + 1] === '[' ? 'array-table' : 'table';
            scope = parsedHeaderPath(text);
            result.push({ start, end: offset, path: [...scope], kind, text });
        } else {
            if (equal === undefined) throw new Error('Grok configuration has an unsupported TOML statement; it was left unchanged.');
            let valueStart = equal + 1;
            while (/\s/.test(source[valueStart] ?? '') && valueStart < lastTokenEnd) valueStart++;
            const key = source.slice(first, equal).trim();
            const keyPath = onlyValuePath(parseDocument(`${key} = 0`));
            result.push({ start, end: offset, path: [...scope, ...keyPath], kind: 'assignment', valueStart, valueEnd: lastTokenEnd, text });
        }
    }
    return result;
}

function parsedHeaderPath(header: string): string[] {
    return onlyValuePath(parseDocument(`${header}\n__xora_span_probe__ = 0`)).slice(0, -1);
}

function onlyValuePath(value: unknown): string[] {
    const result: string[] = [];
    while (value && typeof value === 'object') {
        if (Array.isArray(value)) { value = value[0]; continue; }
        const entries = Object.entries(value);
        if (entries.length !== 1) throw new Error('Unable to identify a TOML source span.');
        result.push(entries[0][0]);
        value = entries[0][1];
    }
    return result;
}

function prefix(parent: readonly string[], value: readonly string[]): boolean {
    return parent.length <= value.length && parent.every((part, index) => part === value[index]);
}

function removeSpans(source: string, spans: { start: number; end: number }[]): string {
    const ordered = spans.sort((a, b) => a.start - b.start || a.end - b.end);
    let end = 0;
    let result = '';
    for (const span of ordered) {
        if (span.start > end) result += source.slice(end, span.start);
        end = Math.max(end, span.end);
    }
    return result + source.slice(end);
}

function markerPairs(entries: Statement[], strict = false): { start: Statement; end: Statement }[] {
    const pairs: { start: Statement; end: Statement }[] = [];
    let opening: Statement | undefined;
    for (const entry of entries) {
        if (entry.kind !== 'comment' || !MARKERS.includes(entry.text)) continue;
        const index = MARKERS.indexOf(entry.text);
        if (index % 2 === 0) {
            if (opening && strict) throw new Error('Grok config contains an incomplete managed provider block. Xora Code left it unchanged.');
            opening = entry;
        } else if (opening && MARKERS.indexOf(opening.text) + 1 === index) {
            pairs.push({ start: opening, end: entry });
            opening = undefined;
        } else if (strict) throw new Error('Grok config contains an incomplete managed provider block. Xora Code left it unchanged.');
    }
    if (opening && strict) throw new Error('Grok config contains an incomplete managed provider block. Xora Code left it unchanged.');
    return pairs;
}

export function assertManagedProviderMarkers(source: string): void {
    markerPairs(statements(source), true);
}

export function markedManagedModelIds(source: string): string[] {
    const entries = statements(source);
    const pairs = markerPairs(entries);
    return [...new Set(entries.filter(entry => entry.kind !== 'comment' && entry.path.length === 2
        && entry.path[0] === 'model' && OWNED_MODEL_ID.test(entry.path[1] ?? '')
        && pairs.some(pair => entry.start > pair.start.start && entry.start < pair.end.start))
        .map(entry => entry.path[1]))];
}

/** Marker comments never confer ownership over Skills, MCP, or other user tables. */
export function removeMarkedManagedBlocksFromToml(source: string): string {
    const entries = statements(source);
    const pairs = markerPairs(entries);
    return removeSpans(source, [
        ...modelRemovalSpans(entries, markedManagedModelIds(source)),
        ...pairs.flatMap(pair => [pair.start, pair.end])
    ]);
}

export function removeModelTablesFromToml(source: string, catalogIds: readonly string[]): string {
    return removeSpans(source, modelRemovalSpans(statements(source), catalogIds));
}

function modelRemovalSpans(entries: Statement[], catalogIds: readonly string[]): { start: number; end: number }[] {
    const identifiers = new Set(catalogIds);
    // Preserve standalone comments, including labels immediately before the
    // next user table. Multiline strings remain part of their one assignment.
    return entries.filter(entry => entry.kind !== 'comment'
        && entry.path[0] === 'model' && identifiers.has(entry.path[1]));
}

export function removeModelTableFromToml(source: string, catalogId: string): string {
    return catalogId ? removeModelTablesFromToml(source, [catalogId]) : source;
}

export function tomlValueAt(source: string, keys: readonly string[]): unknown {
    return valueAt(parseDocument(source), keys);
}

function valueAt(value: unknown, keys: readonly string[]): unknown {
    for (const key of keys) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

function inlineValue(value: unknown): string {
    if (typeof value === 'number' && Object.is(value, -0)) return '-0.0';
    if (Array.isArray(value)) return `[${value.map(inlineValue).join(', ')}]`;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${inlineValue(child)}`).join(', ')} }`;
    }
    return stringifyToml({ value }).trim().replace(/^value\s*=\s*/, '');
}

/** Replace a parsed value span while preserving unrelated bytes and comments. */
export function setTomlValue(source: string, keys: readonly string[], value: unknown): string {
    const before = parseDocument(source);
    const entries = statements(source);
    const candidates = entries.filter(entry => entry.kind === 'assignment' && prefix(entry.path, keys));
    if (candidates.length > 1) throw new Error('Grok configuration has ambiguous TOML values; it was left unchanged.');
    let after: string;
    if (candidates.length === 1) {
        const entry = candidates[0];
        let replacement = value;
        if (entry.path.length < keys.length) {
            replacement = parseDocument(`value = ${source.slice(entry.valueStart!, entry.valueEnd!)}`).value;
            setValueAt(replacement, keys.slice(entry.path.length), value);
        }
        after = `${source.slice(0, entry.valueStart!)}${inlineValue(replacement)}${source.slice(entry.valueEnd!)}`;
    } else {
        const parent = keys.slice(0, -1);
        const sections = entries.filter(entry => (entry.kind === 'table' || entry.kind === 'array-table') && prefix(entry.path, parent));
        sections.sort((a, b) => b.path.length - a.path.length);
        const section = sections[0];
        if (section?.kind === 'array-table') throw new Error('Grok configuration cannot be safely edited inside a TOML array of tables.');
        const sectionIndex = section ? entries.indexOf(section) : -1;
        const next = entries.slice(sectionIndex + 1).find(entry => entry.kind === 'table' || entry.kind === 'array-table');
        const position = next?.start ?? source.length;
        const relative = section ? keys.slice(section.path.length) : keys;
        const assignment = `${relative.map(key => JSON.stringify(key)).join('.')} = ${inlineValue(value)}`;
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const separator = position > 0 && !source.slice(0, position).endsWith('\n') ? newline : '';
        after = `${source.slice(0, position)}${separator}${assignment}${newline}${source.slice(position)}`;
    }
    setValueAt(before, keys, value);
    if (!isDeepStrictEqual(before, parseDocument(after))) throw new Error('Grok configuration edit would change unrelated settings; it was left unchanged.');
    return after;
}

function setValueAt(root: unknown, keys: readonly string[], value: unknown): void {
    let current = root as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Grok configuration contains an incompatible TOML table.');
        if (!Object.prototype.hasOwnProperty.call(current, key)) Object.defineProperty(current, key, { value: {}, enumerable: true, writable: true, configurable: true });
        current = current[key] as Record<string, unknown>;
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Grok configuration contains an incompatible TOML table.');
    Object.defineProperty(current, keys[keys.length - 1], { value, enumerable: true, writable: true, configurable: true });
}

/** Provider rewrites may change model entries only, even if markers drifted. */
export function assertUnmanagedTomlPreserved(before: string, after: string, ownedModelIds: readonly string[]): void {
    const documents = [parseDocument(before), parseDocument(after)];
    for (const document of documents) {
        const models = document.model;
        if (models && typeof models === 'object' && !Array.isArray(models)) {
            for (const id of ownedModelIds) delete (models as Record<string, unknown>)[id];
            if (Object.keys(models).length === 0) delete document.model;
        }
    }
    if (!isDeepStrictEqual(documents[0], documents[1])) throw new Error('Provider update would change shared Skills, MCP or other user settings. Xora Code left config.toml unchanged.');
}
