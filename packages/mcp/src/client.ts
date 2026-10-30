import {
    type AuthProvider,
    Client,
    type ContentBlock,
    type FetchLike,
    type GetPromptResult,
    type Implementation,
    type Prompt,
    ProtocolError,
    type Resource,
    type ResourceTemplateType,
    SdkError,
    SdkErrorCode,
    SdkHttpError,
    SSEClientTransport,
    StreamableHTTPClientTransport,
    type Tool,
    type Transport,
    UnauthorizedError,
    UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/client';
import {
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_TOOL_TIMEOUT_MS,
    type McpServerConfig,
    type McpServerConfigInput,
    parseServerConfig,
} from './config.ts';
import { errorMessage, isAbortError, McpError } from './errors.ts';
import { mergeEnv, ProcessTransport, safeBaseEnv } from './process.ts';
import { isSecretEntry, redactText, secretArgValues } from './secrets.ts';
import { capContent, capResourceContents, type ResourceContents } from './truncate.ts';

export type McpStatus = 'stopped' | 'starting' | 'running' | 'failed';
export type McpLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface McpLogLine {
    readonly ts: number;
    /** `stderr` of a stdio server, a `notifications/message` from the server, or a lifecycle event of ours. */
    readonly source: 'stderr' | 'server' | 'client';
    readonly level: McpLogLevel;
    /** Already redacted. */
    readonly text: string;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
export const DEFAULT_LOG_LIMIT = 500;
const MAX_LOG_LINE_LENGTH = 4000;

export interface McpConnectOptions {
    /** Cancels connecting; it has no effect once the connection is running. */
    readonly signal?: AbortSignal;
    readonly onLog?: (line: McpLogLine) => void;
    readonly onStatus?: (status: McpStatus, error: McpError | undefined) => void;
    /** The server went away by itself (process exit, closed transport) while running. Not called after `close()`. */
    readonly onClose?: (error: McpError) => void;
    /** The server announced `notifications/tools/list_changed`; carries the refreshed list. */
    readonly onToolsChanged?: (tools: Tool[]) => void;
    /**
     * Environment for stdio servers, already stripped of secrets by the caller (10 §6); the config's `env` is layered
     * on top. Defaults to {@link safeBaseEnv}. Nothing else from `process.env` reaches the server.
     */
    readonly baseEnv?: Readonly<Record<string, string | undefined>>;
    /** Bearer tokens for http and sse servers, e.g. {@link oauthAuthProvider}. */
    readonly authProvider?: AuthProvider;
    readonly fetch?: FetchLike;
    readonly clientInfo?: Implementation;
    readonly connectTimeoutMs?: number;
    /** Lines kept in {@link McpConnection.logs}; defaults to {@link DEFAULT_LOG_LIMIT}. */
    readonly logLimit?: number;
}

export interface McpCallOptions {
    readonly signal?: AbortSignal;
    /** Overrides the config's `timeoutMs`; progress notifications restart the clock. */
    readonly timeoutMs?: number;
    readonly onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
}

export interface McpToolResult {
    readonly content: ContentBlock[];
    /** The tool ran and reported a failure; the content says why. */
    readonly isError: boolean;
    readonly structuredContent?: unknown;
    /** Content was cut to the config's `maxOutputBytes`. */
    readonly truncated: boolean;
}

export interface McpResourceResult {
    readonly contents: ResourceContents[];
    readonly truncated: boolean;
}

const DEFAULT_CLIENT_INFO: Implementation = { name: 'xora-code', title: 'Xora Code', version: '1.0.0' };

/** Values of this config that must never show up in logs or errors. */
function secretValues(config: McpServerConfig): string[] {
    const values: string[] = [];
    const entries = config.transport === 'stdio' ? config.env : config.headers;
    for (const [key, value] of Object.entries(entries)) {
        if (isSecretEntry(key, value)) {
            values.push(value);
        }
    }
    if (config.transport === 'stdio') {
        values.push(...secretArgValues(config.args));
    } else {
        const url = new URL(config.url);
        values.push(url.password, ...[...url.searchParams].filter(([k, v]) => isSecretEntry(k, v)).map(([, v]) => v));
    }
    return values.filter((value) => value.length > 0);
}

function describeTarget(config: McpServerConfig): string {
    if (config.transport === 'stdio') {
        return `${config.command} ${config.args.join(' ')}`.trim();
    }
    const url = new URL(config.url);
    return `${config.transport} ${url.origin}${url.pathname}`;
}

function isUnauthorized(error: unknown): boolean {
    if (error instanceof UnauthorizedError) {
        return true;
    }
    return error instanceof SdkHttpError && (error.status === 401 || error.status === 403);
}

const UNSUPPORTED_PROTOCOL_VERSION = -32022;

function isUnsupportedProtocolVersion(error: unknown): boolean {
    if (error instanceof UnsupportedProtocolVersionError) {
        return true;
    }
    if (error instanceof ProtocolError) {
        return error.code === UNSUPPORTED_PROTOCOL_VERSION;
    }
    // Over HTTP the rejection arrives as a 400 whose body is the JSON-RPC error.
    if (error instanceof SdkHttpError && typeof error.data.text === 'string') {
        try {
            const body = JSON.parse(error.data.text) as { error?: { code?: unknown } } | null;
            return body?.error?.code === UNSUPPORTED_PROTOCOL_VERSION;
        } catch {
            return false;
        }
    }
    return false;
}

function isSpawnError(error: unknown): error is NodeJS.ErrnoException {
    const syscall = (error as NodeJS.ErrnoException | undefined)?.syscall;
    return error instanceof Error && typeof syscall === 'string' && syscall.startsWith('spawn');
}

/** Removes empty headers: imported configs leave secrets empty until the user enters them. */
function presentHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== ''));
}

