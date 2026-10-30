import { mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    checkPathAccess,
    checkPathSyntax,
    decidePathAccess,
    isPathInside,
    pathFlavor,
    realpathLoose,
    resolveToolPath,
} from '../src/index.ts';
import { isWindows, temporaryDir } from './helpers.ts';

describe('resolveToolPath', () => {
    it('resolves relative paths against the working directory', () => {
        const cwd = path.resolve('/work/repo');
        expect(resolveToolPath(cwd, 'src/a.ts')).toBe(path.join(cwd, 'src', 'a.ts'));
        expect(resolveToolPath(cwd, './src/../b.ts')).toBe(path.join(cwd, 'b.ts'));
        expect(resolveToolPath(cwd, '../other')).toBe(path.resolve('/work/other'));
    });

    it('keeps absolute paths and expands ~', () => {
        const home = path.resolve('/home/me');
        expect(resolveToolPath('/x', path.resolve('/etc/hosts'), home)).toBe(path.resolve('/etc/hosts'));
        expect(resolveToolPath('/x', '~', home)).toBe(home);
        expect(resolveToolPath('/x', '~/notes.md', home)).toBe(path.join(home, 'notes.md'));
        expect(resolveToolPath(path.resolve('/x'), '~user/a', home)).toBe(path.resolve('/x/~user/a'));
    });
});

describe('isPathInside', () => {
    const posix = pathFlavor('linux');
    it('does not treat a shared prefix as containment', () => {
        expect(isPathInside('/a/b', '/a/b', posix)).toBe(true);
        expect(isPathInside('/a/b', '/a/b/c', posix)).toBe(true);
        expect(isPathInside('/a/b', '/a/bc', posix)).toBe(false);
        expect(isPathInside('/', '/anything', posix)).toBe(true);
        expect(isPathInside('/a/b/', '/a/b/c', posix)).toBe(true);
    });
});

