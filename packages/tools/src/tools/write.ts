import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import { countLines, detectEol, encodeText, withEol, writeFileAtomic } from '../text.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { isToolResult, loadExisting } from './files.ts';
import { describeError, displayPath, errorResult } from './shared.ts';

const WriteInput = z.object({
    path: z.string().min(1).describe('File to write: absolute, or relative to the working directory'),
    content: z.string().describe('The complete content of the file'),
});

export type WriteInput = z.infer<typeof WriteInput>;

async function runWrite(input: WriteInput, ctx: ToolContext): Promise<ToolResult> {
    const file = resolveToolPath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, file);
    const existing = await loadExisting(file, shown);
    if (isToolResult(existing)) {
        return existing;
    }
    const previous = existing.state === 'text' ? existing.file : null;
    // Keep the file's conventions: its encoding, and CRLF line endings when it used them and the new text has none.
    let content = input.content;
    if (previous !== null && detectEol(previous.text) === '\r\n' && !content.includes('\r\n')) {
        content = withEol(content, '\r\n');
    }
    if (previous?.text === content) {
        return { content: `${shown} already has exactly this content; nothing was written.` };
    }
    try {
        await writeFileAtomic(file, encodeText(content, previous?.encoding ?? 'utf8'));
    } catch (error) {
        return errorResult(`Cannot write ${shown}: ${describeError(error)}`);
    }
    const count = countLines(content);
    const lines = `${count} ${count === 1 ? 'line' : 'lines'}`;
    const created = existing.state === 'missing';
    return {
        content: created ? `Created ${shown} (${lines}).` : `Replaced the content of ${shown} (${lines}).`,
        display: {
            kind: 'diff',
            diffs: [{ path: file, oldText: created ? null : (previous?.text ?? ''), newText: content }],
        },
        locations: [{ path: file, line: 1 }],
    };
}

export const writeTool: ToolDefinition<WriteInput> = {
    name: 'write',
    description:
        'Create a file, or replace the entire content of one. Missing parent directories are created. ' +
        'To change part of an existing file use `edit`, `multi_edit` or `apply_patch` instead, which send only the changed text; if you must rewrite an existing file, read it first. ' +
        'Only create files the task needs.',
    kind: 'edit',
    schema: WriteInput,
    readOnly: false,
    targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path)],
    title: (input) => `Write ${input.path}`,
    run: runWrite,
};
