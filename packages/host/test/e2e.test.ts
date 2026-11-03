import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    domPortTransport,
    type EventEnvelope,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    RpcPeer,
    type ThreadMeta,
} from '@xora/protocol';
import { errorTurn, openaiText, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HostCore } from '../src/core.ts';
import type { Logger } from '../src/log.ts';
import { MemoryShell } from '../src/shell.ts';

/**
 * M1 acceptance, headless: the real host, the real xora engine as a subprocess and a scripted model server.
 * "Ask for a change → the agent edits → approve → see the diff → undo → restart → continue the thread."
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSource = path.resolve(here, '../../engine/src/main.ts');
const work = mkdtempSync(path.join(tmpdir(), 'xora-e2e-'));
const engineEntry = path.join(work, 'engine.cjs');
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type Ui = RpcPeer<HostMethods, HostNotifications>;

interface Harness {
    readonly core: HostCore;
    readonly ui: Ui;
    readonly shell: MemoryShell;
    readonly events: EventEnvelope[];
    close(): Promise<void>;
}

/** One shell per data directory, so keys survive a host restart the way the OS keychain keeps them. */
const shells = new Map<string, MemoryShell>();

async function startHost(dataDir: string): Promise<Harness> {
    const shell = shells.get(dataDir) ?? new MemoryShell({ dataDir });
    shells.set(dataDir, shell);
    const core = await HostCore.create({
        dataDir,
        shell,
        bundleVersion: '1.0.0-test',
        shellVersion: '1.0.0-test',
        engineEntry,
        skipShellEnv: true,
        log: quiet,
    });
    // These runs test the user's own answers to approval cards (06 §24 has the supervisor's).
    core.settings.update({
        approvals: { reviewer: 'user' },
        team: { ...core.settings.get().team, models: 'tiers' },
    });
    const channel = new MessageChannel();
    const hostSide = core.connectUi(domPortTransport(channel.port1));
    const ui: Ui = new RpcPeer(domPortTransport(channel.port2), { methods, notifications, timeoutMs: 60_000 });
    const events: EventEnvelope[] = [];
    ui.onNotification('thread.event', ({ event }) => events.push(event));
    return {
        core,
        ui,
        shell,
        events,
        close: async () => {
            ui.dispose();
            hostSide.dispose();
            channel.port1.close();
            channel.port2.close();
            await core.dispose();
        },
    };
}

async function waitFor<T>(
    probe: () => T | undefined | Promise<T | undefined>,
    what: string,
    timeoutMs = 30_000,
): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await probe();
        if (value !== undefined && value !== false) {
            return value as T;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

function gitRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-e2e-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
}

type MockServer = Awaited<ReturnType<typeof startMockModelServer>>;
let server: MockServer;
const harnesses: Harness[] = [];

beforeAll(async () => {
    await build({
        entryPoints: [engineSource],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile: engineEntry,
        logLevel: 'silent',
    });
    server = await startMockModelServer();
}, 60_000);

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.close().catch(() => undefined);
    }
});

afterAll(async () => {
    await server?.close();
});

async function setUp(dataDir = mkdtempSync(path.join(tmpdir(), 'xora-e2e-data-'))) {
    const harness = await startHost(dataDir);
    harnesses.push(harness);
    const { ui } = harness;
    const connection = await ui.request('provider.save', {
        presetId: 'custom-openai',
        name: 'mock',
        apiKey: 'test-key',
        baseUrl: server.url,
    });
    await ui.request('settings.update', {
        patch: { defaultModel: { connectionId: connection.id, model: 'mock-model' } },
    });
    return { harness, dataDir, connectionId: connection.id };
}

function lastRole(body: unknown): string | undefined {
    const messages = (body as { messages?: Array<{ role: string }> }).messages ?? [];
    return messages.at(-1)?.role;
}

