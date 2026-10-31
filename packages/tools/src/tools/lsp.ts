import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { fileUri, type LspClient, uriToFile } from '../lsp/client.ts';
import {
    formatDocumentSymbols,
    formatFileDiagnostics,
    hoverText,
    locationLine,
    position as showPosition,
    workspaceSymbolLine,
} from '../lsp/format.ts';
import {
    ConnectionClosedError,
    ErrorCodes,
    RequestAbortedError,
    RequestTimeoutError,
    ResponseError,
} from '../lsp/jsonrpc.ts';
import { readyBy } from '../lsp/manager.ts';
import type { DocumentSymbol, Hover, Location, LocationLink, Position, SymbolInformation } from '../lsp/protocol.ts';
import type { ServerSpec } from '../lsp/servers.ts';
import { checkPathAccess, isPathInside, resolveToolPath } from '../path.ts';
import { readTextFile } from '../text.ts';
import { truncateLine, truncateMiddle } from '../truncate.ts';
import type { LspAccess, ToolContext, ToolDefinition, ToolLocation, ToolResult } from '../types.ts';
import { describeError, displayPath, errorCode, errorResult, formatBytes, notFoundMessage } from './shared.ts';

const OPERATIONS = ['diagnostics', 'definition', 'references', 'hover', 'symbols'] as const;
type Operation = (typeof OPERATIONS)[number];

/** Files one `diagnostics` call may check. */
export const LSP_MAX_FILES = 10;
/** Larger files are not sent to a server. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_LOCATIONS = 100;
const MAX_SYMBOLS = 300;
const MAX_DIAGNOSTICS_PER_FILE = 50;
const MAX_HOVER_CHARS = 6000;

const LspInput = z.object({
    operation: z
        .enum(OPERATIONS)
        .describe(
            'diagnostics: errors and warnings of the file(s); definition, references, hover: about the symbol at line/column; symbols: the outline of the file, or with `query` a search across the workspace',
        ),
    path: z.string().min(1).describe('The file: absolute, or relative to the working directory'),
    paths: z
        .array(z.string().min(1))
        .max(LSP_MAX_FILES - 1)
        .optional()
        .describe('diagnostics only: more files to check in the same call'),
    line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based line of the symbol, as `read` numbers lines; needed for definition, references and hover'),
    column: z.number().int().min(1).optional().describe('1-based column of any character of the symbol on that line'),
    symbol: z
        .string()
        .min(1)
        .optional()
        .describe('The symbol as written on that line; its first occurrence there is used when `column` is not given'),
    query: z
        .string()
        .min(1)
        .optional()
        .describe(
            'symbols only: search the whole workspace for symbols matching this name instead of listing the file',
        ),
});

export type LspInput = z.infer<typeof LspInput>;

const needsPosition = (operation: Operation): boolean =>
    operation === 'definition' || operation === 'references' || operation === 'hover';

interface Target {
    /** Real path. */
    readonly file: string;
    readonly shown: string;
}

interface Server {
    readonly client: LspClient;
    readonly spec: ServerSpec;
    readonly languageId: string;
}

function isResult(value: unknown): value is ToolResult {
    return typeof value === 'object' && value !== null && 'content' in value;
}

/** The text of a source file, or why it cannot be sent to a server. */
async function readSource(target: Target): Promise<string | ToolResult> {
    try {
        const stats = await stat(target.file);
        if (stats.isDirectory()) {
            return errorResult(`${target.shown} is a directory; the lsp tool needs a file.`);
        }
        if (stats.size > MAX_FILE_BYTES) {
            return errorResult(
                `${target.shown} is too large (${formatBytes(stats.size)}) to send to a language server.`,
            );
        }
        const text = await readTextFile(target.file);
        return text === null ? errorResult(`${target.shown} is a binary file.`) : text.text;
    } catch (error) {
        return errorResult(
            errorCode(error) === 'ENOENT'
                ? await notFoundMessage(target.file, target.shown)
                : `Cannot read ${target.shown}: ${describeError(error)}`,
        );
    }
}

function languages(lsp: LspAccess): string {
    return lsp.manager.servers.map((spec) => `${spec.language} (${spec.name})`).join(', ');
}

