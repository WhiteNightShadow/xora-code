import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { errorTurn, openaiText, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createXoraAgent } from '../src/agent.ts';

type MockServer = Awaited<ReturnType<typeof startMockModelServer>>;
let server: MockServer;

beforeAll(async () => {
    server = await startMockModelServer();
});

afterAll(async () => {
    await server.close();
});

interface Harness {
    readonly client: acp.ClientContext;
    readonly updates: acp.SessionUpdate[];
    readonly permissions: acp.RequestPermissionRequest[];
    answer: 'allow' | 'deny' | 'cancel';
    hostToolCalls: Array<{ name: string; input: unknown }>;
    readonly hookCalls: Array<{ event: string; payload: Record<string, unknown> }>;
    hookReply: (event: string, payload: Record<string, unknown>) => Record<string, unknown>;
    close(): void;
}

function harness(): Harness {
    const updates: acp.SessionUpdate[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const state = {
        answer: 'allow' as Harness['answer'],
        hostToolCalls: [] as Array<{ name: string; input: unknown }>,
        hookCalls: [] as Array<{ event: string; payload: Record<string, unknown> }>,
        hookReply: ((): Record<string, unknown> => ({})) as (
            event: string,
            payload: Record<string, unknown>,
        ) => Record<string, unknown>,
    };
    const agentApp = createXoraAgent({ dataDir: mkdtempSync(path.join(tmpdir(), 'xora-engine-')), version: 'test' });
    const clientApp = acp
        .client({ name: 'test-host' })
        .onNotification('session/update', ({ params }) => {
            updates.push(params.update);
        })
        .onRequest('session/request_permission', ({ params }) => {
            permissions.push(params);
            if (state.answer === 'cancel') return { outcome: { outcome: 'cancelled' as const } };
            return {
                outcome: {
                    outcome: 'selected' as const,
                    optionId: state.answer === 'allow' ? 'allow_once' : 'reject_once',
                },
            };
        })
        .onRequest(
            '_xora/tool/call',
            z.object({ sessionId: z.string(), name: z.string(), input: z.unknown() }),
            ({ params }) => {
                state.hostToolCalls.push({ name: params.name, input: params.input });
                return { content: `host handled ${params.name}` };
            },
        )
        .onRequest(
            '_xora/hook/run',
            z.object({ sessionId: z.string(), event: z.string(), payload: z.record(z.string(), z.unknown()) }),
            ({ params }) => {
                state.hookCalls.push({ event: params.event, payload: params.payload });
                return state.hookReply(params.event, params.payload);
            },
        );
    const connection = clientApp.connect(agentApp);
    const result: Harness = {
        client: connection.agent,
        updates,
        permissions,
        get answer() {
            return state.answer;
        },
        set answer(value) {
            state.answer = value;
        },
        get hostToolCalls() {
            return state.hostToolCalls;
        },
        get hookCalls() {
            return state.hookCalls;
        },
        get hookReply() {
            return state.hookReply;
        },
        set hookReply(value) {
            state.hookReply = value;
        },
        set hostToolCalls(value) {
            state.hostToolCalls = value;
        },
        close: () => connection.close(),
    };
    return result;
}

function config(extra: Record<string, unknown> = {}) {
    return {
        xora: {
            model: { connection: { presetId: 'custom-openai', apiKey: 'k', baseUrl: server.url }, model: 'mock-model' },
            mode: 'ask',
            ...extra,
        },
    };
}

async function newSession(h: Harness, cwd: string, extra: Record<string, unknown> = {}): Promise<string> {
    await h.client.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
    const created = await h.client.request('session/new', { cwd, mcpServers: [], _meta: config(extra) });
    return created.sessionId;
}

function lastRole(body: unknown): string | undefined {
    return ((body as { messages?: Array<{ role: string }> }).messages ?? []).at(-1)?.role;
}

function workspace(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-engine-ws-'));
    writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    return dir;
}

describe('xora engine over ACP', () => {
    it('streams a plain answer and ends the turn', async () => {
        server.reset();
        server.respondWith(() => openaiText('你好'));
        const h = harness();
        const sessionId = await newSession(h, workspace());
        const response = await h.client.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
        });
        expect(response.stopReason).toBe('end_turn');
        const text = h.updates
            .filter(
                (update): update is Extract<acp.SessionUpdate, { sessionUpdate: 'agent_message_chunk' }> =>
                    update.sessionUpdate === 'agent_message_chunk',
            )
            .map((update) => (update.content.type === 'text' ? update.content.text : ''))
            .join('');
        expect(text).toBe('你好');
        expect(h.updates.some((update) => update.sessionUpdate === 'usage_update')).toBe(true);
        // The first user message carries the environment block, not the system prompt.
        const body = server.requests[0]?.body as { messages: Array<{ role: string; content: unknown }> };
        expect(JSON.stringify(body.messages[1]?.content)).toContain('<environment>');
        h.close();
    });

    it('runs read-only tools without asking and asks for writes', async () => {
        server.reset();
        let step = 0;
        server.respondWith((request) => {
            step++;
            if (step === 1) return openaiToolCalls([{ name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) }]);
            if (step === 2) {
                expect(lastRole(request.body)).toBe('tool');
                return openaiToolCalls([
                    { name: 'write', arguments: JSON.stringify({ path: 'b.txt', content: 'beta\n' }) },
                ]);
            }
            return openaiText('done');
        });
        const dir = workspace();
        const h = harness();
        const sessionId = await newSession(h, dir);
        const response = await h.client.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'go' }],
        });
        expect(response.stopReason).toBe('end_turn');
        expect(h.permissions.map((request) => (request._meta as { xora: { toolName: string } }).xora.toolName)).toEqual(
            ['write'],
        );
        expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('beta\n');
        h.close();
    });

    it('feeds a denial back to the model and does not write', async () => {
        server.reset();
        server.respondWith((request) =>
            lastRole(request.body) === 'tool'
                ? openaiText('ok, not writing')
                : openaiToolCalls([{ name: 'write', arguments: JSON.stringify({ path: 'c.txt', content: 'x' }) }]),
        );
        const dir = workspace();
        const h = harness();
        h.answer = 'deny';
        const sessionId = await newSession(h, dir);
        await h.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write c' }] });
        expect(() => readFileSync(path.join(dir, 'c.txt'))).toThrow();
        const lastBody = server.requests.at(-1)?.body as
            | { messages?: Array<{ role: string; content: string }> }
            | undefined;
        const toolMessage = lastBody?.messages?.at(-1);
        expect(toolMessage?.content).toContain('denied');
        h.close();
    });

    it('treats a cancelled permission as a cancelled turn', async () => {
        server.reset();
        server.respondWith(() =>
            openaiToolCalls([{ name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) }]),
        );
        const h = harness();
        h.answer = 'cancel';
        const sessionId = await newSession(h, workspace());
        const response = await h.client.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'run' }],
        });
        expect(response.stopReason).toBe('cancelled');
        expect(server.requests.length).toBe(1);
        h.close();
    });

    it('retries rate limits and reports a classified error when they persist', async () => {
        server.reset();
        let calls = 0;
        server.respondWith(() => {
            calls++;
            return calls === 1
                ? errorTurn(429, { error: { message: 'slow down' } }, { 'retry-after-ms': '10' })
                : openaiText('after retry');
        });
        const h = harness();
        const sessionId = await newSession(h, workspace());
        const response = await h.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] });
        expect(response.stopReason).toBe('end_turn');
        expect(calls).toBe(2);
        expect(h.updates.some((update) => update.sessionUpdate === 'notice')).toBe(true);

        server.reset();
        server.respondWith(() => errorTurn(401, { error: { message: 'bad key', type: 'authentication_error' } }));
        const failure = await h.client
            .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'y' }] })
            .catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: -32050, data: { xora: { errorClass: 'auth' } } });
        h.close();
    });

    it('forwards host tools to the client', async () => {
        server.reset();
        server.respondWith((request) =>
            lastRole(request.body) === 'tool'
                ? openaiText('dispatched')
                : openaiToolCalls([{ name: 'team_dispatch', arguments: JSON.stringify({ taskIds: ['T1'] }) }]),
        );
        const h = harness();
        const sessionId = await newSession(h, workspace(), {
            hostTools: [
                {
                    name: 'team_dispatch',
                    description: 'Dispatch tasks',
                    parameters: {
                        type: 'object',
                        properties: { taskIds: { type: 'array', items: { type: 'string' } } },
                    },
                },
            ],
        });
        await h.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'dispatch' }] });
        expect(h.hostToolCalls).toEqual([{ name: 'team_dispatch', input: { taskIds: ['T1'] } }]);
        const firstBody = server.requests[0]?.body as
            | { tools?: Array<{ function: { name: string; parameters: unknown } }> }
            | undefined;
        const declared = firstBody?.tools?.find((tool) => tool.function.name === 'team_dispatch');
        expect(declared?.function.parameters).toMatchObject({ properties: { taskIds: { type: 'array' } } });
        expect(h.permissions).toHaveLength(0);
        h.close();
    });

    it('compacts older turns when the context passes the budget', async () => {
        server.reset();
        let summaries = 0;
        server.respondWith((request) => {
            const body = request.body as { messages: Array<{ role: string; content: unknown }> };
            if (JSON.stringify(body.messages[0]?.content ?? '').includes('compress the earlier part')) {
                summaries++;
                return openaiText('Goal: test. Decisions: none. Files: none. Open items: none.');
            }
            return openaiText('x'.repeat(4000));
        });
        const h = harness();
        const sessionId = await newSession(h, workspace(), { softContextWindow: 12_000, maxOutputTokens: 1000 });
        for (let turn = 0; turn < 8; turn++) {
            await h.client.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: `turn ${turn} ${'y'.repeat(4000)}` }],
            });
        }
        expect(summaries).toBeGreaterThan(0);
        expect(h.updates.some((update) => update.sessionUpdate === 'compaction_update')).toBe(true);
        const last = server.requests.at(-1)?.body as { messages: Array<{ role: string; content: unknown }> };
        expect(JSON.stringify(last.messages)).toContain('conversation_summary');
        h.close();
    }, 30_000);

    it('resumes a stored session in a new working directory', async () => {
        server.reset();
        server.respondWith(() => openaiText('ok'));
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-engine-'));
        const first = createXoraAgent({ dataDir, version: 'test' });
        const client = acp.client({ name: 'test-host' }).onNotification('session/update', () => undefined);
        const connection = client.connect(first);
        await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
        const { sessionId } = await connection.agent.request('session/new', {
            cwd: workspace(),
            mcpServers: [],
            _meta: config(),
        });
        await connection.agent.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'remember 42' }],
        });
        connection.close();

        const second = createXoraAgent({ dataDir, version: 'test' });
        const again = acp
            .client({ name: 'test-host' })
            .onNotification('session/update', () => undefined)
            .connect(second);
        await again.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
        await again.agent.request('session/resume', { sessionId, cwd: workspace(), _meta: config() });
        await again.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what number?' }] });
        const body = server.requests.at(-1)?.body as { messages: Array<{ role: string; content: unknown }> };
        expect(JSON.stringify(body.messages)).toContain('remember 42');
        again.close();
    });
});

