import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { TextDecoder } from 'node:util';
import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import { detectEncoding, textDecoder } from '../text.ts';
import { truncateLine } from '../truncate.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import {
    describeError,
    displayPath,
    errorCode,
    errorResult,
    formatBytes,
    notFoundMessage,
    numberedLine,
} from './shared.ts';

export const READ_DEFAULT_LIMIT = 2000;
export const READ_MAX_LINE_CHARS = 2000;
/** Stop adding lines once the output reaches this size (about 25k tokens), and say where to continue. */
const MAX_OUTPUT_CHARS = 100_000;

const ReadInput = z.object({
    path: z.string().min(1).describe('File to read: absolute, or relative to the working directory'),
    offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Line number to start from, 1-based (default 1). Use with `limit` to page through large files'),
    limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Maximum number of lines to return (default ${READ_DEFAULT_LIMIT})`),
});

export type ReadInput = z.infer<typeof ReadInput>;

interface Window {
    readonly lines: readonly string[];
    readonly totalLines: number;
    /** Last line included, 0 when none. */
    readonly endLine: number;
    /** The output size limit stopped the window early. */
    readonly cut: boolean;
}

/**
 * Streams `file` once: formats the lines from `start` to `end` and counts all of them. Only the first
 * `READ_MAX_LINE_CHARS + 1` characters of a line are kept, so a huge single-line file does not fill the memory.
 */
async function readWindow(file: string, start: number, end: number, signal: AbortSignal): Promise<Window | 'binary'> {
    const stream = createReadStream(file, { highWaterMark: 64 * 1024, signal });
    let decoder: TextDecoder | undefined;
    const lines: string[] = [];
    let chars = 0;
    let lineNumber = 0;
    let endLine = 0;
    let cut = false;
    // The line being read.
    let kept = '';
    let length = 0;
    let endsWithCr = false;

    const inWindow = (n: number): boolean => n >= start && n <= end && !cut;
    const finishLine = (): void => {
        lineNumber++;
        if (inWindow(lineNumber)) {
            const fullLength = endsWithCr ? length - 1 : length;
            const body = kept.length > fullLength ? kept.slice(0, fullLength) : kept;
            const formatted = numberedLine(lineNumber, truncateLine(body, READ_MAX_LINE_CHARS, fullLength));
            if (lines.length > 0 && chars + formatted.length > MAX_OUTPUT_CHARS) {
                cut = true;
            } else {
                lines.push(formatted);
                chars += formatted.length + 1;
                endLine = lineNumber;
            }
        }
        kept = '';
        length = 0;
        endsWithCr = false;
    };
    const consume = (text: string): void => {
        let pos = 0;
        for (;;) {
            const newline = text.indexOf('\n', pos);
            const pieceEnd = newline < 0 ? text.length : newline;
            if (pieceEnd > pos) {
                if (inWindow(lineNumber + 1) && kept.length <= READ_MAX_LINE_CHARS) {
                    kept += text.slice(pos, Math.min(pieceEnd, pos + READ_MAX_LINE_CHARS + 1 - kept.length));
                }
                length += pieceEnd - pos;
                endsWithCr = text.charCodeAt(pieceEnd - 1) === 13;
            }
            if (newline < 0) {
                return;
            }
            finishLine();
            pos = newline + 1;
        }
    };

    for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (decoder === undefined) {
            const encoding = detectEncoding(chunk);
            if (encoding === 'binary') {
                stream.destroy();
                return 'binary';
            }
            decoder = textDecoder(encoding);
        }
        consume(decoder.decode(chunk, { stream: true }));
    }
    consume(decoder?.decode() ?? '');
    if (length > 0) {
        finishLine();
    }
    return { lines, totalLines: lineNumber, endLine, cut };
}

async function runRead(input: ReadInput, ctx: ToolContext): Promise<ToolResult> {
    const file = resolveToolPath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, file);
    let stats: Stats;
    try {
        stats = await stat(file);
    } catch (error) {
        return errorResult(
            errorCode(error) === 'ENOENT'
                ? await notFoundMessage(file, shown)
                : `Cannot read ${shown}: ${describeError(error)}`,
        );
    }
    if (stats.isDirectory()) {
        return errorResult(`${shown} is a directory, not a file. Use the list tool to see what it contains.`);
    }
    if (!stats.isFile()) {
        return errorResult(`${shown} is not a regular file.`);
    }
    if (stats.size === 0) {
        return {
            content: `${shown} is empty (0 lines).`,
            display: { kind: 'read', path: file, startLine: 0, endLine: 0, totalLines: 0 },
            locations: [{ path: file }],
        };
    }
    const start = input.offset ?? 1;
    const limit = input.limit ?? READ_DEFAULT_LIMIT;
    let window: Window | 'binary';
    try {
        window = await readWindow(file, start, start + limit - 1, ctx.signal);
    } catch (error) {
        return errorResult(`Cannot read ${shown}: ${describeError(error)}`);
    }
    if (window === 'binary') {
        return errorResult(
            `${shown} is a binary file (${formatBytes(stats.size)}); the read tool only shows text. ` +
                'If you need to inspect it, use bash with a tool such as `file`, `xxd` or `unzip -l`.',
        );
    }
    const { lines, totalLines, endLine, cut } = window;
    if (lines.length === 0) {
        return errorResult(`${shown} has ${totalLines} lines; offset ${start} is past the end.`);
    }
    let content = lines.join('\n');
    if (start > 1 || endLine < totalLines) {
        const more = endLine < totalLines ? ` Use offset=${endLine + 1} to read on.` : '';
        const reason = cut ? ' The output size limit was reached.' : '';
        content += `\n\n(Lines ${start}-${endLine} of ${totalLines}.${reason}${more})`;
    }
    return {
        content,
        display: { kind: 'read', path: file, startLine: start, endLine, totalLines },
        locations: [{ path: file, line: start }],
    };
}

export const readTool: ToolDefinition<ReadInput> = {
    name: 'read',
    description: [
        `Read a text file. Returns its lines numbered like \`cat -n\` (1-based), at most ${READ_DEFAULT_LIMIT} lines starting at \`offset\`; lines longer than ${READ_MAX_LINE_CHARS} characters are cut, and a note says how many lines the file has when only part is shown.`,
        '- Read a file before editing it, so that `oldString` matches the current text exactly.',
        '- The line number and tab at the start of each line are not part of the file; never copy them into edits.',
        '- For large files, page with `offset` and `limit`, or find the relevant lines with `grep` first.',
        '- Directories and binary files are refused; use `list` for directories. Read several files in parallel when useful.',
    ].join('\n'),
    kind: 'read',
    schema: ReadInput,
    readOnly: true,
    targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path)],
    title: (input) => {
        if (input.offset === undefined && input.limit === undefined) {
            return `Read ${input.path}`;
        }
        const from = input.offset ?? 1;
        return `Read ${input.path} (lines ${from}-${from + (input.limit ?? READ_DEFAULT_LIMIT) - 1})`;
    },
    run: runRead,
};
