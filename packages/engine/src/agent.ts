import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { readSessionConfig } from './config.ts';
import { type AnyTool, createDefaultTools } from './deps.ts';
import { type HookReply, ModelError, type TurnIO, TurnRunner } from './loop.ts';
import { createMcpManager, readMcpServers } from './mcp.ts';
import { EngineSession, SessionBusyError } from './session.ts';
import { listStoredSessions, liveTurns, SessionFile } from './store.ts';

export interface XoraAgentOptions {
    /** Root for session files: `<dataDir>/sessions/<id>/`. */
    readonly dataDir: string;
    readonly version: string;
    /** Tools offered to the model; defaults to the built-in set. */
    readonly tools?: readonly AnyTool[];
    readonly log?: (message: string) => void;
}

/** JSON-RPC error code for model failures; `data.xora` carries the classified error. */
export const MODEL_ERROR_CODE = -32050;
export const BUSY_ERROR_CODE = -32051;

function realDir(dir: string): string {
    try {
        return realpathSync(dir);
    } catch {
        throw acp.RequestError.invalidParams(undefined, `directory does not exist: ${dir}`);
    }
}

const SessionRefSchema = z.object({ sessionId: z.string().min(1) }).passthrough();
const CompactSchema = z.object({ sessionId: z.string().min(1), focus: z.string().optional() });
const RewindSchema = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) });
const ForkSchema = z.object({
    sessionId: z.string().min(1),
    /** Copy the history up to the start of this turn; without it, the whole history. */
    beforeTurnId: z.string().min(1).optional(),
});

/** Replays a stored conversation as `session/update` notifications for `session/load`. */
function replay(session: EngineSession, notify: (update: acp.SessionUpdate) => void): void {
    const results = new Map<string, string>();
    for (const message of session.history) {
        if (message.role === 'tool') {
            results.set(
                message.toolCallId,
                message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
            );
        }
    }
    for (const message of session.history) {
        if (message.role === 'user') {
            for (const part of message.content) {
                if (part.type === 'text' && !part.text.startsWith('<environment>')) {
                    notify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: part.text } });
                }
            }
        } else if (message.role === 'assistant') {
            for (const part of message.content) {
                if (part.type === 'reasoning' && part.text) {
                    notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: part.text } });
                } else if (part.type === 'text') {
                    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part.text } });
                } else if (part.type === 'tool_call') {
                    notify({
                        sessionUpdate: 'tool_call',
                        toolCallId: part.id,
                        title: part.name,
                        status: 'completed',
                        content: [{ type: 'content', content: { type: 'text', text: results.get(part.id) ?? '' } }],
                    });
                }
            }
        }
    }
}

/**
 * The xora engine as an ACP agent. One process serves many sessions; each session has its own working
 * directory, history and configuration. Permission decisions are made by the client (the Xora host).
 */
