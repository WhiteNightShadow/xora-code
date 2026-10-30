import type { Stats } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { walk } from '../walk.ts';
import { describeError, displayPath, errorCode, errorResult, placeName } from './shared.ts';

export const GLOB_MAX_RESULTS = 1000;

const GlobInput = z.object({
    pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.ts", "src/**/*.{ts,tsx}" or "*.json"'),
    path: z
        .string()
        .optional()
        .describe(
            'Directory to search in: absolute, or relative to the working directory (default: the working directory)',
        ),
});

export type GlobInput = z.infer<typeof GlobInput>;

/**
 * Where a glob search starts and what it matches below that directory. The literal leading directories of the
 * pattern (`src` in `src/**`, an absolute prefix, `..`) move the start, so `targets()` reports the real scope.
 * `glob` is empty when the pattern has no wildcards; `root` is then the file itself.
 */
export function globScope(cwd: string, input: GlobInput): { readonly root: string; readonly glob: string } {
    const base = resolveToolPath(cwd, input.path ?? '.');
    let pattern = path.sep === '\\' ? input.pattern.replaceAll('\\', '/') : input.pattern;
    if (pattern === '~' || pattern.startsWith('~/')) {
        pattern = os.homedir().replaceAll('\\', '/') + pattern.slice(1);
    }
    const scan = picomatch.scan(pattern);
    if (scan.negated) {
        return { root: base, glob: pattern };
    }
    const literal = (scan.isGlob ? scan.base : pattern).replace(/\\(.)/g, '$1');
    if (!scan.isGlob) {
        return { root: path.resolve(base, literal), glob: '' };
    }
    return { root: literal === '' ? base : path.resolve(base, literal), glob: scan.glob };
}

async function modifiedAt(file: string): Promise<number> {
    try {
        return (await stat(file)).mtimeMs;
    } catch {
        // A dangling symbolic link.
        return (await lstat(file).catch(() => undefined))?.mtimeMs ?? 0;
    }
}

async function runGlob(input: GlobInput, ctx: ToolContext): Promise<ToolResult> {
    const { root, glob } = globScope(ctx.cwd, input);
    const shownRoot = displayPath(ctx.cwd, root);
    let stats: Stats;
    try {
        stats = await stat(root);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return { content: `No files found matching ${input.pattern} (${shownRoot} does not exist).` };
        }
        return errorResult(`Cannot search ${shownRoot}: ${describeError(error)}`);
    }
    if (glob === '') {
        if (!stats.isFile()) {
            return { content: `No files found matching ${input.pattern} (${shownRoot} is a directory).` };
        }
        return { content: shownRoot, display: { kind: 'files', paths: [root], truncated: false } };
    }
    if (!stats.isDirectory()) {
        return errorResult(`${shownRoot} is not a directory.`);
    }

    const isMatch = picomatch(glob, { dot: true, windows: false });
    const matches: Array<{ path: string; relative: string; mtime: number }> = [];
    try {
        for await (const entry of walk(root, { signal: ctx.signal })) {
            if ((entry.kind === 'file' || entry.kind === 'symlink') && isMatch(entry.relative)) {
                matches.push({ path: entry.path, relative: entry.relative, mtime: 0 });
            }
        }
    } catch (error) {
        return errorResult(ctx.signal.aborted ? 'Aborted.' : `Cannot search ${shownRoot}: ${describeError(error)}`);
    }
    if (matches.length === 0) {
        return { content: `No files found matching ${input.pattern} in ${placeName(shownRoot)}.` };
    }
    await Promise.all(
        matches.map(async (match) => {
            match.mtime = await modifiedAt(match.path);
        }),
    );
    matches.sort((a, b) => b.mtime - a.mtime || (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    const shown = matches.slice(0, GLOB_MAX_RESULTS);
    const truncated = matches.length > shown.length;
    const lines = shown.map((match) => displayPath(ctx.cwd, match.path));
    if (truncated) {
        lines.push(
            '',
            `(Showing the ${shown.length} most recently modified of ${matches.length} matching files; narrow the pattern or path to see the rest.)`,
        );
    }
    return {
        content: lines.join('\n'),
        display: { kind: 'files', paths: shown.map((match) => match.path), truncated },
    };
}

export const globTool: ToolDefinition<GlobInput> = {
    name: 'glob',
    description:
        'Find files by name with a glob pattern: `*` matches within one directory level, `**` across levels, `{a,b}` either alternative, e.g. `**/*.ts`, `src/**/*.{ts,tsx}`, `*.json`. ' +
        `Patterns are matched against paths relative to \`path\` (default: the working directory). Returns matching files, most recently modified first, at most ${GLOB_MAX_RESULTS}. ` +
        'Honours .gitignore and skips .git and node_modules. Use it instead of `find` or `ls` in bash.',
    kind: 'search',
    schema: GlobInput,
    readOnly: true,
    targets: (input, ctx) => [globScope(ctx.cwd, input).root],
    title: (input) => (input.path === undefined ? `Find ${input.pattern}` : `Find ${input.pattern} in ${input.path}`),
    run: runGlob,
};
