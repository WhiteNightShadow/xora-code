import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOB_MAX_RESULTS, globScope, globTool, LIST_MAX_ENTRIES, listTool } from '../src/index.ts';
import { isWindows, makeContext, runTool, temporaryDir, writeFiles } from './helpers.ts';

const PROJECT = {
    '.gitignore': 'dist/\n*.log\n',
    'package.json': '{}',
    'README.md': '# readme',
    'src/index.ts': 'export {};',
    'src/util/helpers.ts': 'export {};',
    'src/util/debug.log': 'noise',
    'src/view.tsx': 'export {};',
    'src/.gitignore': 'generated/\n',
    'src/generated/types.ts': 'export {};',
    'dist/index.js': 'compiled',
    'node_modules/dep/index.js': 'dep',
    '.git/HEAD': 'ref: refs/heads/main',
    '.github/workflows/ci.yml': 'on: push',
};

describe('list', () => {
    it('renders a tree with directories first and leaves ignored entries out', async () => {
        const root = await temporaryDir();
        await writeFiles(root, PROJECT);
        const result = await runTool(listTool, {}, await makeContext(root));
        expect(result.content).toBe(
            [
                `${root}/`,
                '  .github/',
                '    workflows/',
                '      ci.yml',
                '  src/',
                '    util/',
                '      helpers.ts',
                '    .gitignore',
                '    index.ts',
                '    view.tsx',
                '  .gitignore',
                '  README.md',
                '  package.json',
            ].join('\n'),
        );
        expect(result.display).toMatchObject({ kind: 'files', truncated: false });
        if (result.display?.kind === 'files') {
            expect(result.display.paths).toContain(path.join(root, 'src', 'util', 'helpers.ts'));
        }
    });

    it('lists a subdirectory with extra ignore patterns', async () => {
        const root = await temporaryDir();
        await writeFiles(root, PROJECT);
        const result = await runTool(listTool, { path: 'src', ignore: ['*.tsx', 'util/'] }, await makeContext(root));
        expect(result.content).toBe([`${path.join(root, 'src')}/`, '  .gitignore', '  index.ts'].join('\n'));
    });

    it('stops after the entry limit, keeping upper levels complete', async () => {
        const root = await temporaryDir();
        const files: Record<string, string> = { 'top.txt': '' };
        for (let i = 0; i < LIST_MAX_ENTRIES + 50; i++) {
            files[`deep/file-${String(i).padStart(4, '0')}.txt`] = '';
        }
        files['deep/nested/inner.txt'] = '';
        await writeFiles(root, files);
        const result = await runTool(listTool, {}, await makeContext(root));
        expect(result.display).toMatchObject({ kind: 'files', truncated: true });
        if (result.display?.kind === 'files') {
            expect(result.display.paths).toHaveLength(LIST_MAX_ENTRIES);
        }
        expect(result.content).toContain('  top.txt');
        expect(result.content).toContain('    nested/ …');
        expect(result.content).toContain(`(Stopped after ${LIST_MAX_ENTRIES} entries`);
    }, 30_000); // creating the files alone can take several seconds on Windows

    it('marks empty directories and refuses files and missing paths', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a.txt': 'a' });
        await mkdir(path.join(root, 'empty'));
        const ctx = await makeContext(root);
        expect((await runTool(listTool, { path: 'empty' }, ctx)).content).toBe(
            `${path.join(root, 'empty')}/\n  (empty directory)`,
        );
        const file = await runTool(listTool, { path: 'a.txt' }, ctx);
        expect(file.isError).toBe(true);
        expect(file.content).toContain('read tool');
        const missing = await runTool(listTool, { path: 'nope' }, ctx);
        expect(missing).toMatchObject({ isError: true, content: 'Directory not found: nope' });
    });

    it.skipIf(isWindows)('shows symbolic links without following them', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'real/a.txt': 'a' });
        await symlink(path.join(root, 'real'), path.join(root, 'alias'));
        const result = await runTool(listTool, {}, await makeContext(root));
        expect(result.content).toContain(`  alias -> ${path.join(root, 'real')}`);
        expect(result.content.match(/a\.txt/g)).toHaveLength(1);
    });
});

