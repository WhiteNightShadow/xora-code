import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    allocatePort,
    currentBranch,
    readCursorWorktreesJson,
    releasePort,
    WorktreeDirtyError,
    WorktreeLimitError,
    WorktreeManager,
} from '../src/index.ts';
import { commitAll, GIT_TIMEOUT, git, hasGit, initRepo, lines, read, temporaryDir, writeFiles } from './helpers.ts';

async function project(maxWorktrees?: number) {
    const root = await temporaryDir();
    const repo = await initRepo(path.join(root, 'repo'), {
        '.gitignore': '.env\nconfig/local.json\nbuild/\n',
        'f.txt': lines(10),
        'src/app.ts': 'export {};\n',
    });
    const rootDir = path.join(root, 'data', 'worktrees', 'project-1');
    const manager = new WorktreeManager({
        repoDir: repo,
        rootDir,
        ...(maxWorktrees === undefined ? {} : { maxWorktrees }),
    });
    return { root, repo, rootDir, manager };
}

describe.skipIf(!hasGit)('worktrees', { timeout: GIT_TIMEOUT }, () => {
    it('creates detached worktrees and copies the files .worktreeinclude selects', async () => {
        const { repo, rootDir, manager } = await project();
        await writeFiles(repo, {
            '.worktreeinclude': '# secrets the app needs\n.env\nconfig/local.json\n',
            '.env': 'TOKEN=1\n',
            'config/local.json': '{"debug":true}\n',
            'build/out.js': 'built\n',
            'extra.txt': 'untracked, asked for explicitly\n',
            'notes.txt': 'untracked, not asked for\n',
        });
        const created = await manager.create({ id: 'thread-1', include: ['extra.txt'] });
        expect(created.path).toBe(path.join(rootDir, 'thread-1'));
        expect(created.head).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
        expect([...created.copied].sort()).toEqual(['.env', 'config/local.json', 'extra.txt']);
        expect(read(created.path, 'config/local.json')).toBe('{"debug":true}\n');
        expect(existsSync(path.join(created.path, 'build'))).toBe(false);
        expect(existsSync(path.join(created.path, 'notes.txt'))).toBe(false);
        await expect(currentBranch(created.path)).resolves.toBeUndefined();

        const listed = await manager.list();
        expect(listed).toHaveLength(2);
        expect(listed[0]).toMatchObject({ main: true, branch: 'main', detached: false });
        expect(listed[0]?.id).toBeUndefined();
        expect(listed[1]).toMatchObject({ main: false, id: 'thread-1', detached: true, head: created.head });
        await expect(manager.create({ id: 'thread-1' })).rejects.toThrow(/already exists/);
        await expect(manager.create({ id: '../escape' })).rejects.toThrow(/invalid worktree id/);
    });

    it('enforces the worktree limit', async () => {
        const { manager } = await project(2);
        await manager.create({ id: 'a' });
        await expect(manager.checkLimit()).resolves.toEqual({ count: 1, max: 2, ok: true });
        await manager.create({ id: 'b' });
        await expect(manager.checkLimit()).resolves.toEqual({ count: 2, max: 2, ok: false });
        await expect(manager.create({ id: 'c' })).rejects.toBeInstanceOf(WorktreeLimitError);
    });

    it('refuses to remove a dirty worktree unless forced', async () => {
        const { manager } = await project();
        const clean = await manager.create({ id: 'clean' });
        const dirty = await manager.create({ id: 'dirty' });
        await writeFile(path.join(dirty.path, 'scratch.txt'), 'work in progress\n');

        await expect(manager.remove('dirty')).rejects.toBeInstanceOf(WorktreeDirtyError);
        expect(existsSync(path.join(dirty.path, 'scratch.txt'))).toBe(true);
        await manager.remove('clean');
        expect(existsSync(clean.path)).toBe(false);
        await manager.remove('dirty', { force: true });
        expect(existsSync(dirty.path)).toBe(false);
        expect((await manager.list()).map((entry) => entry.id)).toEqual([undefined]);
        // Removing again is a no-op.
        await manager.remove('dirty');
    });

    it('hands uncommitted work off to another checkout and cleans the source', async () => {
        const { repo, manager } = await project();
        const target = await manager.create({ id: 'thread-2' });
        await writeFiles(repo, {
            'f.txt': lines(10).replace('line 3', 'line 3 edited'),
            'staged-new.txt': 'staged\n',
            'docs/untracked.md': '# new\n',
            '.env': 'ignored, stays\n',
        });
        git(repo, ['add', 'staged-new.txt']);

        const result = await manager.handoff(repo, target.path);
        expect(result.status).toBe('moved');
        expect(result.sourceCleaned).toBe(true);
        expect([...result.tracked].sort()).toEqual(['f.txt', 'staged-new.txt']);
        expect(result.untracked).toEqual(['docs/untracked.md']);
        expect(read(target.path, 'f.txt')).toContain('line 3 edited');
        expect(read(target.path, 'staged-new.txt')).toBe('staged\n');
        expect(read(target.path, 'docs/untracked.md')).toBe('# new\n');
        // The source is back at HEAD; ignored files are not part of the work and stay.
        expect(git(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
        expect(existsSync(path.join(repo, 'docs'))).toBe(false);
        expect(read(repo, '.env')).toBe('ignored, stays\n');
        expect(existsSync(path.join(target.path, '.env'))).toBe(false);
    });

    it('merges into a checkout at another commit when the changes do not overlap', async () => {
        const { repo, manager } = await project();
        const source = await manager.create({ id: 'thread-3' });
        await writeFiles(repo, { 'f.txt': lines(10).replace('line 9', 'line 9 from main') });
        commitAll(repo, 'main moves on');
        await writeFiles(source.path, { 'f.txt': lines(10).replace('line 1\n', 'line 1 from thread\n') });

        const result = await manager.handoff(source.path, repo);
        expect(result.status).toBe('moved');
        expect(read(repo, 'f.txt')).toContain('line 1 from thread\n');
        expect(read(repo, 'f.txt')).toContain('line 9 from main\n');
        expect(git(source.path, ['status', '--porcelain'])).toBe('');
    });

    it('reports conflicts and leaves the source untouched', async () => {
        const { repo, manager } = await project();
        const source = await manager.create({ id: 'thread-4' });
        await writeFiles(repo, { 'f.txt': lines(10).replace('line 5', 'line 5 from main') });
        commitAll(repo, 'main changes line 5');
        await writeFiles(source.path, {
            'f.txt': lines(10).replace('line 5', 'line 5 from thread'),
            'new/file.txt': 'thread file\n',
        });
        const before = git(source.path, ['diff', 'HEAD']);

        const result = await manager.handoff(source.path, repo);
        expect(result.status).toBe('conflicts');
        expect(result.sourceCleaned).toBe(false);
        expect(result.conflicts).toEqual([{ path: 'f.txt', reason: 'merge conflict' }]);
        expect(read(repo, 'f.txt')).toContain('<<<<<<<');
        expect(git(source.path, ['diff', 'HEAD'])).toBe(before);
        expect(read(source.path, 'new/file.txt')).toBe('thread file\n');
    });

    it('fails without changing anything when untracked files would be overwritten', async () => {
        const { repo, manager } = await project();
        const target = await manager.create({ id: 'thread-5' });
        await writeFiles(repo, { 'f.txt': 'changed\n', 'clash.txt': 'from source\n' });
        await writeFiles(target.path, { 'clash.txt': 'already here\n' });

        const result = await manager.handoff(repo, target.path);
        expect(result.status).toBe('failed');
        expect(result.conflicts).toEqual([{ path: 'clash.txt', reason: 'exists in the destination' }]);
        expect(read(target.path, 'f.txt')).toBe(lines(10));
        expect(read(target.path, 'clash.txt')).toBe('already here\n');
        expect(read(repo, 'f.txt')).toBe('changed\n');
    });

    it('refuses checkouts of different repositories', async () => {
        const { repo, root, manager } = await project();
        const other = await initRepo(path.join(root, 'other'), { 'x.txt': 'x\n' });
        await writeFile(path.join(repo, 'f.txt'), 'changed\n');
        await expect(manager.handoff(repo, other)).rejects.toThrow(/same repository/);
        await expect(manager.handoff(repo, repo)).rejects.toThrow(/two different checkouts/);
    });
});

describe('allocatePort', () => {
    const servers: Server[] = [];

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    const occupy = (port: number): Promise<void> =>
        new Promise((resolve, reject) => {
            const server = createServer();
            servers.push(server);
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => resolve());
        });

    it('starts from the same port for the same id and skips busy ones', async () => {
        const range: [number, number] = [45100, 45199];
        const first = await allocatePort('worktree-a', range);
        expect(first).toBeGreaterThanOrEqual(45100);
        expect(first).toBeLessThanOrEqual(45199);
        await expect(allocatePort('worktree-a', range)).resolves.toBe(first);
        releasePort('worktree-a');
        await expect(allocatePort('worktree-a', range)).resolves.toBe(first);

        releasePort('worktree-a');
        await occupy(first);
        const second = await allocatePort('worktree-a', range);
        expect(second).not.toBe(first);
        releasePort('worktree-a');
    });

    it('never hands one port to two ids and fails when the range is exhausted', async () => {
        const port = await allocatePort('solo-1', [45250, 45250]);
        expect(port).toBe(45250);
        await expect(allocatePort('solo-2', [45250, 45250])).rejects.toThrow(/no free port/);
        releasePort('solo-1');
        await expect(allocatePort('solo-2', [45250, 45250])).resolves.toBe(45250);
        releasePort('solo-2');
        await expect(allocatePort('x', [2, 1])).rejects.toThrow(/invalid port range/);
    });

    it('gives concurrent requests different ports', async () => {
        // Room for a port another program on the machine holds.
        const range: [number, number] = [45300, 45399];
        const ports = await Promise.all([allocatePort('concurrent-1', range), allocatePort('concurrent-2', range)]);
        expect(new Set(ports).size).toBe(2);
        releasePort('concurrent-1');
        releasePort('concurrent-2');
    });
});

describe('readCursorWorktreesJson', () => {
    async function withConfig(content: string | undefined): Promise<string> {
        const dir = await temporaryDir();
        if (content !== undefined) {
            await mkdir(path.join(dir, '.cursor'));
            await writeFile(path.join(dir, '.cursor', 'worktrees.json'), content);
        }
        return dir;
    }

    it('tolerates missing and invalid files', async () => {
        await expect(readCursorWorktreesJson(await withConfig(undefined))).resolves.toBeUndefined();
        await expect(readCursorWorktreesJson(await withConfig('{ not json'))).resolves.toBeUndefined();
        await expect(readCursorWorktreesJson(await withConfig('[1, 2]'))).resolves.toBeUndefined();
        await expect(readCursorWorktreesJson(await withConfig('{"other": 1}'))).resolves.toBeUndefined();
    });

    it('reads setup commands, preferring the platform-specific key', async () => {
        const dir = await withConfig(
            JSON.stringify({
                'setup-worktree': ['pnpm install', 42, '', 'cp $ROOT_WORKTREE_PATH/.env .env'],
                'setup-worktree-windows': 'setup-worktree.ps1',
            }),
        );
        await expect(readCursorWorktreesJson(dir, 'darwin')).resolves.toEqual({
            setup: ['pnpm install', 'cp $ROOT_WORKTREE_PATH/.env .env'],
        });
        await expect(readCursorWorktreesJson(dir, 'win32')).resolves.toEqual({ setup: ['setup-worktree.ps1'] });
    });
});