describe('M1 core loop', () => {
    it('edits a file after approval, shows the diff, undoes it and continues after a restart', async () => {
        const repo = gitRepo();
        server.respondWith((request) => {
            if (lastRole(request.body) === 'tool') {
                return openaiText('Done: hello.txt now says hello world.');
            }
            return openaiToolCalls([
                {
                    name: 'edit',
                    arguments: JSON.stringify({ path: 'hello.txt', oldString: 'hello', newString: 'hello world' }),
                },
            ]);
        });
        const { harness, dataDir } = await setUp();
        const { ui } = harness;
        const project = await ui.request('project.add', { path: repo });
        const thread = await ui.request('thread.create', { projectId: project.id });
        await ui.request('thread.subscribe', { threadId: thread.id });
        const approvals = new Promise<string>((resolve) =>
            ui.onNotification('approval.requested', ({ approval }) => resolve(approval.id)),
        );
        const { turnId } = await ui.request('turn.start', {
            threadId: thread.id,
            text: 'say hello world in hello.txt',
        });

        const approvalId = await approvals;
        await waitFor(
            async () =>
                (await ui.request('thread.read', { threadId: thread.id })).thread.status === 'awaiting_approval',
            'awaiting_approval',
        );
        expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hello\n');
        await ui.request('approval.respond', { approvalId, decision: 'allow_once' });

        const done = await waitFor(async () => {
            const snapshot = await ui.request('thread.read', { threadId: thread.id });
            return snapshot.events.find((event) => event.kind === 'turn.completed') ? snapshot : undefined;
        }, 'turn.completed');
        expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hello world\n');
        const meta: ThreadMeta = done.thread;
        expect(meta.status).toBe('idle');
        expect(meta.needsReview).toBe(true);
        expect(done.events.map((event) => event.kind)).toEqual(
            expect.arrayContaining(['thread.created', 'turn.started', 'item.completed', 'turn.completed']),
        );

        const review = await ui.request('review.turn', { threadId: thread.id, turnId });
        expect(review.available).toBe(true);
        expect(review.files.map((file) => file.path)).toEqual(['hello.txt']);
        const file = await ui.request('review.file', { threadId: thread.id, turnId, path: 'hello.txt' });
        expect(file).toMatchObject({ oldText: 'hello\n', newText: 'hello world\n', binary: false });

        const reverted = await ui.request('review.revert', { threadId: thread.id, turnId });
        expect(reverted.restored).toEqual(['hello.txt']);
        expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hello\n');

        const usage = await ui.request('usage.thread', { threadId: thread.id });
        expect(usage.requests.length).toBe(2);

        // Restart the host on the same data directory: the thread is still there and the engine resumes.
        await harnesses.pop()?.close();
        const restarted = await startHost(dataDir);
        harnesses.push(restarted);
        const snapshot = await restarted.ui.request('thread.read', { threadId: thread.id });
        expect(snapshot.events.some((event) => event.kind === 'turn.completed')).toBe(true);
        const before = server.requests.length;
        server.respondWith(() => openaiText('Still here.'));
        await restarted.ui.request('turn.start', { threadId: thread.id, text: 'are you still there?' });
        await waitFor(async () => {
            const read = await restarted.ui.request('thread.read', { threadId: thread.id });
            return read.events.filter((event) => event.kind === 'turn.completed').length === 2 ? read : undefined;
        }, 'second turn');
        const resumed = server.requests[before]?.body as { messages: Array<{ role: string }> };
        // System + first user message + tool call + tool result + answer + the new user message.
        expect(resumed.messages.length).toBeGreaterThanOrEqual(5);
    }, 90_000);

    it('denies edits in plan mode without asking', async () => {
        const repo = gitRepo();
        server.respondWith((request) =>
            lastRole(request.body) === 'tool'
                ? openaiText('I will only plan.')
                : openaiToolCalls([{ name: 'write', arguments: JSON.stringify({ path: 'new.txt', content: 'x' }) }]),
        );
        const { harness } = await setUp();
        const { ui } = harness;
        const project = await ui.request('project.add', { path: repo });
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'plan' });
        let asked = false;
        ui.onNotification('approval.requested', () => {
            asked = true;
        });
        await ui.request('turn.start', { threadId: thread.id, text: 'create new.txt' });
        const snapshot = await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: thread.id });
            return read.events.find((event) => event.kind === 'turn.completed') ? read : undefined;
        }, 'turn.completed');
        expect(asked).toBe(false);
        const tool = snapshot.events
            .filter((event) => event.kind === 'item.completed')
            .map((event) => (event.payload as { item?: { type: string; status?: string } }).item)
            .find((item) => item?.type === 'tool_call');
        expect(tool?.status).toBe('denied');
        expect(() => readFileSync(path.join(repo, 'new.txt'))).toThrow();
    }, 60_000);

    it('reports a classified error when the key is rejected', async () => {
        const repo = gitRepo();
        server.respondWith(() =>
            errorTurn(401, { error: { message: 'invalid api key', type: 'authentication_error' } }),
        );
        const { harness } = await setUp();
        const { ui } = harness;
        const project = await ui.request('project.add', { path: repo });
        const thread = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', { threadId: thread.id, text: 'hi' });
        const snapshot = await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: thread.id });
            return read.events.find((event) => event.kind === 'turn.failed') ? read : undefined;
        }, 'turn.failed');
        const failed = snapshot.events.find((event) => event.kind === 'turn.failed');
        expect((failed?.payload as { error?: { errorClass?: string } } | undefined)?.error?.errorClass).toBe('auth');
        expect(snapshot.thread.status).toBe('failed');
    }, 60_000);

    it('asks for every high-risk action of a team thread, even in full mode with an allow rule', async () => {
        const repo = gitRepo();
        const commands = ['git status', 'git push', 'git push'];
        server.respondWith((request) => {
            const body = request.body as { messages?: Array<{ role: string }> };
            const done = (body.messages ?? []).filter((message) => message.role === 'tool').length;
            const command = commands[done];
            return command
                ? openaiToolCalls([{ name: 'bash', arguments: JSON.stringify({ command }) }])
                : openaiText('Pushed.');
        });
        const { harness, connectionId } = await setUp();
        const { ui, core } = harness;
        const project = await ui.request('project.add', { path: repo });
        core.approvals.addRule({ scope: 'global', tool: 'bash', pattern: 'git push', decision: 'allow' });
        const member = core.threads.create({
            projectId: project.id,
            title: 'T1',
            engine: 'xora',
            model: { connectionId, model: 'mock-model' },
            mode: 'full',
            effort: 'medium',
            extra: { teamRunId: 'team-test', role: 'executor', agentId: 'coder-T1', taskId: 'T1' },
        });
        const asked: Array<{ title: string; alwaysScopes: readonly string[]; command?: string }> = [];
        ui.onNotification('approval.requested', ({ approval }) => {
            asked.push(approval);
            // "For this session" does not carry over to the next high-risk action.
            void ui.request('approval.respond', { approvalId: approval.id, decision: 'allow_session' });
        });
        await ui.request('turn.start', { threadId: member.id, text: 'push the branch' });
        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: member.id });
            return read.events.find((event) => event.kind === 'turn.completed') ? read : undefined;
        }, 'turn.completed');
        expect(asked.map((approval) => approval.command)).toEqual(['git push', 'git push']);
        expect(asked.every((approval) => approval.title.startsWith('高风险动作（推送）'))).toBe(true);
        expect(asked.every((approval) => approval.alwaysScopes.length === 0)).toBe(true);

        // An ordinary thread in full mode keeps running such commands on its own.
        commands.splice(0, commands.length, 'git push');
        const plain = await ui.request('thread.create', { projectId: project.id, mode: 'full' });
        await ui.request('turn.start', { threadId: plain.id, text: 'push the branch' });
        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: plain.id });
            return read.events.find((event) => event.kind === 'turn.completed') ? read : undefined;
        }, 'plain turn.completed');
        expect(asked).toHaveLength(2);
    }, 60_000);

    it('stops a running turn on cancel', async () => {
        const repo = gitRepo();
        server.respondWith(() =>
            openaiToolCalls([{ name: 'bash', arguments: JSON.stringify({ command: 'sleep 30' }) }]),
        );
        const { harness } = await setUp();
        const { ui } = harness;
        const project = await ui.request('project.add', { path: repo });
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'full' });
        await ui.request('turn.start', { threadId: thread.id, text: 'wait a bit' });
        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: thread.id });
            return read.live.some((item) => item.type === 'tool_call' && item.status === 'in_progress')
                ? true
                : undefined;
        }, 'command running');
        await ui.request('turn.cancel', { threadId: thread.id });
        const snapshot = await waitFor(
            async () => {
                const read = await ui.request('thread.read', { threadId: thread.id });
                return read.events.find((event) => event.kind === 'turn.completed') ? read : undefined;
            },
            'cancelled turn',
            20_000,
        );
        const completed = snapshot.events.find((event) => event.kind === 'turn.completed');
        expect((completed?.payload as { stopReason?: string } | undefined)?.stopReason).toBe('cancelled');
        expect(snapshot.thread.status).toBe('cancelled');
    }, 60_000);
});

