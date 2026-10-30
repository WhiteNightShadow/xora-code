import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, readlink, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/index.ts';
import {
    GIT_TIMEOUT,
    git,
    gitDirFingerprint,
    hasGit,
    initRepo,
    lines,
    read,
    temporaryDir,
    treeFiles,
    writeFiles,
} from './helpers.ts';

async function setup(options: { repo?: boolean; maxFileBytes?: number } = {}) {
    const root = await temporaryDir();
    const workTree = path.join(root, 'project');
    await mkdir(workTree, { recursive: true });
    if (options.repo) {
        await initRepo(workTree);
    }
    const gitDir = path.join(root, 'data', 'checkpoints', 'project.git');
    const store = new CheckpointStore({
        gitDir,
        workTree,
        ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    });
    return { root, workTree, gitDir, store };
}

describe.skipIf(!hasGit)('checkpoint snapshots', { timeout: GIT_TIMEOUT }, () => {
    it('snapshots a plain directory and chains snapshots per label', async () => {
        const { workTree, gitDir, store } = await setup();
        await writeFiles(workTree, { 'a.txt': 'one\n', 'src/b.txt': 'two\n' });
        const first = await store.snapshot('thread-1');
        expect(treeFiles(gitDir, first.tree)).toEqual(['a.txt', 'src/b.txt']);

        await writeFiles(workTree, { 'a.txt': 'one, edited\n' });
        const second = await store.snapshot('thread-1');
        expect(second.tree).not.toBe(first.tree);

        const history = await store.listSnapshots('thread-1');
        expect(history.map((entry) => entry.commit)).toEqual([second.commit, first.commit]);
        expect(history[0]).toMatchObject({ tree: second.tree, parent: first.commit });
        expect(history[1]?.parent).toBeUndefined();
        expect(Number.isNaN(Date.parse(history[0]?.date ?? ''))).toBe(false);
        await expect(store.listSnapshots('thread-2')).resolves.toEqual([]);
        // The project itself gains nothing.
        expect(existsSync(path.join(workTree, '.git'))).toBe(false);
        expect(git(gitDir, ['config', 'core.bare'], { GIT_DIR: gitDir }).trim()).toBe('true');
    });

    it('rejects labels that are not safe ref names', async () => {
        const { store } = await setup();
        for (const label of ['', '../x', 'a..b', 'x.lock', '-x', 'a b', 'x/']) {
            await expect(store.snapshot(label)).rejects.toThrow(/invalid checkpoint label/);
        }
    });

    it('snapshots a repository without touching its .git', async () => {
        const { workTree, gitDir, store } = await setup({ repo: true });
        await writeFiles(workTree, { 'tracked.txt': lines(5), 'secret.txt': 'local only\n' });
        git(workTree, ['add', 'tracked.txt']);
        git(workTree, ['commit', '-q', '-m', 'initial']);
        // A rule that only lives in the user's info/exclude must still keep the file out of snapshots.
        await writeFile(path.join(workTree, '.git', 'info', 'exclude'), '# local\nsecret.txt\n');
        await writeFiles(workTree, { 'tracked.txt': lines(6), 'new.txt': 'new\n' });
        // `git status` may refresh the index, so it runs before the fingerprint is taken.
        const status = git(workTree, ['status', '--porcelain']);
        const before = gitDirFingerprint(workTree);

        const first = await store.snapshot('t');
        expect(treeFiles(gitDir, first.tree)).toEqual(['new.txt', 'tracked.txt']);
        await writeFiles(workTree, { 'tracked.txt': lines(7) });
        const second = await store.snapshot('t');
        await store.changes(first.tree, second.tree);
        await store.patch(first.tree, second.tree);
        await store.restore(first.tree, ['tracked.txt'], { expectTree: second.tree });

        expect(gitDirFingerprint(workTree)).toEqual(before);
        expect(git(workTree, ['status', '--porcelain'])).toBe(status);
        expect(read(workTree, 'tracked.txt')).toBe(lines(6));
    });

    it('honours .gitignore files in the work tree', async () => {
        const { workTree, gitDir, store } = await setup();
        await writeFiles(workTree, {
            '.gitignore': 'dist/\n*.log\n',
            'keep.txt': 'keep\n',
            'dist/bundle.js': 'built\n',
            'debug.log': 'noise\n',
            'sub/.gitignore': 'local.json\n',
            'sub/local.json': '{}\n',
            'sub/code.ts': 'export {};\n',
        });
        const { tree } = await store.snapshot('t');
        expect(treeFiles(gitDir, tree)).toEqual(['.gitignore', 'keep.txt', 'sub/.gitignore', 'sub/code.ts']);
    });

    it('leaves untracked files over the size limit out, and takes them once they shrink', async () => {
        const { workTree, gitDir, store } = await setup({ maxFileBytes: 1024 });
        await writeFiles(workTree, {
            'small.txt': 'small\n',
            'big [1].bin': Buffer.alloc(4096, 1),
            'nested/big*.dat': Buffer.alloc(2048, 2),
        });
        const first = await store.snapshot('t');
        expect(treeFiles(gitDir, first.tree)).toEqual(['small.txt']);
        const exclude = readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8');
        expect(exclude).toContain('/big \\[1\\].bin');
        expect(exclude).toContain('/nested/big\\*.dat');

        await writeFiles(workTree, { 'big [1].bin': 'now small\n' });
        const second = await store.snapshot('t');
        expect(treeFiles(gitDir, second.tree)).toEqual(['big [1].bin', 'small.txt']);
    });

    it('mirrors ignore rules from above when the project is a subdirectory of a repository', async () => {
        const root = await temporaryDir();
        const repo = await initRepo(path.join(root, 'repo'), { '.gitignore': 'node_modules/\n*.tmp\n' });
        await writeFile(path.join(repo, '.git', 'info', 'exclude'), 'private/\n');
        const workTree = path.join(repo, 'packages', 'app');
        await writeFiles(workTree, {
            'index.ts': 'export {};\n',
            'node_modules/dep/index.js': 'module.exports = 1;\n',
            'scratch.tmp': 'x\n',
            'private/notes.md': 'x\n',
        });
        const gitDir = path.join(root, 'checkpoints', 'app.git');
        const store = new CheckpointStore({ gitDir, workTree });
        const { tree } = await store.snapshot('t');
        expect(treeFiles(gitDir, tree)).toEqual(['index.ts']);
    });

    it('serialises concurrent snapshots and restores', async () => {
        const { workTree, store } = await setup();
        await writeFiles(workTree, { 'a.txt': '0\n' });
        const base = await store.snapshot('base');
        await writeFiles(workTree, { 'a.txt': 'changed\n' });
        // Without serialisation the parallel `git add` runs would fail on the shared index lock.
        const snapshots = Array.from({ length: 6 }, async (_, index) => {
            await writeFiles(workTree, { [`file-${index}.txt`]: `${index}\n` });
            return store.snapshot(index % 2 === 0 ? 'even' : 'odd');
        });
        const restores = [store.restore(base.tree, ['a.txt']), store.restore(base.tree, ['a.txt'])];
        const results = await Promise.all(snapshots);
        expect(results.every((result) => /^[0-9a-f]{40,64}$/.test(result.tree))).toBe(true);
        for (const restored of await Promise.all(restores)) {
            expect(restored).toEqual({ restored: ['a.txt'], deleted: [], conflicts: [] });
        }
        expect(read(workTree, 'a.txt')).toBe('0\n');
        const even = await store.listSnapshots('even');
        const odd = await store.listSnapshots('odd');
        expect(even).toHaveLength(3);
        expect(odd).toHaveLength(3);
        expect(even[0]?.parent).toBe(even[1]?.commit);
        expect(odd[1]?.parent).toBe(odd[2]?.commit);
    });

    it('recovers from a stale index lock', async () => {
        const { workTree, gitDir, store } = await setup();
        await writeFiles(workTree, { 'a.txt': 'a\n' });
        await store.init();
        const lock = path.join(gitDir, 'xora-index.lock');
        await writeFile(lock, '');
        const old = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(lock, old, old);
        await expect(store.snapshot('t')).resolves.toMatchObject({ tree: expect.any(String) });
        expect(existsSync(lock)).toBe(false);
    });
});