/**
 * One MCP server: starts or connects to it, lists and calls its tools, resources and prompts, and keeps the status,
 * the last error and recent log lines for diagnostics. Output is capped at the config's `maxOutputBytes`.
 */
export class McpConnection {
    #status: McpStatus = 'stopped';
    #lastError: McpError | undefined;
    #logs: McpLogLine[] = [];
    #config: McpServerConfig | undefined;
    #options: McpConnectOptions = {};
    #client: Client | undefined;
    #transport: Transport | undefined;
    /** Bumped by every `connect()` and `close()`; callbacks of an older generation are ignored. */
    #generation = 0;
    #secrets: string[] = [];

    get status(): McpStatus {
        return this.#status;
    }

    get lastError(): McpError | undefined {
        return this.#lastError;
    }

    /** Recent stderr, server log and lifecycle lines, oldest first. */
    get logs(): readonly McpLogLine[] {
        return this.#logs;
    }

    get config(): McpServerConfig | undefined {
        return this.#config;
    }

    get serverInfo(): Implementation | undefined {
        return this.#client?.getServerVersion();
    }

    get instructions(): string | undefined {
        return this.#client?.getInstructions();
    }

    /** The negotiated MCP revision, e.g. `2025-11-25`, or `2026-07-28` for a server that only speaks that. */
    get protocolVersion(): string | undefined {
        return this.#client?.getNegotiatedProtocolVersion();
    }

    /** Process id of a running stdio server. */
    get pid(): number | undefined {
        return this.#transport instanceof ProcessTransport ? this.#transport.pid : undefined;
    }

