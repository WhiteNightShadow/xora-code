import { utimes } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGrepTool, findRipgrep, GREP_MAX_FILE_BYTES } from '../src/index.ts';
import { isRipgrep } from '../src/ripgrep.ts';
import { makeContext, runTool, temporaryDir, writeFiles } from './helpers.ts';

const jsGrep = createGrepTool({ ripgrep: false });

const PROJECT: Readonly<Record<string, string | Uint8Array>> = {
    '.gitignore': 'ignored.txt\nbuild/\n',
    'a.ts': 'alpha foo\nbeta\ngamma Foo\n',
    'a/b.ts': 'foo in nested\n',
    'a.txt': 'foo text\r\nbar\r\n',
    'ignored.txt': 'foo ignored\n',
    'build/out.ts': 'foo built\n',
    'sub/.gitignore': '*.log\n',
    'sub/x.log': 'foo log\n',
    'sub/y.ts': 'line1\nline2\nfoo\nline4\nline5\nline6\nline7\nfoo again\nline9\n',
    '.hidden/h.ts': 'foo hidden\n',
    'node_modules/m/i.js': 'foo module\n',
    '.git/config': 'foo git\n',
    'bin.dat': Buffer.from('\0binary foo\n'),
    'big.txt': `${'x'.repeat(GREP_MAX_FILE_BYTES - 4)}foo\n`,
    'too-big.txt': `${'x'.repeat(GREP_MAX_FILE_BYTES)}foo\n`,
};

async function project() {
    const root = await temporaryDir();
    await writeFiles(root, PROJECT);
    return { root, ctx: await makeContext(root) };
}

describe('grep (JavaScript engine)', () => {
    it('lists matching files, most recently modified first, honouring ignore rules', async () => {
        const { root, ctx } = await project();
        let time = 1_000_000;
        for (const file of ['a/b.ts', 'a.ts', 'a.txt', 'big.txt', 'sub/y.ts', '.hidden/h.ts']) {
            time += 10;
            await utimes(path.join(root, ...file.split('/')), time, time);
        }
        const result = await runTool(jsGrep, { pattern: 'foo' }, ctx);
        expect(result.content).toBe(['.hidden/h.ts', 'sub/y.ts', 'big.txt', 'a.txt', 'a.ts', 'a/b.ts'].join('\n'));
        expect(result.display).toEqual({ kind: 'matches', count: 6, files: 6, truncated: false });
    });

    it('shows matching lines with numbers, and context separated by --', async () => {
        const { ctx } = await project();
        const content = await runTool(jsGrep, { pattern: 'foo', path: 'sub', outputMode: 'content' }, ctx);
        expect(content.content).toBe('sub/y.ts:3:foo\nsub/y.ts:8:foo again');
        const context = await runTool(jsGrep, { pattern: 'foo', path: 'sub', outputMode: 'content', context: 1 }, ctx);
        expect(context.content).toBe(
            [
                'sub/y.ts-2-line2',
                'sub/y.ts:3:foo',
                'sub/y.ts-4-line4',
                '--',
                'sub/y.ts-7-line7',
                'sub/y.ts:8:foo again',
                'sub/y.ts-9-line9',
            ].join('\n'),
        );
        const merged = await runTool(jsGrep, { pattern: 'foo', path: 'sub', outputMode: 'content', context: 3 }, ctx);
        expect(merged.content).not.toContain('--');
        expect(merged.content.split('\n')).toHaveLength(9);
    });

    it('counts matching lines per file', async () => {
        const { ctx } = await project();
        const result = await runTool(jsGrep, { pattern: 'foo', outputMode: 'count', glob: '*.ts' }, ctx);
        expect(result.content).toBe(
            ['.hidden/h.ts:1', 'a/b.ts:1', 'a.ts:1', 'sub/y.ts:2', '', '5 matching lines in 4 files.'].join('\n'),
        );
    });

    it('matches case-insensitively when asked, also with an inline (?i)', async () => {
        const { ctx } = await project();
        const plain = await runTool(jsGrep, { pattern: 'foo', path: 'a.ts', outputMode: 'content' }, ctx);
        expect(plain.content).toBe('a.ts:1:alpha foo');
        const folded = await runTool(
            jsGrep,
            { pattern: 'foo', path: 'a.ts', outputMode: 'content', ignoreCase: true },
            ctx,
        );
        expect(folded.content).toBe('a.ts:1:alpha foo\na.ts:3:gamma Foo');
        const inline = await runTool(jsGrep, { pattern: '(?i)FOO', path: 'a.ts', outputMode: 'count' }, ctx);
        expect(inline.content.split('\n')[0]).toBe('a.ts:2');
    });

    it('filters by glob relative to the search path', async () => {
        const { ctx } = await project();
        const result = await runTool(jsGrep, { pattern: 'foo', glob: 'a/*.ts', outputMode: 'count' }, ctx);
        expect(result.content.split('\n')[0]).toBe('a/b.ts:1');
        const braces = await runTool(jsGrep, { pattern: 'foo', glob: '*.{txt,log}', outputMode: 'count' }, ctx);
        expect(braces.content.split('\n').slice(0, 2)).toEqual(['a.txt:1', 'big.txt:1']);
    });

    it('caps output at headLimit and says so', async () => {
        const { ctx } = await project();
        const result = await runTool(jsGrep, { pattern: 'foo', outputMode: 'content', headLimit: 2 }, ctx);
        expect(result.content.split('\n').slice(0, 2)).toEqual(['.hidden/h.ts:1:foo hidden', 'a/b.ts:1:foo in nested']);
        expect(result.content).toContain('(Showing the first 2 lines; there are more matches.)');
        expect(result.display).toMatchObject({ truncated: true });
    });

    it('strips CR from displayed lines but matches the raw line like ripgrep', async () => {
        const { ctx } = await project();
        const result = await runTool(jsGrep, { pattern: 'foo text', path: 'a.txt', outputMode: 'content' }, ctx);
        expect(result.content).toBe('a.txt:1:foo text');
        const anchored = await runTool(jsGrep, { pattern: 'foo text$', path: 'a.txt' }, ctx);
        expect(anchored.content).toBe('No matches for foo text$ in a.txt.');
    });

    it('supports JavaScript-only syntax such as look-ahead', async () => {
        const { ctx } = await project();
        const result = await runTool(jsGrep, { pattern: 'foo(?= again)', path: 'sub', outputMode: 'content' }, ctx);
        expect(result.content).toBe('sub/y.ts:8:foo again');
    });

    it('reports invalid patterns and missing paths', async () => {
        const { ctx } = await project();
        const invalid = await runTool(jsGrep, { pattern: 'foo(' }, ctx);
        expect(invalid.isError).toBe(true);
        expect(invalid.content).toContain('Invalid regular expression foo(');
        const missing = await runTool(jsGrep, { pattern: 'x', path: 'nope' }, ctx);
        expect(missing).toMatchObject({ isError: true, content: 'Path not found: nope' });
        const none = await runTool(jsGrep, { pattern: 'zzz' }, ctx);
        expect(none).toMatchObject({ content: 'No matches for zzz in the working directory.' });
        expect(none.isError).toBeUndefined();
    });

    it('cuts very long matching lines', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'min.js': `${'a'.repeat(3000)}needle\n` });
        const result = await runTool(jsGrep, { pattern: 'needle', outputMode: 'content' }, await makeContext(root));
        expect(result.content).toBe(`min.js:1:${'a'.repeat(500)} [... 2506 characters truncated]`);
    });

    it('describes itself and its targets', async () => {
        const { root } = await project();
        expect(jsGrep.targets({ pattern: 'x', path: 'sub' }, { cwd: root })).toEqual([path.join(root, 'sub')]);
        expect(jsGrep.title({ pattern: 'x', path: 'sub' })).toBe('Search /x/ in sub');
        expect(jsGrep.readOnly).toBe(true);
    });
});

