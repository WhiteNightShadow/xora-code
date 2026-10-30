import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { findGit } from '../src/index.ts';

// Tests must not depend on the developer's git configuration (signing, hooks, autocrlf, …).
const configDir = mkdtempSync(path.join(tmpdir(), 'xora-workspace-gitconfig-'));
export const globalConfigFile = path.join(configDir, 'gitconfig');
writeFileSync(globalConfigFile, '');
process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
process.env.GIT_CONFIG_NOSYSTEM = '1';

export const gitPath = findGit();
export const hasGit = gitPath !== undefined;
/** Generous: every test drives many git processes. */
export const GIT_TIMEOUT = 60_000;

const temporaryDirs: string[] = [];

afterEach(async () => {
    for (const dir of temporaryDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

afterAll(async () => {
    await rm(configDir, { recursive: true, force: true });
});

/** A fresh directory, resolved through symlinks (macOS puts tmpdir behind /var -> /private/var). */
export async function temporaryDir(): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'xora-workspace-test-')));
    temporaryDirs.push(dir);
    return dir;
}

/** Runs git synchronously for test setup and assertions. */
export function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): string {
    return execFileSync(gitPath ?? 'git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

export function gitBuffer(cwd: string, args: readonly string[], env: Record<string, string> = {}): Buffer {
    return execFileSync(gitPath ?? 'git', args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

export async function writeFiles(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }
}

export function read(root: string, relative: string): string {
    return readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

/** `git init` with a local identity and settings that keep commits deterministic. */
export async function initRepo(
    dir: string,
    files: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<string> {
    await mkdir(dir, { recursive: true });
    git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
    git(dir, ['config', 'user.name', 'Test User']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    if (Object.keys(files).length > 0) {
        await writeFiles(dir, files);
        commitAll(dir, 'initial');
    }
    return dir;
}

export function commitAll(dir: string, message: string): string {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '--no-verify', '-m', message]);
    return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Files in a tree of the shadow repository. */
export function treeFiles(gitDir: string, tree: string): string[] {
    return git(gitDir, ['ls-tree', '-r', '-z', '--name-only', tree], { GIT_DIR: gitDir })
        .split('\0')
        .filter(Boolean)
        .sort();
}

/** Every file under `.git` with its size, modification time and content hash. */
export function gitDirFingerprint(repo: string): Record<string, string> {
    const result: Record<string, string> = {};
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
            } else {
                const info = statSync(absolute);
                const hash = createHash('sha256').update(readFileSync(absolute)).digest('hex');
                result[path.relative(repo, absolute)] = `${info.size}:${info.mtimeMs}:${hash}`;
            }
        }
    };
    walk(path.join(repo, '.git'));
    return result;
}

export const lines = (count: number, map: (line: number) => string = (line) => `line ${line}`): string =>
    `${Array.from({ length: count }, (_, index) => map(index + 1)).join('\n')}\n`;
