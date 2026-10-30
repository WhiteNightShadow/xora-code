/**
 * A small YAML-frontmatter reader and writer for the subset that SKILL.md, slash command and agent files use:
 * plain, quoted and block (`|`, `>`) scalars, numbers, booleans, null, flow `[a, b]` and `{a: 1}` collections,
 * block `- item` sequences and nested mappings. Nothing is ever evaluated: anchors, aliases and tags are read as
 * plain text, and keys such as `__proto__` become ordinary own properties.
 */

export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[] | FrontmatterMap;

export interface FrontmatterMap {
    [key: string]: FrontmatterValue;
}

export interface FrontmatterError {
    /** 1-based line number in the whole file. */
    readonly line: number;
    readonly message: string;
}

export interface Frontmatter {
    /** Parsed keys; whatever could be read when there are errors. */
    readonly data: FrontmatterMap;
    /** The text after the closing `---`, without leading blank lines; the whole text when there is no frontmatter. */
    readonly body: string;
    readonly errors: readonly FrontmatterError[];
    /** Whether the file starts with a closed `---` block. */
    readonly present: boolean;
}

const MAX_DEPTH = 16;
const OPENING = /^---[ \t]*$/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;
/** `key:` followed by a space or the end of the line; the key is plain, single- or double-quoted. */
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#:[\]{},&*!|>%@`-][^:]*?)[ \t]*:(?:[ \t]+(.*))?$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
const BLANK = /^[ \t]*$/;
const BLOCK_HEADER = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(?:#.*)?$/;

/** Reads a leading `---` … `---` block. Line endings are normalised to `\n` in the returned body. */
export function parseFrontmatter(text: string): Frontmatter {
    const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    if (!OPENING.test(lines[0] ?? '')) {
        return { data: {}, body: normalized, errors: [], present: false };
    }
    const end = lines.findIndex((line, index) => index > 0 && CLOSING.test(line));
    if (end < 0) {
        return {
            data: {},
            body: normalized,
            errors: [{ line: 1, message: 'frontmatter is not closed with ---' }],
            present: false,
        };
    }
    const parser = new BlockParser(lines.slice(1, end), 2);
    const data = parser.document();
    const body = lines
        .slice(end + 1)
        .join('\n')
        .replace(/^(?:[ \t]*\n)+/, '');
    return { data, body, errors: parser.errors, present: true };
}

export function isFrontmatterMap(value: FrontmatterValue | undefined): value is FrontmatterMap {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves a plain (unquoted) scalar the way YAML 1.2's core schema does. */
export function resolveScalar(text: string): FrontmatterValue {
    switch (text) {
        case '':
        case '~':
        case 'null':
        case 'Null':
        case 'NULL':
            return null;
        case 'true':
        case 'True':
        case 'TRUE':
            return true;
        case 'false':
        case 'False':
        case 'FALSE':
            return false;
    }
    if (/^[-+]?[0-9]+$/.test(text)) {
        const value = Number(text);
        // Long numeric ids would lose precision as numbers.
        return Number.isSafeInteger(value) ? value : text;
    }
    if (/^0x[0-9a-fA-F]+$/.test(text)) {
        return Number.parseInt(text.slice(2), 16);
    }
    if (/^0o[0-7]+$/.test(text)) {
        return Number.parseInt(text.slice(2), 8);
    }
    if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) {
        return Number(text);
    }
    return text;
}

function isSequenceItem(text: string): boolean {
    return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}

function stripComment(text: string): string {
    return text.replace(/[ \t]+#.*$/, '').trim();
}

/** Joins lines the way YAML folds flow scalars: a single break becomes a space, blank lines become breaks. */
function foldLines(lines: readonly string[]): string {
    let out = '';
    let breaks = 0;
    let started = false;
    for (const line of lines) {
        if (line === '') {
            if (started) {
                breaks++;
            }
            continue;
        }
        if (started) {
            out += breaks > 0 ? '\n'.repeat(breaks) : ' ';
        }
        out += line;
        started = true;
        breaks = 0;
    }
    return out;
}

/** Folding for `>` block scalars: more-indented lines keep their breaks. */
function foldBlock(lines: readonly string[]): string {
    let out = '';
    let previous: 'start' | 'text' | 'empty' | 'indented' = 'start';
    for (const line of lines) {
        const kind = line === '' ? 'empty' : /^[ \t]/.test(line) ? 'indented' : 'text';
        if (previous === 'start') {
            out = line;
        } else if (kind === 'empty') {
            out += '\n';
        } else if (kind === 'text' && previous === 'text') {
            out += ` ${line}`;
        } else if (previous === 'empty') {
            out += line;
        } else {
            out += `\n${line}`;
        }
        previous = kind;
    }
    return out;
}

/** Index of the quote that closes the scalar opened at index 0, or -1. */
function closingQuote(text: string): number {
    const quote = text[0];
    for (let index = 1; index < text.length; index++) {
        const char = text[index];
        if (quote === '"' && char === '\\') {
            index++;
        } else if (char === quote) {
            if (quote === "'" && text[index + 1] === "'") {
                index++;
            } else {
                return index;
            }
        }
    }
    return -1;
}

const ESCAPES = new Map<string, string>([
    ['0', '\0'],
    ['a', '\x07'],
    ['b', '\b'],
    ['t', '\t'],
    ['\t', '\t'],
    ['n', '\n'],
    ['v', '\v'],
    ['f', '\f'],
    ['r', '\r'],
    ['e', '\x1b'],
    [' ', ' '],
    ['"', '"'],
    ['/', '/'],
    ['\\', '\\'],
    ['N', '\u0085'],
    ['_', ' '],
    ['L', ' '],
    ['P', ' '],
]);

function unescapeDouble(text: string, onError: (message: string) => void): string {
    return text.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (match, sequence: string) => {
        if (sequence.length > 1) {
            const code = Number.parseInt(sequence.slice(1), 16);
            if (code <= 0x10ffff) {
                return String.fromCodePoint(code);
            }
            onError(`invalid escape ${match}`);
            return match;
        }
        const replacement = ESCAPES.get(sequence);
        if (replacement === undefined) {
            onError(`invalid escape ${match}`);
            return sequence;
        }
        return replacement;
    });
}

function unquote(text: string, onError: (message: string) => void): string {
    const inner = text.slice(1, -1);
    return text[0] === '"' ? unescapeDouble(inner, onError) : inner.replaceAll("''", "'");
}

/** Whether every bracket opened outside quoted scalars is closed. */
function flowBalanced(text: string): boolean {
    let depth = 0;
    let previous = '';
    for (let index = 0; index < text.length; index++) {
        const char = text[index] ?? '';
        // A quote opens a quoted scalar only at the start of a token, so `don't` stays plain text.
        if ((char === '"' || char === "'") && /^[[{,:\s]?$/.test(previous)) {
            const close = closingQuote(text.slice(index));
            if (close < 0) {
                return false;
            }
            index += close;
        } else if (char === '[' || char === '{') {
            depth++;
        } else if (char === ']' || char === '}') {
            depth--;
        }
        if (!/\s/.test(char)) {
            previous = char;
        }
    }
    return depth <= 0;
}

class FlowError extends Error {}

/** Recursive-descent reader for one flow collection such as `[a, "b, c", {d: 1}]`. */
class FlowParser {
    readonly #text: string;
    readonly #onError: (message: string) => void;
    #pos = 0;

    constructor(text: string, onError: (message: string) => void) {
        this.#text = text;
        this.#onError = onError;
    }

    /** Parses the collection and returns it with whatever text follows it. */
    parse(): { value: FrontmatterValue; rest: string } {
        const value = this.#value(0, ',]}');
        return { value, rest: this.#text.slice(this.#pos).trim() };
    }

    #skipSpace(): void {
        while (this.#pos < this.#text.length && /\s/.test(this.#text[this.#pos] ?? '')) {
            this.#pos++;
        }
    }

    #value(depth: number, stops: string): FrontmatterValue {
        if (depth > MAX_DEPTH) {
            throw new FlowError('nesting is too deep');
        }
        this.#skipSpace();
        const char = this.#text[this.#pos];
        if (char === '[') {
            return this.#sequence(depth);
        }
        if (char === '{') {
            return this.#mapping(depth);
        }
        if (char === '"' || char === "'") {
            return this.#quoted();
        }
        return resolveScalar(this.#plain(stops));
    }

    #quoted(): string {
        const close = closingQuote(this.#text.slice(this.#pos));
        if (close < 0) {
            throw new FlowError('unterminated quoted string');
        }
        const raw = this.#text.slice(this.#pos, this.#pos + close + 1);
        this.#pos += close + 1;
        return unquote(raw, this.#onError);
    }

    #plain(stops: string, key = false): string {
        const start = this.#pos;
        while (this.#pos < this.#text.length) {
            const char = this.#text[this.#pos] ?? '';
            if (stops.includes(char)) {
                break;
            }
            // A mapping key ends at a `:` that is followed by a space, a delimiter or the end.
            if (key && char === ':' && /^(?:[\s,}]|)$/.test(this.#text[this.#pos + 1] ?? '')) {
                break;
            }
            this.#pos++;
        }
        return this.#text.slice(start, this.#pos).trim();
    }

    #expect(char: string): void {
        this.#skipSpace();
        if (this.#text[this.#pos] !== char) {
            throw new FlowError(`expected "${char}"`);
        }
        this.#pos++;
    }

    #sequence(depth: number): FrontmatterValue[] {
        this.#pos++;
        const items: FrontmatterValue[] = [];
        for (;;) {
            this.#skipSpace();
            if (this.#text[this.#pos] === ']') {
                this.#pos++;
                return items;
            }
            items.push(this.#value(depth + 1, ',]'));
            this.#skipSpace();
            if (this.#text[this.#pos] === ',') {
                this.#pos++;
            } else {
                this.#expect(']');
                return items;
            }
        }
    }

    #mapping(depth: number): FrontmatterMap {
        this.#pos++;
        const entries = new Map<string, FrontmatterValue>();
        for (;;) {
            this.#skipSpace();
            if (this.#text[this.#pos] === '}') {
                this.#pos++;
                return Object.fromEntries(entries);
            }
            const char = this.#text[this.#pos];
            const key = char === '"' || char === "'" ? this.#quoted() : this.#plain(',}', true);
            if (key === '') {
                throw new FlowError('expected a key');
            }
            this.#skipSpace();
            let value: FrontmatterValue = null;
            if (this.#text[this.#pos] === ':') {
                this.#pos++;
                this.#skipSpace();
                const next = this.#text[this.#pos];
                value = next === ',' || next === '}' ? null : this.#value(depth + 1, ',}');
            }
            if (entries.has(key)) {
                this.#onError(`duplicate key "${key}"`);
            } else {
                entries.set(key, value);
            }
            this.#skipSpace();
            if (this.#text[this.#pos] === ',') {
                this.#pos++;
            } else {
                this.#expect('}');
                return Object.fromEntries(entries);
            }
        }
    }
}

/** Indentation-driven reader for block mappings and sequences. */
class BlockParser {
    readonly errors: FrontmatterError[] = [];
    readonly #lines: string[];
    readonly #indents: number[];
    readonly #firstLine: number;
    #pos = 0;

    constructor(lines: string[], firstLine: number) {
        this.#lines = lines;
        this.#firstLine = firstLine;
        this.#indents = lines.map((line, index) => {
            const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
            if (leading.includes('\t') && !BLANK_OR_COMMENT.test(line)) {
                this.#error(index, 'tabs are not allowed for indentation');
            }
            return leading.length;
        });
    }

    document(): FrontmatterMap {
        const start = this.#next();
        if (start === undefined) {
            return {};
        }
        const indent = this.#indents[start] ?? 0;
        if (indent > 0) {
            this.#error(start, 'unexpected indentation');
        }
        const value = this.#block(indent, 0);
        for (let index = this.#next(); index !== undefined; index = this.#next()) {
            this.#error(index, 'unexpected content');
            this.#pos++;
        }
        if (!isFrontmatterMap(value)) {
            this.#error(start, 'frontmatter must be a mapping of keys to values');
            return {};
        }
        return value;
    }

    #error(index: number, message: string): void {
        this.errors.push({ line: index + this.#firstLine, message });
    }

    /** Moves to the next line that is neither blank nor a comment and returns its index. */
    #next(): number | undefined {
        while (this.#pos < this.#lines.length) {
            if (!BLANK_OR_COMMENT.test(this.#lines[this.#pos] ?? '')) {
                return this.#pos;
            }
            this.#pos++;
        }
        return undefined;
    }

    #content(index: number): string {
        return (this.#lines[index] ?? '').slice(this.#indents[index] ?? 0);
    }

    /** Parses the node starting at the current line, whose indentation is `indent`. */
    #block(indent: number, depth: number): FrontmatterValue {
        const index = this.#pos;
        if (depth > MAX_DEPTH) {
            this.#error(index, 'nesting is too deep');
            this.#skipDeeper(indent - 1);
            return null;
        }
        const text = this.#content(index);
        if (isSequenceItem(text)) {
            return this.#sequence(indent, depth);
        }
        if (KEY.test(text)) {
            return this.#mapping(indent, depth);
        }
        // A scalar on its own line below its key.
        this.#pos = index + 1;
        return this.#scalar(text, indent - 1, index, depth);
    }

    #skipDeeper(indent: number): void {
        while (this.#pos < this.#lines.length) {
            const line = this.#lines[this.#pos] ?? '';
            if (!BLANK.test(line) && (this.#indents[this.#pos] ?? 0) <= indent) {
                return;
            }
            this.#pos++;
        }
    }

    #mapping(indent: number, depth: number): FrontmatterMap {
        const entries = new Map<string, FrontmatterValue>();
        for (let index = this.#next(); index !== undefined; index = this.#next()) {
            const lineIndent = this.#indents[index] ?? 0;
            if (lineIndent < indent) {
                break;
            }
            const text = this.#content(index);
            const match = lineIndent === indent ? KEY.exec(text) : null;
            if (!match) {
                this.#error(
                    index,
                    lineIndent > indent
                        ? 'unexpected indentation'
                        : isSequenceItem(text)
                          ? 'unexpected list item'
                          : 'expected "key: value"',
                );
                this.#pos++;
                this.#skipDeeper(indent);
                continue;
            }
            const rawKey = match[1] ?? '';
            const key =
                rawKey.startsWith('"') || rawKey.startsWith("'")
                    ? unquote(rawKey, (message) => this.#error(index, message))
                    : rawKey;
            this.#pos = index + 1;
            const value = this.#value(match[2] ?? '', indent, index, depth, true);
            if (entries.has(key)) {
                this.#error(index, `duplicate key "${key}"`);
            } else {
                entries.set(key, value);
            }
        }
        return Object.fromEntries(entries);
    }

    #sequence(indent: number, depth: number): FrontmatterValue[] {
        const items: FrontmatterValue[] = [];
        for (let index = this.#next(); index !== undefined; index = this.#next()) {
            const lineIndent = this.#indents[index] ?? 0;
            if (lineIndent < indent) {
                break;
            }
            const text = this.#content(index);
            if (lineIndent > indent) {
                this.#error(index, 'unexpected indentation');
                this.#pos++;
                continue;
            }
            if (!isSequenceItem(text)) {
                break;
            }
            const after = text.slice(1);
            const spaces = /^[ \t]*/.exec(after)?.[0].length ?? 0;
            const item = after.slice(spaces);
            if (item !== '' && !item.startsWith('#') && (KEY.test(item) || isSequenceItem(item))) {
                // `- key: value` or `- - x`: read the rest of the line as a node at its own column.
                const column = indent + 1 + spaces;
                this.#lines[index] = ' '.repeat(column) + item;
                this.#indents[index] = column;
                this.#pos = index;
                items.push(this.#block(column, depth + 1));
                continue;
            }
            this.#pos = index + 1;
            items.push(this.#value(item, indent, index, depth, false));
        }
        return items;
    }

    /**
     * The value after `key:` or `-`. `parent` is the indentation of the key or dash; nested blocks and
     * continuation lines must be indented deeper. A key's value may also be a sequence at the key's own column.
     */
    #value(rest: string, parent: number, line: number, depth: number, sameColumnSequence: boolean): FrontmatterValue {
        const text = rest.trim();
        if (text === '' || text.startsWith('#')) {
            const next = this.#next();
            if (next === undefined) {
                return null;
            }
            const nextIndent = this.#indents[next] ?? 0;
            if (nextIndent > parent) {
                return this.#block(nextIndent, depth + 1);
            }
            if (sameColumnSequence && nextIndent === parent && isSequenceItem(this.#content(next))) {
                return this.#sequence(parent, depth + 1);
            }
            return null;
        }
        return this.#scalar(text, parent, line, depth);
    }

    #scalar(text: string, parent: number, line: number, depth: number): FrontmatterValue {
        const header = BLOCK_HEADER.exec(text);
        if (header) {
            const chomp = header[2] || header[4] || '';
            const explicit = header[3] ? Number(header[3]) : undefined;
            return this.#blockScalar(header[1] === '>', chomp, explicit, parent);
        }
        const first = text[0];
        if (first === '[' || first === '{') {
            return this.#flow(text, parent, line, depth);
        }
        if (first === '"' || first === "'") {
            return this.#quoted(text, parent, line);
        }
        return this.#plain(text, parent);
    }

    /** Lines after the current one that belong to a multi-line scalar: blank, or deeper than `parent`. */
    #continuation(parent: number, stopAtComment: boolean): string[] {
        const lines: string[] = [];
        let pending = 0;
        while (this.#pos < this.#lines.length) {
            const line = this.#lines[this.#pos] ?? '';
            if (BLANK.test(line)) {
                pending++;
                this.#pos++;
                continue;
            }
            if ((this.#indents[this.#pos] ?? 0) <= parent || (stopAtComment && /^[ \t]*#/.test(line))) {
                break;
            }
            for (; pending > 0; pending--) {
                lines.push('');
            }
            lines.push(line.trim());
            this.#pos++;
        }
        return lines;
    }

    #plain(text: string, parent: number): FrontmatterValue {
        const head = stripComment(text);
        const more = this.#continuation(parent, true).map((line) => (line === '' ? '' : stripComment(line)));
        return more.length === 0 ? resolveScalar(head) : foldLines([head, ...more]);
    }

    #quoted(text: string, parent: number, line: number): FrontmatterValue {
        let joined = text;
        let close = closingQuote(joined);
        while (close < 0 && this.#pos < this.#lines.length) {
            const next = this.#lines[this.#pos] ?? '';
            if (!BLANK.test(next) && (this.#indents[this.#pos] ?? 0) <= parent) {
                break;
            }
            joined += `\n${next.trim()}`;
            this.#pos++;
            close = closingQuote(joined);
        }
        if (close < 0) {
            this.#error(line, 'unterminated quoted string');
            return joined.slice(1);
        }
        const rest = joined.slice(close + 1).trim();
        if (rest !== '' && !rest.startsWith('#')) {
            this.#error(line, 'unexpected text after a quoted string');
        }
        const quote = joined[0] ?? '"';
        const folded = foldLines(joined.slice(1, close).split('\n'));
        return unquote(`${quote}${folded}${quote}`, (message) => this.#error(line, message));
    }

    #flow(text: string, parent: number, line: number, depth: number): FrontmatterValue {
        let joined = text;
        while (!flowBalanced(joined) && this.#pos < this.#lines.length) {
            const next = this.#lines[this.#pos] ?? '';
            if (!BLANK.test(next) && (this.#indents[this.#pos] ?? 0) <= parent) {
                break;
            }
            joined += ` ${next.trim()}`;
            this.#pos++;
        }
        try {
            const parser = new FlowParser(joined, (message) => this.#error(line, message));
            if (depth > MAX_DEPTH) {
                throw new FlowError('nesting is too deep');
            }
            const { value, rest } = parser.parse();
            if (rest !== '' && !rest.startsWith('#')) {
                this.#error(line, 'unexpected text after a flow collection');
            }
            return value;
        } catch (error) {
            if (!(error instanceof FlowError)) {
                throw error;
            }
            this.#error(line, error.message);
            return null;
        }
    }

    #blockScalar(folded: boolean, chomp: string, explicit: number | undefined, parent: number): string {
        const raw: string[] = [];
        while (this.#pos < this.#lines.length) {
            const line = this.#lines[this.#pos] ?? '';
            if (!BLANK.test(line) && (this.#indents[this.#pos] ?? 0) <= parent) {
                break;
            }
            raw.push(line);
            this.#pos++;
        }
        const firstContent = raw.find((line) => !BLANK.test(line));
        const indent =
            explicit !== undefined
                ? Math.max(parent, 0) + explicit
                : firstContent === undefined
                  ? 0
                  : (/^ */.exec(firstContent)?.[0].length ?? 0);
        const lines = raw.map((line) =>
            BLANK.test(line) ? '' : line.slice(Math.min(indent, /^ */.exec(line)?.[0].length ?? 0)),
        );
        let end = lines.length;
        while (end > 0 && lines[end - 1] === '') {
            end--;
        }
        const content = lines.slice(0, end);
        const trailing = lines.length - end;
        if (content.length === 0) {
            return chomp === '+' ? '\n'.repeat(trailing) : '';
        }
        const value = folded ? foldBlock(content) : content.join('\n');
        if (chomp === '-') {
            return value;
        }
        return chomp === '+' ? `${value}\n${'\n'.repeat(trailing)}` : `${value}\n`;
    }
}

function hasControlCharacters(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
            return true;
        }
    }
    return false;
}