describe('checkPathAccess', () => {
    it('accepts existing files and not-yet-existing nested files under a root', async () => {
        const root = await temporaryDir();
        await writeFile(path.join(root, 'a.txt'), 'a');
        await expect(checkPathAccess([root], path.join(root, 'a.txt'))).resolves.toEqual({
            ok: true,
            realPath: path.join(root, 'a.txt'),
        });
        const nested = path.join(root, 'new', 'deeper', 'file.ts');
        await expect(checkPathAccess([root], nested)).resolves.toEqual({ ok: true, realPath: nested });
        await expect(checkPathAccess([root], root)).resolves.toEqual({ ok: true, realPath: root });
    });

    it('rejects paths outside the roots, including `..` escapes', async () => {
        const parent = await temporaryDir();
        const root = path.join(parent, 'root');
        await mkdir(root);
        await writeFile(path.join(parent, 'secret.txt'), 's');
        await expect(checkPathAccess([root], path.join(parent, 'secret.txt'))).resolves.toEqual({
            ok: false,
            reason: 'outside_roots',
        });
        await expect(checkPathAccess([root], `${root}${path.sep}..${path.sep}secret.txt`)).resolves.toEqual({
            ok: false,
            reason: 'outside_roots',
        });
        await expect(checkPathAccess([root], path.join(parent, 'root2', 'x'))).resolves.toEqual({
            ok: false,
            reason: 'outside_roots',
        });
    });

    it('accepts any of several roots', async () => {
        const first = await temporaryDir();
        const second = await temporaryDir();
        await expect(checkPathAccess([first, second], path.join(second, 'x.ts'))).resolves.toMatchObject({ ok: true });
    });

    it('rejects relative and malformed paths', async () => {
        const root = await temporaryDir();
        await expect(checkPathAccess([root], 'relative/path')).resolves.toEqual({ ok: false, reason: 'invalid' });
        await expect(checkPathAccess([root], path.join(root, 'a\0b'))).resolves.toEqual({
            ok: false,
            reason: 'invalid',
        });
        await expect(checkPathAccess([root], '')).resolves.toEqual({ ok: false, reason: 'invalid' });
    });

    describe.skipIf(isWindows)('symbolic links', () => {
        it('rejects a link inside a root that points outside', async () => {
            const parent = await temporaryDir();
            const root = path.join(parent, 'root');
            const outside = path.join(parent, 'outside');
            await mkdir(root);
            await mkdir(outside);
            await writeFile(path.join(outside, 'secret.txt'), 's');
            await symlink(outside, path.join(root, 'escape'));
            await expect(checkPathAccess([root], path.join(root, 'escape', 'secret.txt'))).resolves.toEqual({
                ok: false,
                reason: 'symlink_escape',
            });
            // Creating a new file through the link escapes just the same.
            await expect(checkPathAccess([root], path.join(root, 'escape', 'new', 'file.txt'))).resolves.toEqual({
                ok: false,
                reason: 'symlink_escape',
            });
        });

        it('follows dangling links to where a write would land', async () => {
            const parent = await temporaryDir();
            const root = path.join(parent, 'root');
            await mkdir(root);
            await symlink(path.join(parent, 'not-yet.txt'), path.join(root, 'dangling'));
            await expect(checkPathAccess([root], path.join(root, 'dangling'))).resolves.toEqual({
                ok: false,
                reason: 'symlink_escape',
            });
            await expect(realpathLoose(path.join(root, 'dangling'))).resolves.toBe(path.join(parent, 'not-yet.txt'));
        });

        it('accepts links that stay inside and reports the real path', async () => {
            const root = await temporaryDir();
            await mkdir(path.join(root, 'real'));
            await writeFile(path.join(root, 'real', 'a.txt'), 'a');
            await symlink(path.join(root, 'real'), path.join(root, 'alias'));
            await expect(checkPathAccess([root], path.join(root, 'alias', 'a.txt'))).resolves.toEqual({
                ok: true,
                realPath: path.join(root, 'real', 'a.txt'),
            });
        });

        it('judges roots by their real path too', async () => {
            const parent = await temporaryDir();
            const real = path.join(parent, 'real-root');
            await mkdir(real);
            await symlink(real, path.join(parent, 'linked-root'));
            await expect(
                checkPathAccess([path.join(parent, 'linked-root')], path.join(real, 'file.ts')),
            ).resolves.toMatchObject({ ok: true });
        });

        it('refuses symbolic link loops', async () => {
            const root = await temporaryDir();
            await symlink(path.join(root, 'b'), path.join(root, 'a'));
            await symlink(path.join(root, 'a'), path.join(root, 'b'));
            await expect(checkPathAccess([root], path.join(root, 'a'))).resolves.toEqual({
                ok: false,
                reason: 'invalid',
            });
        });
    });

    it.skipIf(process.platform !== 'darwin')('matches roots without regard to case on macOS', async () => {
        const root = await temporaryDir();
        await expect(checkPathAccess([root], path.join(root.toUpperCase(), 'x.ts'))).resolves.toMatchObject({
            ok: true,
        });
    });

    it('works with the home directory shorthand through resolveToolPath', async () => {
        const target = resolveToolPath('/', '~/x');
        await expect(checkPathAccess([os.homedir()], target)).resolves.toMatchObject({ ok: true });
    });
});