describe('glob', () => {
    it('matches across directories, honours ignore files and includes hidden directories', async () => {
        const root = await temporaryDir();
        await writeFiles(root, PROJECT);
        const result = await runTool(globTool, { pattern: '**/*.ts' }, await makeContext(root));
        expect(result.content.split('\n').sort()).toEqual(['src/index.ts', 'src/util/helpers.ts']);
        const yml = await runTool(globTool, { pattern: '**/*.yml' }, await makeContext(root));
        expect(yml.content).toBe('.github/workflows/ci.yml');
    });

    it('supports braces, a search path and literal prefixes', async () => {
        const root = await temporaryDir();
        await writeFiles(root, PROJECT);
        const ctx = await makeContext(root);
        const braces = await runTool(globTool, { pattern: 'src/**/*.{ts,tsx}' }, ctx);
        expect(braces.content.split('\n').sort()).toEqual(['src/index.ts', 'src/util/helpers.ts', 'src/view.tsx']);
        const scoped = await runTool(globTool, { pattern: '*.ts', path: 'src' }, ctx);
        expect(scoped.content).toBe('src/index.ts');
        expect(globTool.targets({ pattern: 'src/util/*.ts' }, ctx)).toEqual([path.join(root, 'src', 'util')]);
        expect(globTool.targets({ pattern: '../elsewhere/**' }, ctx)).toEqual([path.resolve(root, '..', 'elsewhere')]);
        expect(globScope(root, { pattern: 'package.json' })).toEqual({
            root: path.join(root, 'package.json'),
            glob: '',
        });
        expect((await runTool(globTool, { pattern: 'package.json' }, ctx)).content).toBe('package.json');
    });

    it('accepts absolute patterns', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a/x.md': '', 'a/y.txt': '' });
        const pattern = `${root.replaceAll('\\', '/')}/a/*.md`;
        const result = await runTool(globTool, { pattern }, await makeContext(root));
        expect(result.content).toBe('a/x.md');
    });

    it('sorts by modification time, newest first', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'old.ts': '', 'new.ts': '', 'mid.ts': '' });
        const at = (name: string, seconds: number) => utimes(path.join(root, name), seconds, seconds);
        await at('old.ts', 1_000_000);
        await at('mid.ts', 2_000_000);
        await at('new.ts', 3_000_000);
        const result = await runTool(globTool, { pattern: '*.ts' }, await makeContext(root));
        expect(result.content).toBe('new.ts\nmid.ts\nold.ts');
    });

    it('caps the number of results', async () => {
        const root = await temporaryDir();
        await mkdir(path.join(root, 'many'));
        await Promise.all(
            Array.from({ length: GLOB_MAX_RESULTS + 5 }, (_, i) => writeFile(path.join(root, 'many', `f${i}.txt`), '')),
        );
        const result = await runTool(globTool, { pattern: 'many/*.txt' }, await makeContext(root));
        expect(result.display).toMatchObject({ kind: 'files', truncated: true });
        expect(result.content).toContain(
            `(Showing the ${GLOB_MAX_RESULTS} most recently modified of ${GLOB_MAX_RESULTS + 5}`,
        );
    });

    it('reports when nothing matches', async () => {
        const root = await temporaryDir();
        await writeFiles(root, { 'a.ts': '' });
        const ctx = await makeContext(root);
        const none = await runTool(globTool, { pattern: '**/*.rs' }, ctx);
        expect(none.isError).toBeUndefined();
        expect(none.content).toBe('No files found matching **/*.rs in the working directory.');
        const missing = await runTool(globTool, { pattern: '*.ts', path: 'nope' }, ctx);
        expect(missing.content).toBe('No files found matching *.ts (nope does not exist).');
    });
});
