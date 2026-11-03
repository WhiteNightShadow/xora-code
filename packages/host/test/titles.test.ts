import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanTitle, openingLine } from '../src/titles.ts';
import { buildEngine, type ChatBody, connectMock, gitRepo, hosts, say, textOf, waitFor } from './harness.ts';

/**
 * Titles say what a conversation is about (06 §28): a new conversation, the chief's, a member's and a team run get
 * the gist of the opening request, written by a model; the start of the request until then.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

const isTitle = (body: ChatBody) =>
    textOf(body.messages.find((message) => message.role === 'system')?.content).includes('给一段对话起标题');

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

describe('titles', () => {
    it('cleans what a model answers into a title', () => {
        expect(cleanTitle('标题：修好登录页报错。')).toBe('修好登录页报错');
        expect(cleanTitle('“整理发布流程”\n多余的解释')).toBe('整理发布流程');
        expect(cleanTitle('')).toBeUndefined();
        expect(openingLine('\n\n  第一行要做的事\n第二行')).toBe('第一行要做的事');
    });

    it('titles a new conversation, the chief and a team run by the gist of their request', async () => {
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            return isTitle(body) ? say('“整理hello文件”') : say('好的。');
        });
        const { ui } = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-titles-data-')), { modelTitles: true });
        await connectMock(ui, server);
        const project = await ui.request('project.add', { path: gitRepo({ 'hello.txt': 'hello\n' }) });

        const thread = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', {
            threadId: thread.id,
            text: '帮我把hello.txt里的内容整理一下，顺便看看有没有拼写错误',
        });
        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: thread.id });
            return read.thread.title === '整理hello文件' ? read : undefined;
        }, 'the summarized title');

        const chief = await ui.request('chief.start', { projectId: project.id, text: '让团队把hello.txt整理一下' });
        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: chief.id });
            return read.thread.title === '总助手：整理hello文件' ? read : undefined;
        }, "the chief's title");

        const run = await ui.request('team.start', {
            projectId: project.id,
            goal: '把hello.txt整理一下，写清楚改了什么',
        });
        await waitFor(async () => {
            const read = await ui.request('team.get', { runId: run.id });
            return read.title === '整理hello文件' ? read : undefined;
        }, "the run's title");
        await ui.request('team.stop', { runId: run.id });
    }, 60_000);
});