describe.skipIf(!hasGit)('checkpoint diffs', { timeout: GIT_TIMEOUT }, () => {
    it('reports added, modified, deleted, renamed and binary files', async () => {
        const { workTree, store } = await setup();
        const renamed = lines(30, (line) => `stable content ${line}`);
        await writeFiles(workTree, {
            'keep.txt': 'keep\n',
            'modify.txt': 'one\ntwo\nthree\n',
            'delete.txt': 'gone\n',
            'rename-me.txt': renamed,
            'image.bin': Buffer.from([0, 1, 2, 3, 0, 5]),
        });
        const before = await store.snapshot('t');
        await writeFiles(workTree, {
            'modify.txt': 'one\nTWO\nthree\nfour\n',
            'added.txt': 'hello\n',
            'renamed.txt': renamed,
            'image.bin': Buffer.from([0, 9, 9, 9, 0, 5]),
        });
        await unlink(path.join(workTree, 'delete.txt'));
        await unlink(path.join(workTree, 'rename-me.txt'));
        const after = await store.snapshot('t');

        const changes = (await store.changes(before.tree, after.tree)).sort((a, b) => a.path.localeCompare(b.path));
        expect(changes).toEqual([
            { path: 'added.txt', status: 'added', additions: 1, deletions: 0, binary: false },
            { path: 'delete.txt', status: 'deleted', additions: 0, deletions: 1, binary: false },
            { path: 'image.bin', status: 'modified', additions: 0, deletions: 0, binary: true },
            { path: 'modify.txt', status: 'modified', additions: 2, deletions: 1, binary: false },
            {
                path: 'renamed.txt',
                oldPath: 'rename-me.txt',
                status: 'renamed',
                additions: 0,
                deletions: 0,
                binary: false,
            },
        ]);

        const patch = await store.patch(before.tree, after.tree);
        expect(patch).toContain('diff --git a/modify.txt b/modify.txt');
        expect(patch).toContain('rename from rename-me.txt');
        expect(patch).toContain('Binary files a/image.bin and b/image.bin differ');
        const limited = await store.patch(before.tree, after.tree, ['modify.txt']);
        expect(limited).toContain('+TWO');
        expect(limited).not.toContain('added.txt');

        await expect(store.fileVersions(before.tree, after.tree, 'modify.txt')).resolves.toEqual({
            oldText: 'one\ntwo\nthree\n',
            newText: 'one\nTWO\nthree\nfour\n',
            binary: false,
        });
        await expect(store.fileVersions(before.tree, after.tree, 'added.txt')).resolves.toEqual({
            oldText: null,
            newText: 'hello\n',
            binary: false,
        });
        await expect(store.fileVersions(before.tree, after.tree, 'delete.txt')).resolves.toMatchObject({
            oldText: 'gone\n',
            newText: null,
        });
        await expect(store.fileVersions(before.tree, after.tree, 'image.bin')).resolves.toEqual({
            oldText: null,
            newText: null,
            binary: true,
        });
        await expect(
            store.fileVersions(before.tree, after.tree, 'renamed.txt', 'rename-me.txt'),
        ).resolves.toMatchObject({ oldText: renamed, newText: renamed });
        await expect(store.readBlob(after.tree, 'missing.txt')).resolves.toBeNull();
        await expect(store.readBlob(after.tree, 'keep.txt')).resolves.toEqual(Buffer.from('keep\n'));
    });

    it('keeps bytes exactly, including CRLF line endings that .gitattributes would normalise', async () => {
        const { workTree, store } = await setup();
        await writeFiles(workTree, { '.gitattributes': '* text=auto eol=lf\n', 'win.txt': 'a\r\nb\r\n' });
        const { tree } = await store.snapshot('t');
        await expect(store.readBlob(tree, 'win.txt')).resolves.toEqual(Buffer.from('a\r\nb\r\n'));
    });
});

