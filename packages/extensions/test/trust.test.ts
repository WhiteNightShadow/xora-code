import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveTrust, TrustStore } from '../src/index.ts';
import { isWindows, temporaryDir } from './helpers.ts';

describe('TrustStore', () => {
    it('trusts a project root and everything below it', async () => {
        const root = await temporaryDir();
        const project = path.join(root, 'repo');
        await mkdir(path.join(project, 'packages', 'a'), { recursive: true });
        await mkdir(path.join(root, 'repo-other'));
        const store = new TrustStore(path.join(root, 'data', 'trust.json'), {
            now: () => new Date('2026-10-30T00:00:00Z'),
        });
        expect(await store.isTrusted(project)).toBe(false);
        expect(await store.trust(project)).toBe(project);
        expect(await store.trust(`${project}${path.sep}`)).toBe(project);
        expect(await store.list()).toEqual([{ path: project, trustedAt: '2026-10-30T00:00:00.000Z' }]);
        expect(await store.isTrusted(project)).toBe(true);
        expect(await store.isTrusted(path.join(project, 'packages', 'a'))).toBe(true);
        expect(await store.isTrusted(path.join(project, 'not-yet-created'))).toBe(true);
        expect(await store.isTrusted(path.join(root, 'repo-other'))).toBe(false);
        expect(await store.isTrusted(root)).toBe(false);

        // A subdirectory is trusted through its parent and cannot be untrusted on its own.
        expect(await store.untrust(path.join(project, 'packages'))).toBe(false);
        expect(await new TrustStore(store.file).isTrusted(project)).toBe(true);
        expect(await store.untrust(project)).toBe(true);
        expect(await store.isTrusted(path.join(project, 'packages', 'a'))).toBe(false);
    });

    it.skipIf(isWindows)('compares real paths', async () => {
        const root = await temporaryDir();
        await mkdir(path.join(root, 'real'));
        await symlink(path.join(root, 'real'), path.join(root, 'link'));
        const store = new TrustStore(path.join(root, 'trust.json'));
        expect(await store.trust(path.join(root, 'link'))).toBe(path.join(root, 'real'));
        expect(await store.isTrusted(path.join(root, 'link'))).toBe(true);
    });

    it('trusts nothing when the file is unreadable and refuses filesystem roots', async () => {
        const root = await temporaryDir();
        const file = path.join(root, 'trust.json');
        await writeFile(file, '{ broken');
        const store = new TrustStore(file);
        expect(await store.isTrusted(root)).toBe(false);
        expect((await readdir(root)).some((name) => name.startsWith('trust.json.corrupt-'))).toBe(true);
        await expect(store.trust(path.parse(root).root)).rejects.toThrow(/filesystem root/);
    });

    it('serialises concurrent changes', async () => {
        const root = await temporaryDir();
        const dirs = ['a', 'b', 'c', 'd'].map((name) => path.join(root, name));
        await Promise.all(dirs.map((dir) => mkdir(dir)));
        const store = new TrustStore(path.join(root, 'trust.json'));
        await Promise.all(dirs.map((dir) => store.trust(dir)));
        expect((await store.list()).map((item) => item.path).sort()).toEqual(dirs);
    });
});

describe('effectiveTrust', () => {
    it('disables hooks, MCP and scripts in untrusted projects but keeps skills readable', () => {
        expect(effectiveTrust('project', false)).toEqual({
            trusted: false,
            runHooks: false,
            startMcpServers: false,
            readSkills: true,
            runSkillScripts: false,
            useCommands: true,
            useAgents: true,
        });
        expect(effectiveTrust('project', true)).toMatchObject({ trusted: true, runHooks: true, runSkillScripts: true });
    });

    it('always trusts user and built-in extensions and only enabled plugins', () => {
        for (const origin of ['user', 'builtin'] as const) {
            expect(effectiveTrust(origin, false)).toMatchObject({
                trusted: true,
                runHooks: true,
                startMcpServers: true,
            });
        }
        expect(effectiveTrust('plugin', true)).toMatchObject({ trusted: true, runHooks: true });
        expect(Object.values(effectiveTrust('plugin', false)).every((value) => value === false)).toBe(true);
    });
});
