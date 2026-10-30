import { spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import { resolveToolPath } from '../path.ts';
import { findRipgrep } from '../ripgrep.ts';
import { truncateLine } from '../truncate.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { walk } from '../walk.ts';
import { describeError, displayPath, errorCode, errorResult, placeName } from './shared.ts';

export const GREP_DEFAULT_LIMIT = 1000;
/** Larger files are skipped, like `rg --max-filesize 2M`. */
export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT = 50;
const MAX_LINE_CHARS = 500;
const MAX_OUTPUT_CHARS = 50_000;
/** Bound on the files collected in `files_with_matches` mode, which must see every match to sort by time. */
const MAX_FILES = 50_000;

const OUTPUT_MODES = ['files_with_matches', 'content', 'count'] as const;
type OutputMode = (typeof OUTPUT_MODES)[number];

const GrepInput = z.object({
    pattern: z.string().min(1).describe('Regular expression to search for, matched against each line'),
    path: z
        .string()
        .optional()
        .describe(
            'File or directory to search: absolute, or relative to the working directory (default: the working directory)',
        ),
    glob: z
        .string()
        .optional()
        .describe('Only search files whose path matches this glob, e.g. "*.ts" or "src/**/*.{ts,tsx}"'),
    ignoreCase: z.boolean().optional().describe('Match without regard to case'),
    outputMode: z
        .enum(OUTPUT_MODES)
        .optional()
        .describe(
            '"files_with_matches" (default): matching files, most recently modified first; "content": matching lines; "count": matching lines per file',
        ),
    context: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(`Lines of context before and after each match, in "content" mode (at most ${MAX_CONTEXT})`),
    headLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
            `Return at most this many files ("files_with_matches", "count") or lines ("content"); default ${GREP_DEFAULT_LIMIT}`,
        ),
});

export type GrepInput = z.infer<typeof GrepInput>;

interface MatchLine {
    readonly line: number;
    readonly text: string;
    readonly match: boolean;
}

/** One file's results, in the same shape from both engines so that the output is identical. */
interface FileMatches {
    readonly path: string;
    readonly count: number;
    /** Matching lines and their context; only filled in `content` mode. */
    readonly lines: readonly MatchLine[];
}

interface Query {
    readonly pattern: string;
    readonly regex: RegExp | null;
    readonly ignoreCase: boolean;
    /** Directory searched; for a single file, its directory. */
    readonly root: string;
    /** Set when a single file is searched. */
    readonly file: string | null;
    readonly include: ((relative: string) => boolean) | null;
    readonly mode: OutputMode;
    readonly context: number;
    readonly limit: number;
    readonly signal: AbortSignal;
}

/**
 * The `glob` filter, with ripgrep's (gitignore) meaning: a pattern without `/` matches the file name at any depth,
 * one with `/` matches the path below the search root.
 */
