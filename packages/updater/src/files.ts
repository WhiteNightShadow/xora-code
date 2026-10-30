import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type BundleManifest, MANIFEST_FILE } from './manifest.ts';

export type BundleCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * Every regular file below `dir` as a sorted POSIX relative path, excluding the top-level manifest.
 * Symbolic links and other special files are rejected rather than followed.
 */
export async function listBundleFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (current: string, prefix: string): Promise<void> => {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) {
                throw new Error(`symlink-not-allowed:${relative}`);
            }
            if (entry.isDirectory()) {
                await walk(path.join(current, entry.name), relative);
            } else if (entry.isFile()) {
                if (relative !== MANIFEST_FILE) {
                    files.push(relative);
                }
            } else {
                throw new Error(`special-file-not-allowed:${relative}`);
            }
        }
    };
    await walk(dir, '');
    return files.sort();
}

export async function buildFileEntries(dir: string): Promise<BundleManifest['files']> {
    const entries: Array<BundleManifest['files'][number]> = [];
    for (const relative of await listBundleFiles(dir)) {
        const absolute = path.join(dir, ...relative.split('/'));
        const stats = await lstat(absolute);
        entries.push({ path: relative, sha256: await sha256File(absolute), size: stats.size });
    }
    return entries;
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const failure = (reason: string): BundleCheck => ({ ok: false, reason });

/** Checks that `dir` holds exactly the files the manifest lists, with matching sizes and hashes. */
export async function verifyBundleFiles(dir: string, manifest: BundleManifest): Promise<BundleCheck> {
    let root: string;
    try {
        root = await realpath(dir);
    } catch {
        return failure('bundle-missing');
    }
    const expected = new Map(manifest.files.map((file) => [file.path, file]));
    if (!expected.has(manifest.entry.host)) {
        return failure('entry-host-not-listed');
    }
    if (!expected.has(manifest.entry.ui)) {
        return failure('entry-ui-not-listed');
    }
    let actual: string[];
    try {
        actual = await listBundleFiles(root);
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
    }
    for (const relative of actual) {
        if (!expected.has(relative)) {
            return failure(`unexpected-file:${relative}`);
        }
    }
    for (const file of manifest.files) {
        const absolute = path.join(root, ...file.path.split('/'));
        let stats: Stats;
        try {
            stats = await lstat(absolute);
        } catch {
            return failure(`missing:${file.path}`);
        }
        if (!stats.isFile()) {
            return failure(`not-a-file:${file.path}`);
        }
        if (!isInside(root, await realpath(absolute))) {
            return failure(`outside-bundle:${file.path}`);
        }
        if (stats.size !== file.size) {
            return failure(`size-mismatch:${file.path}`);
        }
        if ((await sha256File(absolute)) !== file.sha256) {
            return failure(`hash-mismatch:${file.path}`);
        }
    }
    return { ok: true };
}
