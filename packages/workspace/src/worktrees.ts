import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readlink, rm, symlink, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import {
    chunkPaths,
    lstatOrUndefined,
    nativePath,
    realpathOrResolve,
    removeEmptyParents,
    samePath,
    splitNul,
} from './files.ts';
import { assertRevision, GitError, gitOutput, outputLine, requireGitRoot, runGit } from './git.ts';
import { serialize } from './lock.ts';

export interface WorktreeManagerOptions {
    /** Any directory of the project's repository. */
    readonly repoDir: string;
    /** Where this project's worktrees live, for example `<data>/worktrees/<projectId>`. */
    readonly rootDir: string;
    /** Most worktrees kept under `rootDir` (default 15). */
    readonly maxWorktrees?: number;
}

export interface CreateWorktreeOptions {
    /** Directory name under `rootDir`, usually the thread id. */
    readonly id: string;
    /** Commit to check out, detached (default HEAD). */
    readonly ref?: string;
    /** Extra gitignore-style patterns of untracked or ignored files to copy, on top of `.worktreeinclude`. */
    readonly include?: readonly string[];
}

export interface CreatedWorktree {
    readonly path: string;
    readonly head: string;
    /** Repository-relative paths copied in through `.worktreeinclude` and `include`. */
    readonly copied: readonly string[];
}

export interface WorktreeInfo {
    readonly path: string;
    readonly head?: string;
    /** Short branch name; absent for a detached HEAD. */
    readonly branch?: string;
    readonly detached: boolean;
    readonly bare: boolean;
    readonly locked: boolean;
    readonly prunable: boolean;
    /** The repository's main checkout. */
    readonly main: boolean;
    /** Set for worktrees directly under `rootDir`, which this manager owns. */
    readonly id?: string;
}

export interface WorktreeLimit {
    readonly count: number;
    readonly max: number;
    /** Whether another worktree may be created. */
    readonly ok: boolean;
}

export interface HandoffConflict {
    readonly path: string;
    readonly reason: string;
}

export interface HandoffResult {
    /**
     * `moved`: the work now lives in the destination. `conflicts`: it was applied with conflict markers that need
     * resolving in the destination. `failed`: nothing was applied.
     */
    readonly status: 'moved' | 'conflicts' | 'failed';
    /** Tracked paths with uncommitted changes in the source. */
    readonly tracked: readonly string[];
    /** Untracked, non-ignored files in the source. */
    readonly untracked: readonly string[];
    readonly conflicts: readonly HandoffConflict[];
    /** Whether the moved work was removed from the source; never true unless `status` is `moved`. */
    readonly sourceCleaned: boolean;
    readonly message?: string;
}

export const DEFAULT_MAX_WORKTREES = 15;
export const DEFAULT_PORT_RANGE: readonly [number, number] = [41000, 41999];

export class WorktreeLimitError extends Error {
    readonly count: number;
    readonly max: number;

    constructor(count: number, max: number) {
        super(`this project already has ${count} worktrees (limit ${max})`);
        this.name = 'WorktreeLimitError';
        this.count = count;
        this.max = max;
    }
}

export class WorktreeDirtyError extends Error {
    readonly path: string;

    constructor(worktree: string) {
        super(`worktree has uncommitted or untracked changes: ${worktree}`);
        this.name = 'WorktreeDirtyError';
        this.path = worktree;
    }
}

const ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function assertId(id: string): void {
    if (!ID.test(id) || id.length > 128) {
        throw new Error(`invalid worktree id: ${JSON.stringify(id)}`);
    }
}

const user = (cwd: string) => ({ cwd, eol: 'user' as const });