/** Whether `text` can be written without quotes and read back as the same string. */
function isPlainSafe(text: string, inFlow: boolean): boolean {
    if (text === '' || text.trim() !== text || hasControlCharacters(text)) {
        return false;
    }
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text) || text.includes(': ') || text.includes(' #') || text.endsWith(':')) {
        return false;
    }
    if (inFlow && /[,[\]{}]/.test(text)) {
        return false;
    }
    return resolveScalar(text) === text;
}

function renderScalar(value: string | number | boolean | null, inFlow: boolean): string {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    }
    if (typeof value === 'boolean') {
        return String(value);
    }
    return isPlainSafe(value, inFlow) ? value : JSON.stringify(value);
}

function renderKey(key: string): string {
    return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
}

type Scalar = string | number | boolean | null;

function isScalar(value: FrontmatterValue): value is Scalar {
    return value === null || typeof value !== 'object';
}

function renderNode(key: string, value: FrontmatterValue, indent: number): string[] {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return [`${pad}${key}: []`];
        }
        if (value.every(isScalar)) {
            const inline = `${pad}${key}: [${value.map((item) => renderScalar(item, true)).join(', ')}]`;
            if (inline.length <= 100) {
                return [inline];
            }
        }
        return [`${pad}${key}:`, ...renderSequence(value, indent + 2)];
    }
    if (isFrontmatterMap(value)) {
        const entries = Object.entries(value);
        return entries.length === 0 ? [`${pad}${key}: {}`] : [`${pad}${key}:`, ...renderMapping(value, indent + 2)];
    }
    return [`${pad}${key}: ${renderScalar(value, false)}`];
}

