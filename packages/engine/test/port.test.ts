import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { mainPortChannel, openaiText, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createXoraAgent } from '../src/agent.ts';
import { portStream } from '../src/port.ts';

/** ACP between a host-like client and the xora engine over the kind of MessagePort the shell sets up in the app. */

type MockServer = Awaited<ReturnType<typeof startMockModelServer>>;
let server: MockServer;

beforeAll(async () => {
    server = await startMockModelServer();
});

afterAll(async () => {
    await server.close();
});

function workspace(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-port-ws-'));
    writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    return dir;
}

function connected() {
    const { port1, port2 } = mainPortChannel();
    const engine = createXoraAgent({
        dataDir: mkdtempSync(path.join(tmpdir(), 'xora-port-')),
        version: 'test',
    }).connect(portStream(port1));
    const updates: acp.SessionUpdate[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const host = acp
        .client({ name: 'test-host' })
        .onNotification('session/update', ({ params }) => {
            updates.push(params.update);
        })
        .onRequest('session/request_permission', ({ params }) => {
            permissions.push(params);
            return { outcome: { outcome: 'selected' as const, optionId: 'allow_once' } };
        })
        .connect(portStream(port2));
    return { engine, host, updates, permissions, ports: { engine: port1, host: port2 } };
}

const config = () => ({
    xora: {
        model: { connection: { presetId: 'custom-openai', apiKey: 'k', baseUrl: server.url }, model: 'mock-model' },
        mode: 'ask',
    },
});

describe('ACP over a MessagePort', () => {
    it('runs a turn with a permission request in both directions', async () => {
        server.reset();
        server.respondWith((request) => {
            const messages = (request.body as { messages?: Array<{ role: string }> }).messages ?? [];
            return messages.at(-1)?.role === 'tool'
                ? openaiText('改好了')
                : openaiToolCalls([
                      {
                          name: 'edit',
                          arguments: JSON.stringify({ path: 'a.txt', oldString: 'alpha', newString: 'beta' }),
                      },
                  ]);
        });
        const { engine, host, updates, permissions } = connected();
        const info = await host.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
        expect((info._meta as { xora?: unknown } | undefined)?.xora).toBeDefined();
        const cwd = workspace();
        const { sessionId } = await host.agent.request('session/new', { cwd, mcpServers: [], _meta: config() });
        const response = await host.agent.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'change alpha to beta' }],
        });
        expect(response.stopReason).toBe('end_turn');
        expect(permissions).toHaveLength(1);
        expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('beta\n');
        expect(updates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true);
        host.close();
        await engine.closed;
    });

    it('ends the connection on the other side when one side closes', async () => {
        const { engine, host } = connected();
        await host.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
        host.close();
        await engine.closed;
        expect(engine.signal.aborted).toBe(true);
    });

    it('ends the connection when the port closes under it, as when the other process dies', async () => {
        const { engine, host, ports } = connected();
        await host.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
        ports.engine.close();
        await Promise.all([engine.closed, host.closed]);
        await expect(host.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })).rejects.toThrow();
    });

    it('ignores port messages that are not JSON-RPC text', async () => {
        const { engine, host, ports } = connected();
        ports.host.postMessage({ jsonrpc: '2.0', id: 'x', method: 'initialize' });
        ports.host.postMessage('not json');
        ports.host.postMessage('42');
        const info = await host.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
        expect(info.agentInfo?.name).toBe('xora-engine');
        host.close();
        await engine.closed;
    });
});