/** The running server for a file, started if needed. */
async function serverFor(lsp: LspAccess, target: Target, ctx: ToolContext): Promise<Server | ToolResult> {
    const found = await lsp.manager.lookup(target.file, ctx.roots, lsp.trusted);
    if (found.kind === 'unsupported') {
        const extension = path.extname(target.file);
        return errorResult(
            `No language server handles ${extension === '' ? 'files without an extension' : `${extension} files`} (${target.shown}). The lsp tool covers ${languages(lsp)}.`,
        );
    }
    if (found.kind === 'outside') {
        return errorResult(`${target.shown} is outside the workspace; language servers only look at files inside it.`);
    }
    if (found.kind === 'unavailable') {
        return errorResult(found.reason);
    }
    // The server's own start timeout comes first, so a failure arrives with its reason.
    const ready = await readyBy(found.client, Date.now() + lsp.manager.startTimeoutMs + 1000, ctx.signal);
    if (ctx.signal.aborted) {
        return errorResult('Cancelled.');
    }
    if (!ready || found.client.state !== 'ready') {
        return errorResult(`${found.spec.name} did not start: ${found.client.failure}`);
    }
    return found;
}

function duration(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

function requestFailure(error: unknown, spec: ServerSpec, what: string): ToolResult {
    if (error instanceof RequestTimeoutError) {
        return errorResult(
            `${spec.name} did not answer the ${what} request within ${duration(error.timeoutMs)}; it may still be loading the project. Try again shortly.`,
        );
    }
    if (error instanceof RequestAbortedError) {
        return errorResult('Cancelled.');
    }
    if (error instanceof ConnectionClosedError) {
        return errorResult(`${error.message}\nThe next call tries to start it again.`);
    }
    if (error instanceof ResponseError) {
        return errorResult(
            error.code === ErrorCodes.MethodNotFound
                ? `${spec.name} does not support ${what}.`
                : `${spec.name} could not answer the ${what} request: ${error.message}`,
        );
    }
    return errorResult(`The ${what} request failed: ${error instanceof Error ? error.message : String(error)}`);
}

/** The identifier around a 0-based character of a line. */
function wordAt(text: string, character: number): string | undefined {
    for (const match of text.matchAll(/[\p{L}\p{N}_$]+/gu)) {
        if (match.index <= character && character <= match.index + match[0].length) {
            return match[0];
        }
    }
    return undefined;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where `symbol` starts on a line: as a whole word if it appears as one, else anywhere. */
function findSymbol(text: string, symbol: string): number {
    const whole = new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(symbol)}(?![\\p{L}\\p{N}_$])`, 'u').exec(text);
    return whole ? whole.index : text.indexOf(symbol);
}

/** The protocol position for the 1-based line and column (or symbol) the model gave. */
function resolvePosition(
    text: string,
    input: LspInput,
    target: Target,
): { readonly position: Position; readonly word: string; readonly where: string } | ToolResult {
    const line = input.line ?? 1;
    const lines = text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') {
        lines.pop();
    }
    if (line > lines.length) {
        const count = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`;
        return errorResult(`${target.shown} has ${count}; line ${line} is past the end.`);
    }
    const content = (lines[line - 1] ?? '').replace(/\r$/, '');
    let character: number;
    if (input.column !== undefined) {
        if (input.column > content.length + 1) {
            return errorResult(
                `Line ${line} of ${target.shown} has ${content.length} characters; column ${input.column} is past its end.`,
            );
        }
        character = input.column - 1;
    } else {
        const symbol = input.symbol ?? '';
        const at = findSymbol(content, symbol);
        if (at < 0) {
            return errorResult(
                `\`${symbol}\` does not appear on line ${line} of ${target.shown}, which reads: ${truncateLine(content.trim(), 200)}`,
            );
        }
        character = at;
    }
    const word = wordAt(content, character) ?? input.symbol ?? '';
    return { position: { line: line - 1, character }, word, where: `${target.shown}:${line}:${character + 1}` };
}