function parseWorktreeList(text: string): Array<Omit<WorktreeInfo, 'main' | 'id'>> {
    const entries: Array<{
        path: string;
        head?: string;
        branch?: string;
        detached: boolean;
        bare: boolean;
        locked: boolean;
        prunable: boolean;
    }> = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('worktree ')) {
            entries.push({
                path: path.resolve(line.slice('worktree '.length)),
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
            });
            continue;
        }
        const current = entries.at(-1);
        if (!current) {
            continue;
        }
        if (line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        } else if (line === 'detached') {
            current.detached = true;
        } else if (line === 'bare') {
            current.bare = true;
        } else if (line === 'locked' || line.startsWith('locked ')) {
            current.locked = true;
        } else if (line === 'prunable' || line.startsWith('prunable ')) {
            current.prunable = true;
        }
    }
    return entries;
}

/** Copies a file or symbolic link, never overwriting. */
async function copyEntry(source: string, destination: string): Promise<boolean> {
    const info = await lstatOrUndefined(source);
    if (!info) {
        return false;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    if (info.isSymbolicLink()) {
        await symlink(await readlink(source), destination);
        return true;
    }
    if (info.isFile()) {
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        return true;
    }
    return false;
}

/**
 * Copies untracked and ignored files matching `.worktreeinclude` (gitignore syntax, at the repository root) and
 * `extra` into a new worktree. git does the matching: the patterns are handed to `ls-files --ignored` as exclude
 * rules, so they behave exactly like .gitignore lines.
 */
async function copyIncluded(root: string, target: string, extra: readonly string[]): Promise<string[]> {
    const includeFile = path.join(root, '.worktreeinclude');
    const hasFile = (await lstatOrUndefined(includeFile))?.isFile() === true;
    const patterns = extra.map((pattern) => pattern.trim()).filter((pattern) => pattern && !/[\r\n]/.test(pattern));
    if (!hasFile && patterns.length === 0) {
        return [];
    }
    const args = ['ls-files', '-z', '--others', '--ignored'];
    if (hasFile) {
        args.push(`--exclude-from=${includeFile}`);
    }
    for (const pattern of patterns) {
        args.push(`--exclude=${pattern}`);
    }
    const copied: string[] = [];
    for (const relative of splitNul(await gitOutput(args, user(root)))) {
        // Entries ending in "/" are nested repositories; never overwrite what the checkout already has.
        if (relative.endsWith('/') || (await lstatOrUndefined(nativePath(target, relative)))) {
            continue;
        }
        if (await copyEntry(nativePath(root, relative), nativePath(target, relative))) {
            copied.push(relative);
        }
    }
    return copied;
}

async function commonDir(root: string): Promise<string> {
    return realpathOrResolve(
        path.resolve(root, outputLine(await gitOutput(['rev-parse', '--git-common-dir'], user(root)))),
    );
}

const TRACKED_DIFF = ['diff', 'HEAD', '--no-renames', '--ignore-submodules=all', '--no-color', '--no-ext-diff'];

/** Uncommitted tracked changes (staged and unstaged) as a binary patch with full blob ids for `apply --3way`. */
function trackedPatch(root: string): Promise<Buffer> {
    return gitOutput(
        [...TRACKED_DIFF, '--binary', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--'],
        user(root),
    );
}

async function unmergedPaths(root: string): Promise<string[]> {
    const paths = new Set<string>();
    for (const record of splitNul(await gitOutput(['ls-files', '-z', '--unmerged'], user(root)))) {
        paths.add(record.slice(record.indexOf('\t') + 1));
    }
    return [...paths];
}

function applyErrors(stderr: string): HandoffConflict[] {
    const conflicts = new Map<string, string>();
    for (const line of stderr.split('\n')) {
        const failed = /^error: patch failed: (.+):\d+$/.exec(line);
        const other = /^error: (.+?): (.+)$/.exec(line);
        if (failed?.[1] && !conflicts.has(failed[1])) {
            conflicts.set(failed[1], 'patch does not apply');
        } else if (other?.[1] && other[2] && !conflicts.has(other[1])) {
            conflicts.set(other[1], other[2]);
        }
    }
    return [...conflicts].map(([file, reason]) => ({ path: file, reason }));
}

/**
 * Detached worktrees for one project under `rootDir`, plus moving uncommitted work between checkouts. Operations
 * on one repository run one at a time.
 */
export class WorktreeManager {
    readonly repoDir: string;
    readonly rootDir: string;
    readonly maxWorktrees: number;

    constructor(options: WorktreeManagerOptions) {
        this.repoDir = path.resolve(options.repoDir);
        this.rootDir = path.resolve(options.rootDir);
        this.maxWorktrees = options.maxWorktrees ?? DEFAULT_MAX_WORKTREES;
    }

    /**
     * `git worktree add --detach <rootDir>/<id> <ref>`, then copies the files selected by `.worktreeinclude` and
     * `include`. Throws {@link WorktreeLimitError} at the limit.
     */
    async create(options: CreateWorktreeOptions): Promise<CreatedWorktree> {
        assertId(options.id);
        const ref = options.ref ?? 'HEAD';
        assertRevision(ref);
        return serialize(this.#key(), async () => {
            const limit = await this.checkLimit();
            if (!limit.ok) {
                throw new WorktreeLimitError(limit.count, limit.max);
            }
            const root = await requireGitRoot(this.repoDir);
            const target = path.join(this.rootDir, options.id);
            if (await lstatOrUndefined(target)) {
                throw new Error(`worktree directory already exists: ${target}`);
            }
            await mkdir(this.rootDir, { recursive: true });
            await gitOutput(['worktree', 'add', '--detach', '--quiet', target, ref], user(root));
            try {
                const head = outputLine(await gitOutput(['rev-parse', 'HEAD'], user(target)));
                const copied = await copyIncluded(root, target, options.include ?? []);
                return { path: target, head, copied };
            } catch (error) {
                await runGit(['worktree', 'remove', '--force', target], user(root)).catch(() => undefined);
                await rm(target, { recursive: true, force: true });
                await runGit(['worktree', 'prune'], user(root)).catch(() => undefined);
                throw error;
            }
        });
    }

    /** Every worktree of the repository (`git worktree list --porcelain`), the main checkout first. */
    async list(): Promise<WorktreeInfo[]> {
        const root = await requireGitRoot(this.repoDir);
        const text = (await gitOutput(['worktree', 'list', '--porcelain'], user(root))).toString('utf8');
        const rootDir = await realpathOrResolve(this.rootDir);
        return Promise.all(
            parseWorktreeList(text).map(async (entry, index) => {
                const real = await realpathOrResolve(entry.path);
                const owned = samePath(path.dirname(real), rootDir);
                return { ...entry, main: index === 0, ...(owned ? { id: path.basename(real) } : {}) };
            }),
        );
    }

    /** How many worktrees this manager owns against its limit. */
    async checkLimit(): Promise<WorktreeLimit> {
        const count = (await this.list()).filter((entry) => entry.id !== undefined).length;
        return { count, max: this.maxWorktrees, ok: count < this.maxWorktrees };
    }

    /**
     * Removes a worktree created by this manager. A worktree with uncommitted or untracked changes is refused with
     * {@link WorktreeDirtyError} unless `force` is set.
     */
    async remove(id: string, options: { readonly force?: boolean } = {}): Promise<void> {
        assertId(id);
        await serialize(this.#key(), async () => {
            const root = await requireGitRoot(this.repoDir);
            const target = path.join(this.rootDir, id);
            if (await lstatOrUndefined(target)) {
                if (!options.force) {
                    const status = await gitOutput(
                        ['status', '--porcelain', '-z', '--untracked-files=all'],
                        user(target),
                    );
                    if (status.length > 0) {
                        throw new WorktreeDirtyError(target);
                    }
                }
                const args = ['worktree', 'remove', ...(options.force ? ['--force'] : []), target];
                const removed = await runGit(args, user(root));
                if (removed.code !== 0) {
                    if (!options.force) {
                        throw new GitError(args, removed.code, removed.stderr);
                    }
                    // No longer a registered worktree (its .git file is gone); it is still ours to delete.
                    await rm(target, { recursive: true, force: true });
                }
            }
            await gitOutput(['worktree', 'prune'], user(root));
        });
    }

    /**
     * Moves uncommitted work from one checkout of the repository to another: tracked changes travel as a binary
     * patch, untracked non-ignored files are copied. The patch goes onto the destination's files as they are, which
     * may hold uncommitted or untracked work of their own; when it does not fit them it is merged with
     * `git apply --3way`, whose results end up staged. Only after a clean apply are the tracked paths reset and the
     * copied files deleted in the source; on conflicts or failure the source is left exactly as it was.
     */
    async handoff(fromDir: string, toDir: string): Promise<HandoffResult> {
        return serialize(this.#key(), async () => {
            const [source, destination] = await Promise.all([requireGitRoot(fromDir), requireGitRoot(toDir)]);
            if (samePath(await realpathOrResolve(source), await realpathOrResolve(destination))) {
                throw new Error('handoff needs two different checkouts');
            }
            if (!samePath(await commonDir(source), await commonDir(destination))) {
                throw new Error('handoff needs two checkouts of the same repository');
            }
            const patch = await trackedPatch(source);
            const tracked = splitNul(await gitOutput([...TRACKED_DIFF, '--name-only', '-z', '--'], user(source)));
            const untracked = splitNul(
                await gitOutput(['ls-files', '-z', '--others', '--exclude-standard'], user(source)),
            ).filter((relative) => !relative.endsWith('/'));
            const result = (status: HandoffResult['status'], extra: Partial<HandoffResult> = {}): HandoffResult => ({
                status,
                tracked,
                untracked,
                conflicts: [],
                sourceCleaned: false,
                ...extra,
            });
            if (tracked.length === 0 && untracked.length === 0) {
                return result('moved', { sourceCleaned: true });
            }
            const collisions: HandoffConflict[] = [];
            for (const relative of untracked) {
                if (await lstatOrUndefined(nativePath(destination, relative))) {
                    collisions.push({ path: relative, reason: 'exists in the destination' });
                }
            }
            if (collisions.length > 0) {
                return result('failed', { conflicts: collisions, message: 'untracked files would be overwritten' });
            }
            let conflicts: HandoffConflict[] = [];
            // The destination's files as they are first: `--3way` works through the index, which refuses files
            // changed or untracked there, such as a project's own uncommitted work under a team's (06 §29).
            const direct =
                patch.length > 0
                    ? await runGit(['apply', '--whitespace=nowarn', '-'], { ...user(destination), input: patch })
                    : undefined;
            if (direct !== undefined && direct.code !== 0) {
                const unresolved = new Set(await unmergedPaths(destination));
                const applied = await runGit(['apply', '--3way', '--whitespace=nowarn', '-'], {
                    ...user(destination),
                    input: patch,
                });
                if (applied.code !== 0) {
                    const unmerged = (await unmergedPaths(destination)).filter((file) => !unresolved.has(file));
                    if (unmerged.length === 0) {
                        // git apply is all or nothing: the destination is unchanged.
                        return result('failed', {
                            conflicts: applyErrors(applied.stderr),
                            message: applied.stderr.trim(),
                        });
                    }
                    conflicts = unmerged.map((file) => ({ path: file, reason: 'merge conflict' }));
                }
            }
            const copied: Array<{ relative: string; size: number; mtimeMs: number }> = [];
            for (const relative of untracked) {
                const info = await lstatOrUndefined(nativePath(source, relative));
                if (info && (await copyEntry(nativePath(source, relative), nativePath(destination, relative)))) {
                    copied.push({ relative, size: info.size, mtimeMs: info.mtimeMs });
                }
            }
            if (conflicts.length > 0) {
                return result('conflicts', { conflicts, message: 'resolve the conflicts in the destination' });
            }
            // Clean the source only if nothing changed there while the work was being moved.
            if (!(await trackedPatch(source)).equals(patch)) {
                return result('moved', { message: 'the source changed during the handoff and was left as it is' });
            }
            for (const chunk of chunkPaths(tracked)) {
                await gitOutput(
                    ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...chunk],
                    user(source),
                );
            }
            const kept: HandoffConflict[] = [];
            for (const entry of copied) {
                const absolute = nativePath(source, entry.relative);
                const info = await lstatOrUndefined(absolute);
                if (info && info.size === entry.size && info.mtimeMs === entry.mtimeMs) {
                    await unlink(absolute);
                    await removeEmptyParents(source, entry.relative);
                } else if (info) {
                    kept.push({ path: entry.relative, reason: 'changed in the source during the handoff' });
                }
            }
            return result('moved', { conflicts: kept, sourceCleaned: kept.length === 0 });
        });
    }

    #key(): string {
        return `worktrees:${this.repoDir}`;
    }
}