function fileFilter(glob: string): (relative: string) => boolean {
    const pattern = path.sep === '\\' ? glob.replaceAll('\\', '/') : glob;
    const anchored = pattern.replace(/^\.\//, '');
    return picomatch(anchored, { dot: true, basename: !anchored.includes('/'), windows: false });
}

/** JavaScript lacks inline flags; a leading `(?i)`, common in ripgrep patterns, becomes the `i` flag. */
function compilePattern(pattern: string, ignoreCase: boolean): RegExp | Error {
    const inline = pattern.startsWith('(?i)');
    const source = inline ? pattern.slice(4) : pattern;
    const flags = ignoreCase || inline ? 'i' : '';
    try {
        return new RegExp(source, `${flags}u`);
    } catch {
        // Valid without the `u` flag only, e.g. `\-`.
    }
    try {
        return new RegExp(source, flags);
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }
}

/** Collected enough to know the output will be cut, so the search can stop. */
function enough(query: Query, files: number, lines: number): boolean {
    switch (query.mode) {
        case 'content':
            return lines > query.limit;
        case 'count':
            return files > query.limit;
        default:
            return files >= MAX_FILES;
    }
}

const stripLineEnd = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** Matching lines with `context` lines around them; overlapping and adjacent ranges merge, as in ripgrep. */
function withContext(lines: readonly string[], matched: readonly number[], context: number): MatchLine[] {
    const result: MatchLine[] = [];
    let next = 0;
    for (const [k, index] of matched.entries()) {
        for (let i = Math.max(next, index - context); i < index; i++) {
            result.push({ line: i + 1, text: stripLineEnd(lines[i] ?? ''), match: false });
        }
        result.push({ line: index + 1, text: stripLineEnd(lines[index] ?? ''), match: true });
        const to = Math.min(lines.length, index + 1 + context, matched[k + 1] ?? Number.POSITIVE_INFINITY);
        for (let i = index + 1; i < to; i++) {
            result.push({ line: i + 1, text: stripLineEnd(lines[i] ?? ''), match: false });
        }
        next = Math.max(to, index + 1);
    }
    return result;
}

async function searchFile(file: string, query: Query, regex: RegExp): Promise<FileMatches | null> {
    let bytes: Buffer;
    try {
        const stats = await stat(file);
        if (!stats.isFile() || stats.size > GREP_MAX_FILE_BYTES) {
            return null;
        }
        bytes = await readFile(file);
    } catch {
        return null;
    }
    // ripgrep skips files with NUL bytes when it walks a directory.
    if (bytes.includes(0)) {
        return null;
    }
    const text = bytes.toString('utf8');
    const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    const matched: number[] = [];
    for (const [index, line] of lines.entries()) {
        if (regex.test(line)) {
            matched.push(index);
            if (query.mode === 'files_with_matches') {
                break;
            }
        }
    }
    if (matched.length === 0) {
        return null;
    }
    return {
        path: file,
        count: matched.length,
        lines: query.mode === 'content' ? withContext(lines, matched, query.context) : [],
    };
}

async function searchWithJavaScript(query: Query, regex: RegExp): Promise<FileMatches[]> {
    const results: FileMatches[] = [];
    let lines = 0;
    const consider = async (file: string): Promise<boolean> => {
        const found = await searchFile(file, query, regex);
        if (found !== null) {
            results.push(found);
            lines += found.lines.length;
        }
        return enough(query, results.length, lines);
    };
    if (query.file !== null) {
        await consider(query.file);
        return results;
    }
    for await (const entry of walk(query.root, { signal: query.signal })) {
        if (entry.kind === 'file' && (query.include === null || query.include(entry.relative))) {
            if (await consider(entry.path)) {
                break;
            }
        }
    }
    return results;
}

/** Flags that make ripgrep walk and filter exactly like the JavaScript engine. */
const RIPGREP_ARGS = [
    '--no-config',
    '--hidden',
    '--no-require-git',
    '--no-ignore-global',
    '--no-ignore-exclude',
    '--no-ignore-dot',
    '--sort=path',
    '--max-filesize=2M',
    '--path-separator=/',
    '--glob=!.git',
    '--glob=!node_modules',
];

interface RipgrepText {
    readonly text?: string;
    readonly bytes?: string;
}

interface RipgrepMessage {
    readonly type: 'begin' | 'match' | 'context' | 'end' | 'summary';
    readonly data: { readonly path?: RipgrepText; readonly lines?: RipgrepText; readonly line_number?: number };
}

const ripgrepText = (value: RipgrepText | undefined): string =>
    value?.text ?? (value?.bytes === undefined ? '' : Buffer.from(value.bytes, 'base64').toString('utf8'));

/**
 * Runs `rg` in the search root. The `glob` filter is applied afterwards rather than passed to `rg`, because ripgrep
 * lets a `--glob` match override `.gitignore` while the JavaScript engine does not. Returns `null` when ripgrep fails
 * without results (for example on look-around, which its regex engine lacks) so the caller can fall back.
 */
function searchWithRipgrep(rg: string, query: Query): Promise<FileMatches[] | null> {
    const args = [...RIPGREP_ARGS];
    if (query.ignoreCase) {
        args.push('--ignore-case');
    }
    if (query.mode === 'files_with_matches') {
        args.push('--files-with-matches', '--null');
    } else {
        args.push('--json');
        if (query.mode === 'content' && query.context > 0) {
            args.push(`--context=${query.context}`);
        }
    }
    args.push('--regexp', query.pattern, '--', '.');

    return new Promise((resolve) => {
        const results: FileMatches[] = [];
        let lines = 0;
        let pending = '';
        let current: { path: string; included: boolean; count: number; lines: MatchLine[] } | null = null;
        let stopped = false;
        const child = spawn(rg, args, { cwd: query.root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const stop = (): void => {
            stopped = true;
            child.kill();
        };
        const onAbort = (): void => stop();
        query.signal.addEventListener('abort', onAbort, { once: true });

        const relativeOf = (p: string): string => (p.startsWith('./') ? p.slice(2) : p);
        const accept = (relative: string): boolean => query.include === null || query.include(relative);
        const handleRecord = (record: string): void => {
            if (query.mode === 'files_with_matches') {
                const relative = relativeOf(record);
                if (relative !== '' && accept(relative)) {
                    results.push({ path: path.resolve(query.root, relative), count: 1, lines: [] });
                    if (enough(query, results.length, 0)) {
                        stop();
                    }
                }
                return;
            }
            let message: RipgrepMessage;
            try {
                message = JSON.parse(record) as RipgrepMessage;
            } catch {
                return;
            }
            const { data } = message;
            if (message.type === 'begin') {
                const relative = relativeOf(ripgrepText(data.path));
                current = { path: path.resolve(query.root, relative), included: accept(relative), count: 0, lines: [] };
            } else if ((message.type === 'match' || message.type === 'context') && current?.included) {
                const match = message.type === 'match';
                if (match) {
                    current.count++;
                }
                if (query.mode === 'content') {
                    const text = stripLineEnd(ripgrepText(data.lines).replace(/\n$/, ''));
                    current.lines.push({ line: data.line_number ?? 0, text, match });
                }
            } else if (message.type === 'end' && current !== null) {
                if (current.included && current.count > 0) {
                    results.push({ path: current.path, count: current.count, lines: current.lines });
                    lines += current.lines.length;
                    if (enough(query, results.length, lines)) {
                        stop();
                    }
                }
                current = null;
            }
        };
        const separator = query.mode === 'files_with_matches' ? '\0' : '\n';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (stopped) {
                return;
            }
            const records = (pending + chunk).split(separator);
            pending = records.pop() ?? '';
            for (const record of records) {
                if (stopped) {
                    return;
                }
                handleRecord(record);
            }
        });
        child.on('error', () => {
            query.signal.removeEventListener('abort', onAbort);
            resolve(null);
        });
        child.on('close', (code) => {
            query.signal.removeEventListener('abort', onAbort);
            if (!stopped && pending !== '') {
                handleRecord(pending);
            }
            // 0: matches, 1: none, 2: an error, possibly after partial results.
            resolve(stopped || code === 0 || code === 1 || results.length > 0 ? results : null);
        });
    });
}

async function modifiedAt(file: string): Promise<number> {
    try {
        return (await stat(file)).mtimeMs;
    } catch {
        return 0;
    }
}

/** Cuts `lines` so that the joined text stays within `maxChars`; returns how many lines were kept. */
function fitLines(lines: readonly string[], maxChars: number): number {
    let chars = 0;
    for (const [index, line] of lines.entries()) {
        chars += line.length + 1;
        if (chars > maxChars && index > 0) {
            return index;
        }
    }
    return lines.length;
}

async function formatResults(files: FileMatches[], query: Query, cwd: string, shownRoot: string): Promise<ToolResult> {
    const total = files.reduce((sum, file) => sum + file.count, 0);
    if (files.length === 0) {
        return {
            content: `No matches for ${query.pattern} in ${placeName(shownRoot)}.`,
            display: { kind: 'matches', count: 0, files: 0, truncated: false },
        };
    }
    let lines: string[];
    let truncated: boolean;
    let note: string;
    if (query.mode === 'files_with_matches') {
        const times = await Promise.all(files.map((file) => modifiedAt(file.path)));
        // A stable sort keeps the path order among files with the same modification time.
        const order = files.map((file, index) => ({ file, time: times[index] ?? 0 })).sort((a, b) => b.time - a.time);
        const shown = order.slice(0, query.limit);
        truncated = order.length > shown.length || files.length >= MAX_FILES;
        lines = shown.map(({ file }) => displayPath(cwd, file.path));
        note = `(Showing ${shown.length} of ${files.length}${files.length >= MAX_FILES ? '+' : ''} files with matches.)`;
    } else if (query.mode === 'count') {
        const shown = files.slice(0, query.limit);
        truncated = files.length > shown.length;
        lines = shown.map((file) => `${displayPath(cwd, file.path)}:${file.count}`);
        const counted = shown.reduce((sum, file) => sum + file.count, 0);
        lines.push('', `${counted} matching lines in ${shown.length} files.`);
        note = `(Showing the first ${shown.length} files with matches; there are more.)`;
    } else {
        lines = [];
        truncated = false;
        let emitted = 0;
        outer: for (const file of files) {
            const shown = displayPath(cwd, file.path);
            let previous = -1;
            for (const line of file.lines) {
                if (emitted >= query.limit) {
                    truncated = true;
                    break outer;
                }
                // Like ripgrep, `--` separates groups of lines that are not adjacent, when context is shown.
                if (query.context > 0 && lines.length > 0 && (previous < 0 || line.line > previous + 1)) {
                    lines.push('--');
                }
                const mark = line.match ? ':' : '-';
                lines.push(`${shown}${mark}${line.line}${mark}${truncateLine(line.text, MAX_LINE_CHARS)}`);
                emitted++;
                previous = line.line;
            }
        }
        note = `(Showing the first ${query.limit} lines; there are more matches.)`;
    }
    const kept = fitLines(lines, MAX_OUTPUT_CHARS);
    if (kept < lines.length) {
        lines = lines.slice(0, kept);
        truncated = true;
        note = '(Output cut at the size limit.)';
    }
    if (truncated) {
        lines.push('', `${note} Narrow the search with path, glob or a more specific pattern.`);
    }
    return {
        content: lines.join('\n'),
        display: { kind: 'matches', count: total, files: files.length, truncated },
    };
}

export interface GrepToolOptions {
    /**
     * `'auto'` (the default) uses `rg` from PATH when there is one, `false` always uses the JavaScript engine, and a
     * path selects a ripgrep binary.
     */
    readonly ripgrep?: 'auto' | false | string;
}

export function createGrepTool(options: GrepToolOptions = {}): ToolDefinition<GrepInput> {
    const ripgrep = options.ripgrep ?? 'auto';

    async function run(input: GrepInput, ctx: ToolContext): Promise<ToolResult> {
        const target = resolveToolPath(ctx.cwd, input.path ?? '.');
        const shownRoot = displayPath(ctx.cwd, target);
        let stats: Stats;
        try {
            stats = await stat(target);
        } catch (error) {
            return errorResult(
                errorCode(error) === 'ENOENT'
                    ? `Path not found: ${shownRoot}`
                    : `Cannot search ${shownRoot}: ${describeError(error)}`,
            );
        }
        const compiled = compilePattern(input.pattern, input.ignoreCase === true);
        const isFile = !stats.isDirectory();
        const glob = input.glob === undefined || isFile ? null : input.glob;
        const query: Query = {
            pattern: input.pattern,
            regex: compiled instanceof RegExp ? compiled : null,
            ignoreCase: input.ignoreCase === true,
            root: isFile ? path.dirname(target) : target,
            file: isFile ? target : null,
            include: glob === null ? null : fileFilter(glob),
            mode: input.outputMode ?? 'files_with_matches',
            context: Math.min(input.context ?? 0, MAX_CONTEXT),
            limit: input.headLimit ?? GREP_DEFAULT_LIMIT,
            signal: ctx.signal,
        };

        let files: FileMatches[] | null = null;
        try {
            // A single file is quicker to search here, and ripgrep would also search it if it were binary.
            const rg = isFile ? null : ripgrep === 'auto' ? await findRipgrep() : ripgrep || null;
            if (rg !== null) {
                files = await searchWithRipgrep(rg, query);
            }
            if (files === null) {
                if (query.regex === null) {
                    const reason = compiled instanceof Error ? compiled.message : 'unknown error';
                    return errorResult(`Invalid regular expression ${input.pattern}: ${reason}`);
                }
                files = await searchWithJavaScript(query, query.regex);
            }
        } catch (error) {
            return errorResult(ctx.signal.aborted ? 'Aborted.' : `Search failed: ${describeError(error)}`);
        }
        if (ctx.signal.aborted) {
            return errorResult('Aborted.');
        }
        return formatResults(files, query, ctx.cwd, shownRoot);
    }

    return {
        name: 'grep',
        description: [
            'Search file contents with a regular expression (ripgrep / JavaScript syntax), line by line; escape literal special characters such as `(`, `.`, `{` or `|`. Honours .gitignore and skips .git, node_modules, binary files and files over 2 MB.',
            '- outputMode "files_with_matches" (default) lists matching files, most recently modified first; "content" shows matching lines as `path:line:text` (add `context` for surrounding lines, shown as `path-line-text`); "count" shows the number of matching lines per file.',
            `- Narrow with \`path\` (a file or directory), \`glob\` (e.g. "*.ts", "src/**/*.{ts,tsx}") and \`ignoreCase\`; \`headLimit\` caps the files or lines returned (default ${GREP_DEFAULT_LIMIT}).`,
            '- Use this instead of grep or rg in bash.',
        ].join('\n'),
        kind: 'search',
        schema: GrepInput,
        readOnly: true,
        targets: (input, ctx) => [resolveToolPath(ctx.cwd, input.path ?? '.')],
        title: (input) => `Search /${input.pattern}/${input.path === undefined ? '' : ` in ${input.path}`}`,
        run,
    };
}

export const grepTool: ToolDefinition<GrepInput> = createGrepTool();
