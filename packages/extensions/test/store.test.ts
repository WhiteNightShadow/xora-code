import { spawnSync } from 'node:child_process';
import { access, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashDirectory, INDEX_FILE, PluginInstallError, PluginStore } from '../src/index.ts';
import { isWindows, ROOT_VAR, temporaryDir, writeTree } from './helpers.ts';

function manifest(version: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ name: 'demo', version, description: 'Demo plugin', ...extra });
}

async function pluginSource(root: string, version = '1.0.0', files: Record<string, string> = {}): Promise<string> {
    const dir = path.join(root, `src-${version}-${Object.keys(files).length}`);
    await writeTree(dir, {
        '.claude-plugin/plugin.json': manifest(version),
        'commands/hello.md': 'Say hello.\n',
        'skills/greet/SKILL.md': '---\nname: greet\ndescription: Greets people.\n---\nGreet.\n',
        ...files,
    });
    return dir;
}

async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

const HOOKS = JSON.stringify({
    hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${ROOT_VAR}/check.sh` }] }],
    },
});

describe('PluginStore', () => {
    it('installs from a directory, disabled until confirmed, with a stable content hash', async () => {
        const root = await temporaryDir();
        const source = await pluginSource(root);
        const store = new PluginStore({ root: path.join(root, 'store'), now: () => new Date('2026-10-30T00:00:00Z') });
        const result = await store.install({ kind: 'dir', path: source });
        expect(result).toMatchObject({ status: 'installed', permissionsGrew: false, diagnostics: [] });
        expect(result.plugin).toMatchObject({
            name: 'demo',
            version: '1.0.0',
            enabled: false,
            pinned: false,
            installedAt: '2026-10-30T00:00:00.000Z',
            source: { kind: 'dir', path: source },
            dir: path.join(root, 'store', 'demo@1.0.0'),
        });
        expect(result.plugin.hash).toBe(await hashDirectory(source));
        expect(result.plugin.hash).toBe(await hashDirectory(result.plugin.dir));
        expect(await exists(path.join(result.plugin.dir, 'commands', 'hello.md'))).toBe(true);
        expect((await readdir(path.join(root, 'store'))).sort()).toEqual(['demo@1.0.0', INDEX_FILE]);

        // Same content again: nothing to do.
        const again = await store.install({ kind: 'dir', path: source });
        expect(again.status).toBe('unchanged');
        // Same version, different content: refused.
        await writeFile(path.join(source, 'commands', 'hello.md'), 'Changed.\n');
        await expect(store.install({ kind: 'dir', path: source })).rejects.toThrow(/installed with different content/);
        expect((await readdir(path.join(root, 'store'))).filter((name) => name.startsWith('.staging'))).toEqual([]);
    });

    it('enables, disables and persists the index', async () => {
        const root = await temporaryDir();
        const storeRoot = path.join(root, 'store');
        const store = new PluginStore({ root: storeRoot });
        await store.install({ kind: 'dir', path: await pluginSource(root) });
        expect((await store.enable('demo', true)).enabled).toBe(true);
        const reopened = new PluginStore({ root: storeRoot });
        expect((await reopened.get('demo'))?.enabled).toBe(true);
        const enabled = await reopened.loadEnabled();
        expect(enabled.map((plugin) => [plugin.manifest.name, plugin.components.commands[0]?.trusted])).toEqual([
            ['demo', true],
        ]);
        await reopened.enable('demo', false);
        expect(await reopened.loadEnabled()).toEqual([]);
        expect((await reopened.read('demo')).components.skills[0]?.trusted).toBe(false);
        await expect(reopened.enable('nope', true)).rejects.toThrow(PluginInstallError);
        const index = JSON.parse(await readFile(path.join(storeRoot, INDEX_FILE), 'utf8'));
        expect(index).toMatchObject({ schemaVersion: 1, plugins: [{ name: 'demo', enabled: false }] });
    });

    it('updates, keeps the previous version and rolls back', async () => {
        const root = await temporaryDir();
        const store = new PluginStore({ root: path.join(root, 'store') });
        await store.install({ kind: 'dir', path: await pluginSource(root, '1.0.0') }, { enable: true });
        const update = await store.install({ kind: 'dir', path: await pluginSource(root, '1.1.0') });
        expect(update).toMatchObject({ status: 'updated', previousVersion: '1.0.0', permissionsGrew: false });
        // Nothing new to run, so the update stays enabled.
        expect(update.plugin).toMatchObject({ version: '1.1.0', enabled: true, previous: { version: '1.0.0' } });
        const third = await store.install({ kind: 'dir', path: await pluginSource(root, '1.2.0') });
        expect(third.plugin.previous?.version).toBe('1.1.0');
        // Only one previous version is kept.
        expect((await readdir(path.join(root, 'store'))).sort()).toEqual(['demo@1.1.0', 'demo@1.2.0', INDEX_FILE]);
        const rolledBack = await store.rollback('demo');
        expect(rolledBack).toMatchObject({ version: '1.1.0', previous: { version: '1.2.0' } });
        expect(rolledBack.dir).toBe(path.join(root, 'store', 'demo@1.1.0'));
        expect((await store.read('demo')).manifest.version).toBe('1.1.0');
        expect((await store.rollback('demo')).version).toBe('1.2.0');
    });

    it('reports grown permissions and disables the update until confirmed again', async () => {
        const root = await temporaryDir();
        const store = new PluginStore({ root: path.join(root, 'store') });
        await store.install({ kind: 'dir', path: await pluginSource(root, '1.0.0') }, { enable: true });
        const update = await store.install({
            kind: 'dir',
            path: await pluginSource(root, '2.0.0', {
                'hooks/hooks.json': HOOKS,
                '.mcp.json': JSON.stringify({ mcpServers: { api: { url: 'https://api.example.com/mcp' } } }),
            }),
        });
        expect(update.permissionsGrew).toBe(true);
        expect(update.addedPermissions).toEqual({
            hookCommands: [`${ROOT_VAR}/check.sh`],
            hookUrls: [],
            mcpCommands: [],
            mcpUrls: ['https://api.example.com/mcp'],
            domains: ['api.example.com'],
            skillScripts: [],
        });
        expect(update.plugin.enabled).toBe(false);
        expect(update.plugin.previous?.enabled).toBe(true);
        // The user declines: roll back to the confirmed version, which is enabled again.
        const back = await store.rollback('demo');
        expect(back).toMatchObject({ version: '1.0.0', enabled: true });
        // Growth is measured against the installed version: 2.1.0 asks again, the user agrees, and 2.1.1 with
        // the same permissions as 2.1.0 does not ask.
        const again = await store.install({
            kind: 'dir',
            path: await pluginSource(root, '2.1.0', { 'hooks/hooks.json': HOOKS }),
        });
        expect(again.permissionsGrew).toBe(true);
        await store.enable('demo', true);
        const patch = await store.install({
            kind: 'dir',
            path: await pluginSource(root, '2.1.1', { 'hooks/hooks.json': HOOKS, 'README.md': 'docs' }),
        });
        expect(patch.permissionsGrew).toBe(false);
        expect(patch.plugin.enabled).toBe(true);
    }, 30_000);

    it('pins, uninstalls and validates names', async () => {
        const root = await temporaryDir();
        const store = new PluginStore({ root: path.join(root, 'store') });
        await store.install({ kind: 'dir', path: await pluginSource(root, '1.0.0') });
        await store.pin('demo', true);
        await expect(store.install({ kind: 'dir', path: await pluginSource(root, '1.1.0') })).rejects.toThrow(
            /pinned to 1\.0\.0/,
        );
        await store.pin('demo', false);
        await store.install({ kind: 'dir', path: await pluginSource(root, '1.1.0') });
        expect(await store.uninstall('demo')).toBe(true);
        expect(await store.uninstall('demo')).toBe(false);
        expect(await store.list()).toEqual([]);
        expect(await readdir(path.join(root, 'store'))).toEqual([INDEX_FILE]);
        await expect(
            store.install({ kind: 'dir', path: await pluginSource(root, '3.0.0') }, { expectedName: 'other' }),
        ).rejects.toThrow(/expected plugin other, got demo/);
        await writeTree(root, { 'broken/.claude-plugin/plugin.json': '{' });
        const failure = await store.install({ kind: 'dir', path: path.join(root, 'broken') }).catch((error) => error);
        expect(failure).toBeInstanceOf(PluginInstallError);
        expect((failure as PluginInstallError).diagnostics[0]?.message).toMatch(/cannot read plugin.json/);
        await expect(store.install({ kind: 'dir', path: path.join(root, 'nowhere') })).rejects.toThrow(
            /does not exist/,
        );
        await expect(store.install({ kind: 'dir', path: path.join(root, 'store') })).rejects.toThrow(
            /inside the plugin store/,
        );
        await expect(store.rollback('demo')).rejects.toThrow(/not installed/);
    });

    it('enables an unchanged reinstall on request and refuses names that differ only in case', async () => {
        const root = await temporaryDir();
        const store = new PluginStore({ root: path.join(root, 'store') });
        const source = await pluginSource(root);
        await store.install({ kind: 'dir', path: source });
        const again = await store.install({ kind: 'dir', path: source }, { enable: true });
        expect(again).toMatchObject({ status: 'unchanged', plugin: { enabled: true } });
        expect((await store.get('demo'))?.enabled).toBe(true);
        await writeTree(root, {
            'upper/.claude-plugin/plugin.json': JSON.stringify({ name: 'Demo', version: '1.0.0' }),
        });
        await expect(store.install({ kind: 'dir', path: path.join(root, 'upper') })).rejects.toThrow(
            /Demo clashes with the installed plugin demo/,
        );
        expect(await exists(path.join(root, 'store', 'demo@1.0.0', 'commands', 'hello.md'))).toBe(true);
    });

    it('names an unversioned plugin after its hash and keeps marketplace entries', async () => {
        const root = await temporaryDir();
        await writeTree(root, { 'entry-only/skills/a/SKILL.md': '---\nname: a\ndescription: A.\n---\nA.\n' });
        const store = new PluginStore({ root: path.join(root, 'store') });
        const entry = { name: 'from-market', source: './entry-only', description: 'Listed in a marketplace' };
        const result = await store.install(
            { kind: 'dir', path: path.join(root, 'entry-only') },
            { expectedName: 'from-market', entry, enable: true },
        );
        expect(result.plugin.version).toBe(`0.0.0-${result.plugin.hash.slice(0, 12)}`);
        expect(result.plugin.entry).toEqual(entry);
        const [loaded] = await store.loadEnabled();
        expect(loaded?.manifest.name).toBe('from-market');
        expect(loaded?.components.skills.map((skill) => skill.id)).toEqual(['from-market:a']);
    });

    it.skipIf(isWindows)('copies links inside the plugin as files and skips links that leave it', async () => {
        const root = await temporaryDir();
        const source = await pluginSource(root);
        await writeTree(root, { 'secret.txt': 'do not copy' });
        await symlink(path.join(source, 'commands', 'hello.md'), path.join(source, 'commands', 'alias.md'));
        await symlink(path.join(root, 'secret.txt'), path.join(source, 'leak.txt'));
        await symlink(path.join(source, 'skills'), path.join(source, 'skills-link'));
        const store = new PluginStore({ root: path.join(root, 'store') });
        const result = await store.install({ kind: 'dir', path: source });
        expect(result.diagnostics.map((item) => item.message)).toEqual([
            'skipped leak.txt: symbolic link points outside the plugin',
            'skipped skills-link: symbolic link to a directory',
        ]);
        expect(await readFile(path.join(result.plugin.dir, 'commands', 'alias.md'), 'utf8')).toBe('Say hello.\n');
        expect(await exists(path.join(result.plugin.dir, 'leak.txt'))).toBe(false);
    });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit)('PluginStore with git sources', () => {
    function git(cwd: string, ...args: string[]): string {
        const result = spawnSync(
            'git',
            ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
            {
                cwd,
                encoding: 'utf8',
                env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, '.no-global') },
            },
        );
        if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        }
        return result.stdout.trim();
    }

    async function bareRepo(root: string): Promise<{ url: string; first: string }> {
        const work = path.join(root, 'work');
        await writeTree(work, {
            '.claude-plugin/plugin.json': manifest('1.0.0'),
            'commands/hello.md': 'Hello from git.\n',
            'packages/sub/.claude-plugin/plugin.json': JSON.stringify({ name: 'sub', version: '0.1.0' }),
            'packages/sub/commands/sub.md': 'Sub.\n',
        });
        git(work, 'init', '-q', '-b', 'main');
        git(work, 'add', '.');
        git(work, 'commit', '-q', '-m', 'first');
        const first = git(work, 'rev-parse', 'HEAD');
        git(work, 'tag', 'v1');
        await writeTree(work, { '.claude-plugin/plugin.json': manifest('1.1.0') });
        git(work, 'commit', '-q', '-am', 'second');
        git(root, 'clone', '-q', '--bare', work, path.join(root, 'plugin.git'));
        return { url: pathToFileURL(path.join(root, 'plugin.git')).href, first };
    }

    const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1' };

    it('clones, installs and records the commit', async () => {
        const root = await temporaryDir();
        const { url, first } = await bareRepo(root);
        const store = new PluginStore({ root: path.join(root, 'store'), env });
        const latest = await store.install({ kind: 'git', url });
        expect(latest.plugin).toMatchObject({ name: 'demo', version: '1.1.0', source: { kind: 'git', url } });
        expect(latest.plugin.source.kind === 'git' && latest.plugin.source.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(await exists(path.join(latest.plugin.dir, '.git'))).toBe(false);
        expect(await readFile(path.join(latest.plugin.dir, 'commands', 'hello.md'), 'utf8')).toBe('Hello from git.\n');

        const tagged = await store.install({ kind: 'git', url, ref: 'v1' });
        expect(tagged.plugin.version).toBe('1.0.0');
        const pinned = await store.install({ kind: 'git', url, sha: first, path: 'packages/sub' });
        expect(pinned.plugin).toMatchObject({ name: 'sub', source: { commit: first, path: 'packages/sub' } });
    }, 30_000); // git is slow to start on Windows

    it('refuses unsafe urls and reports clone failures', async () => {
        const root = await temporaryDir();
        const store = new PluginStore({ root: path.join(root, 'store'), env });
        await expect(store.install({ kind: 'git', url: 'ext::sh -c touch% /tmp/x' })).rejects.toThrow(
            /unsupported git url/,
        );
        await expect(store.install({ kind: 'git', url: '--upload-pack=touch /tmp/x' })).rejects.toThrow(
            /unsupported git url/,
        );
        await expect(
            store.install({ kind: 'git', url: pathToFileURL(path.join(root, 'missing.git')).href }),
        ).rejects.toThrow(/git clone failed/);
        expect((await readdir(path.join(root, 'store'))).filter((name) => name.startsWith('.staging'))).toEqual([]);
    });
});