describe('shell language', () => {
    it('tells the shell the language setting when the host starts and when it changes', async () => {
        const harness = await startHost(mkdtempSync(path.join(tmpdir(), 'xora-e2e-data-')));
        harnesses.push(harness);
        expect(harness.shell.language).toBe('system');
        await harness.ui.request('settings.update', { patch: { theme: 'dark' } });
        expect(harness.shell.language).toBe('system');
        await harness.ui.request('settings.update', { patch: { language: 'en' } });
        expect(harness.shell.language).toBe('en');
    });
});

describe('host language', () => {
    it('answers in English once the language is en, and still titles a thread created in Chinese', async () => {
        server.respondWith(() => openaiText('Hello.'));
        const { harness } = await setUp();
        const { ui } = harness;
        const project = await ui.request('project.add', { path: gitRepo() });
        const created = await ui.request('thread.create', { projectId: project.id });
        expect(created.title).toBe('新线程');

        await ui.request('settings.update', { patch: { language: 'en' } });
        await expect(ui.request('thread.create', { projectId: project.id, engine: 'nope' })).rejects.toThrow(
            'Unknown engine: nope',
        );
        expect((await ui.request('thread.create', { projectId: project.id })).title).toBe('New thread');
        // The default title is recognised in either language: the first turn replaces it.
        await ui.request('turn.start', { threadId: created.id, text: 'say hello' });
        await waitFor(
            async () => (await ui.request('thread.read', { threadId: created.id })).thread.title === 'say hello',
            'the title from the first message',
        );
    }, 60_000);
});

