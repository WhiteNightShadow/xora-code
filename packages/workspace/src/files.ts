import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Splits NUL-terminated git output (`-z`) into UTF-8 strings. */
export function splitNul(output: Buffer): string[] {
    const items = output.toString('utf8').split('\0');
    if (items.at(-1) === '') {
        items.pop();
    }
    return items;
}

/**
 * Groups paths so that no command line grows past `maxChars`; Windows caps a whole command line at 32767
 * characters.
 */
export function chunkPaths(paths: readonly string[], maxChars = 8000): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let length = 0;
    for (const item of paths) {
        if (current.length > 0 && length + item.length + 1 > maxChars) {
            chunks.push(current);
            current = [];
            length = 0;
        }
        current.push(item);
        length += item.length + 1;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}

/** A repository-relative POSIX path as a native path below `root`. */
export function nativePath(root: string, relative: string): string {
    return path.join(root, ...relative.replace(/\/$/, '').split('/'));
}

/**
 * Why a caller-supplied repository path must not be written to, or undefined when it is safe: it has to be a
 * relative POSIX path that stays below the root and never enters a `.git` directory.
 */
export function unsafePathReason(relative: string): string | undefined {
    if (!relative || relative.includes('\0')) {
        return 'empty';
    }
    if (relative.startsWith('/') || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
        return 'absolute';
    }
    if (process.platform === 'win32' && /[\\:]/.test(relative)) {
        return 'separator';
    }
    for (const segment of relative.split('/')) {
        if (segment === '' || segment === '.' || segment === '..') {
            return 'traversal';
        }
        // Windows ignores trailing dots and spaces, and `git~1` is the short name of `.git`.
        const folded = segment.toLowerCase().replace(/[. ]+$/, '');
        if (folded === '.git' || folded === 'git~1') {
            return 'git-directory';
        }
    }
    return undefined;
}

/** Whether a directory between `root` and `relative` is a symbolic link, which could redirect writes elsewhere. */
export async function hasSymlinkParent(root: string, relative: string): Promise<boolean> {
    const segments = relative.split('/');
    segments.pop();
    let current = root;
    for (const segment of segments) {
        current = path.join(current, segment);
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink()) {
                return true;
            }
            if (!info.isDirectory()) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return false;
}

/** Removes directories left empty by deleting `relative`, up to (not including) `root`. */
export async function removeEmptyParents(root: string, relative: string): Promise<void> {
    const segments = relative.split('/');
    segments.pop();
    while (segments.length > 0) {
        try {
            await rmdir(path.join(root, ...segments));
        } catch {
            return;
        }
        segments.pop();
    }
}

function temporarySibling(file: string): string {
    // Short on purpose: appending to a long file name could exceed the file system's name limit.
    return path.join(path.dirname(file), `.xora-${randomBytes(6).toString('hex')}.tmp`);
}

/** Writes through a temporary file and a rename, so readers see either the old or the new content. */
export async function writeFileAtomic(file: string, data: Uint8Array, executable: boolean): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = temporarySibling(file);
    try {
        // Like git, start from 0777/0666 and let the umask decide the final permissions.
        await writeFile(temporary, data, { mode: executable ? 0o777 : 0o666, flag: 'wx' });
        await rename(temporary, file);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

/**
 * Replaces `file` with a symbolic link to `target` atomically. Where links cannot be created (Windows without
 * developer mode) it writes the target as a plain file, which is what git does with `core.symlinks=false`.
 */
export async function writeSymlinkAtomic(file: string, target: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = temporarySibling(file);
    try {
        await symlink(target.toString('utf8'), temporary);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
            await writeFileAtomic(file, target, false);
            return;
        }
        throw error;
    }
    try {
        await rename(temporary, file);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

/** git's binary heuristic: a NUL byte within the first 8000 bytes. */
export function looksBinary(data: Uint8Array | null | undefined): boolean {
    return data ? data.subarray(0, 8000).includes(0) : false;
}

/** The blob id git would give `content`; the algorithm follows the length of a known id (SHA-1 or SHA-256). */
export function blobId(content: Uint8Array, oidLength: number): string {
    return createHash(oidLength === 64 ? 'sha256' : 'sha1')
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest('hex');
}

/** lstat that returns undefined instead of throwing. */
export async function lstatOrUndefined(file: string): Promise<Stats | undefined> {
    try {
        return await lstat(file);
    } catch {
        return undefined;
    }
}

/** realpath that falls back to the resolved path for files that do not exist (yet). */
export async function realpathOrResolve(file: string): Promise<string> {
    try {
        return await realpath(file);
    } catch {
        return path.resolve(file);
    }
}

/** Compares two resolved paths, ignoring case where the platform usually does. */
export function samePath(a: string, b: string): boolean {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32' || process.platform === 'darwin'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

/** Whether `child` lies strictly below `parent`. */
export function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Runs `worker` over `items` with at most `limit` calls in flight. */
export async function forEachLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>) {
    let next = 0;
    const lane = async (): Promise<void> => {
        while (next < items.length) {
            const item = items[next++] as T;
            await worker(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
