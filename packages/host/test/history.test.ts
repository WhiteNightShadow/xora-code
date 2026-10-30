import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    domPortTransport,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    RpcPeer,
} from '@xora/protocol';
import { openaiText, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HostCore } from '../src/core.ts';
import type { Logger } from '../src/log.ts';
import { MemoryShell } from '../src/shell.ts';

/** M3-3: go back to before a turn (conversation and files) and fork a thread from a turn. */

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSource = path.resolve(here, '../../engine/src/main.ts');
const work = mkdtempSync(path.join(tmpdir(), 'xora-history-'));
const engineEntry = path.join(work, 'engine.cjs');
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
type Ui = RpcPeer<HostMethods, HostNotifications>;
type Body = { messages?: Array<{ role: string; content: unknown }> };

let server: Awaited<ReturnType<typeof startMockModelServer>>;
const cleanups: Array<() => Promise<void>> = [];

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
    for (const cleanup of cleanups.splice(0)) {
        await cleanup().catch(() => undefined);
    }
});

afterAll(async () => {
    await server?.close();
});

async function host(): Promise<Ui> {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-history-data-'));
    const core = await HostCore.create({
        dataDir,
        shell: new MemoryShell({ dataDir }),
        bundleVersion: '1.0.0-test',
        shellVersion: '1.0.0-test',
        engineEntry,
        skipShellEnv: true,
        log: quiet,
        home: mkdtempSync(path.join(tmpdir(), 'xora-history-home-')),
    });
    const channel = new MessageChannel();
    const hostSide = core.connectUi(domPortTransport(channel.port1));
    const ui: Ui = new RpcPeer(domPortTransport(channel.port2), { methods, notifications, timeoutMs: 60_000 });
    cleanups.push(async () => {
        ui.dispose();
        hostSide.dispose();
        channel.port1.close();
        channel.port2.close();
        await core.dispose();
    });
    const connection = await ui.request('provider.save', {
        presetId: 'custom-openai',
        name: 'mock',
        apiKey: 'test-key',
        baseUrl: server.url,
    });
    await ui.request('settings.update', {
        patch: { defaultModel: { connectionId: connection.id, model: 'mock-model' } },
    });
    return ui;
}

function gitRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-history-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
}

function userTexts(body: unknown): string {
    return ((body as Body).messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
        .join('\n');
}

async function turn(ui: Ui, threadId: string, text: string): Promise<string> {
    const before = (await ui.request('thread.read', { threadId })).events.filter(
        (event) => event.kind === 'turn.completed',
    ).length;
    const { turnId } = await ui.request('turn.start', { threadId, text });
    const started = Date.now();
    for (;;) {
        const read = await ui.request('thread.read', { threadId });
        if (read.events.filter((event) => event.kind === 'turn.completed').length > before) return turnId;
        if (Date.now() - started > 30_000) throw new Error(`turn "${text}" did not finish`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe('rewind and fork', () => {
    it('goes back to before a turn with its files, then forks the thread from its first turn', async () => {
        const repo = gitRepo();
        server.reset();
        server.respondWith((request) => {
            if (request.method !== 'POST') return undefined;
            const last = (request.body as Body).messages?.at(-1);
            if (last?.role === 'tool') return openaiText('done');
            const text = JSON.stringify(last?.content ?? '');
            if (text.includes('make it one')) {
                return openaiToolCalls([
                    {
                        name: 'edit',
                        arguments: JSON.stringify({ path: 'hello.txt', oldString: 'hello', newString: 'hello 1' }),
                    },
                ]);
            }
            if (text.includes('make it two')) {
                return openaiToolCalls([
                    {
                        name: 'edit',
                        arguments: JSON.stringify({ path: 'hello.txt', oldString: 'hello 1', newString: 'hello 2' }),
                    },
                ]);
            }
            return openaiText('just talking');
        });
        const ui = await host();
        const project = await ui.request('project.add', { path: repo });
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'full' });

        const first = await turn(ui, thread.id, 'make it one');
        const second = await turn(ui, thread.id, 'make it two');
        await turn(ui, thread.id, 'third, no edits');
        expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hello 2\n');

        const reverted = await ui.request('thread.rewind', { threadId: thread.id, turnId: second, files: true });
        expect(reverted.restored).toEqual(['hello.txt']);
        expect(reverted.conflicts).toEqual([]);
        expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hello 1\n');
        const read = await ui.request('thread.read', { threadId: thread.id });
        expect(read.events.some((event) => event.kind === 'thread.rewound' && event.turnId === second)).toBe(true);
        await expect(
            ui.request('thread.rewind', { threadId: thread.id, turnId: second, files: false }),
        ).rejects.toThrow();

        await turn(ui, thread.id, 'after the rewind');
        let texts = userTexts(server.requests.at(-1)?.body);
        expect(texts).toContain('make it one');
        expect(texts).toContain('after the rewind');
        expect(texts).not.toContain('make it two');
        expect(texts).not.toContain('third, no edits');

        const fork = await ui.request('thread.fork', { threadId: thread.id, afterTurnId: first });
        expect(fork.id).not.toBe(thread.id);
        expect(fork.title).toContain('分叉');
        const forkRead = await ui.request('thread.read', { threadId: fork.id });
        const forkTurns = forkRead.events.filter((event) => event.kind === 'turn.started').map((event) => event.turnId);
        expect(forkTurns).toEqual([first]);
        const forkReview = await ui.request('review.turn', { threadId: fork.id, turnId: first });
        expect(forkReview.available).toBe(true);
        expect(forkReview.files.map((file) => file.path)).toEqual(['hello.txt']);

        await turn(ui, fork.id, 'inside the fork');
        texts = userTexts(server.requests.at(-1)?.body);
        expect(texts).toContain('make it one');
        expect(texts).toContain('inside the fork');
        expect(texts).not.toContain('after the rewind');
    }, 90_000);
});
