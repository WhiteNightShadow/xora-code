import type { AuthProvider, FetchLike, Implementation, Tool, ToolAnnotations } from '@modelcontextprotocol/client';
import { type McpCallOptions, McpConnection, type McpLogLine, type McpStatus, type McpToolResult } from './client.ts';
import {
    isToolAllowed,
    MAX_TOOL_NAME_LENGTH,
    type McpServerConfig,
    type McpServerConfigInput,
    type McpServerOrigin,
    type McpTransportKind,
    parseQualifiedToolName,
    parseServerConfig,
    qualifyToolName,
    shortHash,
} from './config.ts';
import { McpError, type McpErrorCode } from './errors.ts';

/** A JSON Schema object as MCP tools declare it. */
export type McpJsonSchema = { readonly type: 'object'; readonly [key: string]: unknown };

export interface McpTool {
    readonly server: string;
    /** The tool's own name, as the server knows it. */
    readonly name: string;
    /** `mcp__<server>__<tool>`; the name the model sees. See {@link qualifyToolName}. */
    readonly qualifiedName: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema: McpJsonSchema;
    readonly outputSchema?: McpJsonSchema;
    /** Hints such as `readOnlyHint`; they come from the server and are not to be trusted for permissions. */
    readonly annotations?: ToolAnnotations;
}

export interface McpServerStatus {
    readonly name: string;
    readonly transport: McpTransportKind;
    readonly origin: McpServerOrigin;
    readonly status: McpStatus;
    /** Why a configured server was not started. */
    readonly skipped?: 'disabled' | 'untrusted';
    readonly error?: string;
    readonly errorCode?: McpErrorCode;
    /** Tools the tool filter lets through. */
    readonly toolCount: number;
    /** Automatic reconnect attempts since the last start, restart or stable period. */
    readonly reconnects: number;
    /** A reconnect is scheduled or in progress. */
    readonly reconnecting: boolean;
    readonly serverInfo?: Implementation;
    readonly pid?: number;
}

export interface McpReconnectPolicy {
    /** Default 3. */
    readonly maxAttempts?: number;
    /** Delay before the first attempt, doubled for each further one; default 500 ms. */
    readonly baseDelayMs?: number;
    /** Default 8 s. */
    readonly maxDelayMs?: number;
    /** A server that stayed up this long before dying gets its attempts back; default 60 s. */
    readonly stableMs?: number;
}

export interface McpManagerOptions {
    readonly clientInfo?: Implementation;
    /** Sanitized environment for stdio servers; see {@link McpConnectOptions.baseEnv}. */
    readonly baseEnv?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: FetchLike;
    /** Bearer tokens for a remote server, e.g. `(config) => oauthAuthProvider(config.url, storage)`. */
    readonly authProvider?: (config: McpServerConfig) => AuthProvider | undefined;
    readonly connectTimeoutMs?: number;
    readonly reconnect?: McpReconnectPolicy;
    readonly onLog?: (server: string, line: McpLogLine) => void;
    readonly onStatus?: (status: McpServerStatus) => void;
    /** The set of tools changed: a server started or stopped, or announced a new list. */
    readonly onToolsChanged?: () => void;
}

interface Entry {
    config: McpServerConfig;
    readonly connection: McpConnection;
    tools: Tool[];
    reconnects: number;
    reconnecting: boolean;
    reconnectTimer: NodeJS.Timeout | undefined;
    connectedAt: number;
    /** Bumped by stop and restart, so that callbacks and pending reconnects of an earlier run do nothing. */
    run: number;
}

interface IndexedTool {
    readonly entry: Entry;
    readonly tool: Tool;
    readonly allowed: boolean;
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function runnable(config: McpServerConfig): boolean {
    return config.enabled && config.trusted;
}

/**
 * All MCP servers of one engine (or one project in the host). Starts the enabled and trusted ones, exposes their
 * tools under qualified names, honours tool filters, and reconnects a stdio server that dies while running, at most
 * {@link McpReconnectPolicy.maxAttempts} times. A server that fails to start is left failed until restarted.
 */
export class McpManager {
    readonly #options: McpManagerOptions;
    #entries = new Map<string, Entry>();
    #index: Map<string, IndexedTool> | undefined;

    constructor(options: McpManagerOptions = {}) {
        this.#options = options;
    }

