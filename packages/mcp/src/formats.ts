/**
 * Readers for the config formats of other tools: JSON with comments (VS Code) and the part of TOML that
 * `~/.codex/config.toml` uses. Both are lenient: they exist to import settings, not to validate them.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Index of the next character that is not whitespace or a `//` / `/* *\/` comment. */
function skipJsoncTrivia(text: string, from: number): number {
    let i = from;
    while (i < text.length) {
        const char = text[i];
        if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
            i += 1;
        } else if (char === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                i += 1;
            }
        } else if (char === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
        } else {
            break;
        }
    }
    return i;
}

/** JSON plus comments, trailing commas and a byte order mark. Throws `SyntaxError` like `JSON.parse`. */
export function parseJsonc(text: string): unknown {
    let out = '';
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < text.length) {
        const char = text[i] as string;
        if (char === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') {
                j += text[j] === '\\' ? 2 : 1;
            }
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (char === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            out += ' ';
            i = skipJsoncTrivia(text, i);
        } else if (char === ',') {
            const next = skipJsoncTrivia(text, i + 1);
            if (text[next] !== '}' && text[next] !== ']') {
                out += char;
            }
            i += 1;
        } else {
            out += char;
            i += 1;
        }
    }
    return JSON.parse(out);
}

class TomlSyntaxError extends Error {}

export interface TomlResult {
    readonly data: Record<string, unknown>;
    /** Statements that could not be parsed and were skipped, e.g. `line 12: expected =`. */
    readonly warnings: readonly string[];
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
const BARE_VALUE_CHAR = /[A-Za-z0-9_+\-.:]/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
    b: '\b',
    t: '\t',
    n: '\n',
    f: '\f',
    r: '\r',
    e: '\x1b',
    '"': '"',
    '\\': '\\',
};

/**
 * A TOML reader for tables, array tables, dotted keys, all four string forms, numbers, booleans, arrays and inline
 * tables (multi-line ones too). Dates stay strings. A statement it cannot read is skipped with a warning, so an
 * unsupported section elsewhere in the file does not stop the import of `[mcp_servers]`.
 */
