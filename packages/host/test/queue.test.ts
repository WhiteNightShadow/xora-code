import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildEngine, type ChatBody, connectMock, gitRepo, hosts, say, textOf, waitFor } from './harness.ts';

/**
 * Messages that wait their turn (03): sent while a turn runs, they start turns of their own, in order, once the
 * running one ended by itself; a stopped turn leaves them to the user, who can edit, drop or send them now.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'deepseek-flash' }] });
}, 60_000);

afterEach(async () => {
    await host.closeAll();
    server.reset();
});

afterAll(async () => {
    await server?.close();
});

/** The user's words of every model request, in order (after the environment block the engine puts first). */
/** The thread as the UI knows it. */
const meta = async (ui: Awaited<ReturnType<typeof setUp>>['ui'], threadId: string) =>
    (await ui.request('thread.read', { threadId })).thread;

const asked = () =>
    server.requests
        .map((request) => request.body as ChatBody | undefined)
        .filter((body): body is ChatBody => Boolean(body?.messages))
        .map(
            (body) =>
                textOf(body.messages.filter((message) => message.role === 'user').at(-1)?.content)
                    .split('\n')
                    .filter((line) => line.trim())
                    .at(-1) ?? '',
        );

async function setUp(delayMs: number) {
    server.respondWith((request) => {
        const body = request.body as ChatBody | undefined;
        if (!body?.messages) return undefined;
        const last = textOf(body.messages.filter((message) => message.role === 'user').at(-1)?.content);
        return { ...say(`收到：${last.split('\n')[0]}`), ...(last.includes('慢') ? { delayMs } : {}) };
    });
    const { ui } = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-queue-data-')));
    await connectMock(ui, server);
    const project = await ui.request('project.add', { path: gitRepo() });
    const thread = await ui.request('thread.create', { projectId: project.id });
    return { ui, thread };
}

describe('waiting messages', () => {
    it('start their own turns in order once the running turn has ended', async () => {
        const { ui, thread } = await setUp(1500);
        const first = await ui.request('turn.queue', { threadId: thread.id, text: '第一条，慢一点' });
        expect(first.turnId).toBeDefined();
        const second = await ui.request('turn.queue', { threadId: thread.id, text: '第二条' });
        const third = await ui.request('turn.queue', { threadId: thread.id, text: '第三条' });
        expect(second.queuedId && third.queuedId).toBeTruthy();
        const waiting = await meta(ui, thread.id);
        expect(waiting.queued?.map((item) => item.text)).toEqual(['第二条', '第三条']);

        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: thread.id });
            const turns = read.events.filter((event) => event.kind === 'turn.completed').length;
            return turns === 3 && read.thread.status === 'idle' ? read : undefined;
        }, 'three turns');
        expect(asked()).toEqual(['第一条，慢一点', '第二条', '第三条']);
        expect((await meta(ui, thread.id)).queued).toBeUndefined();
    }, 60_000);

    it('wait for the user after a stop, who can edit, drop or send them now', async () => {
        const { ui, thread } = await setUp(4000);
        await ui.request('turn.queue', { threadId: thread.id, text: '慢慢做这件事' });
        const keep = await ui.request('turn.queue', { threadId: thread.id, text: '再补一句' });
        const drop = await ui.request('turn.queue', { threadId: thread.id, text: '这条不要了' });
        await ui.request('turn.editQueued', { threadId: thread.id, id: keep.queuedId as string, text: '改过的补充' });
        await ui.request('turn.unqueue', { threadId: thread.id, id: drop.queuedId as string });
        await ui.request('turn.cancel', { threadId: thread.id });
        await waitFor(async () => {
            const current = await meta(ui, thread.id);
            return current.status === 'cancelled' ? current : undefined;
        }, 'the stop');
        // Nothing starts by itself after a stop.
        await new Promise((resolve) => setTimeout(resolve, 600));
        const stopped = await meta(ui, thread.id);
        expect(stopped.status).toBe('cancelled');
        expect(stopped.queued?.map((item) => item.text)).toEqual(['改过的补充']);

        const sent = await ui.request('turn.sendQueued', { threadId: thread.id, id: keep.queuedId as string });
        expect(sent.turnId).toBeDefined();
        await waitFor(async () => {
            const current = await meta(ui, thread.id);
            return current.status === 'idle' ? current : undefined;
        }, 'the sent message');
        expect(asked().at(-1)).toBe('改过的补充');
        expect((await meta(ui, thread.id)).queued).toBeUndefined();
    }, 60_000);
});