function renderMapping(map: Readonly<Record<string, FrontmatterValue | undefined>>, indent: number): string[] {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(map)) {
        if (value !== undefined) {
            lines.push(...renderNode(renderKey(key), value, indent));
        }
    }
    return lines;
}

function renderSequence(items: readonly FrontmatterValue[], indent: number): string[] {
    const pad = ' '.repeat(indent);
    const lines: string[] = [];
    for (const item of items) {
        if (isScalar(item)) {
            lines.push(`${pad}- ${renderScalar(item, false)}`);
            continue;
        }
        const nested = Array.isArray(item) ? renderSequence(item, indent + 2) : renderMapping(item, indent + 2);
        const [first, ...rest] = nested;
        if (first === undefined) {
            lines.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`);
        } else {
            lines.push(`${pad}- ${first.trimStart()}`, ...rest);
        }
    }
    return lines;
}

/**
 * Renders `data` as a frontmatter block followed by `body`. Keys whose value is `undefined` are left out; strings
 * are quoted only when they would otherwise read back differently.
 */
export function stringifyFrontmatter(data: Readonly<Record<string, FrontmatterValue | undefined>>, body = ''): string {
    const lines = renderMapping(data, 0);
    const head = `---\n${lines.map((line) => `${line}\n`).join('')}---\n`;
    const text = body.replace(/^\n+/, '');
    if (text === '') {
        return head;
    }
    return `${head}\n${text.endsWith('\n') ? text : `${text}\n`}`;
}
