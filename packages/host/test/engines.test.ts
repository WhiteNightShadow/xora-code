import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { createXoraAgent, portStream } from '@xora/engine';
import {
    domPortTransport,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    RpcPeer,
    type ShellMethods,
    type ShellNotifications,
    shellMethods,
    shellNotifications,
} from '@xora/protocol';
import { type MainPort, mainPortChannel, openaiText, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HostCore } from '../src/core.ts';
import { EngineManager, type SessionHandlers } from '../src/engines/manager.ts';
import { XORA_ENGINE } from '../src/engines/registry.ts';
import { ShellEngines } from '../src/engines/shell-engines.ts';
import type { Logger } from '../src/log.ts';
import { type EngineStart, MemoryShell } from '../src/shell.ts';

/**
 * The xora engine the way the app runs it: the bootstrap forks a utility process and hands the host its ACP port.
 * A fake bootstrap serves `shell.engine.*` over a real shell channel and runs the engine in this process behind
 * a MessagePort shaped like Electron's.
 */

type ShellPeer = RpcPeer<ShellMethods, ShellNotifications>;

interface Started {
    readonly id: string;
    readonly entry: string;
    readonly env: Record<string, string>;
    readonly connection: acp.AgentConnection;
    readonly port: MainPort;
}

const cleanups: Array<() => void> = [];
const work = mkdtempSync(path.join(tmpdir(), 'xora-engines-'));

function fakeBootstrap(options: { portAfterReply?: boolean; refuse?: string } = {}) {
    const channel = new MessageChannel();
    const bootstrap: ShellPeer = new RpcPeer(domPortTransport(channel.port1), {
        methods: shellMethods,
        notifications: shellNotifications,
    });
    const peer: ShellPeer = new RpcPeer(domPortTransport(channel.port2), {
        methods: shellMethods,
        notifications: shellNotifications,
    });
    const engines = new ShellEngines(peer);
    const started: Started[] = [];
    const stopped: string[] = [];
    bootstrap.handle('shell.engine.start', ({ id, entry, env }) => {
        if (options.refuse) {
            throw new Error(options.refuse);
        }
        const { port1, port2 } = mainPortChannel();
        const connection = createXoraAgent({
            dataDir: env.XORA_ENGINE_DATA ?? mkdtempSync(path.join(work, 'engine-')),
            version: 'test',
        }).connect(portStream(port1));
        started.push({ id, entry, env, connection, port: port1 });
        bootstrap.notify('shell.engine.output', { id, text: '[xora-engine] ready\n\nsecond line\n' });
        // The port travels on the parent port, apart from this reply: either may arrive first.
        if (options.portAfterReply) {
            setTimeout(() => engines.deliver(id, port2), 20);
        } else {
            engines.deliver(id, port2);
        }
        return { pid: 4000 + started.length };
    });
    bootstrap.handle('shell.engine.stop', ({ id }) => {
        stopped.push(id);
        const engine = started.find((entry) => entry.id === id);
        engine?.connection.close();
        bootstrap.notify('shell.engine.exit', { id, code: 0 });
        return { ok: true as const };
    });
    cleanups.push(() => {
        for (const engine of started) engine.connection.close();
        bootstrap.dispose();
        peer.dispose();
        channel.port1.close();
        channel.port2.close();
    });
    return {
        engines,
        started,
        stopped,
        /** What a crash looks like from the host: the port closes, then the bootstrap reports the exit. */
        crash(engine: Started, code: number) {
            engine.port.close();
            bootstrap.notify('shell.engine.exit', { id: engine.id, code });
        },
        /** Only the exit report, with the port still open. */
        exit(engine: Started, code: number) {
            bootstrap.notify('shell.engine.exit', { id: engine.id, code });
        },
    };
}

function managerFor(fake: ReturnType<typeof fakeBootstrap>, lines: string[] = []) {
    const log: Logger = { info: (line) => lines.push(line), warn: (line) => lines.push(line), error: () => undefined };
    return new EngineManager({
        log,
        version: 'test',
        shell: { startEngine: (request) => fake.engines.start(request) },
        launch: async () => ({
            kind: 'utility',
            entry: 'engine/index.cjs',
            env: { XORA_ENGINE_DATA: mkdtempSync(path.join(work, 'data-')), UNSET: undefined },
        }),
    });
}

