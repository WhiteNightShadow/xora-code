import { readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatchTool, editTool, multiEditTool, readTool, writeTool } from '../src/index.ts';
import { decodeFile, encodeText } from '../src/text.ts';
import { fileLedger, makeContext, runTool, temporaryDir, writeFiles } from './helpers.ts';

/** `中文测试` and `你好` in GBK, which is not valid UTF-8. */
const ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4];
const NIHAO = [0xc4, 0xe3, 0xba, 0xc3];
const gbk = (...parts: Array<string | number[]>): Buffer =>
    Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));

describe('text encodings', () => {
    it('reads UTF-8, and GB18030 where the bytes are not UTF-8', () => {
        expect(decodeFile(Buffer.from('héllo 中文\n'))).toEqual({ text: 'héllo 中文\n', encoding: 'utf8' });
        expect(decodeFile(gbk(ZHONGWEN, '\nname = old\n'))).toEqual({
            text: '中文测试\nname = old\n',
            encoding: 'gb18030',
        });
        expect(decodeFile(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
    });

    it('writes GB18030 back byte for byte, in two and in four bytes', () => {
        // The basic plane in two bytes (中, €) and in four (é, ʰ), and another plane (𠮷).
        const text = '中文 € é ʰ 𠮷 � ok\n';
        const bytes = encodeText(text, 'gb18030');
        expect(new TextDecoder('gb18030', { fatal: true }).decode(bytes)).toBe(text);
        expect(decodeFile(bytes)).toEqual({ text, encoding: 'gb18030' });
        expect([...encodeText('中', 'gb18030')]).toEqual([0xd6, 0xd0]);
        expect([...encodeText('𐀀', 'gb18030')]).toEqual([0x90, 0x30, 0x81, 0x30]);
        expect(() => encodeText('\ud800', 'gb18030')).toThrow('cannot be written in GB18030');
    });

    it('calls bytes that are text in no known encoding lossy', () => {
        // Latin-1 `café` before a line break: not UTF-8, and no GB18030 sequence either.
        const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
        expect(decodeFile(latin1)).toEqual({ text: 'caf�\n', encoding: 'utf8', lossy: true });
        // The single byte 0x80 (the euro sign of cp936 and cp1252) is nothing GB18030 writes back.
        expect(decodeFile(gbk(ZHONGWEN, [0x80], '\n'))).toMatchObject({ encoding: 'utf8', lossy: true });
    });

    it('holds a byte order mark to what it says', () => {
        const bom = [0xef, 0xbb, 0xbf];
        expect(decodeFile(Buffer.from([...bom, 0x61, 0x0a]))).toEqual({ text: 'a\n', encoding: 'utf8bom' });
        expect(decodeFile(Buffer.from([...bom, 0x61, 0xff, 0x0a]))).toEqual({
            text: 'a�\n',
            encoding: 'utf8bom',
            lossy: true,
        });
        // Half a character at the end of UTF-16.
        expect(decodeFile(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62]))).toMatchObject({
            encoding: 'utf16le',
            lossy: true,
        });
    });

    it('does not take UTF-8 with a stray byte in it for GB18030', () => {
        // Every two-byte character of UTF-8 is a GB18030 sequence too, and so is a Latin-1 `é` with the letter after it.
        const stray = (before: string, after: string): Buffer =>
            Buffer.concat([Buffer.from(before, 'utf8'), Buffer.from([0xe9]), Buffer.from(after, 'utf8')]);
        const german = stray('Größe für Übersicht: r', 'sume\n');
        expect(new TextDecoder('gb18030', { fatal: true }).decode(german)).toContain('枚');
        expect(decodeFile(german)).toEqual({ text: 'Größe für Übersicht: r�sume\n', encoding: 'utf8', lossy: true });
        expect(decodeFile(stray('Привет, мир: caf', 'x\n'))).toMatchObject({ encoding: 'utf8', lossy: true });
        // Chinese in GB18030 next to ASCII stays what it is, however little of it there is.
        for (const text of ['中文', '订单号不能为空', 'int main() { return 0; } // 初始化\n', '价格', 'x = "成功"\n']) {
            expect(decodeFile(encodeText(text, 'gb18030'))).toEqual({ text, encoding: 'gb18030' });
        }
    });
});