    /** Starts the server (stdio) or connects to it (http, sse). Throws {@link McpError}; `status` is then `failed`. */
    async connect(input: McpServerConfigInput, options: McpConnectOptions = {}): Promise<void> {
        if (this.#status === 'starting' || this.#status === 'running') {
            throw new McpError('connect-failed', 'the connection is already open');
        }
        const checked = parseServerConfig(input);
        if (!checked.ok) {
            throw new McpError('invalid-config', checked.reason);
        }
        const config = checked.config;
        this.#config = config;
        this.#options = options;
        this.#secrets = secretValues(config);
        this.#lastError = undefined;
        this.#generation += 1;
        const generation = this.#generation;
        this.#setStatus('starting');
        this.#log('client', 'info', `starting ${describeTarget(config)}`);
        try {
            options.signal?.throwIfAborted();
            try {
                await this.#open(config, options, generation, 'legacy');
            } catch (error) {
                if (!isUnsupportedProtocolVersion(error) || generation !== this.#generation) {
                    throw error;
                }
                // A server that only speaks the 2026-07-28 revision rejects `initialize`; negotiate instead.
                this.#log('client', 'info', 'the server rejected the 2025 handshake, negotiating the protocol version');
                await this.#teardown();
                await this.#open(config, options, generation, 'auto');
            }
        } catch (error) {
            if (generation !== this.#generation) {
                // `close()` ran meanwhile and already cleaned up.
                throw new McpError('aborted', 'the connection was closed while starting');
            }
            const failure = this.#connectError(error, config, options);
            await this.#teardown();
            this.#lastError = failure;
            this.#log('client', 'error', failure.message);
            this.#setStatus('failed');
            throw failure;
        }
        const info = this.serverInfo;
        this.#log('client', 'info', `connected${info ? ` to ${info.name} ${info.version}` : ''}`);
        this.#setStatus('running');
    }

    async listTools(): Promise<Tool[]> {
        const client = this.#requireRunning();
        try {
            return (await client.listTools()).tools;
        } catch (error) {
            throw this.#requestError(error, 'listing tools');
        }
    }

    async listResources(): Promise<Resource[]> {
        const client = this.#requireRunning();
        try {
            return (await client.listResources()).resources;
        } catch (error) {
            throw this.#requestError(error, 'listing resources');
        }
    }

    async listResourceTemplates(): Promise<ResourceTemplateType[]> {
        const client = this.#requireRunning();
        try {
            return (await client.listResourceTemplates()).resourceTemplates;
        } catch (error) {
            throw this.#requestError(error, 'listing resource templates');
        }
    }

