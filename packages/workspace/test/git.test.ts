import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentBranch, findGit, GitUnavailableError, gitRoot, headCommit, isGitRepo, runGit } from '../src/index.ts';
import { GIT_TIMEOUT, git, hasGit, initRepo, temporaryDir } from './helpers.ts';

describe.skipIf(!hasGit)('git runner', { timeout: GIT_TIMEOUT }, () => {
    it('finds git on PATH and caches it', () => {
        const found = findGit();
        expect(found && path.isAbsolute(found)).toBe(true);
        expect(findGit()).toBe(found);
    });

    it('reports exit codes instead of throwing, and passes input on stdin', async () => {
        const dir = await temporaryDir();
        const failed = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
        expect(failed.code).not.toBe(0);
        expect(failed.stderr).toMatch(/not a git repository/);
        const hashed = await runGit(['hash-object', '--stdin'], { cwd: dir, input: 'hello\n' });
        expect(hashed).toMatchObject({ code: 0 });
        expect(hashed.stdout.toString()).toBe('ce013625030ba8dba906f756967f9e9ca394464a\n');
    });

    it('rejects oversized output, aborted commands and missing directories', async () => {
        const dir = await temporaryDir();
        await expect(runGit(['--version'], { cwd: dir, maxBuffer: 4 })).rejects.toThrow(/more than 4 bytes/);
        const controller = new AbortController();
        controller.abort();
        await expect(runGit(['--version'], { cwd: dir, signal: controller.signal })).rejects.toThrow(/abort/i);
        await expect(runGit(['--version'], { cwd: path.join(dir, 'missing') })).rejects.toThrow(
            /directory does not exist/,
        );
    });

    it('throws GitUnavailableError when git is not on PATH', async () => {
        const saved = process.env.PATH;
        process.env.PATH = '';
        try {
            expect(findGit({ refresh: true })).toBeUndefined();
            await expect(runGit(['--version'], { cwd: process.cwd() })).rejects.toBeInstanceOf(GitUnavailableError);
        } finally {
            process.env.PATH = saved;
            findGit({ refresh: true });
        }
    });

    it('answers repository questions', async () => {
        const root = await temporaryDir();
        const plain = path.join(root, 'plain');
        await mkdir(plain);
        const repo = await initRepo(path.join(root, 'repo'));
        await expect(headCommit(repo)).resolves.toBeUndefined();
        await expect(currentBranch(repo)).resolves.toBe('main');

        await initRepo(repo, { 'a.txt': 'a\n' });
        const head = git(repo, ['rev-parse', 'HEAD']).trim();
        await expect(isGitRepo(repo)).resolves.toBe(true);
        await expect(isGitRepo(plain)).resolves.toBe(false);
        await expect(isGitRepo(path.join(root, 'missing'))).resolves.toBe(false);
        await mkdir(path.join(repo, 'sub'));
        await expect(gitRoot(path.join(repo, 'sub'))).resolves.toBe(repo);
        await expect(gitRoot(plain)).resolves.toBeUndefined();
        await expect(headCommit(repo)).resolves.toBe(head);
        git(repo, ['checkout', '-q', '--detach']);
        await expect(currentBranch(repo)).resolves.toBeUndefined();
    });

    it('ignores repository-redirecting variables inherited from the environment', async () => {
        const root = await temporaryDir();
        const repo = await initRepo(path.join(root, 'repo'), { 'a.txt': 'a\n' });
        const plain = path.join(root, 'plain');
        await mkdir(plain);
        const saved = process.env.GIT_DIR;
        process.env.GIT_DIR = path.join(repo, '.git');
        try {
            await expect(isGitRepo(plain)).resolves.toBe(false);
        } finally {
            if (saved === undefined) {
                delete process.env.GIT_DIR;
            } else {
                process.env.GIT_DIR = saved;
            }
        }
    });
});