describe.skipIf(!hasGit)('checkpoint restore', { timeout: GIT_TIMEOUT }, () => {
    async function turn() {
        const context = await setup();
        const { workTree, store } = context;
        await writeFiles(workTree, { 'a.txt': 'original a\n', 'b.txt': 'original b\n', 'c.txt': 'untouched\n' });
        const before = await store.snapshot('t');
        // The agent's turn.
        await writeFiles(workTree, { 'a.txt': 'agent a\n', 'deep/dir/new.txt': 'agent new\n' });
        await unlink(path.join(workTree, 'b.txt'));
        const after = await store.snapshot('t');
        const paths = (await store.changes(before.tree, after.tree)).map((change) => change.path);
        return { ...context, before, after, paths };
    }

    it('puts files back as they were before the turn', async () => {
        const { workTree, store, before, after, paths } = await turn();
        const result = await store.restore(before.tree, paths, { expectTree: after.tree });
        expect(result.conflicts).toEqual([]);
        expect([...result.restored].sort()).toEqual(['a.txt', 'b.txt']);
        expect(result.deleted).toEqual(['deep/dir/new.txt']);
        expect(read(workTree, 'a.txt')).toBe('original a\n');
        expect(read(workTree, 'b.txt')).toBe('original b\n');
        expect(read(workTree, 'c.txt')).toBe('untouched\n');
        // Directories the turn created are gone with their last file.
        expect(existsSync(path.join(workTree, 'deep'))).toBe(false);
    });

    it('does not overwrite files the user edited after the turn', async () => {
        const { workTree, store, before, after, paths } = await turn();
        await writeFiles(workTree, { 'a.txt': 'user edit\n', 'b.txt': 'user recreated b\n' });
        const result = await store.restore(before.tree, paths, { expectTree: after.tree });
        expect([...result.conflicts].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
            { path: 'a.txt', reason: 'modified' },
            { path: 'b.txt', reason: 'modified' },
        ]);
        expect(result.deleted).toEqual(['deep/dir/new.txt']);
        expect(read(workTree, 'a.txt')).toBe('user edit\n');
        expect(read(workTree, 'b.txt')).toBe('user recreated b\n');
    });

    it('overwrites later edits with force', async () => {
        const { workTree, store, before, after, paths } = await turn();
        await writeFiles(workTree, { 'a.txt': 'user edit\n' });
        const result = await store.restore(before.tree, paths, { expectTree: after.tree, force: true });
        expect(result.conflicts).toEqual([]);
        expect(read(workTree, 'a.txt')).toBe('original a\n');
    });

    it('refuses paths outside the work tree or inside .git', async () => {
        const { workTree, store, before } = await turn();
        await mkdir(path.join(workTree, '.git'), { recursive: true });
        await writeFile(path.join(workTree, '.git', 'config'), 'keep me');
        const result = await store.restore(before.tree, ['../escape.txt', '.git/config', '/etc/hosts', 'a/./b'], {
            force: true,
        });
        expect(result.conflicts.map((conflict) => conflict.reason)).toEqual([
            'invalid-path',
            'invalid-path',
            'invalid-path',
            'invalid-path',
        ]);
        expect(read(workTree, '.git/config')).toBe('keep me');
    });

    it.skipIf(process.platform === 'win32')('refuses to write through a symbolic link directory', async () => {
        const { root, workTree, store, before } = await turn();
        const outside = path.join(root, 'outside');
        await mkdir(outside);
        await rm(path.join(workTree, 'deep'), { recursive: true, force: true });
        await symlink(outside, path.join(workTree, 'deep'));
        const result = await store.restore(before.tree, ['deep/dir/new.txt'], { force: true });
        expect(result.conflicts).toEqual([{ path: 'deep/dir/new.txt', reason: 'symlink-in-path' }]);
    });

    it.skipIf(process.platform === 'win32')('restores symbolic links as links', async () => {
        const { workTree, store } = await setup();
        await writeFiles(workTree, { 'target.txt': 'target\n' });
        await symlink('target.txt', path.join(workTree, 'link'));
        const before = await store.snapshot('t');
        await unlink(path.join(workTree, 'link'));
        await writeFiles(workTree, { link: 'now a plain file\n' });
        const after = await store.snapshot('t');
        const result = await store.restore(before.tree, ['link'], { expectTree: after.tree });
        expect(result).toEqual({ restored: ['link'], deleted: [], conflicts: [] });
        expect((await lstat(path.join(workTree, 'link'))).isSymbolicLink()).toBe(true);
        await expect(readlink(path.join(workTree, 'link'))).resolves.toBe('target.txt');
        // The link now matches the tree, so restoring again with the link as the expected state is a no-op.
        await expect(store.restore(before.tree, ['link'], { expectTree: before.tree })).resolves.toEqual({
            restored: ['link'],
            deleted: [],
            conflicts: [],
        });
    });

    it.skipIf(process.platform === 'win32')('restores the executable bit from the tree entry', async () => {
        const { workTree, store } = await setup();
        await writeFiles(workTree, { 'run.sh': '#!/bin/sh\necho hi\n', 'plain.txt': 'plain\n' });
        await chmod(path.join(workTree, 'run.sh'), 0o755);
        const before = await store.snapshot('t');
        await writeFiles(workTree, { 'run.sh': '#!/bin/sh\necho changed\n' });
        await chmod(path.join(workTree, 'run.sh'), 0o644);
        await chmod(path.join(workTree, 'plain.txt'), 0o755);
        const after = await store.snapshot('t');
        const result = await store.restore(before.tree, ['run.sh', 'plain.txt'], { expectTree: after.tree });
        expect(result.conflicts).toEqual([]);
        expect(statSync(path.join(workTree, 'run.sh')).mode & 0o111).not.toBe(0);
        expect(statSync(path.join(workTree, 'plain.txt')).mode & 0o111).toBe(0);
        expect(read(workTree, 'run.sh')).toBe('#!/bin/sh\necho hi\n');
    });
});
