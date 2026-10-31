import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { openaiText, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
import { LspManager } from '@xora/tools';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createXoraAgent } from '../src/agent.ts';

/** The fake language server of the tools tests: `error <text>` lines are errors, `def <name>` lines are symbols. */
const FAKE_SERVER = fileURLToPath(new URL('../../tools/test/fake-lsp-server.mjs', import.meta.url));

type MockServer = Awaited<ReturnType<typeof startMockModelServer>>;
let server: MockServer;
const managers: LspManager[] = [];

beforeAll(async () => {
    server = await startMockModelServer();
});

afterAll(async () => {
    await server.close();
});

afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
});

function lspManager(): LspManager {
    const manager = new LspManager({
        servers: [
            {
                id: 'fake',
                name: 'fake-lsp',
                language: 'Fake',
                commands: [{ command: process.execPath, args: [FAKE_SERVER] }],
                extensions: { '.fake': 'fake' },
                install: 'it comes with the tests',
            },
        ],
        settleMs: 100,
    });
    managers.push(manager);
    return manager;
}

async function session(lsp: LspManager, cwd: string, settings: Record<string, unknown> = {}) {
    const permissions: acp.RequestPermissionRequest[] = [];
    const updates: acp.SessionNotification[] = [];
    const agent = createXoraAgent({
        dataDir: mkdtempSync(path.join(tmpdir(), 'xora-engine-lsp-')),
        version: 'test',
        lsp,
    });
    const connection = acp
        .client({ name: 'test-host' })
        .onNotification('session/update', ({ params }) => {
            updates.push(params);
        })
        .onRequest('session/request_permission', ({ params }) => {
            permissions.push(params);
            return { outcome: { outcome: 'selected' as const, optionId: 'allow_once' } };
        })
        .connect(agent);
    await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
    const { sessionId } = await connection.agent.request('session/new', {
        cwd,
        mcpServers: [],
        _meta: {
            xora: {
                model: {
                    connection: { presetId: 'custom-openai', apiKey: 'k', baseUrl: server.url },
                    model: 'mock-model',
                },
                mode: 'ask',
                ...settings,
            },
        },
    });
    const prompt = (text: string) =>
        connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    return { prompt, permissions, updates, close: () => connection.close() };
}

function workspace(): string {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'xora-engine-lsp-ws-')));
    writeFileSync(path.join(dir, 'a.fake'), 'def alpha\ndef beta\n');
    return dir;
}

/** The tool results the model saw in the last request. */
function toolResults(): string[] {
    const body = server.requests.at(-1)?.body as { messages?: Array<{ role: string; content: unknown }> } | undefined;
    return (body?.messages ?? [])
        .filter((message) => message.role === 'tool')
        .map((message) => String(message.content));
}

function answerWith(name: string, args: Record<string, unknown>): void {
    server.reset();
    server.respondWith((request) => {
        const messages = (request.body as { messages?: Array<{ role: string }> }).messages ?? [];
        return messages.at(-1)?.role === 'tool'
            ? openaiText('done')
            : openaiToolCalls([{ name, arguments: JSON.stringify(args) }]);
    });
}

describe('language servers in the engine', () => {
    it('adds the errors a language server reports to the result of an edit', async () => {
        const cwd = workspace();
        answerWith('write', { path: 'bad.fake', content: 'def gamma\nerror broken here\n' });
        const s = await session(lspManager(), cwd);
        await s.prompt('write it');
        expect(readFileSync(path.join(cwd, 'bad.fake'), 'utf8')).toBe('def gamma\nerror broken here\n');
        expect(toolResults()).toEqual([
            'Created bad.fake (2 lines).\n\nLSP diagnostics after the edit:\nbad.fake: 1 error (fake-lsp)\n  2:1 error E1: broken here',
        ]);
        // The host gets the diff and, under it, the same diagnostics for the user.
        type Update = acp.SessionNotification['update'];
        const finished = s.updates
            .map((update) => update.update)
            .find(
                (update): update is Extract<Update, { sessionUpdate: 'tool_call_update' }> =>
                    update.sessionUpdate === 'tool_call_update' && update.status === 'completed',
            );
        expect(finished?.content?.map((entry) => entry.type)).toEqual(['diff', 'content']);
        s.close();
    });

    it('leaves edit results alone when the session turns diagnostics off', async () => {
        const cwd = workspace();
        answerWith('write', { path: 'bad.fake', content: 'error broken here\n' });
        const lsp = lspManager();
        const s = await session(lsp, cwd, { lsp: { diagnostics: false } });
        await s.prompt('write it');
        expect(toolResults()).toEqual(['Created bad.fake (1 line).']);
        expect(lsp.running()).toHaveLength(0);
        s.close();
    });

    it('runs the lsp tool without asking for permission', async () => {
        const cwd = workspace();
        answerWith('lsp', { operation: 'symbols', path: 'a.fake' });
        const s = await session(lspManager(), cwd);
        await s.prompt('outline a.fake');
        expect(s.permissions).toHaveLength(0);
        expect(toolResults()).toEqual(['Symbols in a.fake:\nfunction alpha: () (line 1)\nfunction beta: () (line 2)']);
        s.close();
    });

    it('asks before the lsp tool reads a file outside the workspace, and the tool still refuses it', async () => {
        const cwd = workspace();
        const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'xora-engine-lsp-out-')));
        writeFileSync(path.join(outside, 'x.fake'), 'def x\n');
        answerWith('lsp', { operation: 'symbols', path: path.join(outside, 'x.fake') });
        const lsp = lspManager();
        const s = await session(lsp, cwd);
        await s.prompt('outline x.fake');
        expect(s.permissions).toHaveLength(1);
        expect(toolResults()[0]).toContain('is outside the workspace');
        expect(lsp.running()).toHaveLength(0);
        s.close();
    });
});
