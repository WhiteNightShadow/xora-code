import { chmod, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatchTool, parsePatch } from '../src/index.ts';
import { seekSequence } from '../src/tools/apply-patch.ts';
import { isWindows, makeContext, runTool, temporaryDir, writeFiles } from './helpers.ts';

const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

async function setup(files: Readonly<Record<string, string>> = {}) {
    const root = await temporaryDir();
    await writeFiles(root, files);
    const read = (name: string): Promise<string | null> =>
        readFile(path.join(root, ...name.split('/')), 'utf8').catch(() => null);
    return { root, ctx: await makeContext(root), read };
}

describe('parsePatch', () => {
    it('parses every kind of operation', () => {
        const parsed = parsePatch(
            patch(
                '*** Add File: docs/new.md',
                '+# Title',
                '+',
                '*** Delete File: old.txt',
                '*** Update File: src/app.ts',
                '*** Move to: src/main.ts',
                '@@ class App',
                '@@     start() {',
                ' context',
                '-old',
                '+new',
                '@@',
                ' tail',
                '+appended',
                '*** End of File',
            ),
        );
        expect(parsed).toEqual({
            ok: true,
            operations: [
                { type: 'add', path: 'docs/new.md', content: '# Title\n\n' },
                { type: 'delete', path: 'old.txt' },
                {
                    type: 'update',
                    path: 'src/app.ts',
                    moveTo: 'src/main.ts',
                    chunks: [
                        {
                            contexts: ['class App', '    start() {'],
                            oldLines: ['context', 'old'],
                            newLines: ['context', 'new'],
                            endOfFile: false,
                        },
                        { contexts: [], oldLines: ['tail'], newLines: ['tail', 'appended'], endOfFile: true },
                    ],
                },
            ],
        });
    });

    it('ignores text around the patch and accepts CRLF and unified diff headers', () => {
        const wrapped = `apply_patch <<'EOF'\r\n${patch('*** Update File: a.ts', '@@ -1,2 +1,2 @@ function f()', '-a', '+b')}\r\nEOF\r\n`;
        const parsed = parsePatch(wrapped);
        expect(parsed).toMatchObject({
            ok: true,
            operations: [{ type: 'update', path: 'a.ts', chunks: [{ contexts: ['function f()'], oldLines: ['a'] }] }],
        });
    });

    it('explains malformed patches', () => {
        expect(parsePatch('*** Update File: a.ts')).toEqual({
            ok: false,
            error: 'The patch must start with "*** Begin Patch".',
        });
        expect(parsePatch('*** Begin Patch\n*** Add File: a\n+x')).toMatchObject({
            ok: false,
            error: expect.stringContaining('End Patch'),
        });
        expect(parsePatch(patch('*** Rename File: a'))).toMatchObject({
            ok: false,
            error: expect.stringContaining('is not a file operation'),
        });
        expect(parsePatch(patch('*** Update File: a.ts', '@@', 'oops'))).toMatchObject({
            ok: false,
            error: expect.stringContaining('Unexpected line "oops"'),
        });
        expect(parsePatch(patch('*** Update File: a.ts'))).toMatchObject({
            ok: false,
            error: 'The update of a.ts contains no changes.',
        });
        expect(parsePatch(patch())).toMatchObject({ ok: false, error: 'The patch contains no file operations.' });
        expect(parsePatch(patch('*** Delete File: '))).toEqual({
            ok: false,
            error: 'Missing path in "*** Delete File:" (patch line 2).',
        });
        expect(parsePatch(patch('*** Update File: a.ts', '*** Move to:  ', '-a', '+b'))).toMatchObject({
            ok: false,
            error: expect.stringContaining('Missing path in "*** Move to:"'),
        });
    });
});

describe('seekSequence', () => {
    const lines = ['alpha', '  beta  ', 'gamma', 'delta – “quoted”', 'beta'];
    it('tries exact, then trailing whitespace, then surrounding whitespace, then punctuation', () => {
        expect(seekSequence(lines, ['beta'], 0, false)).toBe(4);
        expect(seekSequence(lines, ['  beta'], 0, false)).toBe(1);
        expect(seekSequence(lines, ['beta', 'gamma'], 0, false)).toBe(1);
        expect(seekSequence(lines, ['delta - "quoted"'], 0, false)).toBe(3);
        expect(seekSequence(lines, ['epsilon'], 0, false)).toBeNull();
        expect(seekSequence(lines, ['alpha'], 1, false)).toBeNull();
        expect(seekSequence(lines, [], 2, false)).toBe(2);
    });

    it('prefers the end of the file for end-of-file chunks', () => {
        expect(seekSequence(['x', 'y', 'x'], ['x'], 0, true)).toBe(2);
        expect(seekSequence(['x', 'y', 'z'], ['x'], 0, true)).toBe(0);
    });
});