    async readResource(uri: string, options: Pick<McpCallOptions, 'signal'> = {}): Promise<McpResourceResult> {
        const client = this.#requireRunning();
        try {
            const result = await client.readResource(
                { uri },
                { ...(options.signal ? { signal: options.signal } : {}) },
            );
            return capResourceContents(result.contents, this.#maxOutputBytes());
        } catch (error) {
            throw this.#requestError(error, `reading ${uri}`, options.signal);
        }
    }

    async listPrompts(): Promise<Prompt[]> {
        const client = this.#requireRunning();
        try {
            return (await client.listPrompts()).prompts;
        } catch (error) {
            throw this.#requestError(error, 'listing prompts');
        }
    }

    async getPrompt(name: string, args: Readonly<Record<string, string>> = {}): Promise<GetPromptResult> {
        const client = this.#requireRunning();
        try {
            return await client.getPrompt({ name, arguments: { ...args } });
        } catch (error) {
            throw this.#requestError(error, `getting prompt ${name}`);
        }
    }

    /**
     * Calls a tool. A tool that ran and failed resolves with `isError: true`; timeouts, cancellation, protocol errors
     * and lost connections reject with {@link McpError}.
     */
    async callTool(
        name: string,
        args: Readonly<Record<string, unknown>> = {},
        options: McpCallOptions = {},
    ): Promise<McpToolResult> {
        const client = this.#requireRunning();
        const config = this.#config as McpServerConfig;
        const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const onProgress = options.onProgress;
        try {
            const result = await client.callTool(
                { name, arguments: { ...args } },
                {
                    timeout: timeoutMs,
                    resetTimeoutOnProgress: true,
                    ...(options.signal ? { signal: options.signal } : {}),
                    ...(onProgress
                        ? {
                              onprogress: (progress) =>
                                  onProgress({
                                      progress: progress.progress,
                                      ...(progress.total === undefined ? {} : { total: progress.total }),
                                      ...(progress.message === undefined ? {} : { message: progress.message }),
                                  }),
                          }
                        : {}),
                },
            );
            const capped = capContent(result.content ?? [], result.structuredContent, this.#maxOutputBytes());
            return {
                content: capped.content,
                isError: result.isError === true,
                ...(capped.structuredContent === undefined ? {} : { structuredContent: capped.structuredContent }),
                truncated: capped.truncated,
            };
        } catch (error) {
            throw this.#requestError(error, `tool ${name}`, options.signal, timeoutMs);
        }
    }

    /** Adds a line of our own to {@link logs}, e.g. a reconnect decision of the manager. */
    note(level: McpLogLevel, text: string): void {
        this.#log('client', level, text);
    }

    /** Disconnects; a stdio server gets its stdin closed, then SIGTERM, then SIGKILL, process tree included. */
    async close(): Promise<void> {
        this.#generation += 1;
        await this.#teardown();
        if (this.#status !== 'stopped') {
            this.#log('client', 'info', 'stopped');
            this.#setStatus('stopped');
        }
    }

    async #open(
        config: McpServerConfig,
        options: McpConnectOptions,
        generation: number,
        mode: 'legacy' | 'auto',
    ): Promise<void> {
        const onToolsChanged = options.onToolsChanged;
        const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO, {
            capabilities: {},
            versionNegotiation: { mode },
            listChanged: {
                tools: {
                    onChanged: (error, tools) => {
                        if (generation !== this.#generation) {
                            return;
                        }
                        if (error) {
                            this.#log('client', 'warn', `refreshing tools failed: ${errorMessage(error)}`);
                        } else {
                            onToolsChanged?.(tools ?? []);
                        }
                    },
                },
            },
        });
        client.onerror = (error) => {
            if (generation === this.#generation) {
                this.#log('client', 'warn', errorMessage(error));
            }
        };
        client.onclose = () => this.#onTransportClosed(generation);
        client.setNotificationHandler('notifications/message', (notification) => {
            if (generation !== this.#generation) {
                return;
            }
            const { level, data, logger } = notification.params;
            const text = typeof data === 'string' ? data : JSON.stringify(data);
            const mapped: McpLogLevel =
                level === 'debug'
                    ? 'debug'
                    : level === 'info' || level === 'notice'
                      ? 'info'
                      : level === 'warning'
                        ? 'warn'
                        : 'error';
            this.#log('server', mapped, logger ? `[${logger}] ${text}` : text);
        });
        if (generation !== this.#generation) {
            throw new McpError('aborted', 'the connection was closed while starting');
        }
        const transport = this.#createTransport(config, options, generation);
        // Reachable through the fields from the start, so that `close()` can stop a server that is still starting.
        this.#client = client;
        this.#transport = transport;
        try {
            await client.connect(transport, {
                timeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
                ...(options.signal ? { signal: options.signal } : {}),
            });
        } finally {
            if (generation !== this.#generation) {
                await client.close().catch(() => undefined);
                await transport.close().catch(() => undefined);
            }
        }
        if (generation !== this.#generation) {
            throw new McpError('aborted', 'the connection was closed while starting');
        }
    }

    #createTransport(config: McpServerConfig, options: McpConnectOptions, generation: number): Transport {
        if (config.transport === 'stdio') {
            return new ProcessTransport({
                command: config.command,
                args: config.args,
                env: mergeEnv(options.baseEnv ?? safeBaseEnv(), config.env),
                ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
                onStderr: (line) => {
                    if (generation === this.#generation && line.trim() !== '') {
                        this.#log('stderr', 'info', line);
                    }
                },
            });
        }
        const httpOptions = {
            requestInit: { headers: presentHeaders(config.headers) },
            ...(options.authProvider ? { authProvider: options.authProvider } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
        };
        const url = new URL(config.url);
        return config.transport === 'http'
            ? new StreamableHTTPClientTransport(url, httpOptions)
            : new SSEClientTransport(url, httpOptions);
    }

    #onTransportClosed(generation: number): void {
        if (generation !== this.#generation || this.#status !== 'running') {
            return;
        }
        const error = new McpError('closed', this.#exitDescription() ?? 'the connection to the server was closed');
        this.#client = undefined;
        this.#transport = undefined;
        this.#lastError = error;
        this.#log('client', 'error', error.message);
        this.#setStatus('failed');
        this.#options.onClose?.(error);
    }

