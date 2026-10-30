import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { type McpServerConfig, normalizeServerName, parseServerConfig, type ToolFilter } from './config.ts';
import { errorMessage } from './errors.ts';
import { isPlainObject, parseJsonc, parseTomlSubset } from './formats.ts';
import { isSecretEntry, secretArg, VARIABLE_REFERENCE } from './secrets.ts';

export type ImportTool = 'claude' | 'cursor' | 'vscode' | 'codex';
/** `local` is Claude Code's per-project entry in `~/.claude.json`. */
export type ImportScope = 'user' | 'project' | 'local';

export interface ImportSource {
    readonly tool: ImportTool;
    readonly file: string;
    readonly scope: ImportScope;
    /** The server's name in that file, before {@link normalizeServerName}. */
    readonly name: string;
}

/**
 * A server found in another tool's config. It is disabled, untrusted and `origin: 'imported'` until the user picks
 * it (09 §6), and secret values were not copied.
 */
export interface ImportedServer {
    readonly config: McpServerConfig;
    readonly source: ImportSource;
    /**
     * Values left empty for the user to enter again: env var names (stdio), header names (http, sse), `args[<i>]`
     * for a command line argument, and `url:<query parameter>` or `url:userinfo` for credentials in the URL.
     */
    readonly secretKeys: readonly string[];
}

export interface ImportWarning {
    readonly tool: ImportTool;
    readonly file: string;
    readonly server?: string;
    readonly message: string;
}

export interface ImportResult {
    readonly servers: readonly ImportedServer[];
    readonly warnings: readonly ImportWarning[];
}

export interface ImportOptions {
    /** Defaults to `os.homedir()`. */
    readonly home?: string;
    /** Project whose `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` and Claude Code local entry are read. */
    readonly projectDir?: string;
    /** Defaults to all four. */
    readonly tools?: readonly ImportTool[];
}

/** One server entry of another tool, before secrets are taken out. */
interface ForeignServer {
    readonly name: string;
    readonly type?: unknown;
    readonly command?: unknown;
    readonly args?: unknown;
    readonly env?: unknown;
    readonly url?: unknown;
    readonly headers?: unknown;
    readonly cwd?: unknown;
    /** Variables the tool forwards from its own environment; their values have to be entered again. */
    readonly forwardedEnv?: readonly string[];
    /** Headers whose values the tool reads from its environment. */
    readonly forwardedHeaders?: readonly string[];
    readonly toolFilter?: ToolFilter;
    readonly timeoutMs?: number;
}

interface FileContext {
    readonly tool: ImportTool;
    readonly file: string;
    readonly scope: ImportScope;
    readonly servers: ImportedServer[];
    readonly warnings: ImportWarning[];
}

const ALL_TOOLS: readonly ImportTool[] = ['claude', 'cursor', 'vscode', 'codex'];
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function warn(ctx: FileContext, message: string, server?: string): void {
    ctx.warnings.push({ tool: ctx.tool, file: ctx.file, message, ...(server === undefined ? {} : { server }) });
}

/** Missing files are not an error: most users have only some of these tools. */
async function readText(ctx: FileContext): Promise<string | undefined> {
    try {
        return await readFile(ctx.file, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            warn(ctx, `cannot read the file: ${errorMessage(error)}`);
        }
        return undefined;
    }
}

async function readJsonc(ctx: FileContext): Promise<unknown> {
    const text = await readText(ctx);
    if (text === undefined) {
        return undefined;
    }
    try {
        return parseJsonc(text);
    } catch (error) {
        warn(ctx, `cannot parse the file: ${errorMessage(error)}`);
        return undefined;
    }
}

function stringRecord(ctx: FileContext, server: string, field: string, value: unknown): Record<string, string> {
    if (value === undefined || value === null) {
        return {};
    }
    if (!isPlainObject(value)) {
        warn(ctx, `${field} is not an object and was ignored`, server);
        return {};
    }
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            out[key] = String(item);
        } else {
            warn(ctx, `${field}.${key} is not a string and was ignored`, server);
        }
    }
    return out;
}