describe('MCP servers', () => {
    it('exposes tools of a stdio MCP server and asks before calling them', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'xora-mcp-'));
        const script = path.join(dir, 'server.cjs');
        writeFileSync(
            script,
            `const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
    } else if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
    } else if (message.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text }] } });
    } else if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
});
`,
        );
        server.reset();
        server.respondWith((request) =>
            lastRole(request.body) === 'tool'
                ? openaiText('echoed')
                : openaiToolCalls([{ name: 'mcp__echo__echo', arguments: JSON.stringify({ text: 'hi' }) }]),
        );
        const h = harness();
        await h.client.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
        const { sessionId } = await h.client.request('session/new', {
            cwd: workspace(),
            mcpServers: [{ name: 'echo', command: process.execPath, args: [script], env: [] }],
            _meta: config(),
        });
        await h.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'echo hi' }] });
        const tools =
            (server.requests[0]?.body as { tools?: Array<{ function: { name: string } }> } | undefined)?.tools ?? [];
        expect(tools.map((tool) => tool.function.name)).toContain('mcp__echo__echo');
        expect(h.permissions.map((request) => (request._meta as { xora: { toolName: string } }).xora.toolName)).toEqual(
            ['mcp__echo__echo'],
        );
        const toolMessage = (
            server.requests.at(-1)?.body as { messages?: Array<{ role: string; content: string }> } | undefined
        )?.messages?.at(-1);
        expect(toolMessage?.content).toContain('echo: hi');
        await h.client.request('session/close', { sessionId });
        h.close();
    }, 30_000);
});

