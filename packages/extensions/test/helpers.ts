import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { ExtensionOrigin, ExtensionSource } from '../src/index.ts';

const temporaryDirs: string[] = [];

afterEach(async () => {
    for (const dir of temporaryDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

/** A fresh directory, as a real path (macOS puts tmpdir behind a symbolic link). */
export async function temporaryDir(): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'xora-extensions-test-')));
    temporaryDirs.push(dir);
    return dir;
}

/** Writes `files` (POSIX relative path → content) below `root`. */
export async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }
}

export function source(
    dir: string,
    origin: ExtensionOrigin = 'project',
    extra: Partial<ExtensionSource> = {},
): ExtensionSource {
    return { dir, origin, trusted: true, ...extra };
}

export const isWindows = process.platform === 'win32';

/** `${NAME}` as literal text, the way hook commands, MCP configs and markdown bodies write placeholders. */
export function placeholder(name: string): string {
    return ['$', '{', name, '}'].join('');
}

export const ROOT_VAR = placeholder('CLAUDE_PLUGIN_ROOT');
export const PROJECT_VAR = placeholder('CLAUDE_PROJECT_DIR');
export const SKILL_DIR_VAR = placeholder('CLAUDE_SKILL_DIR');
export const DATA_VAR = placeholder('CLAUDE_PLUGIN_DATA');