export function createXoraAgent(options: XoraAgentOptions): acp.AgentApp {
    const sessions = new Map<string, EngineSession>();
    const sessionsDir = path.join(options.dataDir, 'sessions');
    const tools = options.tools ?? createDefaultTools();
    const log = options.log ?? (() => undefined);

    function open(
        sessionId: string,
        cwd: string,
        additional: readonly string[] | undefined,
        meta: unknown,
    ): EngineSession {
        const dir = path.join(sessionsDir, sessionId);
        if (!SessionFile.exists(dir)) {
            throw acp.RequestError.resourceNotFound(sessionId);
        }
        const existing = sessions.get(sessionId);
        const config = readSessionConfig(meta);
        const realCwd = realDir(cwd);
        if (existing && existing.cwd === realCwd) {
            existing.configure(config);
            return existing;
        }
        if (existing) {
            // The thread moved between the project folder and a worktree: same history, new working directory.
            if (existing.busy) {
                throw new acp.RequestError(BUSY_ERROR_CODE, 'cannot move a running session');
            }
            existing.dispose();
            sessions.delete(sessionId);
        }
        const session = new EngineSession({
            id: sessionId,
            cwd: realCwd,
            roots: [realCwd, ...(additional ?? []).map(realDir)],
            dir,
            config,
        });
        session.restore(session.file.read());
        session.configure(config);
        sessions.set(sessionId, session);
        return session;
    }

    /** Starts (or reconciles) the session's MCP servers; a failing server never fails the session. */
    async function configureMcp(session: EngineSession, servers: readonly unknown[] | undefined): Promise<void> {
        const { configs, problems } = readMcpServers(servers);
        for (const problem of problems) {
            log(`ignored MCP server: ${problem}`);
        }
        if (configs.length === 0 && !session.mcp) {
            return;
        }
        session.mcp ??= createMcpManager(options.version);
        const started = session.mcp.start(configs).catch((error: unknown) => log(`MCP start failed: ${String(error)}`));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 30_000);
        });
        await Promise.race([started, timeout]);
        clearTimeout(timer);
    }

    /** How each MCP server of the session is doing, for the host to show (`_meta.xora.mcp`). */
    function mcpStatus(session: EngineSession): { mcp?: Array<Record<string, unknown>> } {
        const statuses = session.mcp?.statuses();
        if (!statuses || statuses.length === 0) {
            return {};
        }
        return {
            mcp: statuses.map((status) => ({
                name: status.name,
                status: status.status,
                tools: status.toolCount,
                ...(status.error ? { error: status.error } : {}),
            })),
        };
    }

    function require(sessionId: string): EngineSession {
        const session = sessions.get(sessionId);
        if (!session) {
            throw new acp.RequestError(-32002, `session not loaded: ${sessionId}`);
        }
        return session;
    }

    function io(client: acp.AgentContext, sessionId: string): TurnIO {
        return {
            update: (update) => {
                client.notify('session/update', { sessionId, update }).catch((error: unknown) => {
                    log(`session/update failed: ${error instanceof Error ? error.message : String(error)}`);
                });
            },
            requestPermission: (request) => client.request('session/request_permission', { ...request, sessionId }),
            callHostTool: async (name, input, signal) => {
                const result = await client.request<{ content: string; isError?: boolean; display?: unknown }>(
                    '_xora/tool/call',
                    { sessionId, name, input },
                    { cancellationSignal: signal },
                );
                return {
                    content: String(result.content ?? ''),
                    ...(result.isError ? { isError: true } : {}),
                    ...(result.display ? { display: result.display as never } : {}),
                };
            },
            runHook: (event, payload, signal) =>
                client.request<HookReply>(
                    '_xora/hook/run',
                    { sessionId, event, payload },
                    { cancellationSignal: signal },
                ),
        };
    }

    return acp
        .agent({ name: 'xora-engine' })
        .onRequest('initialize', () => ({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, embeddedContext: true },
                mcpCapabilities: { http: true, sse: true },
                sessionCapabilities: { list: {}, resume: {}, close: {} },
            },
            agentInfo: { name: 'xora-engine', title: 'Xora Engine', version: options.version },
            authMethods: [],
            _meta: { xora: { protocol: 1, features: ['configure', 'compact', 'usage', 'display'] } },
        }))
        .onRequest('session/new', async ({ params }) => {
            const config = readSessionConfig(params._meta);
            const cwd = realDir(params.cwd);
            const sessionId = randomUUID();
            const dir = path.join(sessionsDir, sessionId);
            const roots = [cwd, ...(params.additionalDirectories ?? []).map(realDir)];
            const session = new EngineSession({ id: sessionId, cwd, roots, dir, config });
            session.file.create({ t: 'header', v: 1, id: sessionId, cwd, roots, createdAt: Date.now() });
            session.configure(config);
            sessions.set(sessionId, session);
            await configureMcp(session, params.mcpServers);
            log(`session ${sessionId} created in ${cwd}`);
            return { sessionId, _meta: { xora: { dir, ...mcpStatus(session) } } };
        })
        .onRequest('session/load', async ({ params, client }) => {
            const session = open(params.sessionId, params.cwd, params.additionalDirectories, params._meta);
            await configureMcp(session, params.mcpServers);
            replay(session, io(client, session.id).update);
            return { _meta: { xora: mcpStatus(session) } };
        })
        .onRequest('session/resume', async ({ params }) => {
            const session = open(params.sessionId, params.cwd, params.additionalDirectories, params._meta);
            await configureMcp(session, params.mcpServers);
            return { _meta: { xora: mcpStatus(session) } };
        })
        .onRequest('session/list', ({ params }) => ({
            sessions: listStoredSessions(sessionsDir, params.cwd ?? undefined).map((info) => ({
                sessionId: info.id,
                cwd: info.cwd,
                title: info.title ?? null,
                updatedAt: info.updatedAt,
            })),
        }))
        .onRequest('session/close', ({ params }) => {
            sessions.get(params.sessionId)?.dispose();
            sessions.delete(params.sessionId);
            return {};
        })
        .onRequest('session/prompt', async ({ params, client, signal }) => {
            const session = require(params.sessionId);
            let controller: AbortController;
            try {
                controller = session.begin();
            } catch (error) {
                if (error instanceof SessionBusyError) {
                    throw new acp.RequestError(BUSY_ERROR_CODE, error.message);
                }
                throw error;
            }
            const onAbort = () => controller.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            const turnId = (params._meta as { xora?: { turnId?: unknown } } | null | undefined)?.xora?.turnId;
            if (typeof turnId === 'string' && turnId.length > 0) {
                session.beginTurn(turnId);
            }
            try {
                const runner = new TurnRunner(session, io(client, session.id), controller.signal, tools);
                const stopReason = await runner.run(params.prompt);
                return { stopReason };
            } catch (error) {
                if (error instanceof ModelError) {
                    throw new acp.RequestError(MODEL_ERROR_CODE, error.message, {
                        xora: {
                            errorClass: error.errorClass,
                            retryable: error.retryable,
                            retryAfterMs: error.retryAfterMs,
                            status: error.status,
                        },
                    });
                }
                log(`prompt failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
                throw error;
            } finally {
                signal.removeEventListener('abort', onAbort);
                session.end();
            }
        })
        .onNotification('session/cancel', ({ params }) => {
            sessions.get(params.sessionId)?.cancel();
        })
        .onRequest('_xora/session/configure', SessionRefSchema, ({ params }) => {
            require(params.sessionId).configure(readSessionConfig(params._meta));
            return {};
        })
        .onRequest('_xora/session/rewind', RewindSchema, ({ params }) => {
            const live = sessions.get(params.sessionId);
            if (live) {
                if (live.busy) {
                    throw new acp.RequestError(BUSY_ERROR_CODE, 'the session is running');
                }
                if (!live.rewind(params.turnId)) {
                    throw acp.RequestError.invalidParams({ turnId: params.turnId }, 'unknown turn');
                }
                return {};
            }
            const file = new SessionFile(path.join(sessionsDir, params.sessionId));
            if (!SessionFile.exists(file.dir)) {
                throw acp.RequestError.resourceNotFound(params.sessionId);
            }
            if (!liveTurns(file.read()).includes(params.turnId)) {
                throw acp.RequestError.invalidParams({ turnId: params.turnId }, 'unknown turn');
            }
            file.append({ t: 'rewind', ts: Date.now(), turnId: params.turnId });
            return {};
        })
        .onRequest('_xora/session/fork', ForkSchema, ({ params }) => {
            const source = new SessionFile(path.join(sessionsDir, params.sessionId));
            if (!SessionFile.exists(source.dir)) {
                throw acp.RequestError.resourceNotFound(params.sessionId);
            }
            if (sessions.get(params.sessionId)?.busy) {
                throw new acp.RequestError(BUSY_ERROR_CODE, 'the session is running');
            }
            const entries = source.read();
            const header = entries[0];
            if (header?.t !== 'header') {
                throw acp.RequestError.internalError({ sessionId: params.sessionId }, 'the session file has no header');
            }
            let end = entries.length;
            if (params.beforeTurnId) {
                if (!liveTurns(entries).includes(params.beforeTurnId)) {
                    throw acp.RequestError.invalidParams({ turnId: params.beforeTurnId }, 'unknown turn');
                }
                end = entries.findLastIndex((entry) => entry.t === 'turn' && entry.turnId === params.beforeTurnId);
            }
            const sessionId = randomUUID();
            const copy = new SessionFile(path.join(sessionsDir, sessionId));
            copy.create({ ...header, id: sessionId, createdAt: Date.now() });
            for (const entry of entries.slice(1, end)) {
                copy.append(entry);
            }
            log(`session ${sessionId} forked from ${params.sessionId}`);
            return { sessionId };
        })
        .onRequest('_xora/session/compact', CompactSchema, async ({ params, client }) => {
            const session = require(params.sessionId);
            const controller = session.begin();
            try {
                const runner = new TurnRunner(session, io(client, session.id), controller.signal, tools);
                const compacted = await runner.compact(3, params.focus, 'manual');
                return { compacted };
            } finally {
                session.end();
            }
        });
}