const reservedPorts = new Map<string, number>();

function canListen(port: number, host?: string): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen({ port, ...(host ? { host } : {}), exclusive: true }, () => {
            server.close(() => resolve(true));
        });
    });
}

/**
 * A free TCP port for a worktree (exposed to it as `XORA_PORT`). The search starts at a position derived from a
 * hash of `id`, so the same worktree tends to get the same port, and skips ports already handed to other ids in
 * this process. The port stays reserved for `id` until {@link releasePort}.
 */
export async function allocatePort(id: string, range: readonly [number, number] = DEFAULT_PORT_RANGE): Promise<number> {
    const [low, high] = range;
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > 65535 || low > high) {
        throw new Error(`invalid port range ${low}-${high}`);
    }
    // One search at a time, so two ids probing concurrently cannot both pick the same free port.
    return serialize('xora:ports', async () => {
        const reserved = reservedPorts.get(id);
        if (reserved !== undefined && reserved >= low && reserved <= high) {
            return reserved;
        }
        const taken = new Set(reservedPorts.values());
        const size = high - low + 1;
        const start = createHash('sha1').update(id).digest().readUInt32BE(0) % size;
        for (let offset = 0; offset < size; offset++) {
            const port = low + ((start + offset) % size);
            if (taken.has(port)) {
                continue;
            }
            // Check the loopback address and the wildcard one: a dev server may bind either.
            if ((await canListen(port, '127.0.0.1')) && (await canListen(port))) {
                reservedPorts.set(id, port);
                return port;
            }
        }
        throw new Error(`no free port between ${low} and ${high}`);
    });
}

/** Forgets the port reserved for `id`. */
export function releasePort(id: string): void {
    reservedPorts.delete(id);
}

/**
 * Setup commands from Cursor's `.cursor/worktrees.json`, for compatibility. The platform-specific key
 * (`setup-worktree-unix` or `setup-worktree-windows`) wins over `setup-worktree`; a string value (Cursor's script
 * form) becomes a single command. Missing or invalid files give undefined.
 */
export async function readCursorWorktreesJson(
    repoDir: string,
    platform: NodeJS.Platform = process.platform,
): Promise<{ setup: string[] } | undefined> {
    let config: unknown;
    try {
        config = JSON.parse(await readFile(path.join(repoDir, '.cursor', 'worktrees.json'), 'utf8'));
    } catch {
        return undefined;
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        return undefined;
    }
    const record = config as Record<string, unknown>;
    const keys = [platform === 'win32' ? 'setup-worktree-windows' : 'setup-worktree-unix', 'setup-worktree'];
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') {
            return { setup: [value] };
        }
        if (Array.isArray(value)) {
            return { setup: value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') };
        }
    }
    return undefined;
}