describe('files that are not UTF-8', () => {
    it('edits a GBK file in its encoding, leaving every other byte alone', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a.txt': gbk(ZHONGWEN, '\r\nname = old\r\n') });
        const ctx = await makeContext(root);
        const read = await runTool(readTool, { path: 'a.txt' }, ctx);
        expect(read.content).toBe(
            '     1\t中文测试\n     2\tname = old\n\n(This file is GB18030 (GBK) text, not UTF-8; edits keep that encoding.)',
        );
        const edited = await runTool(
            editTool,
            { path: 'a.txt', oldString: 'name = old', newString: 'name = 你好' },
            ctx,
        );
        expect(edited.isError).toBeUndefined();
        expect(await readFile(path.join(root, 'a.txt'))).toEqual(gbk(ZHONGWEN, '\r\nname = ', NIHAO, '\r\n'));

        const patched = await runTool(
            applyPatchTool,
            { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-中文测试\n+你好\n*** End Patch' },
            ctx,
        );
        expect(patched.isError).toBeUndefined();
        expect(await readFile(path.join(root, 'a.txt'))).toEqual(gbk(NIHAO, '\r\nname = ', NIHAO, '\r\n'));

        // A full rewrite keeps the encoding too, like it keeps the line endings.
        const ledger = await makeContext(root, { files: fileLedger() });
        await runTool(readTool, { path: 'a.txt' }, ledger);
        await runTool(writeTool, { path: 'a.txt', content: '你好\n' }, ledger);
        expect(await readFile(path.join(root, 'a.txt'))).toEqual(gbk(NIHAO, '\r\n'));
    });

    it('does not rewrite a file it cannot decode', async () => {
        const root = await temporaryDir();
        const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x20, 0x3d, 0x20, 0x31, 0x0a]);
        await writeFiles(root, { 'a.txt': latin1 });
        const ctx = await makeContext(root);
        const read = await runTool(readTool, { path: 'a.txt' }, ctx);
        expect(read.content).toContain('     2\tx = 1');
        expect(read.content).toContain('This file is not valid UTF-8, UTF-16 or GB18030 text');
        for (const result of [
            await runTool(editTool, { path: 'a.txt', oldString: 'x = 1', newString: 'x = 2' }, ctx),
            await runTool(multiEditTool, { path: 'a.txt', edits: [{ oldString: 'x = 1', newString: 'x = 2' }] }, ctx),
            await runTool(
                applyPatchTool,
                { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-x = 1\n+x = 2\n*** End Patch' },
                ctx,
            ),
        ]) {
            expect(result.isError).toBe(true);
            expect(result.content).toContain('a.txt is not valid UTF-8, UTF-16 or GB18030 text');
        }
        expect(await readFile(path.join(root, 'a.txt'))).toEqual(latin1);

        // Nor does write put the replacement characters it was shown in place of the bytes.
        const ledger = await makeContext(root, { files: fileLedger() });
        await runTool(readTool, { path: 'a.txt' }, ledger);
        const copied = await runTool(writeTool, { path: 'a.txt', content: 'caf\ufffd\nx = 2\n' }, ledger);
        expect(copied.isError).toBe(true);
        expect(copied.content).toContain('the content sent has \ufffd in it');
        expect(await readFile(path.join(root, 'a.txt'))).toEqual(latin1);
        // Content of its own replaces the file, and says what became of it.
        const fresh = await runTool(writeTool, { path: 'a.txt', content: 'café\nx = 2\n' }, ledger);
        expect(fresh.content).toBe(
            'Replaced the content of a.txt (2 lines). It was not valid text in an encoding known here; what is written now is.',
        );
        expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('café\nx = 2\n');
    });

    it('does not rewrite a file whose bytes are not what its byte order mark says', async () => {
        const root = await temporaryDir();
        const marked = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x0a, 0x78, 0x20, 0x3d, 0x20, 0x31, 0x0a]);
        await writeFiles(root, { 'a.txt': marked });
        const ctx = await makeContext(root);
        expect((await runTool(readTool, { path: 'a.txt' }, ctx)).content).toContain('the edit tools will not rewrite');
        const edited = await runTool(editTool, { path: 'a.txt', oldString: 'x = 1', newString: 'x = 2' }, ctx);
        expect(edited.isError).toBe(true);
        expect(await readFile(path.join(root, 'a.txt'))).toEqual(marked);
    });

    it('reads a file in the encoding the edit tools find it in', async () => {
        const root = await temporaryDir();
        // More ASCII than the first piece read of a file holds, then GBK: the start alone says UTF-8.
        const ascii = `${'a'.repeat(99)}\n`.repeat(700);
        const mixed = Buffer.concat([Buffer.from(ascii), gbk(ZHONGWEN, '\nname = old\n')]);
        // GBK at the start, and further down a byte that is none.
        const broken = Buffer.concat([gbk(ZHONGWEN, '\n'), Buffer.from(ascii), Buffer.from([0x80, 0x0a])]);
        await writeFiles(root, { 'late.sql': mixed, 'broken.txt': broken });
        const ctx = await makeContext(root, { files: fileLedger() });

        const late = await runTool(readTool, { path: 'late.sql', offset: 700 }, ctx);
        expect(late.content).toContain('   701\t中文测试\n   702\tname = old');
        expect(late.content).toContain('This file is GB18030 (GBK) text');
        const edited = await runTool(editTool, { path: 'late.sql', oldString: '中文测试', newString: '你好' }, ctx);
        expect(edited.isError).toBeUndefined();
        expect(await readFile(path.join(root, 'late.sql'))).toEqual(
            Buffer.concat([Buffer.from(ascii), gbk(NIHAO, '\nname = old\n')]),
        );

        const read = await runTool(readTool, { path: 'broken.txt', limit: 1 }, ctx);
        expect(read.content).toContain('This file is not valid UTF-8, UTF-16 or GB18030 text');
        expect((await runTool(editTool, { path: 'broken.txt', oldString: 'aaa', newString: 'b' }, ctx)).isError).toBe(
            true,
        );
    });

    it('keeps the encoding of a file a patch deletes and adds again', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a.txt': gbk(ZHONGWEN, '\n') });
        const ctx = await makeContext(root);
        const patch = '*** Begin Patch\n*** Delete File: a.txt\n*** Add File: a.txt\n+你好\n*** End Patch';
        expect((await runTool(applyPatchTool, { patch }, ctx)).isError).toBeUndefined();
        expect(await readFile(path.join(root, 'a.txt'))).toEqual(gbk(NIHAO, '\n'));
    });
});

