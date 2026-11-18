import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import { countLines, detectEol, encodeText, withEol, writeFileAtomic } from '../text.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { isToolResult, loadExisting, noteSeen, seenState } from './files.ts';
import { describeError, displayPath, errorResult, FILE_ALIASES } from './shared.ts';

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
    // What was read of such a file shows its undecodable bytes as U+FFFD: content with those in it was copied from
    // there, and writing it would put them in the place of the bytes.
    if (previous?.lossy && content.includes('\ufffd')) {
        return errorResult(
            `${shown} is not valid UTF-8, UTF-16 or GB18030 text, and the content sent has \ufffd in it, which is how the bytes that could not be decoded were shown: writing it would put that character in their place. Convert the file to UTF-8 first (iconv, for example), or change it with a script that works on its bytes.`,
        );
    }
    // What is there now goes: the model must have seen it as it is. An empty file has nothing to lose.
    if (existing.state === 'binary') {
        return errorResult(
            `${shown} is a binary file, and write does not replace one with text. Remove it first if that is intended.`,
        );
    }
    if (previous !== null && previous.text !== '') {
        const state = await seenState(ctx, file);
        if (state === 'unseen') {
            return errorResult(
                `${shown} exists and you have not read it in this session. Read it first, so that what you write keeps what should stay; to change part of it, use edit.`,
            );
        }
        if (state === 'changed') {
            return errorResult(
                `${shown} has changed since you last read it: the user or another process wrote to it. Read it again before you replace it, or your version would undo their change.`,
            );
        }
    }
    try {
        await writeFileAtomic(file, encodeText(content, previous?.encoding ?? 'utf8'));
    } catch (error) {
        return errorResult(`Cannot write ${shown}: ${describeError(error)}`);
    }
    await noteSeen(ctx, file);
    const count = countLines(content);
    const lines = `${count} ${count === 1 ? 'line' : 'lines'}`;
    const created = existing.state === 'missing';
    const recoded = previous?.lossy ? ' It was not valid text in an encoding known here; what is written now is.' : '';
    return {
        content: created ? `Created ${shown} (${lines}).` : `Replaced the content of ${shown} (${lines}).${recoded}`,
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
        'To change part of an existing file use `edit`, `multi_edit` or `apply_patch` instead, which send only the changed text. ' +
        'An existing file is only replaced when you have read it in this session and it has not changed since: read it first. ' +
        'Only create files the task needs.',
    kind: 'edit',
    schema: WriteInput,
    readOnly: false,
    lenient: {
        aliases: { path: FILE_ALIASES, content: ['contents', 'text', 'file_text', 'file_content', 'data', 'body'] },
    },
    targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path)],
    title: (input) => `Write ${input.path}`,
    run: runWrite,
};
