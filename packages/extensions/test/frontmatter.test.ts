import { describe, expect, it } from 'vitest';
import { type FrontmatterMap, parseFrontmatter, stringifyFrontmatter } from '../src/index.ts';

function data(yaml: string): FrontmatterMap {
    const parsed = parseFrontmatter(`---\n${yaml}\n---\nbody\n`);
    expect(parsed.errors).toEqual([]);
    return parsed.data;
}

describe('parseFrontmatter', () => {
    it('returns the whole text as body when there is no frontmatter', () => {
        expect(parseFrontmatter('# Title\n\ntext\n')).toEqual({
            data: {},
            body: '# Title\n\ntext\n',
            errors: [],
            present: false,
        });
        // The opening marker must be the first line.
        expect(parseFrontmatter('\n---\nname: x\n---\n').present).toBe(false);
    });

    it('reads scalars with YAML core types', () => {
        expect(
            data(
                [
                    'name: pdf-tools',
                    'plain: hello world',
                    "single: 'it''s \"fine\"'",
                    'double: "tab\\there\\nline \\"q\\" \\u00e9 \\x41"',
                    'int: 42',
                    'negative: -7',
                    'float: 1.5',
                    'hex: 0x1F',
                    'yes: true',
                    'no: False',
                    'nothing: ~',
                    'empty:',
                    'version: "1.0"',
                    'big: 12345678901234567890',
                    'time: 12:30',
                ].join('\n'),
            ),
        ).toEqual({
            name: 'pdf-tools',
            plain: 'hello world',
            single: 'it\'s "fine"',
            double: 'tab\there\nline "q" é A',
            int: 42,
            negative: -7,
            float: 1.5,
            hex: 31,
            yes: true,
            no: false,
            nothing: null,
            empty: null,
            version: '1.0',
            big: '12345678901234567890',
            time: '12:30',
        });
    });

    it('reads flow collections', () => {
        expect(
            data(
                [
                    'tools: [Read, "Grep, Glob", \'Bash(git:*)\']',
                    'empty: []',
                    'trailing: [a, b,]',
                    'nested: {a: 1, b: [x, y], "c d": null, url: https://x.dev/a}',
                    "words: [don't, stop]",
                    'multi: [one,',
                    '  two]',
                ].join('\n'),
            ),
        ).toEqual({
            tools: ['Read', 'Grep, Glob', 'Bash(git:*)'],
            empty: [],
            trailing: ['a', 'b'],
            nested: { a: 1, b: ['x', 'y'], 'c d': null, url: 'https://x.dev/a' },
            words: ["don't", 'stop'],
            multi: ['one', 'two'],
        });
    });

    it('reads block sequences and nested mappings', () => {
        expect(
            data(
                [
                    'tools:',
                    '  - Read',
                    '  - "Bash(git status *)"',
                    'same-column:',
                    '- a',
                    '- b',
                    'metadata:',
                    '  author: example-org',
                    '  version: "1.0"',
                    '  deep:',
                    '    key: value',
                    'servers:',
                    '  - name: one',
                    '    port: 1',
                    '  - name: two',
                    'matrix:',
                    '  - - 1',
                    '    - 2',
                ].join('\n'),
            ),
        ).toEqual({
            tools: ['Read', 'Bash(git status *)'],
            'same-column': ['a', 'b'],
            metadata: { author: 'example-org', version: '1.0', deep: { key: 'value' } },
            servers: [{ name: 'one', port: 1 }, { name: 'two' }],
            matrix: [[1, 2]],
        });
    });

    it('reads block scalars with chomping', () => {
        expect(
            data(
                [
                    'literal: |',
                    '  line one',
                    '    indented',
                    '',
                    '  line three',
                    'folded: >',
                    '  folded',
                    '  text',
                    '',
                    '  next paragraph',
                    'strip: |-',
                    '  no newline',
                    'keep: |+',
                    '  kept',
                    '',
                    'foldStrip: >-',
                    '  a',
                    '  b',
                    'after: done',
                ].join('\n'),
            ),
        ).toEqual({
            literal: 'line one\n  indented\n\nline three\n',
            folded: 'folded text\nnext paragraph\n',
            strip: 'no newline',
            keep: 'kept\n\n',
            foldStrip: 'a b',
            after: 'done',
        });
    });

    it('folds multi-line plain and quoted scalars', () => {
        expect(
            data(
                [
                    'description: Use this skill when the user',
                    '  asks about PDFs',
                    '',
                    '  or forms.',
                    'quoted: "first',
                    '  second"',
                    'value-below:',
                    '  just text',
                ].join('\n'),
            ),
        ).toEqual({
            description: 'Use this skill when the user asks about PDFs\nor forms.',
            quoted: 'first second',
            'value-below': 'just text',
        });
    });

    it('handles comments without touching quoted or embedded hashes', () => {
        expect(
            data(
                [
                    '# a comment line',
                    'a: value # trailing comment',
                    'b: "not # a comment"',
                    'c: C#',
                    'd: https://example.com/page#anchor',
                    '  # indented comment',
                    'e: [x, y] # after flow',
                ].join('\n'),
            ),
        ).toEqual({ a: 'value', b: 'not # a comment', c: 'C#', d: 'https://example.com/page#anchor', e: ['x', 'y'] });
    });

    it('accepts CRLF line endings, a BOM and the ... end marker', () => {
        const parsed = parseFrontmatter('﻿---\r\nname: x\r\ndescription: y\r\n...\r\n\r\n\r\nBody\r\nmore\r\n');
        expect(parsed.data).toEqual({ name: 'x', description: 'y' });
        expect(parsed.body).toBe('Body\nmore\n');
        expect(parsed.present).toBe(true);
    });

    it('reports an unclosed block and keeps the text as body', () => {
        const parsed = parseFrontmatter('---\nname: x\nbody without end\n');
        expect(parsed.present).toBe(false);
        expect(parsed.data).toEqual({});
        expect(parsed.errors).toEqual([{ line: 1, message: 'frontmatter is not closed with ---' }]);
    });

    it('reports errors with file line numbers and keeps reading', () => {
        const parsed = parseFrontmatter(
            [
                '---',
                'name: first',
                'name: second',
                'not a key',
                '\tindented: tab',
                'quote: "open',
                'ok: yes',
                '---',
                'body',
            ].join('\n'),
        );
        expect(parsed.data.name).toBe('first');
        expect(parsed.data.ok).toBe('yes');
        expect(parsed.errors.map((error) => error.line)).toEqual(expect.arrayContaining([3, 4, 5, 6]));
        expect(parsed.errors.find((error) => error.line === 3)?.message).toBe('duplicate key "name"');
    });

    it('never evaluates tags, anchors or special keys', () => {
        const parsed = parseFrontmatter(
            [
                '---',
                'a: &anchor value',
                'b: *anchor',
                'c: !!python/object:os.system ls',
                '__proto__: polluted',
                'constructor: x',
                '---',
            ].join('\n'),
        );
        expect(parsed.data).toEqual({
            a: '&anchor value',
            b: '*anchor',
            c: '!!python/object:os.system ls',
            ['__proto__']: 'polluted',
            constructor: 'x',
        });
        expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype);
        expect(Object.hasOwn(parsed.data, '__proto__')).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('stops at an absurd nesting depth instead of recursing without bound', () => {
        const lines = ['---'];
        for (let depth = 0; depth < 40; depth++) {
            lines.push(`${' '.repeat(depth * 2)}k${depth}:`);
        }
        lines.push(`${' '.repeat(80)}leaf: 1`, '---');
        const parsed = parseFrontmatter(lines.join('\n'));
        expect(parsed.errors.some((error) => error.message === 'nesting is too deep')).toBe(true);
        expect(parseFrontmatter(`---\nx: ${'['.repeat(40)}${']'.repeat(40)}\n---\n`).errors).toEqual([
            { line: 2, message: 'nesting is too deep' },
        ]);
    });
});

describe('stringifyFrontmatter', () => {
    it('round-trips through the parser', () => {
        const original: FrontmatterMap = {
            name: 'pdf-tools',
            description: 'Extract text: tables, forms # and more',
            plainWord: 'hello',
            looksBoolean: 'true',
            looksNumber: '1.0',
            leadingDash: '- item',
            empty: '',
            multiline: 'line one\nline two\n',
            unicode: '中文说明，带“引号”',
            quotes: `it's "quoted"`,
            count: 3,
            ratio: 0.5,
            enabled: false,
            nothing: null,
            tools: ['Read', 'Bash(git status *)', 'a, b'],
            long: Array.from({ length: 20 }, (_, index) => `tool-number-${index}`),
            metadata: { author: 'example-org', version: '1.0' },
            items: [{ name: 'one', port: 1 }, ['x', 'y'], 'plain'],
            emptyList: [],
            emptyMap: {},
            'odd key': 'v',
        };
        const text = stringifyFrontmatter(original, 'Body text');
        const parsed = parseFrontmatter(text);
        expect(parsed.errors).toEqual([]);
        expect(parsed.data).toEqual(original);
        expect(parsed.body).toBe('Body text\n');
    });

    it('leaves out undefined values and writes simple strings without quotes', () => {
        expect(stringifyFrontmatter({ name: 'x', skip: undefined, tools: ['Read', 'Grep'] }, '')).toBe(
            '---\nname: x\ntools: [Read, Grep]\n---\n',
        );
    });
});
