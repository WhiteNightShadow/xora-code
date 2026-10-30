import { createHash, randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Largest markdown or JSON file the loaders read. */
export const MAX_TEXT_BYTES = 1024 * 1024;

export function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `stat` that follows symbolic links and returns `undefined` instead of throwing. */
export async function statOrUndefined(file: string): Promise<Stats | undefined> {
    try {
        return await stat(file);
    } catch {
        return undefined;
    }
}

export async function isDirectory(dir: string): Promise<boolean> {
    return (await statOrUndefined(dir))?.isDirectory() ?? false;
}

export async function isFile(file: string): Promise<boolean> {
    return (await statOrUndefined(file))?.isFile() ?? false;
}

/** Reads a UTF-8 file of at most `maxBytes`. */
export async function readText(file: string, maxBytes = MAX_TEXT_BYTES): Promise<string> {
    const info = await stat(file);
    if (info.size > maxBytes) {
        throw new Error(`file is larger than ${maxBytes} bytes`);
    }
    return readFile(file, 'utf8');
}

/** Directory entries sorted by name; an empty list when the directory does not exist. */
export async function listDir(dir: string): Promise<Dirent[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
            return [];
        }
        throw error;
    }
}

/** Whether `candidate` is `root` or below it. Both must be absolute and normalised the same way. */
export function isSameOrInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** `realpath`, or the resolved path when the file does not exist. */
export async function realOrResolved(file: string): Promise<string> {
    try {
        return await realpath(file);
    } catch {
        return path.resolve(file);
    }
}

export function toPosix(relative: string): string {
    return relative.split(path.sep).join('/');
}

/** Writes JSON through a temporary file and a rename, so readers never see half a file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await rename(temporary, file);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

export interface WalkOptions {
    /** Stop after this many files; the result is then marked truncated. */
    readonly maxFiles?: number;
    readonly maxDepth?: number;
    /** Skip names starting with a dot. */
    readonly skipHidden?: boolean;
}

/**
 * Regular files below `dir` as sorted POSIX relative paths. Symbolic links and special files are not followed or
 * listed.
 */
export async function walkFiles(
    dir: string,
    options: WalkOptions = {},
): Promise<{ files: string[]; truncated: boolean }> {
    const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
    const maxDepth = options.maxDepth ?? 32;
    const files: string[] = [];
    let truncated = false;
    const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
        for (const entry of await listDir(current)) {
            if (truncated) {
                return;
            }
            if (options.skipHidden && entry.name.startsWith('.')) {
                continue;
            }
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (depth < maxDepth) {
                    await walk(path.join(current, entry.name), relative, depth + 1);
                }
            } else if (entry.isFile()) {
                if (files.length >= maxFiles) {
                    truncated = true;
                    return;
                }
                files.push(relative);
            }
        }
    };
    await walk(dir, '', 0);
    return { files: files.sort(), truncated };
}

/**
 * SHA-256 over every regular file below `dir`: for each file in sorted POSIX path order, its path, a NUL, its byte
 * length, a NUL and its bytes. Symbolic links and special files are rejected, so the hash covers exactly what runs.
 */
export async function hashDirectory(dir: string): Promise<string> {
    const hash = createHash('sha256');
    const files: string[] = [];
    const walk = async (current: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(path.join(current, entry.name), relative);
            } else if (entry.isFile()) {
                files.push(relative);
            } else {
                throw new Error(`cannot hash ${relative}: not a regular file`);
            }
        }
    };
    await walk(dir, '');
    files.sort();
    for (const relative of files) {
        const bytes = await readFile(path.join(dir, ...relative.split('/')));
        hash.update(`${relative}\0${bytes.length}\0`);
        hash.update(bytes);
    }
    return hash.digest('hex');
}

export interface CopyLimits {
    readonly maxFiles: number;
    readonly maxBytes: number;
}

/**
 * Copies a plugin tree. `.git` directories are left out. A symbolic link to a file inside `source` is copied as a
 * regular file; links to directories or to anything outside `source` are skipped and reported through `warn`.
 */
export async function copyTree(
    source: string,
    target: string,
    limits: CopyLimits,
    warn: (message: string) => void,
): Promise<void> {
    const root = await realpath(source);
    let files = 0;
    let bytes = 0;
    const count = (size: number): void => {
        files++;
        bytes += size;
        if (files > limits.maxFiles) {
            throw new Error(`more than ${limits.maxFiles} files`);
        }
        if (bytes > limits.maxBytes) {
            throw new Error(`larger than ${limits.maxBytes} bytes`);
        }
    };
    const copyFileContent = async (from: string, to: string): Promise<void> => {
        const info = await stat(from);
        count(info.size);
        // Copy through memory with the source mode, so executable scripts stay executable and nothing is linked.
        await writeFile(to, await readFile(from), { flag: 'wx', mode: info.mode & 0o777 });
    };
    const walk = async (from: string, to: string, prefix: string): Promise<void> => {
        await mkdir(to, { recursive: true });
        for (const entry of await listDir(from)) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.name === '.git') {
                continue;
            }
            const sourcePath = path.join(from, entry.name);
            const targetPath = path.join(to, entry.name);
            if (entry.isSymbolicLink()) {
                let resolved: string;
                try {
                    resolved = await realpath(sourcePath);
                } catch {
                    warn(`skipped ${relative}: broken symbolic link`);
                    continue;
                }
                const info = await lstat(resolved);
                if (!isSameOrInside(root, resolved)) {
                    warn(`skipped ${relative}: symbolic link points outside the plugin`);
                } else if (!info.isFile()) {
                    warn(`skipped ${relative}: symbolic link to a directory`);
                } else {
                    await copyFileContent(resolved, targetPath);
                }
            } else if (entry.isDirectory()) {
                await walk(sourcePath, targetPath, relative);
            } else if (entry.isFile()) {
                await copyFileContent(sourcePath, targetPath);
            } else {
                warn(`skipped ${relative}: not a regular file`);
            }
        }
    };
    await walk(root, target, '');
}