describe('fallback models', () => {
    it('finishes the turn on the next model in the chain when the thread model keeps failing', async () => {
        const broken = await startMockModelServer();
        broken.respondWith((request) =>
            request.method === 'POST' ? errorTurn(503, { error: { message: 'overloaded' } }) : undefined,
        );
        try {
            // POST only: the server answers `/models` itself.
            server.respondWith((request) =>
                request.method === 'POST' ? openaiText('done by the fallback model') : undefined,
            );
            const { harness, connectionId } = await setUp();
            const { ui } = harness;
            const bad = await ui.request('provider.save', {
                presetId: 'custom-openai',
                name: 'broken',
                apiKey: 'test-key',
                baseUrl: broken.url,
            });
            await ui.request('settings.update', {
                patch: {
                    defaultModel: { connectionId: bad.id, model: 'mock-model' },
                    fallbackModels: [{ connectionId, model: 'mock-model' }],
                },
            });
            const project = await ui.request('project.add', { path: gitRepo() });
            const thread = await ui.request('thread.create', { projectId: project.id });
            await ui.request('turn.start', { threadId: thread.id, text: 'hello' });
            const snapshot = await waitFor(
                async () => {
                    const read = await ui.request('thread.read', { threadId: thread.id });
                    return read.events.some((event) => event.kind === 'turn.completed' || event.kind === 'turn.failed')
                        ? read
                        : undefined;
                },
                'the turn to end',
                60_000,
            );
            expect(snapshot.events.map((event) => event.kind)).toContain('turn.completed');
            const items = snapshot.events
                .filter((event) => event.kind === 'item.completed')
                .map((event) => (event.payload as { item: { type: string; title?: string; text?: string } }).item);
            expect(items.some((item) => item.type === 'notice' && item.title === '切换到备用模型mock-model')).toBe(
                true,
            );
            expect(
                items.some((item) => item.type === 'agent_message' && item.text === 'done by the fallback model'),
            ).toBe(true);
            expect(broken.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
        } finally {
            await broken.close();
        }
    }, 90_000);
});

describe('model lists', () => {
    it('offers the models the user picked from a refreshed list, and keeps the pick', async () => {
        server.reset();
        server.setModels([{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }]);
        try {
            const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-e2e-data-'));
            let harness = await startHost(dataDir);
            harnesses.push(harness);
            const connection = await harness.ui.request('provider.save', {
                presetId: 'custom-openai',
                name: 'local',
                apiKey: 'test-key',
                baseUrl: server.url,
            });
            const refreshed = await harness.ui.request('provider.refreshModels', { connectionId: connection.id });
            // Nothing picked yet: a server without preset models offers everything it lists.
            expect(refreshed.models.map((model) => model.id)).toEqual(['model-a', 'model-b', 'model-c']);
            const picked = await harness.ui.request('provider.selectModels', {
                connectionId: connection.id,
                models: ['model-b'],
            });
            expect(picked.models.map((model) => model.id)).toEqual(['model-b']);
            expect(picked.available?.map((model) => model.id)).toEqual(['model-a', 'model-b', 'model-c']);
            expect((await harness.ui.request('model.list', {})).map((option) => option.model.id)).toEqual(['model-b']);
            await expect(
                harness.ui.request('provider.selectModels', { connectionId: connection.id, models: ['model-z'] }),
            ).rejects.toThrow('model-z');

            // A later refresh lists a new model without offering it, and the pick survives a restart.
            server.setModels([{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }, { id: 'model-d' }]);
            await harness.ui.request('provider.refreshModels', { connectionId: connection.id });
            await harness.close();
            harnesses.splice(harnesses.indexOf(harness), 1);
            harness = await startHost(dataDir);
            harnesses.push(harness);
            const again = await harness.ui.request('provider.connections', {});
            expect(again[0]?.models.map((model) => model.id)).toEqual(['model-b']);
            expect(again[0]?.available?.map((model) => model.id)).toContain('model-d');
        } finally {
            server.reset();
        }
    });
});

describe('usage without a price', () => {
    it('counts the tokens of a model that has no price table', async () => {
        server.reset();
        server.respondWith((request) =>
            request.method === 'POST'
                ? openaiText('ok', { usage: { prompt_tokens: 1200, completion_tokens: 30 } })
                : undefined,
        );
        const { harness } = await setUp();
        const { ui } = harness;
        const project = await ui.request('project.add', { path: gitRepo() });
        const thread = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', { threadId: thread.id, text: 'hello' });
        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: thread.id });
            return read.events.some((event) => event.kind === 'turn.completed') ? true : undefined;
        }, 'the turn to end');
        const meta = (await ui.request('thread.list', { projectId: project.id }))[0];
        expect(meta?.cost).toBeNull();
        expect(meta?.tokens).toEqual({ input: 1200, output: 30 });
        server.reset();
    });
});

