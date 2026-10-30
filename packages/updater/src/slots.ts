import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical.ts';
import { isShellCompatible } from './compat.ts';
import { verifyBundleFiles } from './files.ts';
import {
    MANIFEST_FILE,
    type ManifestCheck,
    parseManifest,
    type TrustedKeys,
    verifyManifestSignature,
} from './manifest.ts';

export async function readManifestFile(dir: string): Promise<ManifestCheck> {
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable' };
    }
    return parseManifest(raw);
}

/** Installed slot versions: directories under `slotsDir` that contain a manifest. */
export async function listSlots(slotsDir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(slotsDir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const versions: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }
        try {
            await stat(path.join(slotsDir, entry.name, MANIFEST_FILE));
            versions.push(entry.name);
        } catch {
            // Not a complete slot; ignored until it is reinstalled.
        }
    }
    return versions.sort();
}

export interface InstallOptions {
    readonly trustedKeys: TrustedKeys;
    readonly shellVersion: string;
}

/**
 * Verifies a bundle directory (signature, shell compatibility, files) and copies it into `slotsDir/<version>`
 * through a temporary directory, so a half-copied slot is never visible under its final name.
 */
export async function installSlot(
    sourceDir: string,
    slotsDir: string,
    options: InstallOptions,
): Promise<{ version: string }> {
    const read = await readManifestFile(sourceDir);
    if (!read.ok) {
        throw new Error(`cannot install bundle: ${read.reason}`);
    }
    const signed = verifyManifestSignature(read.manifest, options.trustedKeys);
    if (!signed.ok) {
        throw new Error(`cannot install bundle: ${signed.reason}`);
    }
    const manifest = signed.manifest;
    if (!isShellCompatible(options.shellVersion, manifest.requires.shell)) {
        throw new Error(
            `cannot install bundle: requires shell ${manifest.requires.shell}, have ${options.shellVersion}`,
        );
    }
    const files = await verifyBundleFiles(sourceDir, manifest);
    if (!files.ok) {
        throw new Error(`cannot install bundle: ${files.reason}`);
    }
    await mkdir(slotsDir, { recursive: true });
    const target = path.join(slotsDir, manifest.version);
    const existing = await readManifestFile(target);
    if (existing.ok) {
        if (canonicalJson(existing.manifest) === canonicalJson(manifest)) {
            return { version: manifest.version };
        }
        throw new Error(
            `cannot install bundle: version ${manifest.version} is already installed with different content`,
        );
    }
    const temporary = path.join(slotsDir, `.${manifest.version}.${randomUUID()}.tmp`);
    try {
        await cp(sourceDir, temporary, { recursive: true, errorOnExist: true, force: false });
        const copied = await verifyBundleFiles(temporary, manifest);
        if (!copied.ok) {
            throw new Error(`cannot install bundle: copy verification failed: ${copied.reason}`);
        }
        await rm(target, { recursive: true, force: true });
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
    return { version: manifest.version };
}

/** Removes slots that are not in `keep`. Returns the removed versions. */
export async function pruneSlots(slotsDir: string, keep: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const version of await listSlots(slotsDir)) {
        if (!keep.has(version)) {
            await rm(path.join(slotsDir, version), { recursive: true, force: true });
            removed.push(version);
        }
    }
    return removed;
}
