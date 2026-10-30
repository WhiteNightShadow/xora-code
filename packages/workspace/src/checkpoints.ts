import { mkdir, readFile, readlink, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    blobId,
    chunkPaths,
    forEachLimit,
    hasSymlinkParent,
    isInside,
    looksBinary,
    lstatOrUndefined,
    nativePath,
    realpathOrResolve,
    removeEmptyParents,
    samePath,
    splitNul,
    unsafePathReason,
    writeFileAtomic,
    writeSymlinkAtomic,
} from './files.ts';
import { assertRevision, GitError, type GitResult, outputLine, runGit } from './git.ts';
import { serialize } from './lock.ts';

export interface CheckpointStoreOptions {
    /** The private shadow repository, for example `<data>/checkpoints/<projectId>.git`. */
    readonly gitDir: string;
    /** The user's project directory that snapshots capture. */
    readonly workTree: string;
    /** Untracked files larger than this stay out of snapshots (default 5 MiB). */
    readonly maxFileBytes?: number;
}

export interface Snapshot {
    readonly tree: string;
    readonly commit: string;
}

export interface SnapshotInfo {
    readonly commit: string;
    readonly tree: string;
    /** The previous snapshot under the same label. */
    readonly parent?: string;
    /** Committer date, ISO 8601. */
    readonly date: string;
    readonly message: string;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
    readonly path: string;
    /** Previous path of a renamed file. */
    readonly oldPath?: string;
    readonly status: FileChangeStatus;
    readonly additions: number;
    readonly deletions: number;
    readonly binary: boolean;
}

export interface FileVersions {
    /** Old and new text; both are null for binary files, and either is null when the file is absent on that side. */
    readonly oldText: string | null;
    readonly newText: string | null;
    readonly binary: boolean;
}

export interface RestoreOptions {
    /**
     * The tree the work tree is expected to match (normally the snapshot taken after the turn being undone). A path
     * whose current content differs from its blob there was edited later and is reported instead of overwritten.
     */
    readonly expectTree?: string;
    /** Skip the `expectTree` check. */
    readonly force?: boolean;
}

export type RestoreConflictReason =
    | 'invalid-path'
    | 'modified'
    | 'symlink-in-path'
    | 'not-a-file'
    | 'submodule'
    | 'write-failed';

export interface RestoreConflict {
    readonly path: string;
    readonly reason: RestoreConflictReason;
}

export interface RestoreResult {
    /** Paths that now hold their version from the tree (written, or already identical). */
    readonly restored: readonly string[];
    /** Paths absent from the tree that are now absent from disk. */
    readonly deleted: readonly string[];
    /** Paths left untouched. */
    readonly conflicts: readonly RestoreConflict[];
}

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

const INDEX_FILE = 'xora-index';
const STALE_LOCK_MS = 2 * 60 * 1000;
const IDENTITY_NAME = 'Xora Code';
const IDENTITY_EMAIL = 'xora@localhost';
const COMMIT_ENV = {
    GIT_AUTHOR_NAME: IDENTITY_NAME,
    GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
    GIT_COMMITTER_NAME: IDENTITY_NAME,
    GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
    GIT_AUTHOR_DATE: undefined,
    GIT_COMMITTER_DATE: undefined,
};
const CONFIG: ReadonlyArray<readonly [string, string]> = [
    ['user.name', IDENTITY_NAME],
    ['user.email', IDENTITY_EMAIL],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['core.autocrlf', 'false'],
    ['core.fsmonitor', 'false'],
    ['commit.gpgsign', 'false'],
];
/**
 * `$GIT_DIR/info/attributes` outranks every `.gitattributes`, so these settings switch off end-of-line conversion,
 * clean filters (git-lfs and friends), ident expansion and re-encoding: blobs hold the exact bytes from disk,
 * and restoring a blob reproduces the file.
 */
const ATTRIBUTES =
    '# Managed by Xora Code: snapshots keep file bytes exactly as they are on disk.\n' +
    '* -text -eol -filter -ident -working-tree-encoding\n';