function handlers(overrides: Partial<SessionHandlers> = {}): SessionHandlers {
    return {
        onUpdate: () => undefined,
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        onExit: () => undefined,
        ...overrides,
    };
}

type MockServer = Awaited<ReturnType<typeof startMockModelServer>>;
let server: MockServer;

beforeAll(async () => {
    server = await startMockModelServer();
});

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

afterAll(async () => {
    await server?.close();
});

describe('engines started by the bootstrap', () => {
    it('runs ACP over the port of a utility process the bootstrap started', async () => {
        server.reset();
        server.respondWith(() => openaiText('hi from the port'));
        const fake = fakeBootstrap();
        const lines: string[] = [];
        const manager = managerFor(fake, lines);
        const engine = await manager.connect(XORA_ENGINE, 'project-1');
        expect(engine.isXora).toBe(true);
        expect(fake.started).toHaveLength(1);
        expect(fake.started[0]?.entry).toBe('engine/index.cjs');
        expect(fake.started[0]?.env).toHaveProperty('XORA_ENGINE_DATA');
        expect(fake.started[0]?.env).not.toHaveProperty('UNSET');
        expect(lines).toContain('started engine xora:project-1 as utility process 4001: engine/index.cjs');
        expect(lines).toEqual(expect.arrayContaining(['[xora] [xora-engine] ready', '[xora] second line']));

        const cwd = mkdtempSync(path.join(work, 'ws-'));
        const { sessionId } = await engine.agent.request('session/new', {
            cwd,
            mcpServers: [],
            _meta: {
                xora: {
                    model: {
                        connection: { presetId: 'custom-openai', apiKey: 'k', baseUrl: server.url },
                        model: 'mock-model',
                    },
                    mode: 'ask',
                },
            },
        });
        const updates: acp.SessionNotification[] = [];
        manager.register(sessionId, engine.key, handlers({ onUpdate: (update) => updates.push(update) }));
        const response = await engine.agent.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: 'hi' }],
        });
        expect(response.stopReason).toBe('end_turn');
        expect(updates.some((update) => update.update.sessionUpdate === 'agent_message_chunk')).toBe(true);

        // One process per engine and project.
        expect(await manager.connect(XORA_ENGINE, 'project-1')).toBe(engine);
        const other = await manager.connect(XORA_ENGINE, 'project-2');
        expect(other).not.toBe(engine);
        expect(fake.started.map((entry) => entry.id)).toEqual(['engine-1', 'engine-2']);
        await manager.dispose();
    });

    it('pairs the reply with a port that arrives after it', async () => {
        const fake = fakeBootstrap({ portAfterReply: true });
        const manager = managerFor(fake);
        const engine = await manager.connect(XORA_ENGINE, 'project-1');
        expect(engine.alive).toBe(true);
        await manager.dispose();
    });

    it('notices a crash, ends its sessions and starts a new process on the next connect', async () => {
        const fake = fakeBootstrap();
        const lines: string[] = [];
        const manager = managerFor(fake, lines);
        const engine = await manager.connect(XORA_ENGINE, 'project-1');
        const exits: string[] = [];
        manager.register('session-1', engine.key, handlers({ onExit: (reason) => exits.push(reason) }));
        const first = fake.started[0];
        if (!first) throw new Error('no engine started');
        fake.crash(first, 9);
        await vi.waitFor(() => expect(exits).toEqual(['engine xora exited (9)']));
        expect(engine.alive).toBe(false);
        expect(lines).toContain('engine xora exited (9)');
        const restarted = await manager.connect(XORA_ENGINE, 'project-1');
        expect(restarted).not.toBe(engine);
        expect(restarted.alive).toBe(true);
        expect(fake.started).toHaveLength(2);
        await manager.dispose();
    });

    it('fails requests in flight as soon as the bootstrap reports the exit', async () => {
        server.reset();
        server.respondWith(() => ({ ...openaiText('too late'), delayMs: 5_000 }));
        const fake = fakeBootstrap();
        const manager = managerFor(fake);
        const engine = await manager.connect(XORA_ENGINE, 'project-1');
        const { sessionId } = await engine.agent.request('session/new', {
            cwd: mkdtempSync(path.join(work, 'ws-')),
            mcpServers: [],
            _meta: {
                xora: {
                    model: {
                        connection: { presetId: 'custom-openai', apiKey: 'k', baseUrl: server.url },
                        model: 'mock-model',
                    },
                },
            },
        });
        const exits: string[] = [];
        manager.register(sessionId, engine.key, handlers({ onExit: (reason) => exits.push(reason) }));
        const prompt = engine.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
        await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
        const first = fake.started[0];
        if (!first) throw new Error('no engine started');
        fake.exit(first, 1);
        await expect(prompt).rejects.toThrow('engine xora exited (1)');
        expect(exits).toEqual(['engine xora exited (1)']);
        await manager.dispose();
    });

    it('stops its engines through the bootstrap when disposed', async () => {
        const fake = fakeBootstrap();
        const manager = managerFor(fake);
        await manager.connect(XORA_ENGINE, 'project-1');
        await manager.connect(XORA_ENGINE, 'project-2');
        await manager.dispose();
        await vi.waitFor(() => expect(fake.stopped.sort()).toEqual(['engine-1', 'engine-2']));
    });

    it('reports a start the bootstrap refuses, and tries again on the next connect', async () => {
        const fake = fakeBootstrap({ refuse: 'not a file of the app bundle: engine/index.cjs' });
        const manager = managerFor(fake);
        await expect(manager.connect(XORA_ENGINE, 'project-1')).rejects.toThrow('not a file of the app bundle');
        await expect(manager.connect(XORA_ENGINE, 'project-1')).rejects.toThrow('not a file of the app bundle');
        await manager.dispose();
    });
});

