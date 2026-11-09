import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ItemOf } from '@xora/protocol';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { briefOutcome } from '../src/chief.ts';
import {
    approveAll,
    buildEngine,
    type ChatBody,
    call,
    connectMock,
    gitRepo,
    hosts,
    lastCall,
    say,
    textOf,
    type Ui,
    userText,
    waitFor,
} from './harness.ts';

/**
 * The chief assistant (06 §23): the one place the user talks to. It hands work to a member or a team, a card in its
 * conversation follows the work, news goes to the bottom of the conversation, and every turn its prompt says how
 * things stand. The real host and xora engine against a scripted model.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

const bodies = () =>
    server.requests.flatMap((request) => {
        const body = request.body as ChatBody | undefined;
        return body?.messages ? [body] : [];
    });
const systemOf = (body: ChatBody | undefined) =>
    textOf(body?.messages.find((message) => message.role === 'system')?.content);
const isChief = (body: ChatBody) => systemOf(body).includes('You are the chief assistant of Xora Code');

async function setUp(dataDir = mkdtempSync(path.join(tmpdir(), 'xora-chief-data-'))) {
    const harness = await host.start(dataDir);
    await connectMock(harness.ui, server);
    const project = await harness.ui.request('project.add', { path: gitRepo({ 'hello.txt': 'hello\n' }) });
    return { ...harness, dataDir, project };
}

/** The end of a thread's latest turn. */
async function settled(ui: Ui, threadId: string): Promise<string> {
    return waitFor(async () => {
        const read = await ui.request('thread.read', { threadId });
        const ended = read.events.filter((event) => event.kind === 'turn.completed' || event.kind === 'turn.failed');
        const started = read.events.filter((event) => event.kind === 'turn.started');
        return ended.length > 0 && ended.length === started.length ? (ended.at(-1)?.kind as string) : undefined;
    }, `the turn of ${threadId}`);
}

/** The cards of a chief's conversation, each as it stands now. */
async function cards(ui: Ui, threadId: string): Promise<Array<ItemOf<'delegation'>>> {
    const read = await ui.request('thread.read', { threadId });
    const latest = new Map<string, ItemOf<'delegation'>>();
    for (const event of read.events) {
        if (event.kind !== 'item.completed' && event.kind !== 'item.started') continue;
        const item = (event.payload as { item: ItemOf<'delegation'> }).item;
        if (item.type === 'delegation') latest.set(item.id, item);
    }
    return [...latest.values()];
}

async function turnIds(ui: Ui, threadId: string): Promise<string[]> {
    const read = await ui.request('thread.read', { threadId });
    return read.events.flatMap((event) =>
        event.kind === 'turn.started' ? [(event.payload as { turnId: string }).turnId] : [],
    );
}

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

