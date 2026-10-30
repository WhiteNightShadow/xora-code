import { describe, expect, it } from 'vitest';
import { parseJsonc, parseTomlSubset } from '../src/index.ts';

describe('parseJsonc', () => {
    it('accepts comments, trailing commas and a byte order mark', () => {
        const text = `\uFEFF{
            // line comment
            "servers": { /* block */ "a": { "args": ["x", "y",], }, },
            "url": "http://example.com//not-a-comment", "text": "a,}b /* no */",
        }`;
        expect(parseJsonc(text)).toEqual({
            servers: { a: { args: ['x', 'y'] } },
            url: 'http://example.com//not-a-comment',
            text: 'a,}b /* no */',
        });
    });

    it('keeps escaped quotes inside strings and still rejects broken JSON', () => {
        expect(parseJsonc('{"a": "say \\"hi\\" // ok"}')).toEqual({ a: 'say "hi" // ok' });
        expect(() => parseJsonc('{"a": }')).toThrow(SyntaxError);
    });
});

describe('parseTomlSubset', () => {
    it('reads tables, dotted keys, strings, numbers, booleans, arrays and inline tables', () => {
        const { data, warnings } = parseTomlSubset(`
# top comment
title = "Codex \\"config\\"" # trailing comment
path = 'C:\\Users\\me'
count = 1_000
negative = -42
ratio = 0.5
hex = 0xff
enabled = true
when = 1979-05-27T07:32:00Z
day = 1979-05-27 07:32:00
site.name = "dotted"

[mcp_servers."my server"]
command = "npx"
args = [
  "-y", # package
  "@scope/pkg",
]
env = { "API_KEY" = "secret", nested = { deep = 1 } }

[mcp_servers.other.env]
A = "1"
`);
        expect(warnings).toEqual([]);
        expect(data).toEqual({
            title: 'Codex "config"',
            path: 'C:\\Users\\me',
            count: 1000,
            negative: -42,
            ratio: 0.5,
            hex: 255,
            enabled: true,
            when: '1979-05-27T07:32:00Z',
            day: '1979-05-27 07:32:00',
            site: { name: 'dotted' },
            mcp_servers: {
                'my server': {
                    command: 'npx',
                    args: ['-y', '@scope/pkg'],
                    env: { API_KEY: 'secret', nested: { deep: 1 } },
                },
                other: { env: { A: '1' } },
            },
        });
    });

    it('reads multi-line and escaped strings', () => {
        const { data } = parseTomlSubset(
            [
                'basic = """',
                'line one',
                'line \\',
                '   two"""',
                "literal = '''",
                'raw \\n text',
                "'''",
                'unicode = "\\u4f60\\U0001F600\\t"',
                'quotes = """say ""hi"""""',
            ].join('\n'),
        );
        expect(data).toEqual({
            basic: 'line one\nline two',
            literal: 'raw \\n text\n',
            unicode: '你😀\t',
            quotes: 'say ""hi""',
        });
    });

    it('reads arrays of tables', () => {
        const { data } = parseTomlSubset(
            '[[fruit]]\nname = "apple"\n[fruit.color]\nhex = "f00"\n[[fruit]]\nname = "pear"\n',
        );
        expect(data).toEqual({ fruit: [{ name: 'apple', color: { hex: 'f00' } }, { name: 'pear' }] });
    });

    it('skips statements it cannot read and keeps going', () => {
        const { data, warnings } = parseTomlSubset(
            [
                'good = 1',
                'this is not toml',
                'dup = 1',
                'dup = 2',
                'unterminated = "oops',
                '[broken',
                'lost = true',
                '[mcp_servers.ok]',
                'command = "uvx"',
            ].join('\n'),
        );
        expect(data).toEqual({ good: 1, dup: 1, mcp_servers: { ok: { command: 'uvx' } } });
        expect(warnings).toEqual([
            'line 2: expected =',
            'line 4: duplicate key dup',
            'line 5: unterminated string',
            'line 6: expected ]',
        ]);
    });
});
