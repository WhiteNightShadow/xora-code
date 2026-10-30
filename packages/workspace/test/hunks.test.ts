import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildPatch,
    type DiffFile,
    diffForReview,
    HunkApplyError,
    parseUnifiedDiff,
    revertHunks,
    stageHunks,
    unstageHunks,
} from '../src/index.ts';
import {
    commitAll,
    GIT_TIMEOUT,
    git,
    gitBuffer,
    hasGit,
    initRepo,
    lines,
    read,
    temporaryDir,
    writeFiles,
} from './helpers.ts';

const original = lines(40);
/** Three separate changes: two lines inserted after line 3, line 20 rewritten, line 35 deleted. */
const edited = (() => {
    const all = original.trimEnd().split('\n');
    all.splice(34, 1);
    all[19] = 'line 20 changed';
    all.splice(3, 0, 'new a', 'new b');
    return `${all.join('\n')}\n`;
})();

const threeHunkDiff = [
    'diff --git a/f.txt b/f.txt',
    'index bab081f..1a3f3c4 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,6 +1,8 @@',
    ' line 1',
    ' line 2',
    ' line 3',
    '+new a',
    '+new b',
    ' line 4',
    ' line 5',
    ' line 6',
    '@@ -17,7 +19,7 @@ line 16',
    ' line 17',
    ' line 18',
    ' line 19',
    '-line 20',
    '+line 20 changed',
    ' line 21',
    ' line 22',
    ' line 23',
    '@@ -32,7 +34,6 @@ line 31',
    ' line 32',
    ' line 33',
    ' line 34',
    '-line 35',
    ' line 36',
    ' line 37',
    ' line 38',
    '',
].join('\n');

function only(files: readonly DiffFile[], name: string): DiffFile {
    const file = files.find((candidate) => candidate.newPath === name);
    if (!file) {
        throw new Error(`no diff for ${name}`);
    }
    return file;
}