describe('write over a file that is there', () => {
    it('asks for the file to be read first, and again when it changed', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a.txt': 'precious\n' });
        const file = path.join(root, 'a.txt');
        const ctx = await makeContext(root, { files: fileLedger() });

        const blind = await runTool(writeTool, { path: 'a.txt', content: 'mine\n' }, ctx);
        expect(blind.isError).toBe(true);
        expect(blind.content).toContain('a.txt exists and you have not read it in this session. Read it first');
        expect(await readFile(file, 'utf8')).toBe('precious\n');

        await runTool(readTool, { path: 'a.txt' }, ctx);
        expect((await runTool(writeTool, { path: 'a.txt', content: 'mine\n' }, ctx)).content).toBe(
            'Replaced the content of a.txt (1 line).',
        );
        // What the session wrote itself, it has seen.
        expect((await runTool(writeTool, { path: 'a.txt', content: 'mine again\n' }, ctx)).isError).toBeUndefined();

        // Someone else writes to it: another size, or the same size at another time.
        await writeFile(file, 'theirs, and longer\n');
        const stale = await runTool(writeTool, { path: 'a.txt', content: 'mine\n' }, ctx);
        expect(stale.isError).toBe(true);
        expect(stale.content).toContain('a.txt has changed since you last read it');
        expect(await readFile(file, 'utf8')).toBe('theirs, and longer\n');
        await runTool(readTool, { path: 'a.txt', limit: 1 }, ctx);
        await utimes(file, new Date(), new Date(Date.now() + 5000));
        expect((await runTool(writeTool, { path: 'a.txt', content: 'mine\n' }, ctx)).isError).toBe(true);

        // An edit that misses says so as well; one that fits needs no reading first: it only fits the text as it is.
        const missed = await runTool(editTool, { path: 'a.txt', oldString: 'nowhere', newString: 'x' }, ctx);
        expect(missed.content).toContain('The file has changed since you last read it');
        const edited = await runTool(editTool, { path: 'a.txt', oldString: 'theirs', newString: 'ours' }, ctx);
        expect(edited.isError).toBeUndefined();
        // It showed the model a few lines, not the file: what the others wrote is still not known here.
        const after = await runTool(writeTool, { path: 'a.txt', content: 'mine\n' }, ctx);
        expect(after.content).toContain('a.txt has changed since you last read it');
        expect(await readFile(file, 'utf8')).toBe('ours, and longer\n');
        await runTool(readTool, { path: 'a.txt' }, ctx);
        expect((await runTool(writeTool, { path: 'a.txt', content: 'mine\n' }, ctx)).isError).toBeUndefined();
    });

    it('does not take a file for read because a part of it was changed', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'conf.txt': 'a = 1\nb = 2\nc = 3\n', 'p.txt': 'a = 1\nb = 2\n' });
        const ctx = await makeContext(root, { files: fileLedger() });
        const whole = { path: 'conf.txt', content: 'a = 9\n' };
        expect((await runTool(writeTool, whole, ctx)).content).toContain('you have not read it in this session');
        // The way the refusal points to: one line changed, the others never seen.
        expect(
            (await runTool(editTool, { path: 'conf.txt', oldString: 'a = 1', newString: 'a = 9' }, ctx)).isError,
        ).toBe(undefined);
        expect(
            (
                await runTool(
                    multiEditTool,
                    { path: 'conf.txt', edits: [{ oldString: 'b = 2', newString: 'b = 8' }] },
                    ctx,
                )
            ).isError,
        ).toBeUndefined();
        expect((await runTool(writeTool, whole, ctx)).content).toContain('you have not read it in this session');
        expect(await readFile(path.join(root, 'conf.txt'), 'utf8')).toBe('a = 9\nb = 8\nc = 3\n');

        const patch = '*** Begin Patch\n*** Update File: p.txt\n@@\n-a = 1\n+a = 9\n*** End Patch';
        expect((await runTool(applyPatchTool, { patch }, ctx)).isError).toBeUndefined();
        expect((await runTool(writeTool, { path: 'p.txt', content: 'x\n' }, ctx)).isError).toBe(true);

        // A file the session made, by an edit or a patch, it knows all of; and one it read stays known through its edits.
        await runTool(editTool, { path: 'made.txt', oldString: '', newString: 'one\n' }, ctx);
        await runTool(editTool, { path: 'made.txt', oldString: 'one', newString: 'two' }, ctx);
        expect((await runTool(writeTool, { path: 'made.txt', content: 'three\n' }, ctx)).isError).toBeUndefined();
        const added = '*** Begin Patch\n*** Add File: added.txt\n+one\n*** End Patch';
        await runTool(applyPatchTool, { patch: added }, ctx);
        expect((await runTool(writeTool, { path: 'added.txt', content: 'two\n' }, ctx)).isError).toBeUndefined();
    });

    it('lets new files, empty files and unchanged content through, and never replaces a binary file', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'empty.txt': '', 'same.txt': 'same\n', 'logo.png': Buffer.from([0x89, 0x50, 0, 1]) });
        const ctx = await makeContext(root, { files: fileLedger() });
        expect((await runTool(writeTool, { path: 'new.txt', content: 'a\n' }, ctx)).content).toBe(
            'Created new.txt (1 line).',
        );
        expect((await runTool(writeTool, { path: 'empty.txt', content: 'a\n' }, ctx)).isError).toBeUndefined();
        expect((await runTool(writeTool, { path: 'same.txt', content: 'same\n' }, ctx)).content).toContain(
            'already has exactly this content',
        );
        const binary = await runTool(writeTool, { path: 'logo.png', content: 'text' }, ctx);
        expect(binary.isError).toBe(true);
        expect(binary.content).toContain('logo.png is a binary file, and write does not replace one with text');
    });
});
