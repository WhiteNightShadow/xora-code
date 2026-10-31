import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { ShellApi } from '../shell.ts';
import type { EngineDefinition } from './registry.ts';
import { type EngineLaunch, type EngineTransport, overPort, spawnStdio } from './transport.ts';

export interface SessionHandlers {
    onUpdate(notification: acp.SessionNotification): void;
    onPermission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
    /** The engine process died while this session was registered. */
    onExit(reason: string): void;
    /** A host-implemented tool call from the xora engine (`_xora/tool/call`). */
    onHostTool?(name: string, input: unknown, signal: AbortSignal): Promise<HostToolResult>;
    /** Hooks the xora engine raises (`_xora/hook/run`): PreToolUse, PostToolUse and PreCompact. */
    onHook?(request: HookRequest, signal: AbortSignal): Promise<Record<string, unknown>>;
}

const HookRequestSchema = z.union([
    z.object({
        sessionId: z.string(),
        event: z.enum(['PreToolUse', 'PostToolUse']),
        payload: z.object({
            tool_name: z.string(),
            tool_input: z.unknown(),
            tool_use_id: z.string(),
            tool_response: z.unknown().optional(),
        }),
    }),
    z.object({
        sessionId: z.string(),
        event: z.literal('PreCompact'),
        payload: z.object({ trigger: z.enum(['auto', 'manual']), custom_instructions: z.string().optional() }),
    }),
]);
export type HookRequest = z.infer<typeof HookRequestSchema>;

export interface HostToolResult {
    readonly content: string;
    readonly isError?: boolean;
    readonly display?: unknown;
}

const HostToolCallSchema = z.object({ sessionId: z.string(), name: z.string(), input: z.unknown() });

/** One running engine process with its ACP connection. */
export class EngineProcess {
    readonly key: string;
    readonly definition: EngineDefinition;
    readonly agent: acp.ClientContext;
    readonly capabilities: acp.AgentCapabilities;
    readonly info: acp.InitializeResponse;
    readonly #transport: EngineTransport;
    readonly #connection: acp.ClientConnection;
    #alive = true;

    constructor(options: {
        key: string;
        definition: EngineDefinition;
        transport: EngineTransport;
        connection: acp.ClientConnection;
        info: acp.InitializeResponse;
    }) {
        this.key = options.key;
        this.definition = options.definition;
        this.#transport = options.transport;
        this.#connection = options.connection;
        this.agent = options.connection.agent;
        this.info = options.info;
        this.capabilities = options.info.agentCapabilities ?? {};
    }

    get alive(): boolean {
        return this.#alive && !this.#connection.signal.aborted;
    }

    /** The process has ended: requests still waiting on it fail now instead of waiting for the stream to end. */
    markDead(reason: string): void {
        this.#alive = false;
        this.#connection.close(new Error(reason));
    }

    get supportsResume(): boolean {
        return Boolean(this.capabilities.sessionCapabilities?.resume);
    }

    get supportsLoad(): boolean {
        return Boolean(this.capabilities.loadSession);
    }

    get isXora(): boolean {
        const meta = this.info._meta as { xora?: unknown } | null | undefined;
        return meta?.xora !== undefined;
    }

    kill(): void {
        this.#alive = false;
        this.#connection.close();
        this.#transport.kill();
    }
}

/**
 * Starts engines as ACP subprocesses (one process per engine and project, 02 §1) and routes their callbacks
 * to the session that owns them. The engines never decide permissions: every request comes back here.
 * External agents are child processes on stdio; in the app the xora engine is a utility process that the
 * bootstrap forks, with ACP over a MessagePort.
 */
export class EngineManager {
    readonly #log: Logger;
    readonly #version: string;
    readonly #launch: (definition: EngineDefinition) => Promise<EngineLaunch>;
    readonly #shell: Pick<ShellApi, 'startEngine'> | undefined;
    readonly #processes = new Map<string, Promise<EngineProcess>>();
    readonly #sessions = new Map<string, { handlers: SessionHandlers; processKey: string }>();