describe('decidePathAccess (pure)', () => {
    const darwin = pathFlavor('darwin');
    const linux = pathFlavor('linux');
    const win32 = pathFlavor('win32');
    const decide = (
        flavor: ReturnType<typeof pathFlavor>,
        roots: readonly string[],
        target: string,
        realTarget = target,
    ) => decidePathAccess({ roots, target, realTarget }, flavor);

    it('compares without case on darwin and with case on linux', () => {
        expect(decide(darwin, ['/Users/Me/Project'], '/users/me/project/src/a.ts')).toMatchObject({ ok: true });
        expect(decide(linux, ['/home/me/Project'], '/home/me/project/src/a.ts')).toEqual({
            ok: false,
            reason: 'outside_roots',
        });
    });

    it('tells symlink escapes from paths that were outside to begin with', () => {
        expect(decide(linux, ['/repo'], '/repo/link/x', '/etc/x')).toEqual({ ok: false, reason: 'symlink_escape' });
        expect(decide(linux, ['/repo'], '/etc/x', '/etc/x')).toEqual({ ok: false, reason: 'outside_roots' });
        expect(decide(linux, ['/repo'], '/elsewhere/link', '/repo/real')).toEqual({ ok: true, realPath: '/repo/real' });
    });

    it('uses real roots when given', () => {
        expect(
            decidePathAccess(
                {
                    roots: ['/var/repo'],
                    realRoots: ['/private/var/repo'],
                    target: '/var/repo/a',
                    realTarget: '/private/var/repo/a',
                },
                darwin,
            ),
        ).toEqual({ ok: true, realPath: '/private/var/repo/a' });
    });

    it('compares Windows paths without case and with either separator', () => {
        expect(decide(win32, ['C:\\Work\\Repo'], 'c:\\work\\repo\\src\\a.ts')).toMatchObject({ ok: true });
        expect(decide(win32, ['C:\\Work\\Repo'], 'C:/Work/Repo/src/a.ts')).toMatchObject({ ok: true });
        expect(decide(win32, ['C:\\Work\\Repo'], 'C:\\Work\\Repo2\\a.ts')).toEqual({
            ok: false,
            reason: 'outside_roots',
        });
        expect(decide(win32, ['C:\\Work\\Repo'], 'C:\\Work\\Repo\\..\\Other\\a.ts')).toEqual({
            ok: false,
            reason: 'outside_roots',
        });
        expect(decide(win32, ['C:\\Work\\Repo'], 'D:\\Work\\Repo\\a.ts')).toEqual({
            ok: false,
            reason: 'outside_roots',
        });
    });

    it('rejects Windows device paths, UNC paths and alternate data streams', () => {
        const roots = ['C:\\Work\\Repo'];
        for (const target of [
            '\\\\?\\C:\\Work\\Repo\\a.ts',
            '\\\\.\\C:\\Work\\Repo\\a.ts',
            '\\\\.\\pipe\\xora',
            '//?/C:/Work/Repo/a.ts',
            '\\??\\C:\\Work\\Repo\\a.ts',
            '\\\\attacker\\share\\a.ts',
            '//attacker/share/a.ts',
            'C:\\Work\\Repo\\a.ts:hidden',
            'C:\\Work\\Repo\\a.ts::$DATA',
            'C:\\Work\\Repo\\nul',
            'C:\\Work\\Repo\\CON.txt',
            'C:\\Work\\Repo\\com1',
            'C:\\Work\\Repo\\aux \\x.ts',
        ]) {
            expect(decide(win32, roots, target), target).toEqual({ ok: false, reason: 'device_path' });
        }
    });

    it('allows UNC paths inside a UNC root', () => {
        expect(decide(win32, ['\\\\server\\share\\proj'], '\\\\server\\share\\proj\\a.ts')).toMatchObject({ ok: true });
        expect(decide(win32, ['\\\\server\\share\\proj'], '\\\\server\\other\\a.ts')).toEqual({
            ok: false,
            reason: 'device_path',
        });
    });

    it('rejects relative and drive-relative Windows paths', () => {
        expect(checkPathSyntax('Repo\\a.ts', win32)).toBe('invalid');
        expect(checkPathSyntax('C:a.ts', win32)).toBe('invalid');
        expect(checkPathSyntax('\\Work\\a.ts', win32)).toBe('invalid');
        expect(checkPathSyntax('C:\\Work\\a.ts', win32)).toBeNull();
        expect(checkPathSyntax('relative', linux)).toBe('invalid');
        expect(checkPathSyntax('/a:b/c', linux)).toBeNull();
    });
});