describe('apply_patch', () => {
    it('adds, updates, deletes and moves files in one step', async () => {
        const { root, ctx, read } = await setup({
            'src/app.ts': 'import a from "a";\n\nexport function start() {\n    return 1;\n}\n',
            'old.txt': 'obsolete\n',
            'legacy/name.ts': 'export const name = "x";\n',
        });
        const result = await runTool(
            applyPatchTool,
            {
                patch: patch(
                    '*** Add File: docs/guide.md',
                    '+# Guide',
                    '+Welcome.',
                    '*** Update File: src/app.ts',
                    '@@ export function start() {',
                    '-    return 1;',
                    '+    return 2;',
                    ' }',
                    '*** Delete File: old.txt',
                    '*** Update File: legacy/name.ts',
                    '*** Move to: src/name.ts',
                    '-export const name = "x";',
                    '+export const name = "y";',
                ),
            },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe(
            'Success. Updated the following files:\nA docs/guide.md\nM src/app.ts\nD old.txt\nM src/name.ts (moved from legacy/name.ts)',
        );
        expect(await read('docs/guide.md')).toBe('# Guide\nWelcome.\n');
        expect(await read('src/app.ts')).toBe('import a from "a";\n\nexport function start() {\n    return 2;\n}\n');
        expect(await read('old.txt')).toBeNull();
        expect(await read('legacy/name.ts')).toBeNull();
        expect(await read('src/name.ts')).toBe('export const name = "y";\n');
        expect(result.display).toEqual({
            kind: 'diff',
            diffs: [
                { path: path.join(root, 'docs', 'guide.md'), oldText: null, newText: '# Guide\nWelcome.\n' },
                {
                    path: path.join(root, 'src', 'app.ts'),
                    oldText: 'import a from "a";\n\nexport function start() {\n    return 1;\n}\n',
                    newText: 'import a from "a";\n\nexport function start() {\n    return 2;\n}\n',
                },
                { path: path.join(root, 'old.txt'), oldText: 'obsolete\n', newText: '', deleted: true },
                {
                    path: path.join(root, 'src', 'name.ts'),
                    oldText: 'export const name = "x";\n',
                    newText: 'export const name = "y";\n',
                    movedFrom: path.join(root, 'legacy', 'name.ts'),
                },
            ],
        });
    });

    it('lists every touched path, move destinations included, as targets', async () => {
        const { root } = await setup();
        const input = {
            patch: patch(
                '*** Delete File: a.ts',
                '*** Update File: b.ts',
                '*** Move to: ../outside/b.ts',
                '@@',
                '-x',
                '+y',
            ),
        };
        expect(applyPatchTool.targets(input, { cwd: root })).toEqual([
            path.join(root, 'a.ts'),
            path.join(root, 'b.ts'),
            path.resolve(root, '..', 'outside', 'b.ts'),
        ]);
        expect(applyPatchTool.targets({ patch: 'garbage' }, { cwd: root })).toEqual([]);
        expect(applyPatchTool.title(input)).toBe('Patch a.ts, b.ts');
    });

    it('changes nothing when any part does not apply', async () => {
        const files = { 'a.ts': 'one\ntwo\n', 'b.ts': 'three\nfour\n' };
        const { ctx, read } = await setup(files);
        const result = await runTool(
            applyPatchTool,
            {
                patch: patch(
                    '*** Update File: a.ts',
                    '-one',
                    '+ONE',
                    '*** Add File: c.ts',
                    '+new',
                    '*** Update File: b.ts',
                    '-five',
                    '+FIVE',
                ),
            },
            ctx,
        );
        expect(result.isError).toBe(true);
        expect(result.content).toBe(
            'The patch does not apply: Could not find the lines to change in b.ts:\nfive\nNo files were changed.',
        );
        expect(await read('a.ts')).toBe(files['a.ts']);
        expect(await read('b.ts')).toBe(files['b.ts']);
        expect(await read('c.ts')).toBeNull();
    });

    it('refuses to add over an existing file, delete a missing one or move onto another file', async () => {
        const { ctx } = await setup({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
        const add = await runTool(applyPatchTool, { patch: patch('*** Add File: a.ts', '+x') }, ctx);
        expect(add.content).toContain('Cannot add a.ts: it already exists.');
        const remove = await runTool(applyPatchTool, { patch: patch('*** Delete File: zzz.ts') }, ctx);
        expect(remove.content).toContain('Cannot delete zzz.ts: no such file.');
        const move = await runTool(applyPatchTool, { patch: patch('*** Update File: a.ts', '*** Move to: b.ts') }, ctx);
        expect(move.content).toContain('Cannot move a.ts to b.ts: the destination exists.');
        const update = await runTool(applyPatchTool, { patch: patch('*** Update File: nope.ts', '-a', '+b') }, ctx);
        expect(update.content).toContain('Cannot update nope.ts: no such file.');
    });

    it('locates chunks despite whitespace and punctuation differences', async () => {
        const { ctx, read } = await setup({
            'a.py': 'def f():\n    x = 1   \n    return x\n',
            'b.md': 'Use the “fast” path – always.\n',
        });
        const result = await runTool(
            applyPatchTool,
            {
                patch: patch(
                    '*** Update File: a.py',
                    ' def f():',
                    '-  x = 1',
                    '+    x = 2',
                    '     return x',
                    '*** Update File: b.md',
                    '-Use the "fast" path - always.',
                    '+Use the fast path.',
                ),
            },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(await read('a.py')).toBe('def f():\n    x = 2\n    return x\n');
        expect(await read('b.md')).toBe('Use the fast path.\n');
    });

    it('uses @@ lines to pick between identical blocks', async () => {
        const source = [
            'function first() {',
            '    const value = 1;',
            '    return value;',
            '}',
            'function second() {',
            '    const value = 1;',
            '    return value;',
            '}',
            '',
        ].join('\n');
        const { ctx, read } = await setup({ 'a.js': source });
        await runTool(
            applyPatchTool,
            {
                patch: patch(
                    '*** Update File: a.js',
                    '@@ function second() {',
                    '-    const value = 1;',
                    '+    const value = 2;',
                ),
            },
            ctx,
        );
        expect(await read('a.js')).toBe(source.replace(/(second\(\) \{\n {4}const value = )1/, '$12'));
    });

    it('applies several chunks and end-of-file chunks', async () => {
        const { ctx, read } = await setup({ 'list.txt': 'a\nb\nc\nd\ne\nb\n' });
        await runTool(
            applyPatchTool,
            {
                patch: patch(
                    '*** Update File: list.txt',
                    '@@',
                    ' a',
                    '-b',
                    '+B',
                    '@@',
                    ' e',
                    '-b',
                    '+last',
                    '*** End of File',
                ),
            },
            ctx,
        );
        expect(await read('list.txt')).toBe('a\nB\nc\nd\ne\nlast\n');
    });

    it('inserts additions after the @@ line, or at the end without one', async () => {
        const { ctx, read } = await setup({ 'a.txt': 'head\nmiddle\nend\n', 'b.txt': 'one\n' });
        await runTool(
            applyPatchTool,
            { patch: patch('*** Update File: a.txt', '@@ head', '+inserted', '*** Update File: b.txt', '+two') },
            ctx,
        );
        expect(await read('a.txt')).toBe('head\ninserted\nmiddle\nend\n');
        expect(await read('b.txt')).toBe('one\ntwo\n');
    });

    it('keeps CRLF line endings and a missing final line break', async () => {
        const { ctx, read } = await setup({ 'win.txt': 'one\r\ntwo\r\n', 'nofinal.txt': 'x\ny' });
        await runTool(
            applyPatchTool,
            {
                patch: patch(
                    '*** Update File: win.txt',
                    ' one',
                    '-two',
                    '+2',
                    '+3',
                    '*** Update File: nofinal.txt',
                    '-y',
                    '+z',
                ),
            },
            ctx,
        );
        expect(await read('win.txt')).toBe('one\r\n2\r\n3\r\n');
        expect(await read('nofinal.txt')).toBe('x\nz');
    });

    it('reports a missing @@ context line', async () => {
        const { ctx } = await setup({ 'a.ts': 'x\n' });
        const result = await runTool(
            applyPatchTool,
            { patch: patch('*** Update File: a.ts', '@@ function missing()', '-x', '+y') },
            ctx,
        );
        expect(result.content).toBe(
            'The patch does not apply: Could not find the @@ line "function missing()" in a.ts.\nNo files were changed.',
        );
    });

    it('rejects invalid patches before touching anything', async () => {
        const { ctx } = await setup();
        const result = await runTool(applyPatchTool, { patch: 'diff --git a/x b/x' }, ctx);
        expect(result).toMatchObject({
            isError: true,
            content: 'Invalid patch: The patch must start with "*** Begin Patch".',
        });
    });

    it.skipIf(isWindows)('keeps the permission bits of moved and updated files', async () => {
        const { root, ctx } = await setup({ 'run.sh': '#!/bin/sh\necho 1\n' });
        await chmod(path.join(root, 'run.sh'), 0o755);
        await runTool(
            applyPatchTool,
            { patch: patch('*** Update File: run.sh', '*** Move to: bin/run.sh', '-echo 1', '+echo 2') },
            ctx,
        );
        expect((await stat(path.join(root, 'bin', 'run.sh'))).mode & 0o777).toBe(0o755);
    });
});