    constructor(options: {
        log: Logger;
        version: string;
        launch: (definition: EngineDefinition) => Promise<EngineLaunch>;
        /** The bootstrap, which starts `utility` launches. */
        shell?: Pick<ShellApi, 'startEngine'>;
    }) {
        this.#log = options.log;
        this.#version = options.version;
        this.#launch = options.launch;
        this.#shell = options.shell;
    }

    register(sessionId: string, processKey: string, handlers: SessionHandlers): void {
        this.#sessions.set(sessionId, { handlers, processKey });
    }

    unregister(sessionId: string): void {
        this.#sessions.delete(sessionId);
    }

    async connect(definition: EngineDefinition, scope: string): Promise<EngineProcess> {
        const key = `${definition.id}:${scope}`;
        const existing = this.#processes.get(key);
        if (existing) {
            const process = await existing.catch(() => undefined);
            if (process?.alive) {
                return process;
            }
            this.#processes.delete(key);
        }
        const starting = this.#start(definition, key);
        this.#processes.set(key, starting);
        starting.catch(() => this.#processes.delete(key));
        return starting;
    }

    async #open(key: string, launch: EngineLaunch, onOutput: (text: string) => void): Promise<EngineTransport> {
        if (launch.kind === 'stdio') {
            this.#log.info(`starting engine ${key}: ${launch.command} ${launch.args.join(' ')}`);
            return spawnStdio(launch, onOutput);
        }
        const shell = this.#shell;
        if (!shell?.startEngine) {
            throw new Error(`engine ${key} can only be started by the app's shell`);
        }
        const engine = await shell.startEngine({ entry: launch.entry, env: launch.env, onOutput });
        this.#log.info(`started engine ${key} as utility process ${engine.pid}: ${launch.entry}`);
        return overPort(engine);
    }

    async #start(definition: EngineDefinition, key: string): Promise<EngineProcess> {
        const launch = await this.#launch(definition);
        const transport = await this.#open(key, launch, (text) => {
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    this.#log.info(`[${definition.id}] ${line}`);
                }
            }
        });
        const app = acp
            .client({ name: 'xora-host' })
            .onRequest('session/request_permission', ({ params, signal }) => {
                const entry = this.#sessions.get(params.sessionId);
                if (!entry) {
                    return { outcome: { outcome: 'cancelled' as const } };
                }
                return entry.handlers.onPermission(params, signal);
            })
            .onNotification('session/update', ({ params }) => {
                this.#sessions.get(params.sessionId)?.handlers.onUpdate(params);
            })
            .onRequest('_xora/tool/call', HostToolCallSchema, async ({ params, signal }) => {
                const handler = this.#sessions.get(params.sessionId)?.handlers.onHostTool;
                if (!handler) {
                    return { content: `Tool ${params.name} is not available in this session.`, isError: true };
                }
                return handler(params.name, params.input, signal);
            })
            .onRequest('_xora/hook/run', HookRequestSchema, async ({ params, signal }) => {
                const handler = this.#sessions.get(params.sessionId)?.handlers.onHook;
                return handler ? handler(params, signal) : {};
            });
        const connection = app.connect(transport.stream);
        let info: acp.InitializeResponse;
        try {
            info = await connection.agent.request('initialize', {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: 'xora-host', title: 'Xora Code', version: this.#version },
            });
        } catch (error) {
            transport.kill();
            throw error;
        }
        const process = new EngineProcess({ key, definition, transport, connection, info });
        void transport.exited.then((code) => {
            const reason = `engine ${definition.id} exited (${code})`;
            process.markDead(reason);
            this.#processes.delete(key);
            this.#log.warn(reason);
            for (const [sessionId, entry] of [...this.#sessions]) {
                if (entry.processKey === key) {
                    this.#sessions.delete(sessionId);
                    entry.handlers.onExit(reason);
                }
            }
        });
        this.#log.info(
            `engine ${key} ready: ${info.agentInfo?.name ?? definition.id} ${info.agentInfo?.version ?? ''}`,
        );
        return process;
    }

    async dispose(): Promise<void> {
        const processes = await Promise.allSettled([...this.#processes.values()]);
        for (const result of processes) {
            if (result.status === 'fulfilled') {
                result.value.kill();
            }
        }
        this.#processes.clear();
        this.#sessions.clear();
    }
}