/** Copies the entries that are not credentials; the others become `""` and their keys are listed. */
function maskEntries(
    ctx: FileContext,
    server: string,
    entries: Record<string, string>,
    secretKeys: string[],
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries)) {
        if (isSecretEntry(key, value) || value.includes('${input:')) {
            out[key] = '';
            secretKeys.push(key);
            continue;
        }
        if (VARIABLE_REFERENCE.test(value)) {
            warn(ctx, `${key} refers to a variable (${value}) that Xora Code does not expand`, server);
        }
        out[key] = value;
    }
    return out;
}

function maskArgs(args: readonly string[], secretKeys: string[]): string[] {
    return args.map((arg, index) => {
        const secret = secretArg(args, index);
        if (secret.kind === 'none') {
            return arg;
        }
        secretKeys.push(`args[${index}]`);
        return secret.kind === 'value' ? `${secret.flag}=` : '';
    });
}

function maskUrl(raw: string, secretKeys: string[]): string {
    const url = new URL(raw);
    if (url.username || url.password) {
        url.username = '';
        url.password = '';
        secretKeys.push('url:userinfo');
    }
    for (const [name, value] of [...url.searchParams]) {
        if (isSecretEntry(name, value)) {
            url.searchParams.set(name, '');
            secretKeys.push(`url:${name}`);
        }
    }
    return url.href;
}

type TransportGuess = McpServerConfig['transport'] | 'unsupported' | undefined;

function transportOf(entry: ForeignServer): TransportGuess {
    if (typeof entry.type === 'string') {
        const type = entry.type.toLowerCase();
        if (type === 'stdio' || type === 'local') {
            return 'stdio';
        }
        if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp' || type === 'remote') {
            return 'http';
        }
        return type === 'sse' ? 'sse' : 'unsupported';
    }
    if (typeof entry.command === 'string') {
        return 'stdio';
    }
    if (typeof entry.url === 'string') {
        // Tools that infer the transport serve the legacy SSE endpoint at `/sse` by convention.
        return /\/sse\/?$/i.test(entry.url.split('?')[0] ?? '') ? 'sse' : 'http';
    }
    return undefined;
}

function convert(ctx: FileContext, entry: ForeignServer, usedNames: Set<string>): void {
    const transport = transportOf(entry);
    if (transport === undefined || transport === 'unsupported') {
        const what = transport === undefined ? 'no command or url' : `unsupported type ${String(entry.type)}`;
        warn(ctx, `skipped: ${what}`, entry.name);
        return;
    }
    let name = normalizeServerName(entry.name);
    for (let n = 2; usedNames.has(name); n += 1) {
        name = `${normalizeServerName(entry.name).slice(0, 36)}-${n}`;
    }
    const secretKeys: string[] = [];
    const common = {
        name,
        enabled: false,
        origin: 'imported' as const,
        trusted: false,
        ...(entry.toolFilter ? { toolFilter: entry.toolFilter } : {}),
        ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
    };
    let raw: unknown;
    if (transport === 'stdio') {
        if (typeof entry.command !== 'string' || entry.command === '') {
            warn(ctx, 'skipped: stdio server without a command', entry.name);
            return;
        }
        const args = Array.isArray(entry.args)
            ? entry.args.filter((arg): arg is string => typeof arg === 'string')
            : [];
        const env = maskEntries(ctx, entry.name, stringRecord(ctx, entry.name, 'env', entry.env), secretKeys);
        for (const key of entry.forwardedEnv ?? []) {
            env[key] = '';
            secretKeys.push(key);
        }
        raw = {
            ...common,
            transport,
            command: entry.command,
            args: maskArgs(args, secretKeys),
            env,
            ...(typeof entry.cwd === 'string' && entry.cwd !== '' ? { cwd: entry.cwd } : {}),
        };
    } else {
        if (typeof entry.url !== 'string') {
            warn(ctx, `skipped: ${transport} server without a url`, entry.name);
            return;
        }
        let url: string;
        try {
            url = maskUrl(entry.url, secretKeys);
        } catch {
            warn(ctx, 'skipped: the url is not valid', entry.name);
            return;
        }
        const headers = maskEntries(
            ctx,
            entry.name,
            stringRecord(ctx, entry.name, 'headers', entry.headers),
            secretKeys,
        );
        for (const key of entry.forwardedHeaders ?? []) {
            headers[key] = '';
            secretKeys.push(key);
        }
        raw = { ...common, transport, url, headers };
    }
    const checked = parseServerConfig(raw);
    if (!checked.ok) {
        warn(ctx, `skipped: ${checked.reason}`, entry.name);
        return;
    }
    usedNames.add(name);
    ctx.servers.push({
        config: checked.config,
        source: { tool: ctx.tool, file: ctx.file, scope: ctx.scope, name: entry.name },
        secretKeys: [...new Set(secretKeys)],
    });
}

