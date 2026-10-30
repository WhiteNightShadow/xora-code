import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTool } from '../src/index.ts';
import { makeContext, runTool, temporaryDir, writeFiles } from './helpers.ts';

async function setup(files: Readonly<Record<string, string | Uint8Array>>) {
    const root = await temporaryDir();
    await writeFiles(root, files);
    return { root, ctx: await makeContext(root) };
}

describe('read', () => {
    it('numbers lines like cat -n', async () => {
        const { root, ctx } = await setup({ 'a.txt': 'alpha\nbeta\ngamma\n' });
        const result = await runTool(readTool, { path: 'a.txt' }, ctx);
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe('     1\talpha\n     2\tbeta\n     3\tgamma');
        expect(result.display).toEqual({
            kind: 'read',
            path: path.join(root, 'a.txt'),
            startLine: 1,
            endLine: 3,
            totalLines: 3,
        });
        expect(result.locations).toEqual([{ path: path.join(root, 'a.txt'), line: 1 }]);
    });

    it('counts a last line without a line break', async () => {
        const { ctx } = await setup({ 'a.txt': 'one\ntwo' });
        const result = await runTool(readTool, { path: 'a.txt' }, ctx);
        expect(result.content).toBe('     1\tone\n     2\ttwo');
    });

    it('reads a window with offset and limit and says where to continue', async () => {
        const { ctx } = await setup({ 'a.txt': 'l1\nl2\nl3\nl4\nl5\n' });
        const result = await runTool(readTool, { path: 'a.txt', offset: 2, limit: 2 }, ctx);
        expect(result.content).toBe('     2\tl2\n     3\tl3\n\n(Lines 2-3 of 5. Use offset=4 to read on.)');
        expect(result.display).toMatchObject({ startLine: 2, endLine: 3, totalLines: 5 });
        const tail = await runTool(readTool, { path: 'a.txt', offset: 4 }, ctx);
        expect(tail.content).toBe('     4\tl4\n     5\tl5\n\n(Lines 4-5 of 5.)');
    });

    it('stops at 2000 lines by default and reports the total', async () => {
        const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n');
        const { ctx } = await setup({ 'big.txt': lines });
        const result = await runTool(readTool, { path: 'big.txt' }, ctx);
        expect(result.display).toMatchObject({ startLine: 1, endLine: 2000, totalLines: 2500 });
        expect(result.content).toContain('  2000\tline 2000');
        expect(result.content).not.toContain('line 2001');
        expect(result.content).toContain('(Lines 1-2000 of 2500. Use offset=2001 to read on.)');
    });

    it('cuts very long lines', async () => {
        const { ctx } = await setup({ 'min.js': `${'x'.repeat(2500)}\nshort\n` });
        const result = await runTool(readTool, { path: 'min.js' }, ctx);
        expect(result.content).toBe(`     1\t${'x'.repeat(2000)} [... 500 characters truncated]\n     2\tshort`);
    });

    it('hides CRLF line endings and byte order marks', async () => {
        const { ctx } = await setup({
            'win.txt': 'first\r\nsecond\r\n',
            'bom.txt': '﻿with bom\n',
            'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide 文字\nline 2\n', 'utf16le')]),
        });
        expect((await runTool(readTool, { path: 'win.txt' }, ctx)).content).toBe('     1\tfirst\n     2\tsecond');
        expect((await runTool(readTool, { path: 'bom.txt' }, ctx)).content).toBe('     1\twith bom');
        expect((await runTool(readTool, { path: 'utf16.txt' }, ctx)).content).toBe('     1\twide 文字\n     2\tline 2');
    });

    it('says when a file is empty', async () => {
        const { ctx } = await setup({ 'empty.txt': '' });
        const result = await runTool(readTool, { path: 'empty.txt' }, ctx);
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe('empty.txt is empty (0 lines).');
        expect(result.display).toMatchObject({ totalLines: 0 });
    });

    it('refuses directories and binary files', async () => {
        const { root, ctx } = await setup({ 'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]) });
        await mkdir(path.join(root, 'src'));
        const dir = await runTool(readTool, { path: 'src' }, ctx);
        expect(dir.isError).toBe(true);
        expect(dir.content).toContain('is a directory');
        expect(dir.content).toContain('list tool');
        const binary = await runTool(readTool, { path: 'image.png' }, ctx);
        expect(binary.isError).toBe(true);
        expect(binary.content).toContain('binary file');
    });

    it('reports missing files with similar names', async () => {
        const { ctx } = await setup({ 'src/index.ts': 'x' });
        const result = await runTool(readTool, { path: 'src/index.js' }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toBe('File not found: src/index.js (did you mean index.ts?)');
        const plain = await runTool(readTool, { path: 'nope/missing.txt' }, ctx);
        expect(plain.content).toBe('File not found: nope/missing.txt');
    });

    it('refuses an offset past the end', async () => {
        const { ctx } = await setup({ 'a.txt': 'one\ntwo\n' });
        const result = await runTool(readTool, { path: 'a.txt', offset: 5 }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toBe('a.txt has 2 lines; offset 5 is past the end.');
    });

    it('reads absolute paths and resolves targets against the working directory', async () => {
        const { root, ctx } = await setup({ 'a.txt': 'x\n' });
        const result = await runTool(readTool, { path: path.join(root, 'a.txt') }, ctx);
        expect(result.content).toBe('     1\tx');
        expect(readTool.targets({ path: 'sub/../a.txt' }, { cwd: root })).toEqual([path.join(root, 'a.txt')]);
        expect(readTool.title({ path: 'a.txt' })).toBe('Read a.txt');
        expect(readTool.title({ path: 'a.txt', offset: 10, limit: 5 })).toBe('Read a.txt (lines 10-14)');
    });

    it('rejects invalid input through its schema', () => {
        expect(readTool.schema.safeParse({ path: 'a', offset: 0 }).success).toBe(false);
        expect(readTool.schema.safeParse({ path: '' }).success).toBe(false);
        expect(readTool.schema.safeParse({ path: 'a', limit: 1.5 }).success).toBe(false);
    });
});
