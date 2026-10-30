import { appendFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyBundleFiles } from '../src/index.ts';
import { temporaryDir, testKey, writeBundle } from './helpers.ts';

describe('verifyBundleFiles', () => {
    it('accepts an untouched bundle', async () => {
        const { dir, manifest } = await writeBundle(await temporaryDir(), testKey());
        await expect(verifyBundleFiles(dir, manifest)).resolves.toEqual({ ok: true });
    });

    it('detects a modified file', async () => {
        const { dir, manifest } = await writeBundle(await temporaryDir(), testKey());
        await writeFile(path.join(dir, 'ui', 'assets', 'app.js'), 'console.log("evil");\n');
        await expect(verifyBundleFiles(dir, manifest)).resolves.toMatchObject({ ok: false });
    });

    it('detects a file that only grew', async () => {
        const { dir, manifest } = await writeBundle(await temporaryDir(), testKey());
        await appendFile(path.join(dir, 'host', 'index.cjs'), '// extra\n');
        await expect(verifyBundleFiles(dir, manifest)).resolves.toEqual({
            ok: false,
            reason: 'size-mismatch:host/index.cjs',
        });
    });

    it('detects a missing file', async () => {
        const { dir, manifest } = await writeBundle(await temporaryDir(), testKey());
        await rm(path.join(dir, 'ui', 'assets', 'app.js'));
        await expect(verifyBundleFiles(dir, manifest)).resolves.toEqual({
            ok: false,
            reason: 'missing:ui/assets/app.js',
        });
    });

    it('rejects files the manifest does not list', async () => {
        const { dir, manifest } = await writeBundle(await temporaryDir(), testKey());
        await writeFile(path.join(dir, 'ui', 'injected.js'), 'alert(1)\n');
        await expect(verifyBundleFiles(dir, manifest)).resolves.toEqual({
            ok: false,
            reason: 'unexpected-file:ui/injected.js',
        });
    });

    it.skipIf(process.platform === 'win32')('rejects symbolic links', async () => {
        const { dir, manifest } = await writeBundle(await temporaryDir(), testKey());
        await symlink('/etc/hosts', path.join(dir, 'ui', 'link'));
        await expect(verifyBundleFiles(dir, manifest)).resolves.toEqual({
            ok: false,
            reason: 'symlink-not-allowed:ui/link',
        });
    });

    it('requires the entry points to be listed', async () => {
        const { dir, manifest } = await writeBundle(await temporaryDir(), testKey());
        const moved = { ...manifest, entry: { ...manifest.entry, host: 'host/missing.cjs' } };
        await expect(verifyBundleFiles(dir, moved)).resolves.toEqual({ ok: false, reason: 'entry-host-not-listed' });
    });
});