describe('parseUnifiedDiff', () => {
    it('parses hunks with line numbers and stable ids', () => {
        const [file] = parseUnifiedDiff(threeHunkDiff);
        expect(file).toMatchObject({ oldPath: 'f.txt', newPath: 'f.txt', status: 'modified', binary: false });
        expect(file?.oldMode).toBe('100644');
        expect(file?.hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([
            [1, 6, 1, 8],
            [17, 7, 19, 7],
            [32, 7, 34, 6],
        ]);
        const second = file?.hunks[1];
        expect(second?.header).toBe('@@ -17,7 +19,7 @@ line 16');
        expect(second?.lines[3]).toEqual({ kind: '-', text: 'line 20', oldLine: 20 });
        expect(second?.lines[4]).toEqual({ kind: '+', text: 'line 20 changed', newLine: 22 });
        expect(second?.lines[0]).toEqual({ kind: ' ', text: 'line 17', oldLine: 17, newLine: 19 });
        for (const [index, hunk] of (file?.hunks ?? []).entries()) {
            expect(hunk.id).toMatch(new RegExp(`^${index}-[0-9a-f]{8}$`));
        }
        expect(parseUnifiedDiff(threeHunkDiff)[0]?.hunks.map((hunk) => hunk.id)).toEqual(
            file?.hunks.map((hunk) => hunk.id),
        );
    });

    it('rebuilds the same hunks when every hunk is selected', () => {
        const [file] = parseUnifiedDiff(threeHunkDiff);
        if (!file) {
            throw new Error('no file');
        }
        const rebuilt = buildPatch(
            file,
            file.hunks.map((hunk) => hunk.id),
        );
        expect(parseUnifiedDiff(rebuilt)[0]?.hunks).toEqual(file.hunks);
    });

    it('renumbers the target side of a partial patch and swaps sides when reversed', () => {
        const [file] = parseUnifiedDiff(threeHunkDiff);
        const last = file?.hunks[2];
        if (!file || !last) {
            throw new Error('no hunk');
        }
        expect(buildPatch(file, [last.id])).toBe(
            [
                'diff --git a/f.txt b/f.txt',
                '--- a/f.txt',
                '+++ b/f.txt',
                '@@ -32,7 +32,6 @@ line 31',
                ' line 32',
                ' line 33',
                ' line 34',
                '-line 35',
                ' line 36',
                ' line 37',
                ' line 38',
                '',
            ].join('\n'),
        );
        expect(buildPatch(file, [last.id], { reverse: true })).toContain('@@ -34,6 +34,7 @@ line 31\n line 32\n');
        expect(buildPatch(file, [last.id], { reverse: true })).toContain('+line 35\n');
        expect(() => buildPatch(file, ['9-deadbeef'])).toThrow(/unknown hunk/);
        expect(() => buildPatch(file, [])).toThrow(/no hunks selected/);
    });

    it('handles quoted paths, renames, new, deleted and binary files', () => {
        const text = [
            'diff --git "a/tab\\there" "b/tab\\there"',
            'new file mode 100755',
            'index 0000000..e69de29',
            '--- /dev/null',
            '+++ "b/tab\\there"',
            '@@ -0,0 +1 @@',
            '+x',
            'diff --git a/with space.txt b/with space.txt',
            'deleted file mode 100644',
            '--- a/with space.txt\t',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-gone',
            'diff --git a/old.txt b/new.txt',
            'similarity index 90%',
            'rename from old.txt',
            'rename to new.txt',
            'diff --git "a/\\303\\244.bin" "b/\\303\\244.bin"',
            'index 1111111..2222222 100644',
            'Binary files "a/\\303\\244.bin" and "b/\\303\\244.bin" differ',
            '',
        ].join('\n');
        const files = parseUnifiedDiff(text);
        expect(files.map((file) => [file.status, file.oldPath, file.newPath, file.binary])).toEqual([
            ['added', 'tab\there', 'tab\there', false],
            ['deleted', 'with space.txt', 'with space.txt', false],
            ['renamed', 'old.txt', 'new.txt', false],
            ['modified', 'ä.bin', 'ä.bin', true],
        ]);
        expect(files[0]?.newMode).toBe('100755');
        const added = files[0];
        if (!added) {
            throw new Error('no file');
        }
        expect(buildPatch(added, [added.hunks[0]?.id ?? ''])).toBe(
            'diff --git "a/tab\\there" "b/tab\\there"\nnew file mode 100755\n--- /dev/null\n+++ "b/tab\\there"\n@@ -0,0 +1 @@\n+x\n',
        );
        const deleted = files[1];
        if (!deleted) {
            throw new Error('no file');
        }
        expect(buildPatch(deleted, [deleted.hunks[0]?.id ?? ''], { reverse: true })).toBe(
            'diff --git a/with space.txt b/with space.txt\nnew file mode 100644\n--- /dev/null\n+++ b/with space.txt\t\n@@ -0,0 +1 @@\n+gone\n',
        );
        expect(() => buildPatch(files[3] as DiffFile, [])).toThrow(/binary/);
    });

    it('marks lines without a trailing newline', () => {
        const [file] = parseUnifiedDiff(
            [
                'diff --git a/x b/x',
                '--- a/x',
                '+++ b/x',
                '@@ -1,2 +1,2 @@',
                ' a',
                '-b',
                '\\ No newline at end of file',
                '+B',
                '\\ No newline at end of file',
                '',
            ].join('\n'),
        );
        expect(file?.hunks[0]?.lines).toEqual([
            { kind: ' ', text: 'a', oldLine: 1, newLine: 1 },
            { kind: '-', text: 'b', oldLine: 2, noNewline: true },
            { kind: '+', text: 'B', newLine: 2, noNewline: true },
        ]);
    });
});

describe.skipIf(!hasGit)('hunk staging and reverting', { timeout: GIT_TIMEOUT }, () => {
    async function repoWithEdits() {
        const repo = await initRepo(path.join(await temporaryDir(), 'repo'), { 'f.txt': original });
        await writeFile(path.join(repo, 'f.txt'), edited);
        return repo;
    }

    it('stages, unstages and reverts single hunks of a multi-hunk file', async () => {
        const repo = await repoWithEdits();
        const file = only(await diffForReview(repo), 'f.txt');
        expect(file.hunks).toHaveLength(3);

        await stageHunks(repo, file, [file.hunks[1]?.id ?? '']);
        const staged = git(repo, ['diff', '--cached']);
        expect(staged).toContain('+line 20 changed');
        expect(staged).not.toContain('new a');
        expect(staged).not.toContain('-line 35');
        expect(only(await diffForReview(repo), 'f.txt').hunks).toHaveLength(2);
        expect(read(repo, 'f.txt')).toBe(edited);

        const stagedFile = only(await diffForReview(repo, { staged: true }), 'f.txt');
        expect(stagedFile.hunks).toHaveLength(1);
        await unstageHunks(repo, stagedFile, [stagedFile.hunks[0]?.id ?? '']);
        expect(git(repo, ['diff', '--cached'])).toBe('');
        expect(read(repo, 'f.txt')).toBe(edited);

        const fresh = only(await diffForReview(repo), 'f.txt');
        await revertHunks(repo, fresh, [fresh.hunks[2]?.id ?? '']);
        const content = read(repo, 'f.txt');
        expect(content).toContain('line 35\n');
        expect(content).toContain('new a\nnew b\n');
        expect(content).toContain('line 20 changed\n');
        expect(git(repo, ['diff', '--cached'])).toBe('');
    });

    it('reverts the last hunk when an earlier one is kept', async () => {
        const repo = await repoWithEdits();
        const file = only(await diffForReview(repo), 'f.txt');
        await revertHunks(repo, file, [file.hunks[0]?.id ?? '']);
        const content = read(repo, 'f.txt');
        expect(content).not.toContain('new a');
        expect(content).toContain('line 20 changed\n');
        expect(content).not.toContain('line 35\n');
    });

    it('fails cleanly when the work tree moved on', async () => {
        const repo = await repoWithEdits();
        const file = only(await diffForReview(repo), 'f.txt');
        const changed = edited.replace('line 20 changed', 'line 20 changed again');
        await writeFile(path.join(repo, 'f.txt'), changed);
        await expect(revertHunks(repo, file, [file.hunks[1]?.id ?? ''])).rejects.toBeInstanceOf(HunkApplyError);
        expect(read(repo, 'f.txt')).toBe(changed);
        await expect(stageHunks(repo, file, ['7-00000000'])).rejects.toThrow(/unknown hunk/);
    });

    it('keeps files without a trailing newline intact', async () => {
        const repo = await initRepo(path.join(await temporaryDir(), 'repo'), { 'eof.txt': 'a\nb\nc' });
        await writeFile(path.join(repo, 'eof.txt'), 'a\nb\nC');
        const file = only(await diffForReview(repo), 'eof.txt');
        expect(file.hunks[0]?.lines.filter((line) => line.noNewline).map((line) => line.kind)).toEqual(['-', '+']);
        await stageHunks(repo, file, [file.hunks[0]?.id ?? '']);
        expect(git(repo, ['show', ':eof.txt'])).toBe('a\nb\nC');
        await revertHunks(repo, file, [file.hunks[0]?.id ?? '']);
        expect(read(repo, 'eof.txt')).toBe('a\nb\nc');

        // Adding the missing newline is a hunk of its own kind.
        git(repo, ['reset', '-q']);
        await writeFile(path.join(repo, 'eof.txt'), 'a\nb\nc\n');
        const added = only(await diffForReview(repo), 'eof.txt');
        await revertHunks(repo, added, [added.hunks[0]?.id ?? '']);
        expect(read(repo, 'eof.txt')).toBe('a\nb\nc');
    });

    it('rebuilds patches byte for byte for files that are not UTF-8', async () => {
        const latin1 = (text: string) => Buffer.from(text, 'latin1');
        const before = latin1(`caf\xe9 1\n${lines(20)}caf\xe9 2\n`);
        const after = latin1(`caf\xe9 1 \xe0\n${lines(20)}caf\xe9 2 \xe8\n`);
        const repo = await initRepo(path.join(await temporaryDir(), 'repo'), { 'old.txt': before });
        await writeFile(path.join(repo, 'old.txt'), after);
        const file = only(await diffForReview(repo), 'old.txt');
        expect(file.hunks).toHaveLength(2);
        await revertHunks(repo, file, [file.hunks[1]?.id ?? '']);
        expect(readFileSync(path.join(repo, 'old.txt'))).toEqual(latin1(`caf\xe9 1 \xe0\n${lines(20)}caf\xe9 2\n`));
        await stageHunks(repo, file, [file.hunks[0]?.id ?? '']);
        expect(gitBuffer(repo, ['show', ':old.txt'])).toEqual(latin1(`caf\xe9 1 \xe0\n${lines(20)}caf\xe9 2\n`));
    });

    it('lists untracked files on request and treats them as whole-file hunks', async () => {
        const repo = await initRepo(path.join(await temporaryDir(), 'repo'), { 'keep.txt': 'keep\n' });
        await writeFiles(repo, { 'notes/new.md': '# title\nbody\n', 'ignored.log': 'x\n', '.gitignore': '*.log\n' });
        expect((await diffForReview(repo)).map((file) => file.newPath)).toEqual([]);
        const files = await diffForReview(repo, { untracked: true });
        expect(files.map((file) => [file.newPath, file.status])).toEqual([
            ['.gitignore', 'added'],
            ['notes/new.md', 'added'],
        ]);
        const notes = only(files, 'notes/new.md');
        await stageHunks(repo, notes, [notes.hunks[0]?.id ?? '']);
        expect(git(repo, ['show', ':notes/new.md'])).toBe('# title\nbody\n');
        const gitignore = only(files, '.gitignore');
        await revertHunks(repo, gitignore, [gitignore.hunks[0]?.id ?? '']);
        expect(git(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('A  notes/new.md\n?? ignored.log\n');
    });

    it('diffs against a base commit, including committed changes', async () => {
        const repo = await initRepo(path.join(await temporaryDir(), 'repo'), { 'f.txt': original });
        const base = git(repo, ['rev-parse', 'HEAD']).trim();
        await writeFiles(repo, { 'g.txt': 'committed\n' });
        commitAll(repo, 'second');
        await writeFile(path.join(repo, 'f.txt'), edited);
        const files = await diffForReview(repo, { base });
        expect(files.map((file) => file.newPath).sort()).toEqual(['f.txt', 'g.txt']);
        const file = only(files, 'f.txt');
        await revertHunks(repo, file, [file.hunks[1]?.id ?? '']);
        expect(read(repo, 'f.txt')).not.toContain('line 20 changed');
        await expect(diffForReview(repo, { base: '--output=/tmp/x' })).rejects.toThrow(/invalid revision/);
    });
});
