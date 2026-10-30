import type { Stats } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { IgnoreRules, readDirectory, type WalkEntry } from '../walk.ts';
import { describeError, displayPath, errorCode, errorResult } from './shared.ts';

export const LIST_MAX_ENTRIES = 1000;

const ListInput = z.object({
    path: z
        .string()
        .optional()
        .describe('Directory to list: absolute, or relative to the working directory (default: the working directory)'),
    ignore: z
        .array(z.string())
        .optional()
        .describe('Extra gitignore-style patterns to leave out, e.g. ["dist/", "*.log"]'),
});

export type ListInput = z.infer<typeof ListInput>;

interface TreeNode {
    readonly entry: WalkEntry;
    readonly children: TreeNode[];
    /** For directories: whether their contents were read before the entry limit was reached. */
    expanded: boolean;
    linkTarget?: string;
}

async function runList(input: ListInput, ctx: ToolContext): Promise<ToolResult> {
    const root = resolveToolPath(ctx.cwd, input.path ?? '.');
    const shown = displayPath(ctx.cwd, root);
    let stats: Stats;
    try {
        stats = await stat(root);
    } catch (error) {
        return errorResult(
            errorCode(error) === 'ENOENT'
                ? `Directory not found: ${shown}`
                : `Cannot list ${shown}: ${describeError(error)}`,
        );
    }
    if (!stats.isDirectory()) {
        return errorResult(`${shown} is a file, not a directory. Use the read tool to see its contents.`);
    }

    // Breadth first, so that hitting the limit leaves the upper levels complete.
    const top: TreeNode[] = [];
    const queue: Array<{ path: string; relative: string; rules: IgnoreRules; node: TreeNode | null }> = [
        { path: root, relative: '', rules: await IgnoreRules.load(root, input.ignore), node: null },
    ];
    let count = 0;
    let truncated = false;
    for (let next = 0; next < queue.length && !truncated; next++) {
        if (ctx.signal.aborted) {
            return errorResult('Aborted.');
        }
        const dir = queue[next];
        if (dir === undefined) {
            break;
        }
        const listing = await readDirectory(dir.path, dir.relative, dir.rules);
        const siblings = dir.node?.children ?? top;
        if (dir.node !== null) {
            dir.node.expanded = true;
        }
        // Directories first, then files, each group by name.
        const entries = [...listing.entries].sort(
            (a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory'),
        );
        for (const entry of entries) {
            if (count >= LIST_MAX_ENTRIES) {
                truncated = true;
                break;
            }
            const node: TreeNode = { entry, children: [], expanded: false };
            if (entry.kind === 'symlink') {
                node.linkTarget = await readlink(entry.path).catch(() => undefined);
            }
            siblings.push(node);
            count++;
            if (entry.kind === 'directory') {
                queue.push({ path: entry.path, relative: entry.relative, rules: listing.rules, node });
            }
        }
    }

    const lines = [`${root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`}`];
    const paths: string[] = [];
    const render = (nodes: readonly TreeNode[], depth: number): void => {
        for (const node of nodes) {
            const { entry } = node;
            let line = `${'  '.repeat(depth)}${entry.name}`;
            if (entry.kind === 'directory') {
                line += node.expanded ? '/' : '/ …';
            } else if (node.linkTarget !== undefined) {
                line += ` -> ${node.linkTarget}`;
            }
            lines.push(line);
            paths.push(entry.path);
            render(node.children, depth + 1);
        }
    };
    render(top, 1);
    if (count === 0) {
        lines.push('  (empty directory)');
    }
    if (truncated) {
        lines.push(
            '',
            `(Stopped after ${LIST_MAX_ENTRIES} entries; directories marked … were not expanded. ` +
                'List a subdirectory, or use glob to find specific files.)',
        );
    }
    return { content: lines.join('\n'), display: { kind: 'files', paths, truncated } };
}

export const listTool: ToolDefinition<ListInput> = {
    name: 'list',
    description:
        `List a directory as an indented tree; directories end with \`/\`. Honours .gitignore files and always skips .git and node_modules; stops after ${LIST_MAX_ENTRIES} entries, keeping the upper levels complete. ` +
        'Use it to get oriented in a project. To find files by name prefer `glob`; to find code prefer `grep`.',
    kind: 'search',
    schema: ListInput,
    readOnly: true,
    targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path ?? '.')],
    title: (input) => `List ${input.path ?? '.'}`,
    run: runList,
};