    /** `server process exited with code 1: <last stderr line>` once a stdio server has exited. */
    #exitDescription(): string | undefined {
        const transport = this.#transport;
        const exit = transport instanceof ProcessTransport ? transport.exit : undefined;
        if (!exit) {
            return undefined;
        }
        const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
        const lastStderr = [...this.#logs].reverse().find((line) => line.source === 'stderr')?.text;
        return `server process ${how}${lastStderr ? `: ${lastStderr.slice(0, 300)}` : ''}`;
    }

    async #teardown(): Promise<void> {
        const client = this.#client;
        const transport = this.#transport;
        this.#client = undefined;
        this.#transport = undefined;
        try {
            await client?.close();
        } catch {
            // Closing is best effort; the transport below is closed either way.
        }
        try {
            await transport?.close();
        } catch {
            // Same.
        }
    }

    #requireRunning(): Client {
        if (this.#status !== 'running' || !this.#client) {
            const name = this.#config?.name ?? 'server';
            throw new McpError('not-running', `${name} is not running (${this.#status})`);
        }
        return this.#client;
    }

    #maxOutputBytes(): number {
        return this.#config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    }

    #redact(text: string): string {
        return redactText(text, this.#secrets);
    }

    #connectError(error: unknown, config: McpServerConfig, options: McpConnectOptions): McpError {
        if (error instanceof McpError) {
            return error;
        }
        if (options.signal?.aborted || isAbortError(error)) {
            return new McpError('aborted', 'connecting was cancelled');
        }
        if (isUnauthorized(error)) {
            return new McpError('unauthorized', 'the server requires authorization');
        }
        if (isSpawnError(error) && config.transport === 'stdio') {
            return new McpError('spawn-failed', this.#redact(`cannot start ${config.command}: ${error.message}`));
        }
        if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
            const ms = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
            return new McpError('timeout', `the server did not complete the handshake within ${ms} ms`);
        }
        const exit = this.#exitDescription();
        if (exit) {
            return new McpError('connect-failed', this.#redact(exit));
        }
        if (error instanceof ProtocolError) {
            return new McpError('protocol', this.#redact(error.message), error.code);
        }
        return new McpError('connect-failed', this.#redact(errorMessage(error)));
    }

    #requestError(error: unknown, what: string, signal?: AbortSignal, timeoutMs?: number): McpError {
        if (error instanceof McpError) {
            return error;
        }
        if (signal?.aborted || isAbortError(error)) {
            return new McpError('aborted', `${what} was cancelled`);
        }
        if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
            return new McpError(
                'timeout',
                `${what} timed out${timeoutMs === undefined ? '' : ` after ${timeoutMs} ms`}`,
            );
        }
        if (isUnauthorized(error)) {
            return new McpError('unauthorized', `${what} failed: the server requires authorization`);
        }
        if (
            error instanceof SdkError &&
            (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected)
        ) {
            const reason =
                this.#exitDescription() ??
                (this.#lastError?.code === 'closed' ? this.#lastError.message : 'the connection was closed');
            return new McpError('closed', `${what} failed: ${reason}`);
        }
        if (error instanceof ProtocolError) {
            return new McpError('protocol', this.#redact(`${what} failed: ${error.message}`), error.code);
        }
        return new McpError('protocol', this.#redact(`${what} failed: ${errorMessage(error)}`));
    }

    #setStatus(status: McpStatus): void {
        this.#status = status;
        this.#options.onStatus?.(status, status === 'failed' ? this.#lastError : undefined);
    }

    #log(source: McpLogLine['source'], level: McpLogLevel, text: string): void {
        const redacted = this.#redact(text);
        const line: McpLogLine = {
            ts: Date.now(),
            source,
            level,
            text: redacted.length > MAX_LOG_LINE_LENGTH ? `${redacted.slice(0, MAX_LOG_LINE_LENGTH)}…` : redacted,
        };
        this.#logs.push(line);
        const limit = this.#options.logLimit ?? DEFAULT_LOG_LIMIT;
        if (this.#logs.length > limit) {
            this.#logs.splice(0, this.#logs.length - limit);
        }
        this.#options.onLog?.(line);
    }
}
