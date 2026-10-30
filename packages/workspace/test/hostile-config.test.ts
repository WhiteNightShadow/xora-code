import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CheckpointStore, diffForReview, revertHunks, stageHunks, WorktreeManager } from '../src/index.ts';
import {
    GIT_TIMEOUT,
    git,
    globalConfigFile,
    hasGit,
    initRepo,
    lines,
    read,
    temporaryDir,
    writeFiles,
} from './helpers.ts';

/**
 * Settings a user may well have globally that would break naive callers: signing that cannot work, diffs without
 * a/ b/ prefixes, colour, an external diff tool, zero context, whitespace errors, signature display, and
 * `autocrlf=true` (the Git for Windows default).
 */
const HOSTILE = [
    '[core]',
    '\tautocrlf = true',
    '\tquotepath = true',
    '[diff]',
    '\tnoprefix = true',
    '\tmnemonicPrefix = true',
    '\texternal = /nonexistent/difftool',
    '\tcontext = 0',
    '[color]',
    '\tui = always',
    '[commit]',
    '\tgpgSign = true',
    '[gpg]',
    '\tprogram = /nonexistent/gpg',
    '[apply]',
    '\twhitespace = error',
    '[log]',
    '\tshowSignature = true',
    '[status]',
    '\tshowUntrackedFiles = no',
    '',
].join('\n');

describe.skipIf(!hasGit)('with a hostile global git configuration', { timeout: GIT_TIMEOUT }, () => {
    beforeAll(() => {
        writeFileSync(globalConfigFile, HOSTILE);
    });

    afterAll(() => {
        writeFileSync(globalConfigFile, '');
    });

    it('still snapshots, diffs and restores byte for byte', async () => {
        const root = await temporaryDir();
        const workTree = path.join(root, 'project');
        await writeFiles(workTree, { 'a.txt': 'a\r\nb\r\n', 'b.txt': lines(3), 'späce name.txt': 'x\n' });
        const store = new CheckpointStore({ gitDir: path.join(root, 'shadow.git'), workTree });
        const before = await store.snapshot('t');
        await writeFiles(workTree, { 'a.txt': 'changed\r\n', 'späce name.txt': 'y\n' });
        const after = await store.snapshot('t');

        const changes = await store.changes(before.tree, after.tree);
        expect(changes.map((change) => change.path).sort()).toEqual(['a.txt', 'späce name.txt']);
        const patch = await store.patch(before.tree, after.tree);
        expect(patch).toContain('diff --git a/späce name.txt b/späce name.txt');
        expect(patch).not.toContain('\u001b[');
        const history = await store.listSnapshots('t');
        expect(history).toHaveLength(2);
        const result = await store.restore(
            before.tree,
            changes.map((change) => change.path),
            { expectTree: after.tree },
        );
        expect(result.conflicts).toEqual([]);
        expect(readFileSync(path.join(workTree, 'a.txt'), 'latin1')).toBe('a\r\nb\r\n');
    });

    it('reviews, stages and reverts hunks using the user end-of-line settings', async () => {
        const root = await temporaryDir();
        const repo = await initRepo(path.join(root, 'repo'), { 'f.txt': lines(12) });
        git(repo, ['config', '--unset', 'core.autocrlf']);
        git(repo, ['config', '--unset', 'commit.gpgsign']);
        // Checked out with autocrlf=true, the worktree's files get CRLF endings, as on Windows.
        const manager = new WorktreeManager({ repoDir: repo, rootDir: path.join(root, 'worktrees') });
        const worktree = await manager.create({ id: 'crlf' });
        expect(readFileSync(path.join(worktree.path, 'f.txt'), 'latin1')).toContain('line 1\r\n');
        await expect(diffForReview(worktree.path)).resolves.toEqual([]);

        const edited = lines(12, (line) =>
            line === 2 ? 'line 2 edited  ' : line === 11 ? 'line 11 edited' : `line ${line}`,
        );
        await writeFile(path.join(worktree.path, 'f.txt'), edited.replaceAll('\n', '\r\n'));
        const [file] = await diffForReview(worktree.path);
        expect(file?.hunks).toHaveLength(2);
        if (!file) {
            throw new Error('no diff');
        }
        // The first hunk adds trailing whitespace, which apply.whitespace=error would reject.
        await stageHunks(worktree.path, file, [file.hunks[0]?.id ?? '']);
        expect(git(worktree.path, ['show', ':f.txt'])).toContain('line 2 edited  \n');
        await revertHunks(worktree.path, file, [file.hunks[1]?.id ?? '']);
        const content = read(worktree.path, 'f.txt');
        expect(content).toContain('line 11\r\n');
        expect(content).toContain('line 2 edited  \r\n');
    });
});