describe('the chief assistant', () => {
    it('takes the first outcome section of a report', () => {
        expect(briefOutcome('## 目标达成\n登录页修好了。\n\n## 已完成\n- 修了表单\n\n## 下一步\n- 上线')).toBe(
            '登录页修好了。',
        );
        expect(briefOutcome('一句话的结论')).toBe('一句话的结论');
    });

    it('hands one job to a member, follows it to the end, and knows the outcome in its next turn', async () => {
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (!isChief(body)) return say('改好了：hello.txt现在是hello world。');
            if (body.messages.at(-1)?.role !== 'tool') {
                return userText(body).includes('结果呢')
                    ? say('编码已经改好了。')
                    : call({ name: 'member_list', arguments: {} });
            }
            return lastCall(body) === 'member_list'
                ? call({
                      name: 'member_dispatch',
                      arguments: { member: '编码', brief: '把hello.txt里的hello改成hello world，改完说一声' },
                  })
                : say('交给编码了，它改完我告诉你。');
        });
        const { ui, project } = await setUp();
        // The user's own conversation thinks at the level they set for new conversations, not the tier's.
        const { team } = await ui.request('settings.get', {});
        await ui.request('settings.update', { patch: { team, defaultEffort: 'max' } });
        const thread = await ui.request('chief.start', { projectId: project.id, text: '让编码把hello改成hello world' });
        expect(thread).toMatchObject({
            role: 'chief',
            mode: 'plan',
            effort: 'max',
            title: '总助手：让编码把hello改成hello world',
        });
        expect(await settled(ui, thread.id)).toBe('turn.completed');

        // It saw every project and the members to pick from.
        const first = bodies().find(isChief) as ChatBody;
        expect(systemOf(first)).toContain(`Projects (this conversation started in "${project.name}"):`);
        expect(systemOf(first)).toContain('Work handed on in this conversation:\n- none yet');
        const listed = bodies().find((body) => isChief(body) && lastCall(body) === 'member_list');
        expect(textOf(listed?.messages.at(-1)?.content)).toContain('- coder (编码): executor');

        // The member works in a conversation of its own; the card follows it to its answer.
        const [card] = await cards(ui, thread.id);
        expect(card).toMatchObject({ kind: 'member', who: '编码', projectId: project.id });
        expect(card?.toolCallId).toBeTruthy();
        const memberThread = await ui.request('thread.read', { threadId: card?.refId as string });
        expect(memberThread.thread).toMatchObject({ agentId: 'coder', projectId: project.id });
        await settled(ui, card?.refId as string);
        const done = await waitFor(async () => {
            const found = (await cards(ui, thread.id)).find((item) => item.refId === card?.refId && !item.report);
            return found?.status === 'done' ? found : undefined;
        }, 'the card to end');
        expect(done.summary).toBe('改好了：hello.txt现在是hello world。');
        // No card ever ended without the answer (the thread turns idle a moment before the turn's end is known).
        const read = await ui.request('thread.read', { threadId: thread.id });
        const ended = read.events
            .map((event) => (event.payload as { item?: ItemOf<'delegation'> }).item)
            .filter((item) => item?.type === 'delegation' && item.status === 'done');
        expect(ended.every((item) => item?.summary === '改好了：hello.txt现在是hello world。')).toBe(true);

        // Its next turn knows how the work ended.
        await ui.request('turn.start', { threadId: thread.id, text: '结果呢？' });
        expect(await settled(ui, thread.id)).toBe('turn.completed');
        const next = bodies()
            .filter((body) => isChief(body) && userText(body).includes('结果呢'))
            .at(-1);
        expect(systemOf(next)).toContain(
            `- member 编码 conversation ${card?.refId} in ${project.name}: "把hello.txt里的hello改成hello world，改完说一声" — done: 改好了`,
        );
        expect(systemOf(next)).toContain('Its report:\n    改好了：hello.txt现在是hello world。');
    }, 90_000);

    it('starts a team run, reports its end at the bottom of the conversation, and follows it after a restart', async () => {
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (!isChief(body)) return say('收到，先看看项目。');
            if (body.messages.at(-1)?.role === 'tool') return say('交给团队了。');
            return userText(body).includes('做个待办')
                ? call({
                      name: 'team_start',
                      arguments: { goal: '做一个待办应用：能加、能勾、能删，npm test通过', members: ['coder'] },
                  })
                : say('团队在做。');
        });
        const { ui, project, dataDir } = await setUp();
        approveAll(ui);
        const thread = await ui.request('chief.start', { projectId: project.id, text: '交给团队：做个待办应用' });
        expect(await settled(ui, thread.id)).toBe('turn.completed');
        const runs = await ui.request('team.list', { projectId: project.id });
        expect(runs).toHaveLength(1);
        const run = runs[0];
        // L2 and full access unless the user asks otherwise; the named member is the one who works.
        expect(run).toMatchObject({
            autonomy: 'L2',
            permission: 'full',
            goal: '做一个待办应用：能加、能勾、能删，npm test通过',
        });
        expect(run?.members?.map((member) => member.memberId)).toEqual(['coder']);
        const [card] = await cards(ui, thread.id);
        expect(card).toMatchObject({ kind: 'team', refId: run?.id, status: 'running' });

        // The conversation goes on; when the run ends, the news goes to the latest turn.
        await ui.request('turn.start', { threadId: thread.id, text: '怎么样了' });
        expect(await settled(ui, thread.id)).toBe('turn.completed');
        const later = (await turnIds(ui, thread.id)).at(-1);
        await ui.request('team.stop', { runId: run?.id as string });
        const report = await waitFor(
            async () => (await cards(ui, thread.id)).find((item) => item.report && item.status === 'cancelled'),
            'the report of the end',
        );
        expect(report).toMatchObject({ refId: run?.id, turnId: later });
        expect(report.toolCallId).toBeUndefined();
        expect((await cards(ui, thread.id)).find((item) => item.id === card?.id)?.status).toBe('cancelled');

        // After a restart the conversation is the chief's again, and knows the work it handed on.
        await host.closeLast();
        const again = await host.start(dataDir);
        await again.ui.request('turn.start', { threadId: thread.id, text: '刚才那个团队呢' });
        expect(await settled(again.ui, thread.id)).toBe('turn.completed');
        const restored = bodies()
            .filter((body) => isChief(body) && userText(body).includes('刚才那个团队呢'))
            .at(-1);
        expect(systemOf(restored)).toContain(`- team run ${run?.id} in ${project.name}:`);
        expect(systemOf(restored)).toContain('— cancelled');
    }, 120_000);

    it('tells the model what went wrong when a tool cannot do it', async () => {
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (!isChief(body)) return say('好的。');
            if (body.messages.at(-1)?.role === 'tool') return say('那个项目没有。');
            return call({ name: 'workflow_list', arguments: { project: 'nowhere' } });
        });
        const { ui, project } = await setUp();
        const thread = await ui.request('chief.start', { projectId: project.id, text: '看看nowhere的工作流' });
        expect(await settled(ui, thread.id)).toBe('turn.completed');
        const answered = bodies().find((body) => isChief(body) && body.messages.at(-1)?.role === 'tool');
        expect(textOf(answered?.messages.at(-1)?.content)).toContain(
            `No project "nowhere"; the projects are: ${project.name}`,
        );
    }, 60_000);
});
