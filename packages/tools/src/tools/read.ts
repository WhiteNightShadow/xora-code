import { createReadStream, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { TextDecoder } from 'node:util';
import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import { decodeFile, startingEncoding, strictDecoder, type TextEncoding, textDecoder } from '../text.ts';
import { truncateLine } from '../truncate.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { noteSeen } from './files.ts';
import {
    describeError,
    displayPath,
    errorCode,
    errorResult,
    FILE_ALIASES,
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

/**
 * A file that is not UTF-8 (or not what its byte order mark says) is held in memory whole to tell what it is, up to
 * this size; a larger one is shown as far as UTF-8 goes, and said to be undecided.
 */
const WHOLE_FILE_MAX_BYTES = 32 * 1024 * 1024;

interface Window {
    readonly lines: readonly string[];
    readonly totalLines: number;
    /** Last line included, 0 when none. */
    readonly endLine: number;
    /** The output size limit stopped the window early. */
    readonly cut: boolean;
    readonly encoding: TextEncoding;
    /** The file is text in no encoding known here; it is shown as far as `encoding` goes. */
    readonly lossy: boolean;
    /** Not UTF-8, and too large to tell here what else: shown as far as UTF-8 goes. */
    readonly undecided?: boolean;
}

/**
 * Collects the lines from `start` to `end` of text that comes in pieces, formatted, and counts all of them. Only
 * the first `READ_MAX_LINE_CHARS + 1` characters of a line are kept, so a huge single-line file does not fill the
 * memory.
 */
function lineWindow(start: number, end: number) {
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
    return {
        consume(text: string): void {
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
        },
        /** The window, once all the text has come. */
        done(encoding: TextEncoding, lossy: boolean): Window {
            if (length > 0) {
                finishLine();
            }
            return { lines, totalLines: lineNumber, endLine, cut, encoding, lossy };
        },
    };
}

/**
 * Streams `file` once, as UTF-8 or as what its byte order mark says: most files are, and they need not be held in
 * memory. Nothing (`undefined`) when a byte is not that: what the file is then takes all of it to tell.
 */
async function streamWindow(
    file: string,
    start: number,
    end: number,
    signal: AbortSignal,
    strict: boolean,
): Promise<Window | 'binary' | undefined> {
    const stream = createReadStream(file, { highWaterMark: 64 * 1024, signal });
    const window = lineWindow(start, end);
    let decoder: TextDecoder | undefined;
    let encoding: TextEncoding = 'utf8';
    /** The text of the next bytes, or of the end of the file; nothing when a strict decoder refuses them. */
    const decode = (chunk?: Buffer): string | undefined => {
        try {
            return chunk ? decoder?.decode(chunk, { stream: true }) : (decoder?.decode() ?? '');
        } catch {
            return undefined;
        }
    };
    try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
            if (decoder === undefined) {
                const starting = startingEncoding(chunk);
                if (starting === 'binary') {
                    return 'binary';
                }
                encoding = starting;
                decoder = strict ? strictDecoder(encoding) : textDecoder(encoding);
            }
            const text = decode(chunk);
            if (text === undefined) {
                return undefined;
            }
            window.consume(text);
        }
        const rest = decode();
        if (rest === undefined) {
            return undefined;
        }
        window.consume(rest);
    } finally {
        stream.destroy();
    }
    return window.done(encoding, !strict);
}

/**
 * The lines from `start` to `end` of `file`, in the encoding the edit tools will find it in: one decision for both
 * ({@link decodeFile}), so that what is read here is what an edit has to match (21 §4.4).
 */
async function readWindow(
    file: string,
    size: number,
    start: number,
    end: number,
    signal: AbortSignal,
): Promise<Window | 'binary'> {
    const streamed = await streamWindow(file, start, end, signal, true);
    if (streamed !== undefined) {
        return streamed;
    }
    if (size > WHOLE_FILE_MAX_BYTES) {
        const shown = await streamWindow(file, start, end, signal, false);
        return shown === undefined || shown === 'binary' ? 'binary' : { ...shown, undecided: true };
    }
    const decoded = decodeFile(await readFile(file, { signal }));
    if (decoded === null) {
        return 'binary';
    }
    const window = lineWindow(start, end);
    window.consume(decoded.text);
    return window.done(decoded.encoding, decoded.lossy === true);
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
        await noteSeen(ctx, file);
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
        window = await readWindow(file, stats.size, start, start + limit - 1, ctx.signal);
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
    await noteSeen(ctx, file);
    const notes: string[] = [];
    if (start > 1 || endLine < totalLines) {
        const more = endLine < totalLines ? ` Use offset=${endLine + 1} to read on.` : '';
        const reason = cut ? ' The output size limit was reached.' : '';
        notes.push(`(Lines ${start}-${endLine} of ${totalLines}.${reason}${more})`);
    }
    if (window.undecided) {
        notes.push(
            `(This file is not valid UTF-8, and at ${formatBytes(stats.size)} it is too large to tell here what encoding it is in: what could not be decoded shows as \ufffd.)`,
        );
    } else if (window.lossy) {
        notes.push(
            '(This file is not valid UTF-8, UTF-16 or GB18030 text: what could not be decoded shows as \ufffd, and the edit tools will not rewrite the file.)',
        );
    } else if (window.encoding === 'gb18030') {
        notes.push('(This file is GB18030 (GBK) text, not UTF-8; edits keep that encoding.)');
    }
    const content = notes.length > 0 ? `${lines.join('\n')}\n\n${notes.join('\n')}` : lines.join('\n');
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
    lenient: {
        aliases: {
            path: FILE_ALIASES,
            offset: ['start_line', 'start', 'from_line', 'line'],
            limit: ['max_lines', 'num_lines', 'lines', 'line_count'],
        },
    },
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
