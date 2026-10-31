import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { EngineDefinition } from './registry.ts';

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

export interface EngineLaunch {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
}

/** One running engine process with its ACP connection. */
export class EngineProcess {
    readonly key: string;
    readonly definition: EngineDefinition;
    readonly agent: acp.ClientContext;
    readonly capabilities: acp.AgentCapabilities;
    readonly info: acp.InitializeResponse;
    readonly #child: ChildProcess;
    readonly #connection: acp.ClientConnection;
    #alive = true;

    constructor(options: {
        key: string;
        definition: EngineDefinition;
        child: ChildProcess;
        connection: acp.ClientConnection;
        info: acp.InitializeResponse;
    }) {
        this.key = options.key;
        this.definition = options.definition;
        this.#child = options.child;
        this.#connection = options.connection;
        this.agent = options.connection.agent;
        this.info = options.info;
        this.capabilities = options.info.agentCapabilities ?? {};
    }

    get alive(): boolean {
        return this.#alive && !this.#connection.signal.aborted;
    }

    markDead(): void {
        this.#alive = false;
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
        if (this.#child.exitCode === null && !this.#child.killed) {
            this.#child.kill();
        }
    }
}

/**
 * Starts engines as ACP subprocesses (one process per engine and project, 02 §1) and routes their callbacks
 * to the session that owns them. The engines never decide permissions: every request comes back here.
 */
export class EngineManager {
    readonly #log: Logger;
    readonly #version: string;
    readonly #launch: (definition: EngineDefinition) => Promise<EngineLaunch>;
    readonly #processes = new Map<string, Promise<EngineProcess>>();
    readonly #sessions = new Map<string, { handlers: SessionHandlers; processKey: string }>();

    constructor(options: {
        log: Logger;
        version: string;
        launch: (definition: EngineDefinition) => Promise<EngineLaunch>;
    }) {
        this.#log = options.log;
        this.#version = options.version;
        this.#launch = options.launch;
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

    async #start(definition: EngineDefinition, key: string): Promise<EngineProcess> {
        const launch = await this.#launch(definition);
        this.#log.info(`starting engine ${key}: ${launch.command} ${launch.args.join(' ')}`);
        const child = spawn(launch.command, [...launch.args], {
            env: launch.env as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            ...(launch.cwd ? { cwd: launch.cwd } : {}),
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            for (const line of chunk.split('\n')) {
                if (line.trim()) {
                    this.#log.info(`[${definition.id}] ${line}`);
                }
            }
        });
        const spawned = new Promise<void>((resolve, reject) => {
            child.once('spawn', () => resolve());
            child.once('error', reject);
        });
        await spawned;
        if (!child.stdin || !child.stdout) {
            throw new Error(`engine ${definition.id} has no stdio`);
        }
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
        const stream = acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        );
        const connection = app.connect(stream);
        let info: acp.InitializeResponse;
        try {
            info = await connection.agent.request('initialize', {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: 'xora-host', title: 'Xora Code', version: this.#version },
            });
        } catch (error) {
            child.kill();
            throw error;
        }
        const process = new EngineProcess({ key, definition, child, connection, info });
        child.once('exit', (code, signal) => {
            process.markDead();
            this.#processes.delete(key);
            const reason = `engine ${definition.id} exited (${signal ?? code})`;
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
