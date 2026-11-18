import { z } from 'zod';
import { sliceText } from '../truncate.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';

const ToolOutputInput = z.object({
    ref: z.string().min(1).describe('The reference shown in place of the output, such as R123'),
    offset: z.number().int().min(1).optional().describe('First line to return, 1-based'),
    limit: z.number().int().min(1).max(2_000).optional().describe('Lines to return'),
    tail: z.number().int().min(1).max(2_000).optional().describe('Last N lines to return from the end of the output'),
    grep: z.string().min(1).optional().describe('Only the lines containing this text (case-insensitive), numbered'),
    context: z.number().int().min(0).max(20).optional().describe('Lines of context before and after each grep match'),
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
        const matched: number[] = [];
        lines.forEach((line, index) => {
            if (line.toLowerCase().includes(needle)) matched.push(index);
        });
        if (matched.length === 0) {
            return { content: `No line of ${ref} (${found.tool}, ${lines.length} lines) contains "${input.grep}".` };
        }
        const around = input.context ?? 0;
        if (around === 0) {
            const hits = matched.map((index) => `${index + 1}: ${lines[index] ?? ''}`);
            return { content: `${ref} (${found.tool}), ${matched.length} matching lines:\n${clip(hits.join('\n'))}` };
        }
        const rendered: string[] = [];
        let next = 0;
        matched.forEach((index, order) => {
            const from = Math.max(next, index - around);
            if (rendered.length > 0 && from > next) rendered.push('--');
            for (let i = from; i < index; i++) rendered.push(`${i + 1}- ${lines[i] ?? ''}`);
            rendered.push(`${index + 1}: ${lines[index] ?? ''}`);
            const to = Math.min(lines.length, index + 1 + around, matched[order + 1] ?? Number.POSITIVE_INFINITY);
            for (let i = index + 1; i < to; i++) rendered.push(`${i + 1}- ${lines[i] ?? ''}`);
            next = Math.max(to, index + 1);
        });
        return { content: `${ref} (${found.tool}), ${matched.length} matching lines:\n${clip(rendered.join('\n'))}` };
    }
    if (input.tail !== undefined && input.offset === undefined) {
        const start = Math.max(0, lines.length - input.tail);
        const end = lines.length;
        const earlier =
            start > 0 ? `\n[lines ${start + 1}–${end} of ${lines.length}; ask for earlier lines with offset]` : '';
        return { content: `${clip(lines.slice(start, end).join('\n'))}${earlier}` };
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
    lenient: {
        aliases: {
            ref: ['reference', 'id', 'output', 'name'],
            offset: ['start_line', 'start', 'line'],
            limit: ['max_lines', 'lines'],
            tail: ['last', 'tail_lines'],
            grep: ['pattern', 'search', 'query', 'filter', 'find'],
            context: ['context_lines', 'around', 'C'],
        },
    },
    targets: () => [],
    title: (input) => `Earlier output ${input.ref}`,
    run: runToolOutput,
};