    /**
     * Applies a server list: new servers start, removed ones stop, changed ones restart, unchanged ones are left as
     * they are. Resolves when every start attempt has finished; failures show up in {@link statuses}, not as a
     * rejection. Rejects only for invalid configs or duplicate names, before anything changes.
     */
    async start(inputs: readonly McpServerConfigInput[]): Promise<void> {
        const configs: McpServerConfig[] = [];
        const names = new Set<string>();
        for (const input of inputs) {
            const checked = parseServerConfig(input);
            if (!checked.ok) {
                throw new McpError('invalid-config', checked.reason);
            }
            if (names.has(checked.config.name)) {
                throw new McpError('invalid-config', `duplicate server name ${checked.config.name}`);
            }
            names.add(checked.config.name);
            configs.push(checked.config);
        }
        const previous = this.#entries;
        const next = new Map<string, Entry>();
        const starting: Entry[] = [];
        const stopping: Promise<void>[] = [];
        for (const [name, entry] of previous) {
            if (!names.has(name)) {
                stopping.push(this.#halt(entry));
            }
        }
        for (const config of configs) {
            const existing = previous.get(config.name);
            if (existing && canonicalJson(existing.config) === canonicalJson(config)) {
                next.set(config.name, existing);
                continue;
            }
            const entry: Entry = existing ?? {
                config,
                connection: new McpConnection(),
                tools: [],
                reconnects: 0,
                reconnecting: false,
                reconnectTimer: undefined,
                connectedAt: 0,
                run: 0,
            };
            if (existing) {
                stopping.push(this.#halt(existing));
            }
            entry.config = config;
            next.set(config.name, entry);
            starting.push(entry);
        }
        this.#entries = next;
        await Promise.all(stopping);
        this.#changed();
        await Promise.all(
            starting.map(async (entry) => {
                if (runnable(entry.config)) {
                    await this.#connect(entry);
                } else {
                    this.#notify(entry);
                }
            }),
        );
        this.#changed();
    }

    /** Stops and starts one server and resets its reconnect attempts; works for failed servers too. */
    async restart(name: string): Promise<McpServerStatus> {
        const entry = this.#require(name);
        await this.#halt(entry);
        if (runnable(entry.config)) {
            await this.#connect(entry);
        }
        this.#changed();
        return this.#statusOf(entry);
    }

    async stop(name: string): Promise<void> {
        await this.#halt(this.#require(name));
        this.#changed();
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.#entries.values()].map((entry) => this.#halt(entry)));
        this.#changed();
    }

    statuses(): McpServerStatus[] {
        return [...this.#entries.values()].map((entry) => this.#statusOf(entry));
    }

    status(name: string): McpServerStatus | undefined {
        const entry = this.#entries.get(name);
        return entry && this.#statusOf(entry);
    }

    logs(name: string): readonly McpLogLine[] {
        return this.#entries.get(name)?.connection.logs ?? [];
    }

    /** The connection of a server, for resources and prompts. */
    connection(name: string): McpConnection | undefined {
        return this.#entries.get(name)?.connection;
    }

    /** Tools of the running servers that their tool filters allow, in config order. */
    tools(): McpTool[] {
        const tools: McpTool[] = [];
        for (const [qualifiedName, { entry, tool, allowed }] of this.#toolIndex()) {
            if (!allowed) {
                continue;
            }
            tools.push({
                server: entry.config.name,
                name: tool.name,
                qualifiedName,
                ...(tool.title === undefined ? {} : { title: tool.title }),
                description: tool.description ?? '',
                inputSchema: { ...tool.inputSchema, type: 'object' },
                ...(tool.outputSchema === undefined ? {} : { outputSchema: { ...tool.outputSchema, type: 'object' } }),
                ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
            });
        }
        return tools;
    }

    /** Lists the tools of one server (or all running ones) again. */
    async refreshTools(name?: string): Promise<void> {
        const entries = name === undefined ? [...this.#entries.values()] : [this.#require(name)];
        await Promise.all(
            entries.filter((entry) => entry.connection.status === 'running').map((entry) => this.#loadTools(entry)),
        );
        this.#changed();
    }

    async callTool(
        qualifiedName: string,
        args: Readonly<Record<string, unknown>> = {},
        options: McpCallOptions = {},
    ): Promise<McpToolResult> {
        const target = this.#toolIndex().get(qualifiedName);
        if (!target) {
            const parsed = parseQualifiedToolName(qualifiedName);
            const entry = parsed && this.#entries.get(parsed.server);
            if (entry && entry.connection.status !== 'running') {
                throw new McpError('not-running', `${entry.config.name} is not running (${entry.connection.status})`);
            }
            throw new McpError('tool-not-found', `no MCP tool named ${qualifiedName}`);
        }
        if (!target.allowed) {
            throw new McpError('tool-not-allowed', `${qualifiedName} is turned off for ${target.entry.config.name}`);
        }
        return target.entry.connection.callTool(target.tool.name, args, options);
    }

    #require(name: string): Entry {
        const entry = this.#entries.get(name);
        if (!entry) {
            throw new McpError('invalid-config', `no MCP server named ${name}`);
        }
        return entry;
    }

    async #connect(entry: Entry): Promise<boolean> {
        const run = entry.run;
        const { clientInfo, baseEnv, fetch, connectTimeoutMs, onLog } = this.#options;
        const authProvider =
            entry.config.transport === 'stdio' ? undefined : this.#options.authProvider?.(entry.config);
        try {
            await entry.connection.connect(entry.config, {
                ...(clientInfo ? { clientInfo } : {}),
                ...(baseEnv ? { baseEnv } : {}),
                ...(fetch ? { fetch } : {}),
                ...(connectTimeoutMs ? { connectTimeoutMs } : {}),
                ...(authProvider ? { authProvider } : {}),
                onLog: (line) => onLog?.(entry.config.name, line),
                onStatus: () => this.#notify(entry),
                onClose: () => this.#onServerExit(entry, run),
                onToolsChanged: (tools) => {
                    if (run === entry.run) {
                        entry.tools = tools;
                        this.#changed();
                    }
                },
            });
        } catch {
            // The status and error are on the connection.
            return false;
        }
        if (run !== entry.run) {
            return false;
        }
        entry.connectedAt = Date.now();
        entry.reconnecting = false;
        await this.#loadTools(entry);
        this.#notify(entry);
        return true;
    }

    async #loadTools(entry: Entry): Promise<void> {
        try {
            entry.tools = await entry.connection.listTools();
        } catch (error) {
            entry.tools = [];
            entry.connection.note('warn', `listing tools failed: ${(error as Error).message}`);
        }
    }

    #onServerExit(entry: Entry, run: number): void {
        entry.tools = [];
        this.#changed();
        if (run !== entry.run || entry.config.transport !== 'stdio') {
            return;
        }
        const policy = this.#options.reconnect ?? {};
        if (Date.now() - entry.connectedAt >= (policy.stableMs ?? 60_000)) {
            entry.reconnects = 0;
        }
        this.#scheduleReconnect(entry, run);
    }

    #scheduleReconnect(entry: Entry, run: number): void {
        const policy = this.#options.reconnect ?? {};
        const maxAttempts = policy.maxAttempts ?? 3;
        if (entry.reconnects >= maxAttempts) {
            entry.reconnecting = false;
            entry.connection.note('error', `gave up after ${maxAttempts} reconnect attempts`);
            this.#notify(entry);
            return;
        }
        const delay = Math.min(policy.maxDelayMs ?? 8000, (policy.baseDelayMs ?? 500) * 2 ** entry.reconnects);
        entry.reconnects += 1;
        entry.reconnecting = true;
        entry.connection.note('info', `reconnecting in ${delay} ms (attempt ${entry.reconnects} of ${maxAttempts})`);
        this.#notify(entry);
        entry.reconnectTimer = setTimeout(async () => {
            entry.reconnectTimer = undefined;
            if (run !== entry.run) {
                return;
            }
            const connected = await this.#connect(entry);
            if (run !== entry.run) {
                return;
            }
            if (connected) {
                this.#changed();
            } else {
                this.#scheduleReconnect(entry, run);
            }
        }, delay);
        entry.reconnectTimer.unref();
    }

