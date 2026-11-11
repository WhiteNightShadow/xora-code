import { z } from 'zod';
import { sliceText } from '../truncate.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';

const ToolOutputInput = z.object({
    ref: z.string().min(1).describe('The reference shown in place of the output, such as R123'),
    offset: z.number().int().min(1).optional().describe('First line to return, 1-based'),
    limit: z.number().int().min(1).max(2_000).optional().describe('Lines to return'),
    grep: z.string().min(1).optional().describe('Only the lines containing this text (case-insensitive), numbered'),
});

export type ToolOutputInput = z.infer<typeof ToolOutputInput>;

/** What one answer carries at most; the rest is a range or a grep away. */
const MAX_CHARS = 30_000;
const DEFAULT_LINES = 400;

function errorResult(message: string): ToolResult {
    return { content: message, isError: true };
}

/**
 * Earlier tool output the context only references (20 §4.3): masked to save context, it stays in the session and
 * comes back here as it was, without running anything again.
 */
async function runToolOutput(input: ToolOutputInput, ctx: ToolContext): Promise<ToolResult> {
    const ref = input.ref.trim().replace(/^#/, '').toUpperCase();
    const found = ctx.outputs?.read(ref);
    if (!found) {
        return errorResult(`There is no earlier tool output ${input.ref}. References look like R123.`);
    }
    const lines = found.text.split('\n');
    if (input.grep) {
        const needle = input.grep.toLowerCase();
        const hits = lines.flatMap((line, index) =>
            line.toLowerCase().includes(needle) ? [`${index + 1}: ${line}`] : [],
        );
        if (hits.length === 0) {
            return { content: `No line of ${ref} (${found.tool}, ${lines.length} lines) contains "${input.grep}".` };
        }
        return { content: `${ref} (${found.tool}), ${hits.length} matching lines:\n${clip(hits.join('\n'))}` };
    }
    const start = (input.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LINES));
    if (start >= lines.length) {
        return errorResult(`${ref} has only ${lines.length} lines.`);
    }
    const more = end < lines.length ? `\n[lines ${start + 1}–${end} of ${lines.length}; ask for more with offset]` : '';
    // The note on what is left comes after the cut, so it is never cut off itself.
    return { content: `${clip(lines.slice(start, end).join('\n'))}${more}` };
}

function clip(text: string): string {
    return text.length > MAX_CHARS
        ? `${sliceText(text, MAX_CHARS)}\n[cut at ${MAX_CHARS} characters; narrow it with offset/limit or grep]`
        : text;
}

export const toolOutputTool: ToolDefinition<ToolOutputInput> = {
    name: 'tool_output',
    description:
        'Read an earlier tool output, or a message of the user, that the context shows only as a reference like #R123 (masked or compacted to save context). It returns it as it was, without running anything again; use offset/limit for a range of lines or grep to find lines.',
    kind: 'read',
    schema: ToolOutputInput,
    readOnly: true,
    targets: () => [],
    title: (input) => `Earlier output ${input.ref}`,
    run: runToolOutput,
};