/** Locations of a definition answer, whichever of its three shapes the server chose. */
function toLocations(result: Location | readonly Location[] | readonly LocationLink[] | null): Location[] {
    if (result === null || result === undefined) {
        return [];
    }
    const list = (Array.isArray(result) ? result : [result]) as ReadonlyArray<Location | LocationLink>;
    return list.map((item) =>
        'targetUri' in item ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange } : item,
    );
}

/** One line per location, with the source line when the file is inside the workspace. */
async function locationLines(locations: readonly Location[], ctx: ToolContext): Promise<string[]> {
    const texts = new Map<string, Promise<string[] | undefined>>();
    const source = (file: string): Promise<string[] | undefined> => {
        let text = texts.get(file);
        if (!text) {
            text = (async () => {
                const access = await checkPathAccess(ctx.roots, file);
                if (!access.ok) {
                    return undefined;
                }
                const read = await readTextFile(access.realPath).catch(() => null);
                return read?.text.split('\n');
            })();
            texts.set(file, text);
        }
        return text;
    };
    const out: string[] = [];
    for (const location of locations) {
        const file = uriToFile(location.uri);
        if (file === undefined) {
            out.push(`${location.uri}:${showPosition(location.range)}`);
            continue;
        }
        const lines = await source(file);
        out.push(locationLine(ctx.cwd, file, location.range, lines?.[location.range.start.line]?.replace(/\r$/, '')));
    }
    return out;
}

function byPlace(a: Location, b: Location): number {
    return (
        a.uri.localeCompare(b.uri) ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character
    );
}

function toolLocations(locations: readonly Location[]): ToolLocation[] {
    return locations.slice(0, 20).flatMap((location) => {
        const file = uriToFile(location.uri);
        return file === undefined ? [] : [{ path: file, line: location.range.start.line + 1 }];
    });
}

async function runPositional(input: LspInput, target: Target, lsp: LspAccess, ctx: ToolContext): Promise<ToolResult> {
    const text = await readSource(target);
    if (isResult(text)) {
        return text;
    }
    const resolved = resolvePosition(text, input, target);
    if (isResult(resolved)) {
        return resolved;
    }
    const server = await serverFor(lsp, target, ctx);
    if (isResult(server)) {
        return server;
    }
    const { client, spec, languageId } = server;
    client.syncDocument(target.file, text, languageId);
    const params = { textDocument: { uri: fileUri(target.file) }, position: resolved.position };
    const options = { timeoutMs: lsp.manager.requestTimeoutMs, signal: ctx.signal };
    const name = resolved.word === '' ? 'the symbol' : `\`${resolved.word}\``;
    try {
        if (input.operation === 'hover') {
            const hover = await client.request<Hover | null>('textDocument/hover', params, options);
            const body = hover ? hoverText(hover) : '';
            if (body === '') {
                return { content: `${spec.name} has no hover information for ${name} at ${resolved.where}.` };
            }
            return {
                content: `Hover for ${name} at ${resolved.where}:\n${truncateMiddle(body, MAX_HOVER_CHARS)}`,
                locations: [{ path: target.file, line: resolved.position.line + 1 }],
            };
        }
        if (input.operation === 'definition') {
            const answer = await client.request<Location | Location[] | LocationLink[] | null>(
                'textDocument/definition',
                params,
                options,
            );
            const locations = toLocations(answer);
            if (locations.length === 0) {
                return { content: `${spec.name} found no definition of ${name} at ${resolved.where}.` };
            }
            const lines = await locationLines(locations.slice(0, MAX_LOCATIONS), ctx);
            return {
                content: `Definition of ${name} (${resolved.where}):\n${lines.join('\n')}`,
                locations: toolLocations(locations),
            };
        }
        const references = toLocations(
            await client.request<Location[] | null>(
                'textDocument/references',
                { ...params, context: { includeDeclaration: true } },
                options,
            ),
        ).sort(byPlace);
        if (references.length === 0) {
            return { content: `${spec.name} found no references to ${name} at ${resolved.where}.` };
        }
        const lines = await locationLines(references.slice(0, MAX_LOCATIONS), ctx);
        const files = new Set(references.map((reference) => reference.uri)).size;
        const more = references.length > MAX_LOCATIONS ? `\n… ${references.length - MAX_LOCATIONS} more not shown` : '';
        const count = `${references.length} ${references.length === 1 ? 'reference' : 'references'}`;
        return {
            content: truncateMiddle(
                `${count} to ${name} in ${files} ${files === 1 ? 'file' : 'files'}, the declaration included:\n${lines.join('\n')}${more}`,
                MAX_OUTPUT_CHARS,
            ),
            locations: toolLocations(references),
        };
    } catch (error) {
        return requestFailure(error, spec, input.operation);
    }
}

