import { chmod, lstat, mkdir, readdir, readFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, editTool, multiEditTool, writeTool } from '../src/index.ts';
import { isWindows, makeContext, runTool, temporaryDir, writeFiles } from './helpers.ts';

async function setup(files: Readonly<Record<string, string | Uint8Array>> = {}) {
    const root = await temporaryDir();
    await writeFiles(root, files);
    return { root, ctx: await makeContext(root), text: (name: string) => readFile(path.join(root, name), 'utf8') };
}

describe('write', () => {
    it('creates files and their parent directories', async () => {
        const { root, ctx, text } = await setup();
        const result = await runTool(writeTool, { path: 'deep/new/file.ts', content: 'a\nb\n' }, ctx);
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe('Created deep/new/file.ts (2 lines).');
        expect(await text('deep/new/file.ts')).toBe('a\nb\n');
        expect(result.display).toEqual({
            kind: 'diff',
            diffs: [{ path: path.join(root, 'deep', 'new', 'file.ts'), oldText: null, newText: 'a\nb\n' }],
        });
    });

    it('replaces content atomically, leaving no temporary files', async () => {
        const { root, ctx, text } = await setup({ 'a.txt': 'old\n' });
        const result = await runTool(writeTool, { path: 'a.txt', content: 'new\n' }, ctx);
        expect(result.content).toBe('Replaced the content of a.txt (1 line).');
        expect(result.display).toMatchObject({ diffs: [{ oldText: 'old\n', newText: 'new\n' }] });
        expect(await text('a.txt')).toBe('new\n');
        expect(await readdir(root)).toEqual(['a.txt']);
    });

    it('keeps CRLF line endings and the byte order mark of an existing file', async () => {
        const { root, ctx } = await setup({ 'win.txt': '﻿one\r\ntwo\r\n' });
        await runTool(writeTool, { path: 'win.txt', content: 'three\nfour\n' }, ctx);
        const bytes = await readFile(path.join(root, 'win.txt'));
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.subarray(3).toString('utf8')).toBe('three\r\nfour\r\n');
    });

    it('reports identical content without writing', async () => {
        const { ctx } = await setup({ 'a.txt': 'same\n' });
        const result = await runTool(writeTool, { path: 'a.txt', content: 'same\n' }, ctx);
        expect(result.content).toBe('a.txt already has exactly this content; nothing was written.');
    });

    it('refuses to write over a directory', async () => {
        const { root, ctx } = await setup();
        await mkdir(path.join(root, 'dir'));
        const result = await runTool(writeTool, { path: 'dir', content: 'x' }, ctx);
        expect(result).toMatchObject({ isError: true, content: 'dir is a directory, not a file.' });
    });

    it.skipIf(isWindows)('keeps the permission bits of an existing file', async () => {
        const { root, ctx } = await setup({ 'run.sh': '#!/bin/sh\n' });
        await chmod(path.join(root, 'run.sh'), 0o755);
        await runTool(writeTool, { path: 'run.sh', content: '#!/bin/sh\necho hi\n' }, ctx);
        expect((await stat(path.join(root, 'run.sh'))).mode & 0o777).toBe(0o755);
    });

    it.skipIf(isWindows)('writes through symbolic links and keeps them links', async () => {
        const { root, ctx, text } = await setup({ 'AGENTS.md': 'old\n' });
        await symlink(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md'));
        await runTool(writeTool, { path: 'CLAUDE.md', content: 'new\n' }, ctx);
        expect((await lstat(path.join(root, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
        expect(await text('AGENTS.md')).toBe('new\n');
    });
});

describe('applyEdit', () => {
    it('replaces exactly one occurrence and treats $ literally', () => {
        expect(applyEdit('a b c', { oldString: 'b', newString: '$&-$1' })).toEqual({
            ok: true,
            text: 'a $&-$1 c',
            replacements: 1,
            index: 2,
            inserted: '$&-$1',
        });
    });

    it('requires unique matches unless replaceAll is set', () => {
        const outcome = applyEdit('x\nx\nx\n', { oldString: 'x', newString: 'y' });
        expect(outcome).toMatchObject({ ok: false });
        expect(!outcome.ok && outcome.error).toContain('Found 3 matches');
        expect(applyEdit('x\nx\nx\n', { oldString: 'x', newString: 'y', replaceAll: true })).toMatchObject({
            ok: true,
            text: 'y\ny\ny\n',
            replacements: 3,
        });
    });

    it('refuses no-op edits', () => {
        expect(applyEdit('abc', { oldString: 'b', newString: 'b' })).toMatchObject({ ok: false });
        // Differs only in line endings, which the file keeps anyway.
        expect(applyEdit('a\r\nb\r\n', { oldString: 'a\nb', newString: 'a\r\nb' })).toMatchObject({ ok: false });
    });

    it('matches LF text in CRLF files and writes CRLF', () => {
        const outcome = applyEdit('one\r\ntwo\r\nthree\r\n', { oldString: 'one\ntwo', newString: 'one\nnew\ntwo' });
        expect(outcome).toMatchObject({ ok: true, text: 'one\r\nnew\r\ntwo\r\nthree\r\n' });
    });

    it('explains a miss with what the file has there', () => {
        const file = 'function f() {\n    const a = 1;\n    return a + 1;\n}\n';
        const outcome = applyEdit(file, {
            oldString: 'function f() {\n    const a = 1;\n    return a + 2;\n}',
            newString: 'x',
        });
        expect(outcome).toEqual({
            ok: false,
            error: [
                'oldString was not found: it must be the text of the file exactly, including whitespace, indentation and line breaks.',
                'The closest text is at lines 1-4; line 3 is the first that differs:',
                '  in the file:  "    return a + 1;"',
                '  in oldString: "    return a + 2;"',
                'The file there, to copy from (without the line numbers):',
                '     1\tfunction f() {',
                '     2\t    const a = 1;',
                '     3\t    return a + 1;',
                '     4\t}',
            ].join('\n'),
        });
        // One line: the line most like it.
        const single = applyEdit('const first = 1;\nconst answer = compute(41);\n', {
            oldString: 'const answer = compute(42);',
            newString: 'x',
        });
        expect(!single.ok && single.error).toContain('The closest text is at line 2; line 2 is the first that differs');
        const far = applyEdit('alpha\nbeta\n', { oldString: 'something else entirely', newString: 'x' });
        expect(!far.ok && far.error).toContain('Nothing in the file comes close to it');
        const applied = applyEdit('const answer = 42;\n', {
            oldString: 'answer = 41',
            newString: 'const answer = 42;',
        });
        expect(!applied.ok && applied.error).toContain('may have been made already');
    });
});

describe('applyEdit when oldString is not in the file exactly', () => {
    it('ignores whitespace at the ends of lines', () => {
        const outcome = applyEdit('a = 1  \nb = 2\nc = 3\n', { oldString: 'a = 1\nb = 2 ', newString: 'a = 1\nb = 5' });
        expect(outcome).toMatchObject({
            ok: true,
            text: 'a = 1\nb = 5\nc = 3\n',
            loose: 'ignoring whitespace at the ends of lines',
        });
    });

    it('finds a block at another indentation and shifts the new text to it', () => {
        const file = 'class A:\n    def f(self):\n        if x:\n            return 1\n        return 2\n';
        const outcome = applyEdit(file, {
            oldString: 'if x:\n    return 1\nreturn 2',
            newString: 'if x:\n    y = 1\n    return y\nreturn 2',
        });
        expect(outcome).toMatchObject({
            ok: true,
            text: 'class A:\n    def f(self):\n        if x:\n            y = 1\n            return y\n        return 2\n',
            loose: 'at a different indentation, and newString was shifted to the indentation of the file',
        });
    });

    it('converts spaces to the tabs of the file, and two spaces to four', () => {
        const tabs = applyEdit('def f():\n\tif x:\n\t\treturn 1\n\treturn 2\n', {
            oldString: '    if x:\n        return 1',
            newString: '    if x:\n        if y:\n            return 3',
        });
        expect(tabs).toMatchObject({
            ok: true,
            text: 'def f():\n\tif x:\n\t\tif y:\n\t\t\treturn 3\n\treturn 2\n',
        });
        expect(tabs.ok && tabs.loose).toContain('with a different unit of indentation');
        const spaces = applyEdit('function f() {\n    if (x) {\n        return 1;\n    }\n}\n', {
            oldString: 'function f() {\n  if (x) {\n    return 1;\n  }\n}',
            newString: 'function f() {\n  if (x) {\n    return 2;\n  }\n}',
        });
        expect(spaces).toMatchObject({ ok: true, text: 'function f() {\n    if (x) {\n        return 2;\n    }\n}\n' });
        // The other way round: the file has spaces, the model wrote tabs.
        const reverse = applyEdit('a:\n  b:\n    c: 1\n', {
            oldString: 'a:\n\tb:\n\t\tc: 1',
            newString: 'a:\n\tb:\n\t\tc: 2',
        });
        expect(reverse).toMatchObject({ ok: true, text: 'a:\n  b:\n    c: 2\n' });
    });

    it('drops the line numbers copied from read output', () => {
        const outcome = applyEdit('one\ntwo\nthree\n', {
            oldString: '     1\tone\n     2\ttwo',
            newString: '     1\tone\n     2\tTWO',
        });
        expect(outcome).toMatchObject({
            ok: true,
            text: 'one\nTWO\nthree\n',
            loose: 'after dropping the line numbers copied from read output',
        });
        // Only the old text carries them.
        expect(applyEdit('one\ntwo\n', { oldString: '     2\ttwo', newString: 'TWO' })).toMatchObject({
            ok: true,
            text: 'one\nTWO\n',
        });
    });

    it('converts rather than shifts when one side has tabs and the other spaces, at one depth too', () => {
        // Moving the block over would leave `\t    x += 1`: a tab from the file, then the spaces of the new text.
        const tabs = applyEdit('def f():\n\tx = 1\n\treturn x\n', {
            oldString: '    x = 1\n    return x',
            newString: '    x = 1\n    if x:\n        x += 1\n    return x',
        });
        expect(tabs).toMatchObject({ ok: true, text: 'def f():\n\tx = 1\n\tif x:\n\t\tx += 1\n\treturn x\n' });
        expect(tabs.ok && tabs.loose).toContain('with a different unit of indentation');
        const spaces = applyEdit('def f():\n    x = 1\n    return x\n', {
            oldString: '\tx = 1\n\treturn x',
            newString: '\tx = 1\n\tif x:\n\t\tx += 1\n\treturn x',
        });
        expect(spaces).toMatchObject({
            ok: true,
            text: 'def f():\n    x = 1\n    if x:\n        x += 1\n    return x\n',
        });
    });

    it('shifts a block of one depth as a whole, and does not halve its indentation instead', () => {
        // Eight spaces where the file has four: every line comes four to the left, the shallower one too.
        const shifted = applyEdit('class A:\n    x = 1\n    y = 2\n', {
            oldString: '        x = 1\n        y = 2',
            newString: '        x = 1\n    z = 0\n            w = 3\n        y = 2',
        });
        expect(shifted).toMatchObject({
            ok: true,
            text: 'class A:\n    x = 1\nz = 0\n        w = 3\n    y = 2\n',
            loose: 'at a different indentation, and newString was shifted to the indentation of the file',
        });
        // A line that cannot come four to the left: the place does not count, at half the indentation either.
        expect(applyEdit('a:\n    x = 1\n', { oldString: '        x = 1', newString: '  y = 2' })).toMatchObject({
            ok: false,
        });
        // Nor one indented with the other character.
        expect(applyEdit('a:\n    x = 1\n', { oldString: '        x = 1', newString: '\t\ty = 2' })).toMatchObject({
            ok: false,
        });
    });

    it('takes line numbers off the new text only where the old text had them', () => {
        // Kept lines carry their numbers, the line put between them has none.
        expect(
            applyEdit('a\nfoo\nbar\nb\n', {
                oldString: '     2\tfoo\n     3\tbar',
                newString: '     2\tfoo\ninserted\n     3\tbar',
            }),
        ).toMatchObject({ ok: true, text: 'a\nfoo\ninserted\nbar\nb\n' });
        // New text that begins with a number and a tab of its own keeps them.
        expect(applyEdit('id\tname\n41\tfoo\n', { oldString: '     2\t41\tfoo', newString: '42\tfoo' })).toMatchObject({
            ok: true,
            text: 'id\tname\n42\tfoo\n',
        });
        expect(applyEdit('1\ta\n', { oldString: '     1\t1\ta', newString: '1\tb' })).toMatchObject({
            ok: true,
            text: '1\tb\n',
        });
        // A number the old text did not have, in the shape of those it had: the model's own numbering, or text.
        const renumbered = applyEdit('a\nfoo\nbar\nb\n', {
            oldString: '     2\tfoo\n     3\tbar',
            newString: '     2\tfoo\n     3\tinserted\n     4\tbar',
        });
        expect(renumbered.ok).toBe(false);
        expect(!renumbered.ok && renumbered.error).toContain('The closest text is at lines 2-3');
    });

    it('does not place an old text of numbered blank lines', () => {
        const file = 'import a\n\n\ndef f():\n    pass\n\nx = 1\n';
        expect(applyEdit(file, { oldString: '     6\t', newString: '     6\ty = 2' })).toMatchObject({ ok: false });
    });

    it('keeps the line endings of the file and the line break the old text ended with', () => {
        const outcome = applyEdit('x\r\n  a\r\n  b\r\nc\r\n', { oldString: 'a\nb\n', newString: 'a\nB\n' });
        expect(outcome).toMatchObject({ ok: true, text: 'x\r\n  a\r\n  B\r\nc\r\n' });
        // One line of the block indented differently from the others is not a shift of the block.
        expect(applyEdit('a\n  b\nc\n', { oldString: 'a\nb\n', newString: 'a\nB\n' })).toMatchObject({ ok: false });
    });

    it('takes no place when several fit, or when the new text cannot be fitted', () => {
        const twice = applyEdit('if a:\n    x = 1\nif b:\n    x = 1\n', { oldString: 'x = 1 ', newString: 'x = 2' });
        expect(twice).toEqual({
            ok: false,
            error: 'oldString is not in the file exactly, and at a different indentation it fits 2 places (starting at lines 2, 4). Include more surrounding lines, copied from the file as they are, so that only one place fits.',
        });
        // Three spaces for a tab cannot say how deep five spaces are.
        const unfit = applyEdit('f:\n\ta\n\t\tb\n', { oldString: 'f:\n   a\n      b', newString: 'f:\n     c' });
        expect(unfit.ok).toBe(false);
        expect(!unfit.ok && unfit.error).toContain('line 2 is the first that differs');
        expect(!unfit.ok && unfit.error).toContain('in the file:  "\\ta"');
    });

    it('replaces every occurrence only where the text is exact', () => {
        expect(
            applyEdit('x = 1 \nx = 1\n', { oldString: 'x = 1\n', newString: 'x = 2\n', replaceAll: true }),
        ).toMatchObject({
            ok: true,
            text: 'x = 1 \nx = 2\n',
            replacements: 1,
        });
        expect(applyEdit('  x = 1\n', { oldString: ' x = 1 ', newString: 'y', replaceAll: true })).toMatchObject({
            ok: false,
        });
    });
});

describe('edit', () => {
    it('edits a unique match and shows the result', async () => {
        const { root, ctx, text } = await setup({ 'a.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' });
        const result = await runTool(
            editTool,
            { path: 'a.ts', oldString: 'const b = 2;', newString: 'const b = 20;' },
            ctx,
        );
        expect(result.isError).toBeUndefined();
        expect(await text('a.ts')).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');
        expect(result.content).toBe(
            'Edited a.ts: 1 replacement. Lines around the change now read:\n     1\tconst a = 1;\n     2\tconst b = 20;\n     3\tconst c = 3;',
        );
        expect(result.display).toEqual({
            kind: 'diff',
            diffs: [
                {
                    path: path.join(root, 'a.ts'),
                    oldText: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
                    newText: 'const a = 1;\nconst b = 20;\nconst c = 3;\n',
                },
            ],
        });
        expect(result.locations).toEqual([{ path: path.join(root, 'a.ts'), line: 2 }]);
    });

    it('reports missing and ambiguous matches without touching the file', async () => {
        const { ctx, text } = await setup({ 'a.ts': 'x = 1\nx = 1\n' });
        const missing = await runTool(editTool, { path: 'a.ts', oldString: 'y = 1', newString: 'y = 2' }, ctx);
        expect(missing.isError).toBe(true);
        expect(missing.content).toContain('oldString was not found');
        const ambiguous = await runTool(editTool, { path: 'a.ts', oldString: 'x = 1', newString: 'x = 2' }, ctx);
        expect(ambiguous.isError).toBe(true);
        expect(ambiguous.content).toContain('Found 2 matches of oldString. Include more surrounding lines');
        expect(await text('a.ts')).toBe('x = 1\nx = 1\n');
        const all = await runTool(
            editTool,
            { path: 'a.ts', oldString: 'x = 1', newString: 'x = 2', replaceAll: true },
            ctx,
        );
        expect(all.content).toContain('2 replacements');
        expect(await text('a.ts')).toBe('x = 2\nx = 2\n');
    });

    it('refuses no-op edits', async () => {
        const { ctx } = await setup({ 'a.ts': 'x\n' });
        const result = await runTool(editTool, { path: 'a.ts', oldString: 'x', newString: 'x' }, ctx);
        expect(result).toMatchObject({ isError: true });
        expect(result.content).toContain('identical');
    });

    it('preserves CRLF line endings', async () => {
        const { root, ctx } = await setup({ 'win.ts': 'a\r\nb\r\nc\r\n' });
        await runTool(editTool, { path: 'win.ts', oldString: 'a\nb', newString: 'a\nx\nb' }, ctx);
        expect(await readFile(path.join(root, 'win.ts'), 'utf8')).toBe('a\r\nx\r\nb\r\nc\r\n');
    });

    it('keeps the final line break when an edit drops it', async () => {
        const { ctx, text } = await setup({ 'a.txt': 'one\ntwo\n' });
        await runTool(editTool, { path: 'a.txt', oldString: 'two\n', newString: 'three' }, ctx);
        expect(await text('a.txt')).toBe('one\nthree\n');
    });

    it('creates a missing file from an empty oldString, and otherwise points to write', async () => {
        const { ctx, text } = await setup({ 'src/index.ts': '' });
        const created = await runTool(editTool, { path: 'new.ts', oldString: '', newString: 'export {};\n' }, ctx);
        expect(created.content.startsWith('Created new.ts.')).toBe(true);
        expect(created.display).toMatchObject({ diffs: [{ oldText: null, newText: 'export {};\n' }] });
        expect(await text('new.ts')).toBe('export {};\n');
        const missing = await runTool(editTool, { path: 'src/index.js', oldString: 'a', newString: 'b' }, ctx);
        expect(missing.content).toBe(
            'File not found: src/index.js (did you mean index.ts?). To create a file, use write.',
        );
        const nonEmpty = await runTool(editTool, { path: 'new.ts', oldString: '', newString: 'x' }, ctx);
        expect(nonEmpty.isError).toBe(true);
    });

    it('refuses binary files', async () => {
        const { ctx } = await setup({ 'blob.bin': Buffer.from([0, 1, 2, 3]) });
        const result = await runTool(editTool, { path: 'blob.bin', oldString: 'a', newString: 'b' }, ctx);
        expect(result).toMatchObject({
            isError: true,
            content: 'blob.bin is a binary file and cannot be edited as text.',
        });
    });

    it('keeps a UTF-16 file in UTF-16', async () => {
        const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello world\n', 'utf16le')]);
        const { root, ctx } = await setup({ 'wide.txt': original });
        await runTool(editTool, { path: 'wide.txt', oldString: 'world', newString: 'there' }, ctx);
        const bytes = await readFile(path.join(root, 'wide.txt'));
        expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
        expect(bytes.subarray(2).toString('utf16le')).toBe('hello there\n');
    });
});

describe('multi_edit', () => {
    it('applies edits in order, each to the previous result', async () => {
        const { root, ctx, text } = await setup({ 'a.ts': 'let x = 1;\nlet y = 2;\n' });
        const result = await runTool(
            multiEditTool,
            {
                path: 'a.ts',
                edits: [
                    { oldString: 'let x = 1;', newString: 'let x = 10;' },
                    { oldString: 'let x = 10;\nlet y', newString: 'let x = 10;\nconst y' },
                ],
            },
            ctx,
        );
        expect(result.content).toBe('Edited a.ts: applied 2 edits.');
        expect(await text('a.ts')).toBe('let x = 10;\nconst y = 2;\n');
        expect(result.display).toMatchObject({
            diffs: [{ path: path.join(root, 'a.ts'), oldText: 'let x = 1;\nlet y = 2;\n' }],
        });
    });

    it('writes nothing when any edit fails', async () => {
        const { ctx, text } = await setup({ 'a.ts': 'one\ntwo\n' });
        const result = await runTool(
            multiEditTool,
            {
                path: 'a.ts',
                edits: [
                    { oldString: 'one', newString: 'uno' },
                    { oldString: 'three', newString: 'tres' },
                ],
            },
            ctx,
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(
            /^Edit 2 of 2 failed: oldString was not found: .* No changes were written to a\.ts\.$/s,
        );
        expect(await text('a.ts')).toBe('one\ntwo\n');
    });

    it('can create a file when the first edit has an empty oldString', async () => {
        const { ctx, text } = await setup();
        const result = await runTool(
            multiEditTool,
            {
                path: 'new.txt',
                edits: [
                    { oldString: '', newString: 'hello world\n' },
                    { oldString: 'world', newString: 'there' },
                ],
            },
            ctx,
        );
        expect(result.content).toBe('Created new.txt: applied 2 edits.');
        expect(await text('new.txt')).toBe('hello there\n');
    });

    it('requires at least one edit', () => {
        expect(multiEditTool.schema.safeParse({ path: 'a', edits: [] }).success).toBe(false);
        expect(multiEditTool.title({ path: 'a.ts', edits: [{ oldString: 'a', newString: 'b' }] })).toBe(
            'Edit a.ts (1 change)',
        );
    });
});