describe('the host with a shell that starts engines', () => {
    it('runs the xora engine from the bundle through the shell for a turn', async () => {
        server.reset();
        server.respondWith(() => openaiText('done over the port'));
        const fake = fakeBootstrap();
        class PortShell extends MemoryShell {
            startEngine(request: EngineStart) {
                return fake.engines.start(request);
            }
        }
        const dataDir = mkdtempSync(path.join(work, 'host-'));
        const core = await HostCore.create({
            dataDir,
            shell: new PortShell({ dataDir }),
            bundleVersion: '1.0.0-test',
            shellVersion: '1.0.0-test',
            skipShellEnv: true,
            log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        });
        const channel = new MessageChannel();
        const hostSide = core.connectUi(domPortTransport(channel.port1));
        const ui: RpcPeer<HostMethods, HostNotifications> = new RpcPeer(domPortTransport(channel.port2), {
            methods,
            notifications,
            timeoutMs: 30_000,
        });
        cleanups.push(() => {
            ui.dispose();
            hostSide.dispose();
            channel.port1.close();
            channel.port2.close();
        });

        const repo = mkdtempSync(path.join(work, 'repo-'));
        execFileSync('git', ['init', '-q'], { cwd: repo });
        writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
        const connection = await ui.request('provider.save', {
            presetId: 'custom-openai',
            name: 'mock',
            apiKey: 'test-key',
            baseUrl: server.url,
        });
        await ui.request('settings.update', {
            patch: { defaultModel: { connectionId: connection.id, model: 'mock-model' } },
        });
        const project = await ui.request('project.add', { path: repo });
        const thread = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', { threadId: thread.id, text: 'hello?' });
        await vi.waitFor(
            async () => {
                const read = await ui.request('thread.read', { threadId: thread.id });
                expect(read.events.map((event) => event.kind)).toContain('turn.completed');
            },
            { timeout: 30_000, interval: 50 },
        );

        expect(fake.started).toHaveLength(1);
        const [engine] = fake.started;
        expect(engine?.entry).toBe('engine/index.cjs');
        expect(engine?.env.XORA_ENGINE_DATA).toBe(path.join(dataDir, 'engines', 'xora'));
        expect(engine?.env.XORA_ENGINE_VERSION).toBe('1.0.0-test');
        expect(engine?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
        await core.dispose();
        await vi.waitFor(() => expect(fake.stopped).toEqual([engine?.id]));
    }, 60_000);
});