    /** Stops a server and cancels its pending reconnect; the entry stays, with fresh reconnect attempts. */
    async #halt(entry: Entry): Promise<void> {
        entry.run += 1;
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = undefined;
        entry.reconnecting = false;
        entry.reconnects = 0;
        entry.tools = [];
        await entry.connection.close();
        this.#notify(entry);
    }

    #toolIndex(): Map<string, IndexedTool> {
        if (this.#index) {
            return this.#index;
        }
        const index = new Map<string, IndexedTool>();
        for (const entry of this.#entries.values()) {
            if (entry.connection.status !== 'running') {
                continue;
            }
            for (const tool of entry.tools) {
                let qualifiedName = qualifyToolName(entry.config.name, tool.name);
                // Two tool names that only differ in characters outside [a-zA-Z0-9_-] get a hash to tell them apart.
                for (let n = 0; index.has(qualifiedName); n += 1) {
                    const suffix = `_${shortHash(`${entry.config.name}\0${tool.name}\0${n}`)}`;
                    qualifiedName = qualifiedName.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
                }
                index.set(qualifiedName, { entry, tool, allowed: isToolAllowed(entry.config.toolFilter, tool.name) });
            }
        }
        this.#index = index;
        return index;
    }

    #changed(): void {
        this.#index = undefined;
        this.#options.onToolsChanged?.();
    }

    #notify(entry: Entry): void {
        if (this.#entries.get(entry.config.name) === entry) {
            this.#index = undefined;
            this.#options.onStatus?.(this.#statusOf(entry));
        }
    }

    #statusOf(entry: Entry): McpServerStatus {
        const { config, connection } = entry;
        const skipped = !config.enabled ? 'disabled' : !config.trusted ? 'untrusted' : undefined;
        const error = connection.status === 'failed' ? connection.lastError : undefined;
        const serverInfo = connection.status === 'running' ? connection.serverInfo : undefined;
        const pid = connection.pid;
        return {
            name: config.name,
            transport: config.transport,
            origin: config.origin,
            status: connection.status,
            ...(skipped ? { skipped } : {}),
            ...(error ? { error: error.message, errorCode: error.code } : {}),
            toolCount: entry.tools.filter((tool) => isToolAllowed(config.toolFilter, tool.name)).length,
            reconnects: entry.reconnects,
            reconnecting: entry.reconnecting,
            ...(serverInfo ? { serverInfo } : {}),
            ...(pid === undefined ? {} : { pid }),
        };
    }
}