/** `mcpServers`-style maps shared by Claude Code, Cursor and VS Code. */
function convertMap(ctx: FileContext, map: unknown, field: string): void {
    if (map === undefined) {
        return;
    }
    if (!isPlainObject(map)) {
        warn(ctx, `${field} is not an object`);
        return;
    }
    const used = new Set<string>();
    for (const [name, value] of Object.entries(map)) {
        if (!isPlainObject(value)) {
            warn(ctx, 'skipped: the entry is not an object', name);
            continue;
        }
        if (value.headersHelper !== undefined) {
            warn(ctx, 'headersHelper is not supported; enter the headers again', name);
        }
        if (value.envFile !== undefined) {
            warn(ctx, 'envFile is not supported; enter its variables again', name);
        }
        convert(
            ctx,
            {
                name,
                type: value.type,
                command: value.command,
                args: value.args,
                env: value.env,
                url: value.url,
                headers: value.headers,
                cwd: value.cwd,
            },
            used,
        );
    }
}

function context(tool: ImportTool, file: string, scope: ImportScope, result: ImportAccumulator): FileContext {
    return { tool, file, scope, servers: result.servers, warnings: result.warnings };
}

interface ImportAccumulator {
    readonly servers: ImportedServer[];
    readonly warnings: ImportWarning[];
}