async function runSymbols(input: LspInput, target: Target, lsp: LspAccess, ctx: ToolContext): Promise<ToolResult> {
    const text = await readSource(target);
    if (isResult(text)) {
        return text;
    }
    const server = await serverFor(lsp, target, ctx);
    if (isResult(server)) {
        return server;
    }
    const { client, spec, languageId } = server;
    client.syncDocument(target.file, text, languageId);
    const options = { timeoutMs: lsp.manager.requestTimeoutMs, signal: ctx.signal };
    try {
        if (input.query !== undefined) {
            if (!client.capabilities.workspaceSymbolProvider) {
                return errorResult(`${spec.name} does not support searching symbols across the workspace.`);
            }
            const found =
                (await client.request<SymbolInformation[] | null>(
                    'workspace/symbol',
                    { query: input.query },
                    options,
                )) ?? [];
            if (found.length === 0) {
                return { content: `${spec.name} found no symbols matching "${input.query}".` };
            }
            // The project's own symbols first; servers also find matches in libraries and system headers.
            const files = found.map((symbol) => uriToFile(symbol.location.uri));
            const inside = files.map(
                (file) => file !== undefined && ctx.roots.some((root) => isPathInside(root, file)),
            );
            const order = found.map((_, index) => index).sort((a, b) => Number(inside[b]) - Number(inside[a]));
            const lines = order
                .slice(0, MAX_LOCATIONS)
                .map((index) => workspaceSymbolLine(ctx.cwd, found[index] as SymbolInformation, files[index]));
            const more = found.length > MAX_LOCATIONS ? `\n… ${found.length - MAX_LOCATIONS} more not shown` : '';
            return {
                content: truncateMiddle(
                    `${found.length} ${found.length === 1 ? 'symbol matches' : 'symbols match'} "${input.query}":\n${lines.join('\n')}${more}`,
                    MAX_OUTPUT_CHARS,
                ),
            };
        }
        const symbols =
            (await client.request<Array<DocumentSymbol | SymbolInformation> | null>(
                'textDocument/documentSymbol',
                { textDocument: { uri: fileUri(target.file) } },
                options,
            )) ?? [];
        if (symbols.length === 0) {
            return { content: `${spec.name} reports no symbols in ${target.shown}.` };
        }
        const outline = formatDocumentSymbols(symbols, MAX_SYMBOLS);
        const more = outline.count > MAX_SYMBOLS ? `\n… ${outline.count - MAX_SYMBOLS} more not shown` : '';
        return {
            content: truncateMiddle(`Symbols in ${target.shown}:\n${outline.text}${more}`, MAX_OUTPUT_CHARS),
            locations: [{ path: target.file }],
        };
    } catch (error) {
        return requestFailure(error, spec, input.query === undefined ? 'document symbols' : 'workspace symbols');
    }
}

async function diagnose(target: Target, lsp: LspAccess, ctx: ToolContext): Promise<{ text: string; ok: boolean }> {
    const text = await readSource(target);
    if (isResult(text)) {
        return { text: text.content, ok: false };
    }
    const server = await serverFor(lsp, target, ctx);
    if (isResult(server)) {
        return { text: `${target.shown}: ${server.content}`, ok: false };
    }
    const { client, spec, languageId } = server;
    client.syncDocument(target.file, text, languageId);
    const report = await client.waitForCurrent(target.file, {
        deadline: Date.now() + lsp.manager.diagnosticsTimeoutMs,
        settleMs: lsp.manager.settleMs,
        signal: ctx.signal,
    });
    if (!report) {
        if (client.state !== 'ready') {
            return { text: `${target.shown}: ${client.failure}`, ok: false };
        }
        return {
            text: `${target.shown}: ${spec.name} reported nothing within ${duration(lsp.manager.diagnosticsTimeoutMs)}; it may still be loading the project. Try again shortly.`,
            ok: false,
        };
    }
    return {
        text: formatFileDiagnostics(ctx.cwd, target.file, report.items, spec.name, MAX_DIAGNOSTICS_PER_FILE),
        ok: true,
    };
}