export function parseTomlSubset(text: string): TomlResult {
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const root: Record<string, unknown> = {};
    const warnings: string[] = [];
    let pos = 0;
    let line = 1;
    let current = root;

    const peek = (offset = 0): string => src[pos + offset] ?? '';
    const fail = (message: string): never => {
        throw new TomlSyntaxError(message);
    };
    const skipSpaces = (): void => {
        while (peek() === ' ' || peek() === '\t') {
            pos += 1;
        }
    };
    const skipToLineEnd = (): void => {
        while (pos < src.length && peek() !== '\n') {
            pos += 1;
        }
    };
    const skipTrivia = (): void => {
        for (;;) {
            const char = peek();
            if (char === ' ' || char === '\t' || char === '\r') {
                pos += 1;
            } else if (char === '\n') {
                pos += 1;
                line += 1;
            } else if (char === '#') {
                skipToLineEnd();
            } else {
                return;
            }
        }
    };
    const expectLineEnd = (): void => {
        skipSpaces();
        if (peek() === '#') {
            skipToLineEnd();
        }
        if (peek() === '\r') {
            pos += 1;
        }
        if (pos < src.length && peek() !== '\n') {
            fail('expected the end of the line');
        }
    };

    const parseEscape = (): string => {
        const char = peek();
        pos += 1;
        const simple = SIMPLE_ESCAPES[char];
        if (simple !== undefined) {
            return simple;
        }
        const length = char === 'u' ? 4 : char === 'U' ? 8 : char === 'x' ? 2 : 0;
        const hex = src.slice(pos, pos + length);
        if (length === 0 || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) {
            return fail(`invalid escape \\${char}`);
        }
        pos += length;
        const code = Number.parseInt(hex, 16);
        return code > 0x10ffff ? fail('invalid unicode escape') : String.fromCodePoint(code);
    };

    /** Content of a multi-line string after its closing quotes: `""""` closes with one quote of content, and so on. */
    const closeMultiline = (quote: string): string => {
        let count = 0;
        while (peek() === quote) {
            count += 1;
            pos += 1;
        }
        return quote.repeat(Math.min(2, count - 3));
    };

    const skipFirstNewline = (): void => {
        if (peek() === '\n') {
            pos += 1;
            line += 1;
        } else if (peek() === '\r' && peek(1) === '\n') {
            pos += 2;
            line += 1;
        }
    };

    const parseBasicString = (): string => {
        if (src.startsWith('"""', pos)) {
            pos += 3;
            skipFirstNewline();
            let out = '';
            for (;;) {
                if (pos >= src.length) {
                    return fail('unterminated string');
                }
                if (src.startsWith('"""', pos)) {
                    return out + closeMultiline('"');
                }
                const char = peek();
                pos += 1;
                if (char === '\\' && /[ \t\r\n]/.test(peek())) {
                    while (/[ \t\r\n]/.test(peek())) {
                        line += peek() === '\n' ? 1 : 0;
                        pos += 1;
                    }
                } else if (char === '\\') {
                    out += parseEscape();
                } else {
                    line += char === '\n' ? 1 : 0;
                    out += char;
                }
            }
        }
        pos += 1;
        let out = '';
        for (;;) {
            const char = peek();
            if (char === '' || char === '\n') {
                return fail('unterminated string');
            }
            pos += 1;
            if (char === '"') {
                return out;
            }
            out += char === '\\' ? parseEscape() : char;
        }
    };

    const parseLiteralString = (): string => {
        if (src.startsWith("'''", pos)) {
            pos += 3;
            skipFirstNewline();
            const end = src.indexOf("'''", pos);
            if (end === -1) {
                return fail('unterminated string');
            }
            const value = src.slice(pos, end);
            line += value.split('\n').length - 1;
            pos = end;
            return value + closeMultiline("'");
        }
        pos += 1;
        const end = src.indexOf("'", pos);
        const newline = src.indexOf('\n', pos);
        if (end === -1 || (newline !== -1 && newline < end)) {
            return fail('unterminated string');
        }
        const value = src.slice(pos, end);
        pos = end + 1;
        return value;
    };

    const parseKeyPart = (): string => {
        if (peek() === '"') {
            return parseBasicString();
        }
        if (peek() === "'") {
            return parseLiteralString();
        }
        const start = pos;
        while (BARE_KEY_CHAR.test(peek())) {
            pos += 1;
        }
        return start === pos ? fail('expected a key') : src.slice(start, pos);
    };

    const parseKey = (): string[] => {
        const parts = [parseKeyPart()];
        for (;;) {
            skipSpaces();
            if (peek() !== '.') {
                return parts;
            }
            pos += 1;
            skipSpaces();
            parts.push(parseKeyPart());
        }
    };

    const assign = (table: Record<string, unknown>, keys: readonly string[], value: unknown): void => {
        let target = table;
        for (const key of keys.slice(0, -1)) {
            const next = target[key] ?? {};
            if (!isPlainObject(next)) {
                fail(`${key} is not a table`);
            }
            target[key] = next;
            target = next as Record<string, unknown>;
        }
        const last = keys.at(-1) as string;
        if (Object.hasOwn(target, last)) {
            fail(`duplicate key ${last}`);
        }
        target[last] = value;
    };

    const parseBareValue = (): unknown => {
        const start = pos;
        while (pos < src.length && BARE_VALUE_CHAR.test(peek())) {
            pos += 1;
        }
        let token = src.slice(start, pos);
        if (/^\d{4}-\d{2}-\d{2}$/.test(token) && peek() === ' ' && /\d/.test(peek(1))) {
            pos += 1;
            while (pos < src.length && BARE_VALUE_CHAR.test(peek())) {
                pos += 1;
            }
            token = src.slice(start, pos);
        }
        if (token === 'true' || token === 'false') {
            return token === 'true';
        }
        if (/^[+-]?(?:inf|nan)$/.test(token)) {
            return token.endsWith('nan') ? Number.NaN : token.startsWith('-') ? -Infinity : Infinity;
        }
        const digits = token.replace(/_/g, '');
        if (
            /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(digits) ||
            /^0(?:x[0-9a-fA-F]+|o[0-7]+|b[01]+)$/.test(digits)
        ) {
            return Number(digits);
        }
        if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(token)) {
            return token;
        }
        return fail(token === '' ? 'expected a value' : `unsupported value ${token}`);
    };

    const parseValue = (): unknown => {
        const char = peek();
        if (char === '"') {
            return parseBasicString();
        }
        if (char === "'") {
            return parseLiteralString();
        }
        if (char === '[') {
            pos += 1;
            const items: unknown[] = [];
            for (;;) {
                skipTrivia();
                if (peek() === ']') {
                    pos += 1;
                    return items;
                }
                items.push(parseValue());
                skipTrivia();
                if (peek() === ',') {
                    pos += 1;
                } else if (peek() !== ']') {
                    return fail('expected , or ] in an array');
                }
            }
        }
        if (char === '{') {
            pos += 1;
            const table: Record<string, unknown> = {};
            for (;;) {
                skipTrivia();
                if (peek() === '}') {
                    pos += 1;
                    return table;
                }
                const keys = parseKey();
                skipSpaces();
                if (peek() !== '=') {
                    return fail('expected = in an inline table');
                }
                pos += 1;
                skipSpaces();
                assign(table, keys, parseValue());
                skipTrivia();
                if (peek() === ',') {
                    pos += 1;
                } else if (peek() !== '}') {
                    return fail('expected , or } in an inline table');
                }
            }
        }
        return parseBareValue();
    };

    /** The table a `[a.b]` or `[[a.b]]` header selects; a path through an array table follows its last entry. */
    const tableAt = (keys: readonly string[], arrayTable: boolean): Record<string, unknown> => {
        let target = root;
        keys.forEach((key, index) => {
            const existing = target[key];
            if (index === keys.length - 1 && arrayTable) {
                const list = existing ?? [];
                if (!Array.isArray(list)) {
                    fail(`${key} is not an array of tables`);
                }
                const table: Record<string, unknown> = {};
                (list as unknown[]).push(table);
                target[key] = list;
                target = table;
                return;
            }
            const next = Array.isArray(existing) ? existing.at(-1) : (existing ?? {});
            if (!isPlainObject(next)) {
                fail(`${key} is not a table`);
            }
            if (existing === undefined) {
                target[key] = next;
            }
            target = next as Record<string, unknown>;
        });
        return target;
    };

    for (;;) {
        skipTrivia();
        if (pos >= src.length) {
            break;
        }
        const statementLine = line;
        const isHeader = peek() === '[';
        try {
            if (isHeader) {
                const arrayTable = src.startsWith('[[', pos);
                pos += arrayTable ? 2 : 1;
                skipSpaces();
                const keys = parseKey();
                skipSpaces();
                const close = arrayTable ? ']]' : ']';
                if (!src.startsWith(close, pos)) {
                    fail(`expected ${close}`);
                }
                pos += close.length;
                expectLineEnd();
                current = tableAt(keys, arrayTable);
            } else {
                const keys = parseKey();
                skipSpaces();
                if (peek() !== '=') {
                    fail('expected =');
                }
                pos += 1;
                skipSpaces();
                assign(current, keys, parseValue());
                expectLineEnd();
            }
        } catch (error) {
            if (!(error instanceof TomlSyntaxError)) {
                throw error;
            }
            warnings.push(`line ${statementLine}: ${error.message}`);
            skipToLineEnd();
            if (isHeader) {
                // Keys under a header we could not read must not land in the previous table.
                current = {};
            }
        }
    }
    return { data: root, warnings };
}
