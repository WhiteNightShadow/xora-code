import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyState, installSlot, listSlots, loadState, pruneSlots, saveState, stagePending } from '../src/index.ts';
import { temporaryDir, testKey, writeBundle } from './helpers.ts';

describe('boot state file', () => {
    it('starts empty when the file does not exist', async () => {
        const dir = await temporaryDir();
        await expect(loadState(path.join(dir, 'state.json'))).resolves.toEqual({ state: emptyState() });
    });

    it('round-trips through an atomic save', async () => {
        const file = path.join(await temporaryDir(), 'app', 'state.json');
        const state = stagePending(emptyState(), '1.2.0');
        await saveState(file, state);
        const loaded = await loadState(file);
        expect(loaded.state).toMatchObject({ pending: '1.2.0' });
        expect(loaded.state.updatedAt).toBeTypeOf('string');
        expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('moves an unreadable file aside and starts over', async () => {
        const dir = await temporaryDir();
        const file = path.join(dir, 'state.json');
        await writeFile(file, '{ not json');
        const loaded = await loadState(file);
        expect(loaded.state).toEqual(emptyState());
        expect(loaded.recoveredFrom).toBeDefined();
        await expect(readFile(loaded.recoveredFrom ?? '', 'utf8')).resolves.toBe('{ not json');
    });
});

describe('slots', () => {
    const shellVersion = '1.0.0-alpha.1';

    it('installs a verified bundle under its version and lists it', async () => {
        const root = await temporaryDir();
        const key = testKey();
        const { dir } = await writeBundle(root, key, { version: '1.2.0' });
        const slotsDir = path.join(root, 'slots');
        await expect(installSlot(dir, slotsDir, { trustedKeys: key.trusted, shellVersion })).resolves.toEqual({
            version: '1.2.0',
        });
        await expect(listSlots(slotsDir)).resolves.toEqual(['1.2.0']);
        // Installing identical content again is a no-op.
        await expect(installSlot(dir, slotsDir, { trustedKeys: key.trusted, shellVersion })).resolves.toEqual({
            version: '1.2.0',
        });
    });

    it('refuses bundles from untrusted keys', async () => {
        const root = await temporaryDir();
        const { dir } = await writeBundle(root, testKey());
        await expect(
            installSlot(dir, path.join(root, 'slots'), { trustedKeys: testKey().trusted, shellVersion }),
        ).rejects.toThrow(/untrusted-key/);
    });

    it('refuses bundles that need a different shell', async () => {
        const root = await temporaryDir();
        const key = testKey();
        const { dir } = await writeBundle(root, key, { shell: '>=2.0.0' });
        await expect(
            installSlot(dir, path.join(root, 'slots'), { trustedKeys: key.trusted, shellVersion }),
        ).rejects.toThrow(/requires shell/);
    });

    it('refuses a tampered source directory', async () => {
        const root = await temporaryDir();
        const key = testKey();
        const { dir } = await writeBundle(root, key);
        await writeFile(path.join(dir, 'ui', 'index.html'), '<script>alert(1)</script>');
        await expect(
            installSlot(dir, path.join(root, 'slots'), { trustedKeys: key.trusted, shellVersion }),
        ).rejects.toThrow(/size-mismatch|hash-mismatch/);
    });

    it('prunes slots that are not kept', async () => {
        const root = await temporaryDir();
        const key = testKey();
        const slotsDir = path.join(root, 'slots');
        for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
            const { dir } = await writeBundle(root, key, { version });
            await installSlot(dir, slotsDir, { trustedKeys: key.trusted, shellVersion });
        }
        await expect(pruneSlots(slotsDir, new Set(['1.2.0', '1.1.0']))).resolves.toEqual(['1.0.0']);
        await expect(listSlots(slotsDir)).resolves.toEqual(['1.1.0', '1.2.0']);
    }, 30_000); // three signed bundles written and checked: slow on a busy Windows runner
});
