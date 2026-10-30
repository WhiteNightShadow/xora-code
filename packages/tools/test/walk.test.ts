import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { walk } from '../src/index.ts';
import { temporaryDir, writeFiles } from './helpers.ts';

async function collect(root: string, ignore?: readonly string[]): Promise<string[]> {
    const entries: string[] = [];
    for await (const entry of walk(root, ignore === undefined ? {} : { ignore })) {
        entries.push(entry.kind === 'directory' ? `${entry.relative}/` : entry.relative);
    }
    return entries;
}

describe('walk', () => {
    it('visits entries depth first, sorted by name, like rg --sort path', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a.ts': '', 'a/b.ts': '', 'B.md': '', '.hidden/x': '' });
        expect(await collect(root)).toEqual(['.hidden/', '.hidden/x', 'B.md', 'a/', 'a/b.ts', 'a.ts']);
    });

    it('always skips .git and node_modules', async () => {
        const root = await temporaryDir();
        await writeFiles(root, {
            '.git/HEAD': '',
            'node_modules/x/i.js': '',
            'pkg/node_modules/y.js': '',
            'pkg/a.js': '',
        });
        expect(await collect(root)).toEqual(['pkg/', 'pkg/a.js']);
    });

    it('applies negations, and deeper ignore files win', async () => {
        const root = await temporaryDir();
        await writeFiles(root, {
            '.gitignore': '*.log\n!keep.log\n',
            'a.log': '',
            'keep.log': '',
            'sub/.gitignore': '!b.log\nlocal.txt\n',
            'sub/b.log': '',
            'sub/c.log': '',
            'sub/local.txt': '',
        });
        expect(await collect(root)).toEqual(['.gitignore', 'keep.log', 'sub/', 'sub/.gitignore', 'sub/b.log']);
    });

    it('honours ignore files of enclosing directories up to the repository root', async () => {
        const repo = await temporaryDir();
        await mkdir(path.join(repo, '.git'));
        await writeFiles(repo, {
            '.gitignore': 'dist/\n*.tmp\n',
            'packages/app/src/a.ts': '',
            'packages/app/src/a.tmp': '',
            'packages/app/dist/out.js': '',
        });
        expect(await collect(path.join(repo, 'packages', 'app'))).toEqual(['src/', 'src/a.ts']);
    });

    it('searches a directory that was asked for even when an enclosing ignore file excludes it', async () => {
        const repo = await temporaryDir();
        await mkdir(path.join(repo, '.git'));
        await writeFiles(repo, { '.gitignore': 'vendor/\n', 'vendor/lib/x.js': '' });
        expect(await collect(path.join(repo, 'vendor'))).toEqual(['lib/', 'lib/x.js']);
    });

    it.skipIf(process.platform === 'win32')('handles names made only of dots', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { '.gitignore': '*.log\n', '.../inner.txt': '', '.../skip.log': '' });
        expect(await collect(root, ['dist/'])).toEqual(['.../', '.../inner.txt', '.gitignore']);
    });

    it('adds extra gitignore-style patterns', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a.ts': '', 'b.js': '', 'dist/c.js': '' });
        expect(await collect(root, ['*.js', 'dist/'])).toEqual(['a.ts']);
    });
});