async function runLsp(input: LspInput, ctx: ToolContext): Promise<ToolResult> {
    const lsp = ctx.lsp;
    if (!lsp) {
        return errorResult('Language servers are not available in this session.');
    }
    if (input.paths !== undefined && input.paths.length > 0 && input.operation !== 'diagnostics') {
        return errorResult('`paths` only works with the diagnostics operation; give one file in `path`.');
    }
    if (input.query !== undefined && input.operation !== 'symbols') {
        return errorResult('`query` only works with the symbols operation.');
    }
    if (needsPosition(input.operation)) {
        if (input.line === undefined) {
            return errorResult(`${input.operation} needs \`line\` (1-based) and either \`column\` or \`symbol\`.`);
        }
        if (input.column === undefined && input.symbol === undefined) {
            return errorResult(
                `${input.operation} needs the symbol's \`column\` (1-based) on line ${input.line}, or the \`symbol\` itself as written there.`,
            );
        }
    }
    const requested = [input.path, ...(input.paths ?? [])];
    const targets: Target[] = [];
    const seen = new Set<string>();
    for (const given of requested) {
        const file = resolveToolPath(ctx.cwd, given);
        const shown = displayPath(ctx.cwd, file);
        const access = await checkPathAccess(ctx.roots, file);
        if (!access.ok) {
            return errorResult(`${shown} is outside the workspace; language servers only look at files inside it.`);
        }
        if (!seen.has(access.realPath)) {
            seen.add(access.realPath);
            targets.push({ file: access.realPath, shown });
        }
    }
    const first = targets[0] as Target;
    if (input.operation === 'symbols') {
        return runSymbols(input, first, lsp, ctx);
    }
    if (input.operation !== 'diagnostics') {
        return runPositional(input, first, lsp, ctx);
    }
    const results = await Promise.all(targets.map((target) => diagnose(target, lsp, ctx)));
    const content = truncateMiddle(results.map((result) => result.text).join('\n'), MAX_OUTPUT_CHARS);
    return results.some((result) => result.ok) ? { content } : errorResult(content);
}

export const lspTool: ToolDefinition<LspInput> = {
    name: 'lsp',
    description: [
        "Ask the project's language server about code: `diagnostics` (errors and warnings of up to 10 files), `definition`, `references` and `hover` for the symbol at `line`/`column`, and `symbols` (the outline of a file, or with `query` a search for symbols across the workspace).",
        '- Lines and columns are 1-based, as `read` shows them. Instead of `column` you can give `symbol`, the identifier as written on that line.',
        '- Covers TypeScript/JavaScript (typescript-language-server), Python (pyright or basedpyright), Go (gopls), Rust (rust-analyzer) and C/C++ (clangd) when the server is installed; otherwise the result says what to install.',
        '- The first call for a language starts its server, which may take a while to load the project.',
        '- Where a server is available it finds definitions and uses of a symbol more precisely than grep: it follows imports and skips comments and strings.',
    ].join('\n'),
    kind: 'search',
    schema: LspInput,
    readOnly: true,
    targets: (input, ctx) => [input.path, ...(input.paths ?? [])].map((p) => resolveToolPath(ctx.cwd, p)),
    title: (input) => {
        if (input.operation === 'symbols' && input.query !== undefined) {
            return `LSP symbols "${input.query}"`;
        }
        const more = input.paths !== undefined && input.paths.length > 0 ? ` (+${input.paths.length})` : '';
        const line = input.line !== undefined && needsPosition(input.operation) ? `:${input.line}` : '';
        return `LSP ${input.operation} ${input.path}${line}${more}`;
    },
    run: runLsp,
};