describe('grep with ripgrep', () => {
    let rg: string | null = null;
    beforeAll(async () => {
        const override = process.env.XORA_TEST_RG;
        rg = override !== undefined && override !== '' && (await isRipgrep(override)) ? override : await findRipgrep();
    });

    const QUERIES: ReadonlyArray<Record<string, unknown>> = [
        { pattern: 'foo' },
        { pattern: 'foo', outputMode: 'content' },
        { pattern: 'foo', outputMode: 'content', context: 1 },
        { pattern: 'foo', outputMode: 'content', context: 3, path: 'sub' },
        { pattern: 'foo', outputMode: 'count' },
        { pattern: 'FOO', ignoreCase: true, outputMode: 'content' },
        { pattern: 'foo', glob: '*.ts', outputMode: 'count' },
        { pattern: 'foo', glob: 'a/*.ts' },
        { pattern: 'foo text$', outputMode: 'content' },
        { pattern: '^line\\d$', outputMode: 'content', headLimit: 3 },
        { pattern: 'foo', outputMode: 'count', headLimit: 2 },
        { pattern: 'nothing-matches-this' },
        { pattern: 'foo(?= again)', outputMode: 'content' },
    ];

    it('gives the same results as the JavaScript engine', async (context) => {
        if (rg === null) {
            context.skip();
            return;
        }
        const { root, ctx } = await project();
        let time = 2_000_000;
        for (const file of ['a/b.ts', 'a.ts', 'a.txt', 'big.txt', 'sub/y.ts', '.hidden/h.ts']) {
            time += 10;
            await utimes(path.join(root, ...file.split('/')), time, time);
        }
        const rgGrep = createGrepTool({ ripgrep: rg });
        for (const query of QUERIES) {
            const viaJs = await runTool(jsGrep, query, ctx);
            const viaRg = await runTool(rgGrep, query, ctx);
            expect(viaRg, JSON.stringify(query)).toEqual(viaJs);
        }
        // Proof that ripgrep really ran: its extended mode `(?x)` is not JavaScript syntax.
        for (const outputMode of ['files_with_matches', 'count', 'content'] as const) {
            const extended = await runTool(rgGrep, { pattern: '(?x) f o o', outputMode }, ctx);
            const plain = await runTool(jsGrep, { pattern: 'foo', outputMode }, ctx);
            expect(extended.content, outputMode).toBe(plain.content);
        }
        expect((await runTool(jsGrep, { pattern: '(?x) f o o' }, ctx)).isError).toBe(true);
    });
});