describe('manual compaction', () => {
    it('compacts in the same thread, drops its context at once and counts the summary tokens', async () => {
        server.reset();
        server.respondWith((request) => {
            if (request.method !== 'POST') return undefined;
            const body = request.body as { messages?: Array<{ content: unknown }> };
            return JSON.stringify(body.messages?.[0]?.content ?? '').includes('compress the earlier part')
                ? openaiText('Goal: test. Decisions: none. Files: none. Open items: none.', {
                      usage: { prompt_tokens: 3000, completion_tokens: 40 },
                  })
                : openaiText('x'.repeat(2000), { usage: { prompt_tokens: 30_000, completion_tokens: 500 } });
        });
        const { harness } = await setUp();
        const { ui } = harness;
        const project = await ui.request('project.add', { path: gitRepo() });
        const thread = await ui.request('thread.create', { projectId: project.id });
        const ended = (count: number) =>
            waitFor(async () => {
                const read = await ui.request('thread.read', { threadId: thread.id });
                return read.events.filter((event) => event.kind === 'turn.completed').length >= count
                    ? true
                    : undefined;
            }, `turn ${count} to end`);
        for (let turn = 1; turn <= 4; turn++) {
            await ui.request('turn.start', { threadId: thread.id, text: `turn ${turn} ${'y'.repeat(4000)}` });
            await ended(turn);
        }
        const [before] = await ui.request('thread.list', { projectId: project.id });
        expect(before?.context?.used).toBe(30_000);

        await ui.request('turn.compact', { threadId: thread.id });
        await ended(5);
        const threads = await ui.request('thread.list', { projectId: project.id });
        expect(threads.map((item) => item.id)).toEqual([thread.id]);
        expect(threads[0]?.context?.used).toBeLessThan(30_000);
        expect(threads[0]?.tokens).toEqual({ input: 4 * 30_000 + 3000, output: 4 * 500 + 40 });
        server.reset();
    }, 60_000);
});