const BLOCK_BEGIN = '# >>> xora-code managed block, regenerated before every snapshot >>>';
const BLOCK_END = '# <<< xora-code managed block <<<';
const LABEL = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

interface TreeEntry {
    readonly mode: string;
    readonly type: string;
    readonly oid: string;
}

type DiskState =
    | { readonly kind: 'missing' }
    | { readonly kind: 'file'; readonly data: Buffer; readonly executable: boolean }
    | { readonly kind: 'symlink'; readonly data: Buffer }
    | { readonly kind: 'other' };

function assertLabel(label: string): void {
    if (!LABEL.test(label) || label.includes('..') || /(\.lock|\.)(\/|$)/.test(label)) {
        throw new Error(`invalid checkpoint label: ${JSON.stringify(label)}`);
    }
}

/** A path as a gitignore pattern that matches exactly that path from the work tree root. */
function literalPattern(relative: string): string | undefined {
    if (/[\r\n]/.test(relative) || relative === '' || relative === './') {
        return undefined;
    }
    const directory = relative.endsWith('/');
    const body = (directory ? relative.slice(0, -1) : relative)
        .replace(/[\\*?[\]]/g, (char) => `\\${char}`)
        .replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length));
    return `/${body}${directory ? '/' : ''}`;
}

/** Replaces the managed block in an exclude file, keeping everything else as it is. */
function replaceManagedBlock(text: string, lines: readonly string[]): string {
    let outside = text;
    const start = text.indexOf(BLOCK_BEGIN);
    if (start !== -1) {
        const end = text.indexOf(BLOCK_END, start);
        const stop = end === -1 ? text.length : end + BLOCK_END.length;
        outside = text.slice(0, start) + text.slice(stop).replace(/^\r?\n/, '');
    }
    if (outside !== '' && !outside.endsWith('\n')) {
        outside += '\n';
    }
    return lines.length === 0 ? outside : `${outside}${BLOCK_BEGIN}\n${lines.join('\n')}\n${BLOCK_END}\n`;
}

async function writeIfChanged(file: string, content: string): Promise<void> {
    let current: string | undefined;
    try {
        current = await readFile(file, 'utf8');
    } catch {
        current = undefined;
    }
    if (current !== content) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
    }
}

/** Removes a lock file left behind by a git process that died more than two minutes ago. */
async function clearStaleLock(file: string): Promise<void> {
    try {
        const info = await stat(file);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
            await rm(file, { force: true });
        }
    } catch {
        // No lock.
    }
}

async function readDiskState(file: string): Promise<DiskState> {
    const info = await lstatOrUndefined(file);
    if (!info) {
        return { kind: 'missing' };
    }
    if (info.isSymbolicLink()) {
        return { kind: 'symlink', data: await readlink(file, { encoding: 'buffer' }) };
    }
    if (info.isFile()) {
        return { kind: 'file', data: await readFile(file), executable: (info.mode & 0o111) !== 0 };
    }
    return { kind: 'other' };
}

/** Whether the file on disk has the content (and kind) of a tree entry; a missing entry matches a missing file. */
function matchesEntry(state: DiskState, entry: TreeEntry | undefined): boolean {
    if (!entry) {
        return state.kind === 'missing';
    }
    if (entry.type !== 'blob') {
        return false;
    }
    if (state.kind === 'symlink') {
        return entry.mode === '120000' && blobId(state.data, entry.oid.length) === entry.oid;
    }
    if (state.kind === 'file') {
        return entry.mode !== '120000' && blobId(state.data, entry.oid.length) === entry.oid;
    }
    return false;
}

function parseNumstat(output: Buffer): Map<string, { additions: number; deletions: number; binary: boolean }> {
    const tokens = splitNul(output);
    const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    for (let index = 0; index < tokens.length; index++) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index] ?? '');
        if (!match) {
            continue;
        }
        let file = match[3] ?? '';
        if (file === '') {
            // A rename: the old and new paths follow as separate tokens.
            index += 2;
            file = tokens[index] ?? '';
        }
        const binary = match[1] === '-';
        stats.set(file, {
            additions: binary ? 0 : Number(match[1]),
            deletions: binary ? 0 : Number(match[2]),
            binary,
        });
    }
    return stats;
}