function samePath(a: string, b: string): boolean {
    const normalize = (value: string): string => {
        const resolved = path.resolve(value).replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? resolved.replace(/\//g, '\\').toLowerCase() : resolved;
    };
    return normalize(a) === normalize(b);
}

async function projectVariants(projectDir: string): Promise<string[]> {
    const variants = [path.resolve(projectDir)];
    try {
        variants.push(await realpath(projectDir));
    } catch {
        // A project that does not exist (yet) only has its literal path.
    }
    return variants;
}

async function importClaude(home: string, projectDir: string | undefined, result: ImportAccumulator): Promise<void> {
    const userCtx = context('claude', path.join(home, '.claude.json'), 'user', result);
    const userFile = await readJsonc(userCtx);
    if (isPlainObject(userFile)) {
        convertMap(userCtx, userFile.mcpServers, 'mcpServers');
        if (projectDir !== undefined && isPlainObject(userFile.projects)) {
            const variants = await projectVariants(projectDir);
            for (const [key, project] of Object.entries(userFile.projects)) {
                if (isPlainObject(project) && variants.some((variant) => samePath(key, variant))) {
                    convertMap(context('claude', userCtx.file, 'local', result), project.mcpServers, 'mcpServers');
                    break;
                }
            }
        }
    }
    if (projectDir !== undefined) {
        const projectCtx = context('claude', path.join(projectDir, '.mcp.json'), 'project', result);
        const projectFile = await readJsonc(projectCtx);
        if (isPlainObject(projectFile)) {
            convertMap(projectCtx, projectFile.mcpServers, 'mcpServers');
        }
    }
}

async function importCursor(home: string, projectDir: string | undefined, result: ImportAccumulator): Promise<void> {
    const files: [string, ImportScope][] = [[path.join(home, '.cursor', 'mcp.json'), 'user']];
    if (projectDir !== undefined) {
        files.push([path.join(projectDir, '.cursor', 'mcp.json'), 'project']);
    }
    for (const [file, scope] of files) {
        const ctx = context('cursor', file, scope, result);
        const data = await readJsonc(ctx);
        if (isPlainObject(data)) {
            convertMap(ctx, data.mcpServers, 'mcpServers');
        }
    }
}

async function importVsCode(projectDir: string | undefined, result: ImportAccumulator): Promise<void> {
    if (projectDir === undefined) {
        return;
    }
    const ctx = context('vscode', path.join(projectDir, '.vscode', 'mcp.json'), 'project', result);
    const data = await readJsonc(ctx);
    if (isPlainObject(data)) {
        convertMap(ctx, data.servers, 'servers');
    }
}

function stringList(value: unknown): string[] | undefined {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

async function importCodex(home: string, result: ImportAccumulator): Promise<void> {
    const ctx = context('codex', path.join(home, '.codex', 'config.toml'), 'user', result);
    const text = await readText(ctx);
    if (text === undefined) {
        return;
    }
    const parsed = parseTomlSubset(text);
    for (const message of parsed.warnings) {
        warn(ctx, message);
    }
    const servers = parsed.data.mcp_servers;
    if (servers === undefined) {
        return;
    }
    if (!isPlainObject(servers)) {
        warn(ctx, 'mcp_servers is not a table');
        return;
    }
    const used = new Set<string>();
    for (const [name, value] of Object.entries(servers)) {
        if (!isPlainObject(value)) {
            warn(ctx, 'skipped: the entry is not a table', name);
            continue;
        }
        const allow = stringList(value.enabled_tools);
        const deny = stringList(value.disabled_tools);
        const forwardedHeaders = isPlainObject(value.env_http_headers) ? Object.keys(value.env_http_headers) : [];
        if (typeof value.bearer_token_env_var === 'string') {
            forwardedHeaders.push('Authorization');
        }
        const timeoutSec = typeof value.tool_timeout_sec === 'number' ? value.tool_timeout_sec : undefined;
        convert(
            ctx,
            {
                name,
                command: value.command,
                args: value.args,
                env: value.env,
                cwd: value.cwd,
                url: value.url,
                headers: value.http_headers,
                ...(typeof value.url === 'string' && value.command === undefined ? { type: 'http' } : {}),
                forwardedEnv: stringList(value.env_vars) ?? [],
                forwardedHeaders,
                ...(allow || deny ? { toolFilter: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } } : {}),
                ...(timeoutSec && timeoutSec > 0
                    ? { timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(timeoutSec * 1000))) }
                    : {}),
            },
            used,
        );
    }
}

/**
 * Reads the MCP servers configured in Claude Code (`~/.claude.json`, `<project>/.mcp.json`), Cursor
 * (`~/.cursor/mcp.json`, `<project>/.cursor/mcp.json`), VS Code (`<project>/.vscode/mcp.json`) and Codex
 * (`~/.codex/config.toml`). Nothing is written and no secret value leaves this function.
 */
export async function importServers(options: ImportOptions = {}): Promise<ImportResult> {
    const home = options.home ?? homedir();
    const tools = new Set(options.tools ?? ALL_TOOLS);
    const result: ImportAccumulator = { servers: [], warnings: [] };
    if (tools.has('claude')) {
        await importClaude(home, options.projectDir, result);
    }
    if (tools.has('cursor')) {
        await importCursor(home, options.projectDir, result);
    }
    if (tools.has('vscode')) {
        await importVsCode(options.projectDir, result);
    }
    if (tools.has('codex')) {
        await importCodex(home, result);
    }
    return result;
}