describe('tool hooks', () => {
    it('lets a PreToolUse hook block a call, rewrite input, and a PostToolUse hook add feedback', async () => {
        const cwd = workspace();
        writeFileSync(path.join(cwd, 'x.txt'), 'from x\n');
        writeFileSync(path.join(cwd, 'y.txt'), 'from y\n');
        server.reset();
        server.respondWith((request) =>
            lastRole(request.body) === 'tool'
                ? openaiText('done')
                : openaiToolCalls([
                      { name: 'write', arguments: JSON.stringify({ path: 'blocked.txt', content: 'nope' }) },
                      { name: 'read', arguments: JSON.stringify({ path: 'x.txt' }) },
                  ]),
        );
        const h = harness();
        h.hookReply = (event, payload) => {
            if (event === 'PreToolUse' && payload.tool_name === 'write') return { blocked: true, reason: 'no writes here' };
            if (event === 'PreToolUse' && payload.tool_name === 'read') return { updatedInput: { path: 'y.txt' } };
            if (event === 'PostToolUse') return { additionalContext: 'checked by hook' };
            return {};
        };
        const sessionId = await newSession(h, cwd, { hookEvents: ['PreToolUse', 'PostToolUse'] });
        await h.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
        expect(existsSync(path.join(cwd, 'blocked.txt'))).toBe(false);
        expect(h.permissions).toHaveLength(0);
        const messages =
            (server.requests.at(-1)?.body as { messages?: Array<{ role: string; content: string }> } | undefined)
                ?.messages ?? [];
        const results = messages.filter((message) => message.role === 'tool').map((message) => message.content);
        expect(results[0]).toContain('A PreToolUse hook blocked this call: no writes here');
        expect(results[1]).toContain('from y');
        expect(results[1]).toContain('checked by hook');
        expect(h.hookCalls.map((call) => `${call.event}:${String(call.payload.tool_name)}`)).toEqual([
            'PreToolUse:write',
            'PreToolUse:read',
            'PostToolUse:read',
        ]);
        h.close();
    });

    it('does not call the host when no hook events are configured', async () => {
        const cwd = workspace();
        writeFileSync(path.join(cwd, 'x.txt'), 'x\n');
        server.reset();
        server.respondWith((request) =>
            lastRole(request.body) === 'tool'
                ? openaiText('done')
                : openaiToolCalls([{ name: 'read', arguments: JSON.stringify({ path: 'x.txt' }) }]),
        );
        const h = harness();
        const sessionId = await newSession(h, cwd);
        await h.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
        expect(h.hookCalls).toHaveLength(0);
        h.close();
    });
});