function parseNameStatus(output: Buffer): Array<{ path: string; oldPath?: string; status: FileChangeStatus }> {
    const tokens = splitNul(output);
    const entries: Array<{ path: string; oldPath?: string; status: FileChangeStatus }> = [];
    for (let index = 0; index < tokens.length; ) {
        const code = tokens[index++] ?? '';
        if (code === '') {
            continue;
        }
        const letter = code[0];
        if (letter === 'R' || letter === 'C') {
            const oldPath = tokens[index++] ?? '';
            const newPath = tokens[index++] ?? '';
            entries.push(
                letter === 'R' ? { path: newPath, oldPath, status: 'renamed' } : { path: newPath, status: 'added' },
            );
            continue;
        }
        const file = tokens[index++] ?? '';
        entries.push({ path: file, status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' });
    }
    return entries;
}

/**
 * Per-turn checkpoints in a private shadow repository whose work tree is the user's project. Everything goes
 * through `GIT_DIR`, `GIT_WORK_TREE` and a private `GIT_INDEX_FILE`, so the user's own `.git` (index, refs, hooks,
 * config) is never read or written. Snapshots stay reachable from `refs/xora/<label>`.
 */
export class CheckpointStore {
    readonly gitDir: string;
    readonly workTree: string;
    readonly maxFileBytes: number;
    #ready: Promise<void> | undefined;

    constructor(options: CheckpointStoreOptions) {
        this.gitDir = path.resolve(options.gitDir);
        this.workTree = path.resolve(options.workTree);
        this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        if (samePath(this.gitDir, this.workTree) || isInside(this.gitDir, this.workTree)) {
            throw new Error('the checkpoint repository must not contain the work tree');
        }
    }

    /** Creates the shadow repository if it is missing and applies its settings. Safe to call repeatedly. */
    init(): Promise<void> {
        this.#ready ??= serialize(this.gitDir, () => this.#initialize()).catch((error: unknown) => {
            this.#ready = undefined;
            throw error;
        });
        return this.#ready;
    }

    /**
     * Captures the current work tree: `add -A` into the private index, `write-tree`, then a commit on
     * `refs/xora/<label>` whose parent is the label's previous snapshot.
     */
    async snapshot(label: string): Promise<Snapshot> {
        assertLabel(label);
        await this.init();
        return serialize(this.gitDir, () => this.#snapshot(label));
    }

    /** Files that differ between two trees, with rename detection and line counts. */
    async changes(fromTree: string, toTree: string): Promise<FileChange[]> {
        assertRevision(fromTree);
        assertRevision(toTree);
        await this.init();
        const base = ['diff-tree', '-r', '-M', '-z', '--no-ext-diff', '--no-textconv'];
        const [nameStatus, numstat] = await Promise.all([
            this.#git([...base, '--name-status', fromTree, toTree]),
            this.#git([...base, '--numstat', fromTree, toTree]),
        ]);
        const stats = parseNumstat(numstat);
        return parseNameStatus(nameStatus).map((entry) => ({
            ...entry,
            ...(stats.get(entry.path) ?? { additions: 0, deletions: 0, binary: false }),
        }));
    }

    /** Unified diff between two trees, optionally limited to `paths` (include both sides of a rename). */
    async patch(fromTree: string, toTree: string, paths?: readonly string[]): Promise<string> {
        assertRevision(fromTree);
        assertRevision(toTree);
        await this.init();
        const base = [
            '--literal-pathspecs',
            'diff-tree',
            '-p',
            '-r',
            '-M',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            fromTree,
            toTree,
        ];
        if (!paths) {
            return (await this.#git(base)).toString('utf8');
        }
        const parts: Buffer[] = [];
        for (const chunk of chunkPaths(paths)) {
            parts.push(await this.#git([...base, '--', ...chunk]));
        }
        return Buffer.concat(parts).toString('utf8');
    }

    /** Both versions of one file for a side-by-side view; `oldPath` defaults to `filePath` (pass it for renames). */
    async fileVersions(fromTree: string, toTree: string, filePath: string, oldPath = filePath): Promise<FileVersions> {
        const [before, after] = await Promise.all([this.readBlob(fromTree, oldPath), this.readBlob(toTree, filePath)]);
        if (looksBinary(before) || looksBinary(after)) {
            return { oldText: null, newText: null, binary: true };
        }
        return { oldText: before?.toString('utf8') ?? null, newText: after?.toString('utf8') ?? null, binary: false };
    }

    /** Content of a file in a tree (a link's target for symbolic links), or null when the tree has no such file. */
    async readBlob(tree: string, filePath: string): Promise<Buffer | null> {
        assertRevision(tree);
        await this.init();
        const entry = (await this.#entries(tree, [filePath])).get(filePath);
        if (entry?.type !== 'blob') {
            return null;
        }
        return this.#git(['cat-file', 'blob', entry.oid]);
    }

    /**
     * Puts each path back to its version in `tree`, deleting it when the tree has none. With `expectTree` (and no
     * `force`) a path is only touched while its current content still equals its blob in `expectTree`; anything
     * else is reported as a conflict and left alone. Files are replaced atomically and get the executable bit
     * from the tree entry.
     */
    async restore(tree: string, paths: readonly string[], options: RestoreOptions = {}): Promise<RestoreResult> {
        assertRevision(tree);
        if (options.expectTree !== undefined) {
            assertRevision(options.expectTree);
        }
        await this.init();
        return serialize(this.gitDir, () => this.#restore(tree, paths, options));
    }

    /** Snapshots recorded under `label`, newest first. */
    async listSnapshots(label: string): Promise<SnapshotInfo[]> {
        assertLabel(label);
        await this.init();
        const ref = `refs/xora/${label}`;
        if (!(await this.#resolve(ref))) {
            return [];
        }
        const output = await this.#git([
            'log',
            '-z',
            '--no-color',
            '--no-show-signature',
            '--format=%H%x1f%T%x1f%P%x1f%cI%x1f%s',
            ref,
            '--',
        ]);
        return splitNul(output).map((record) => {
            const [commit = '', tree = '', parents = '', date = '', message = ''] = record.trim().split('\x1f');
            const parent = parents.split(' ')[0];
            return { commit, tree, ...(parent ? { parent } : {}), date, message };
        });
    }

    #run(
        args: readonly string[],
        options: {
            readonly work?: boolean;
            readonly input?: string | Uint8Array;
            readonly env?: Readonly<Record<string, string | undefined>>;
        } = {},
    ): Promise<GitResult> {
        return runGit(['-c', 'core.fsmonitor=false', ...args], {
            cwd: options.work ? this.workTree : this.gitDir,
            env: {
                GIT_DIR: this.gitDir,
                GIT_INDEX_FILE: path.join(this.gitDir, INDEX_FILE),
                GIT_WORK_TREE: options.work ? this.workTree : undefined,
                ...options.env,
            },
            ...(options.input === undefined ? {} : { input: options.input }),
        });
    }

    async #git(
        args: readonly string[],
        options: {
            readonly work?: boolean;
            readonly env?: Readonly<Record<string, string | undefined>>;
        } = {},
    ): Promise<Buffer> {
        const result = await this.#run(args, options);
        if (result.code !== 0) {
            throw new GitError(args, result.code, result.stderr);
        }
        return result.stdout;
    }

    async #resolve(ref: string): Promise<string | undefined> {
        const result = await this.#run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        return result.code === 0 ? outputLine(result.stdout) : undefined;
    }

    async #initialize(): Promise<void> {
        await mkdir(this.gitDir, { recursive: true });
        if (!(await lstatOrUndefined(path.join(this.gitDir, 'HEAD')))) {
            // With GIT_DIR set to the current directory git creates a bare repository there; snapshots always
            // name the work tree explicitly, so none is recorded in the config.
            await this.#git(['init', '--quiet']);
        }
        const current = new Map<string, string>();
        const listed = await this.#run(['config', '--local', '--list', '-z']);
        for (const item of splitNul(listed.stdout)) {
            const newline = item.indexOf('\n');
            current.set(newline === -1 ? item : item.slice(0, newline), newline === -1 ? '' : item.slice(newline + 1));
        }
        for (const [key, value] of CONFIG) {
            if (current.get(key) !== value) {
                await this.#git(['config', key, value]);
            }
        }
        await writeIfChanged(path.join(this.gitDir, 'info', 'attributes'), ATTRIBUTES);
    }

    async #snapshot(label: string): Promise<Snapshot> {
        const workTree = await stat(this.workTree).catch(() => undefined);
        if (!workTree?.isDirectory()) {
            throw new Error(`work tree does not exist: ${this.workTree}`);
        }
        await clearStaleLock(path.join(this.gitDir, `${INDEX_FILE}.lock`));
        await this.#refreshExcludes();
        // --ignore-errors keeps going past unreadable files and nested repositories without a commit; exit code 1
        // reports those, anything higher is fatal.
        const added = await this.#run(['add', '--all', '--ignore-errors'], { work: true });
        if (added.code !== 0 && added.code !== 1) {
            throw new GitError(['add', '--all'], added.code, added.stderr);
        }
        const tree = outputLine(await this.#git(['write-tree']));
        const ref = `refs/xora/${label}`;
        await clearStaleLock(`${path.join(this.gitDir, ...ref.split('/'))}.lock`);
        const parent = await this.#resolve(ref);
        const commitArgs = ['commit-tree', tree, '--no-gpg-sign', '-m', `xora checkpoint ${label}`];
        if (parent) {
            commitArgs.push('-p', parent);
        }
        const commit = outputLine(await this.#git(commitArgs, { env: COMMIT_ENV }));
        // The expected old value makes the update fail rather than drop a snapshot written by someone else.
        await this.#git(['update-ref', '-m', 'xora checkpoint', ref, commit, parent ?? '']);
        return { tree, commit };
    }

    /**
     * Regenerates the managed exclude block: the user's own `info/exclude` rules (which the shadow repository would
     * not otherwise see), the shadow repository itself if it lives inside the work tree, and untracked files over
     * `maxFileBytes`.
     */
    async #refreshExcludes(): Promise<void> {
        const base = [...this.#selfExclude(), ...(await this.#userExcludes())];
        await this.#writeExcludes(base);
        const large = await this.#largeUntracked();
        if (large.length > 0) {
            await this.#writeExcludes([...base, ...large]);
        }
    }

    #selfExclude(): string[] {
        if (!isInside(this.workTree, this.gitDir)) {
            return [];
        }
        const pattern = literalPattern(`${path.relative(this.workTree, this.gitDir).split(path.sep).join('/')}/`);
        return pattern ? [pattern] : [];
    }

    async #userExcludes(): Promise<string[]> {
        const probe = await runGit(['rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], {
            cwd: this.workTree,
            eol: 'user',
        });
        if (probe.code !== 0) {
            return [];
        }
        const [top, excludeFile] = probe.stdout.toString('utf8').split('\n');
        if (!top || !excludeFile) {
            return [];
        }
        if (samePath(await realpathOrResolve(top), await realpathOrResolve(this.workTree))) {
            let text = '';
            try {
                text = await readFile(path.resolve(this.workTree, excludeFile), 'utf8');
            } catch {
                return [];
            }
            return text
                .split(/\r?\n/)
                .filter((line) => line.trim() !== '' && !line.startsWith('#'))
                .filter((line) => line !== BLOCK_BEGIN && line !== BLOCK_END);
        }
        // The project is a subdirectory of a repository: rules from above it (parent .gitignore files, info/exclude)
        // never reach the shadow repository, so list what they ignore here and exclude those paths literally.
        const listed = await runGit(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], {
            cwd: this.workTree,
            eol: 'user',
        });
        if (listed.code !== 0) {
            return [];
        }
        return splitNul(listed.stdout)
            .map(literalPattern)
            .filter((pattern): pattern is string => pattern !== undefined);
    }

    async #largeUntracked(): Promise<string[]> {
        const candidates = splitNul(
            await this.#git(['ls-files', '-z', '--others', '--exclude-standard'], { work: true }),
        );
        const large: string[] = [];
        await forEachLimit(candidates, 32, async (relative) => {
            const info = await lstatOrUndefined(nativePath(this.workTree, relative));
            if (info?.isFile() && info.size > this.maxFileBytes) {
                large.push(relative);
            }
        });
        return large
            .sort()
            .map(literalPattern)
            .filter((pattern): pattern is string => pattern !== undefined);
    }

    async #writeExcludes(lines: readonly string[]): Promise<void> {
        const file = path.join(this.gitDir, 'info', 'exclude');
        let current = '';
        try {
            current = await readFile(file, 'utf8');
        } catch {
            current = '';
        }
        await writeIfChanged(file, replaceManagedBlock(current, lines));
    }

    /** Tree entries for exactly `paths` (no recursion into directories that are named). */
    async #entries(tree: string, paths: readonly string[]): Promise<Map<string, TreeEntry>> {
        const entries = new Map<string, TreeEntry>();
        const wanted = new Set(paths);
        for (const chunk of chunkPaths(paths)) {
            const output = await this.#git([
                '--literal-pathspecs',
                'ls-tree',
                '-z',
                '--full-tree',
                tree,
                '--',
                ...chunk,
            ]);
            for (const record of splitNul(output)) {
                const tab = record.indexOf('\t');
                const [mode = '', type = '', oid = ''] = record.slice(0, tab).split(' ');
                const file = record.slice(tab + 1);
                if (wanted.has(file)) {
                    entries.set(file, { mode, type, oid });
                }
            }
        }
        return entries;
    }

    async #restore(tree: string, paths: readonly string[], options: RestoreOptions): Promise<RestoreResult> {
        const restored: string[] = [];
        const deleted: string[] = [];
        const conflicts: RestoreConflict[] = [];
        const valid: string[] = [];
        for (const relative of new Set(paths)) {
            if (unsafePathReason(relative)) {
                conflicts.push({ path: relative, reason: 'invalid-path' });
            } else {
                valid.push(relative);
            }
        }
        const target = await this.#entries(tree, valid);
        const expected =
            options.expectTree !== undefined && !options.force
                ? await this.#entries(options.expectTree, valid)
                : undefined;
        for (const relative of valid) {
            const absolute = nativePath(this.workTree, relative);
            const want = target.get(relative);
            if (await hasSymlinkParent(this.workTree, relative)) {
                conflicts.push({ path: relative, reason: 'symlink-in-path' });
                continue;
            }
            if (want && want.type !== 'blob') {
                conflicts.push({ path: relative, reason: want.type === 'commit' ? 'submodule' : 'not-a-file' });
                continue;
            }
            const current = await readDiskState(absolute);
            if (current.kind === 'other') {
                conflicts.push({ path: relative, reason: 'not-a-file' });
                continue;
            }
            if (expected && !matchesEntry(current, expected.get(relative))) {
                conflicts.push({ path: relative, reason: 'modified' });
                continue;
            }
            try {
                if (!want) {
                    if (current.kind !== 'missing') {
                        await unlink(absolute);
                        await removeEmptyParents(this.workTree, relative);
                    }
                    deleted.push(relative);
                    continue;
                }
                const executable = want.mode === '100755';
                const sameMode =
                    current.kind !== 'file' || process.platform === 'win32' || current.executable === executable;
                if (!matchesEntry(current, want) || !sameMode) {
                    const data = await this.#git(['cat-file', 'blob', want.oid]);
                    if (want.mode === '120000') {
                        await writeSymlinkAtomic(absolute, data);
                    } else {
                        await writeFileAtomic(absolute, data, executable);
                    }
                }
                restored.push(relative);
            } catch {
                conflicts.push({ path: relative, reason: 'write-failed' });
            }
        }
        return { restored, deleted, conflicts };
    }
}
