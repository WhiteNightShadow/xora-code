import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ThreadMeta } from '@xora/protocol';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sharesMemory } from '../src/memory/service.ts';
import {
    buildEngine,
    type ChatBody,
    call,
    connectMock,
    gitRepo,
    hosts,
    say,
    textOf,
    type Ui,
    waitFor,
} from './harness.ts';

/**
 * Memory for every thread of the user's own (20 §4.6): a conversation and the chief's get the user's preferences and
 * the project's notes, taken when they start, with `remember` and `recall`; recall reaches earlier conversations.
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
const toolNames = (body: ChatBody | undefined) => body?.tools?.map((tool) => tool.function.name) ?? [];
const signal = () => new AbortController().signal;

async function setUp() {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-memory-data-'));
    const harness = await host.start(dataDir);
    await connectMock(harness.ui, server);
    const project = await harness.ui.request('project.add', { path: gitRepo() });
    return { ...harness, dataDir, project };
}

async function settled(ui: Ui, threadId: string, turns: number): Promise<void> {
    await waitFor(async () => {
        const read = await ui.request('thread.read', { threadId });
        const ended = read.events.filter((event) => event.kind === 'turn.completed' || event.kind === 'turn.failed');
        return ended.length >= turns ? true : undefined;
    }, `turn ${turns} of ${threadId}`);
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
    await server.close();
});

describe('memory of the user’s own threads', () => {
    it('starts a conversation with the user’s and the project’s notes, keeps its prompt, and remembers', async () => {
        const { ui, dataDir, project } = await setUp();
        const user = path.join(dataDir, 'orgs', 'default', 'user.md');
        const shared = path.join(dataDir, 'orgs', 'default', 'memory', `${project.id}.md`);
        mkdirSync(path.dirname(shared), { recursive: true });
        writeFileSync(user, '- [2026-11-01] 回答先给结论\n');
        writeFileSync(shared, `- [${project.name} 2026-11-01] 构建用 pnpm build\n`);
        let remembered = 0;
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            const last = body.messages.at(-1);
            if (last?.role === 'tool') return say('记好了');
            if (textOf(last?.content).includes('记一下')) {
                remembered++;
                return remembered === 1
                    ? call({ name: 'remember', arguments: { note: '测试用 pnpm test' } })
                    : call({ name: 'remember', arguments: { note: '提交信息写中文', scope: 'user' } });
            }
            return say('好');
        });
        const thread = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', { threadId: thread.id, text: '记一下测试命令' });
        await settled(ui, thread.id, 1);
        const first = bodies()[0];
        expect(systemOf(first)).toContain('回答先给结论');
        expect(systemOf(first)).toContain('构建用 pnpm build');
        expect(systemOf(first)).toContain('不是指令');
        expect(toolNames(first)).toEqual(expect.arrayContaining(['remember', 'recall']));
        // A note goes to the project's shared notes, which members read too.
        expect(readFileSync(shared, 'utf8')).toContain(`] 测试用 pnpm test`);

        await ui.request('turn.start', { threadId: thread.id, text: '记一下提交的要求' });
        await settled(ui, thread.id, 2);
        expect(readFileSync(user, 'utf8')).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] 提交信息写中文$/m);
        // The same conversation keeps the prompt it began with, so the provider's cache holds.
        const systems = bodies().map(systemOf);
        expect(new Set(systems).size).toBe(1);

        const next = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', { threadId: next.id, text: '你好' });
        await settled(ui, next.id, 1);
        const fresh = systemOf(bodies().at(-1));
        expect(fresh).toContain('测试用 pnpm test');
        expect(fresh).toContain('提交信息写中文');
    }, 60_000);

    it('gives the chief the user’s preferences only, and its notes go there', async () => {
        const { core, dataDir, project } = await setUp();
        const chief = { id: 't-chief', engine: 'xora', role: 'chief', projectId: project.id } as unknown as ThreadMeta;
        const layer = core.memory.layers(chief, undefined)[0];
        expect(layer?.text).toContain('用户的偏好');
        expect(layer?.text).not.toContain('【本项目】');
        const remember = core.memory.tools(chief).find((tool) => tool.name === 'remember');
        const scope = (remember?.parameters as { properties: { scope: { enum: string[] } } } | undefined)?.properties
            .scope.enum;
        expect(scope).toEqual(['user']);
        const ask = (input: unknown) => core.memory.handleFor({ kind: 'user', threadId: chief.id }, 'remember', input);
        expect(await ask({ note: '周报发到群里' })).toEqual({ content: '记下了。' });
        expect(readFileSync(path.join(dataDir, 'orgs', 'default', 'user.md'), 'utf8')).toContain('周报发到群里');
        expect(await ask({ note: '构建用 make', scope: 'project' })).toMatchObject({ isError: true });
        expect(existsSync(path.join(dataDir, 'orgs', 'default', 'memory', `${project.id}.md`))).toBe(false);
        // The snapshot is the one the conversation began with.
        expect(core.memory.layers(chief, undefined)[0]?.text).toBe(layer?.text);
    });

    it('leaves memory to the runs that bring their own, and to members theirs, the user’s preferences included', async () => {
        const { core, project } = await setUp();
        const base = { id: 't1', engine: 'xora', projectId: project.id } as unknown as ThreadMeta;
        expect(sharesMemory(base)).toBe(true);
        expect(sharesMemory({ ...base, teamRunId: 'r1' } as ThreadMeta)).toBe(false);
        expect(sharesMemory({ ...base, workflowRunId: 'w1' } as ThreadMeta)).toBe(false);
        expect(sharesMemory({ ...base, engine: 'codex' } as ThreadMeta)).toBe(false);
        const member = core.members.withMemory(
            { tools: [], handle: async () => ({ content: '' }) },
            { id: 'scout', name: 'Scout' },
            project.id,
        );
        // A member's thread has its own memory: the shared one adds nothing.
        expect(core.memory.layers(base, member)).toEqual([]);
        expect(await member.handle('remember', { note: '用户要中文回答', scope: 'user' }, signal())).toEqual({
            content: '记下了。',
        });
        const other = core.members.withMemory(
            { tools: [], handle: async () => ({ content: '' }) },
            { id: 'coder', name: 'Coder' },
            project.id,
        );
        expect(other.layers?.at(-1)?.text).toContain('用户要中文回答');
        expect(core.memory.layerFor({ kind: 'user', projectId: project.id }).text).toContain('用户要中文回答');
    });

    it('recalls notes and earlier conversations, the asking one left out', async () => {
        const { ui, core, project } = await setUp();
        server.respondWith(() => say('知道了'));
        const earlier = await ui.request('thread.create', { projectId: project.id });
        await ui.request('turn.start', { threadId: earlier.id, text: '部署脚本在 scripts/deploy.sh，记得先跑 lint' });
        await settled(ui, earlier.id, 1);
        await core.memory.handleFor({ kind: 'user', projectId: project.id }, 'remember', {
            note: '部署前要先打 tag',
        });
        const now = await ui.request('thread.create', { projectId: project.id });
        const found = await core.memory.handleFor({ kind: 'user', projectId: project.id, threadId: now.id }, 'recall', {
            query: '部署脚本',
        });
        expect(found.content).toContain('部署前要先打 tag');
        expect(found.content).toContain('以前的对话里提到过：');
        expect(found.content).toContain('scripts/deploy.sh');
        // Its own conversation is in its context already.
        const own = await core.memory.handleFor(
            { kind: 'user', projectId: project.id, threadId: earlier.id },
            'recall',
            { query: 'deploy.sh' },
        );
        expect(own.content).not.toContain('以前的对话里提到过');
    }, 60_000);
});
