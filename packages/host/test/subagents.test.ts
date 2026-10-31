import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventEnvelope, Item, ItemOf, ThreadMeta } from '@xora/protocol';
import { type MockModelServer, type MockTurn, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mentionedAgents, subagentMode } from '../src/subagents.ts';
import { buildEngine, call, connectMock, gitRepo, hosts, say, textOf, type Ui, userText, waitFor } from './harness.ts';

/**
 * Subagents (03 §4, 06): the thread's agent hands tasks to child threads with the `agent` tool and gets their
 * answers back; several run at once; stopping the turn stops them; `@agent` in a message hands it to a defined
 * agent. The real host and xora engine against a scripted model server.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

interface Body {
    readonly model: string;
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
    readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string; readonly description?: string } }>;
}

/** The parent has the `agent` tool; a subagent never does (no nesting). */
const hasAgentTool = (body: Body) => body.tools?.some((tool) => tool.function.name === 'agent') ?? false;
const systemOf = (body: Body) => textOf(body.messages.find((message) => message.role === 'system')?.content);
const lastOf = (body: Body) => body.messages.at(-1);
const bodies = () =>
    server.requests.flatMap((request) => {
        const body = request.body as Body | undefined;
        return body?.messages ? [body] : [];
    });

/** The final version of every item of a thread's history. */
function itemsOf(events: readonly EventEnvelope[]): Item[] {
    const items = new Map<string, Item>();
    for (const event of events) {
        if (event.kind === 'item.started' || event.kind === 'item.completed') {
            const item = (event.payload as { item: Item }).item;
            items.set(item.id, item);
        }
    }
    return [...items.values()];
}

async function turnEnd(ui: Ui, threadId: string, turnId: string): Promise<EventEnvelope> {
    return waitFor(async () => {
        const read = await ui.request('thread.read', { threadId });
        return read.events.find(
            (event) => (event.kind === 'turn.completed' || event.kind === 'turn.failed') && event.turnId === turnId,
        );
    }, `the end of turn ${turnId}`);
}

async function childrenOf(ui: Ui, threadId: string): Promise<ThreadMeta[]> {
    return (await ui.request('thread.list', {})).filter((thread) => thread.parent?.threadId === threadId);
}

async function setUp(files: Record<string, string> = {}, mode: ThreadMeta['mode'] = 'ask') {
    const { ui } = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-subagents-data-')));
    await connectMock(ui, server);
    const project = await ui.request('project.add', { path: gitRepo(files) });
    const thread = await ui.request('thread.create', { projectId: project.id, mode });
    return { ui, thread };
}

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'deepseek-flash' }, { id: 'kimi-k3' }] });
}, 60_000);

afterEach(async () => {
    await host.closeAll();
    server.reset();
});

afterAll(async () => {
    await server?.close();
});

describe('subagents', () => {
    it('hands a task to a subagent and gets its answer back', async () => {
        server.respondWith((request) => {
            const body = request.body as Body | undefined;
            if (!body?.messages) return undefined;
            if (!hasAgentTool(body)) return say('入口在src/main.ts。');
            return lastOf(body)?.role === 'tool'
                ? say(`子agent说：${textOf(lastOf(body)?.content)}`)
                : call({
                      name: 'agent',
                      arguments: { description: '查找入口', prompt: '找出这个项目的入口文件，回答它的路径。' },
                  });
        });
        const { ui, thread } = await setUp({}, 'auto_edit');
        const { turnId } = await ui.request('turn.start', { threadId: thread.id, text: '入口文件在哪？' });
        expect((await turnEnd(ui, thread.id, turnId)).kind).toBe('turn.completed');

        const read = await ui.request('thread.read', { threadId: thread.id });
        const items = itemsOf(read.events);
        const card = items.find((item): item is ItemOf<'subagent'> => item.type === 'subagent');
        expect(card).toMatchObject({
            status: 'completed',
            agent: '',
            title: '查找入口',
            summary: '入口在src/main.ts。',
        });
        // The card stands for the tool call that started it.
        const toolCall = items.find((item) => item.type === 'tool_call' && item.name === 'agent');
        expect(toolCall?.type === 'tool_call' && toolCall.toolCallId).toBe(card?.toolCallId);
        expect(items.filter((item) => item.type === 'agent_message').at(-1)).toMatchObject({
            text: '子agent说：入口在src/main.ts。',
        });

        const [child] = await childrenOf(ui, thread.id);
        expect(child?.id).toBe(card?.threadId);
        expect(child).toMatchObject({
            parent: { threadId: thread.id, turnId },
            mode: 'plan',
            title: '查找入口',
            status: 'idle',
            needsReview: false,
        });
        expect(child?.agentId).toBeUndefined();

        // The subagent saw the prompt and nothing of the conversation, with the brief and without the tool.
        const sub = bodies().filter((body) => !hasAgentTool(body));
        expect(sub).toHaveLength(1);
        expect(userText(sub[0] as Body)).toContain('找出这个项目的入口文件');
        expect(userText(sub[0] as Body)).not.toContain('入口文件在哪？');
        expect(systemOf(sub[0] as Body)).toContain('你是另一个agent启动的子agent');
        // Its answer is the tool result the parent continued with.
        const parent = bodies().filter(hasAgentTool);
        expect(parent).toHaveLength(2);
        expect(lastOf(parent[1] as Body)).toMatchObject({ role: 'tool' });
        expect(textOf(lastOf(parent[1] as Body)?.content)).toBe('入口在src/main.ts。');
        const tool = parent[0]?.tools?.find((item) => item.function.name === 'agent');
        expect(tool?.function.description).toContain('这个项目没有定义agent');
    }, 60_000);

    it('runs the subagents of one response at the same time', async () => {
        const started: string[] = [];
        let both: () => void = () => undefined;
        const bothStarted = new Promise<void>((resolve) => {
            both = resolve;
        });
        let startedAtFirstAnswer = 0;
        server.respondWith(async (request) => {
            const body = request.body as Body | undefined;
            if (!body?.messages) return undefined;
            if (!hasAgentTool(body)) {
                const prompt = userText(body);
                started.push(prompt);
                if (started.length === 2) both();
                // One after the other, the first would wait here in vain.
                await Promise.race([bothStarted, sleep(10_000)]);
                startedAtFirstAnswer ||= started.length;
                return say(prompt.includes('前端') ? '前端用react。' : '后端用node。');
            }
            return lastOf(body)?.role === 'tool'
                ? say('汇总完毕。')
                : call(
                      { name: 'agent', arguments: { description: '看前端', prompt: '前端用什么框架？' } },
                      { name: 'agent', arguments: { description: '看后端', prompt: '后端用什么运行时？' } },
                  );
        });
        const { ui, thread } = await setUp();
        const { turnId } = await ui.request('turn.start', { threadId: thread.id, text: '看看前后端各用什么' });
        expect((await turnEnd(ui, thread.id, turnId)).kind).toBe('turn.completed');

        expect(startedAtFirstAnswer).toBe(2);
        const read = await ui.request('thread.read', { threadId: thread.id });
        const cards = itemsOf(read.events).filter((item): item is ItemOf<'subagent'> => item.type === 'subagent');
        expect(cards.map((card) => [card.title, card.status]).sort()).toEqual([
            ['看前端', 'completed'],
            ['看后端', 'completed'],
        ]);
        expect(new Set(cards.map((card) => card.toolCallId)).size).toBe(2);
        expect((await childrenOf(ui, thread.id)).map((child) => child.title).sort()).toEqual(['看前端', '看后端']);
        // Both answers came back, each as the result of its own call.
        const last = bodies().filter(hasAgentTool).at(-1) as Body;
        const results = last.messages
            .filter((message) => message.role === 'tool')
            .map((message) => textOf(message.content));
        expect(results.sort()).toEqual(['前端用react。', '后端用node。'].sort());
    }, 60_000);

    it('runs at most four at once; the others wait for a free slot', async () => {
        let started = 0;
        let active = 0;
        let most = 0;
        let all: () => void = () => undefined;
        const allStarted = new Promise<void>((resolve) => {
            all = resolve;
        });
        server.respondWith(async (request) => {
            const body = request.body as Body | undefined;
            if (!body?.messages) return undefined;
            if (!hasAgentTool(body)) {
                started++;
                active++;
                most = Math.max(most, active);
                if (started === 5) all();
                // With no limit all five would be here together.
                await Promise.race([allStarted, sleep(1_500)]);
                active--;
                return say(`结果${/任务(\d)/.exec(userText(body))?.[1]}`);
            }
            return lastOf(body)?.role === 'tool'
                ? say('都做完了。')
                : call(
                      ...[1, 2, 3, 4, 5].map((number) => ({
                          name: 'agent',
                          arguments: { description: `任务${number}`, prompt: `做任务${number}。` },
                      })),
                  );
        });
        const { ui, thread } = await setUp();
        const { turnId } = await ui.request('turn.start', { threadId: thread.id, text: '做五个任务' });
        expect((await turnEnd(ui, thread.id, turnId)).kind).toBe('turn.completed');
        expect(most).toBe(4);
        const read = await ui.request('thread.read', { threadId: thread.id });
        const cards = itemsOf(read.events).filter((item): item is ItemOf<'subagent'> => item.type === 'subagent');
        expect(cards.map((card) => card.status)).toEqual(Array(5).fill('completed'));
        const last = bodies().filter(hasAgentTool).at(-1) as Body;
        const results = last.messages
            .filter((message) => message.role === 'tool')
            .map((message) => textOf(message.content));
        // In the order they finished.
        expect(results.sort()).toEqual(['结果1', '结果2', '结果3', '结果4', '结果5']);
    }, 60_000);

    it('lets a subagent write when asked, and lists the files it changed', async () => {
        server.respondWith((request) => {
            const body = request.body as Body | undefined;
            if (!body?.messages) return undefined;
            if (!hasAgentTool(body)) {
                return lastOf(body)?.role === 'tool'
                    ? say('写好了notes.txt。')
                    : call({ name: 'write', arguments: { path: 'notes.txt', content: 'hello\n' } });
            }
            return lastOf(body)?.role === 'tool'
                ? say('好了。')
                : call({
                      name: 'agent',
                      arguments: { description: '写笔记', prompt: '在notes.txt里写一行hello。', write: true },
                  });
        });
        const { ui, thread } = await setUp({}, 'auto_edit');
        const project = (await ui.request('project.list', {}))[0];
        const { turnId } = await ui.request('turn.start', { threadId: thread.id, text: '记一条笔记' });
        expect((await turnEnd(ui, thread.id, turnId)).kind).toBe('turn.completed');

        expect(readFileSync(path.join(project?.path ?? '', 'notes.txt'), 'utf8')).toBe('hello\n');
        const [child] = await childrenOf(ui, thread.id);
        // The parent's mode, and no review mark: the change is reviewed with the parent's turn.
        expect(child).toMatchObject({ mode: 'auto_edit', needsReview: false });
        const result = textOf(lastOf(bodies().filter(hasAgentTool).at(-1) as Body)?.content);
        expect(result).toBe('写好了notes.txt。\n\n子agent改动的文件：notes.txt');
        const read = await ui.request('thread.read', { threadId: thread.id });
        const changes = itemsOf(read.events).find((item) => item.type === 'file_changes');
        expect(changes?.type === 'file_changes' && changes.files.map((file) => file.path)).toEqual(['notes.txt']);
        expect(read.thread.needsReview).toBe(true);
    }, 60_000);

    it('stops its running subagents when the turn is stopped', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let asked = false;
        server.respondWith(async (request): Promise<MockTurn | undefined> => {
            const body = request.body as Body | undefined;
            if (!body?.messages) return undefined;
            if (!hasAgentTool(body)) {
                asked = true;
                await gate;
                return say('太晚了。');
            }
            return lastOf(body)?.role === 'tool'
                ? say('不该走到这里。')
                : call({ name: 'agent', arguments: { description: '慢任务', prompt: '做一件很慢的事。' } });
        });
        try {
            const { ui, thread } = await setUp();
            const { turnId } = await ui.request('turn.start', { threadId: thread.id, text: '开始慢任务' });
            const child = await waitFor(async () => {
                const [found] = await childrenOf(ui, thread.id);
                return found?.status === 'running' && asked ? found : undefined;
            }, 'the subagent asking its model');
            const running = await ui.request('thread.read', { threadId: thread.id });
            expect(running.live.find((item) => item.type === 'subagent')).toMatchObject({
                status: 'running',
                threadId: child.id,
            });

            await ui.request('turn.cancel', { threadId: thread.id });
            const ended = await turnEnd(ui, thread.id, turnId);
            expect((ended.payload as { stopReason?: string }).stopReason).toBe('cancelled');
            const childRead = await ui.request('thread.read', { threadId: child.id });
            const childTurn = childRead.events.find((event) => event.kind === 'turn.started')?.turnId ?? '';
            const childEnded = await turnEnd(ui, child.id, childTurn);
            expect((childEnded.payload as { stopReason?: string }).stopReason).toBe('cancelled');
            const stopped = await waitFor(async () => {
                const [found] = await childrenOf(ui, thread.id);
                return found?.status === 'cancelled' ? found : undefined;
            }, 'the subagent stopped');
            expect(stopped.id).toBe(child.id);
            const read = await ui.request('thread.read', { threadId: thread.id });
            expect(itemsOf(read.events).find((item) => item.type === 'subagent')).toMatchObject({
                status: 'cancelled',
                threadId: child.id,
            });
            // The card ended with the turn, not after it.
            const kinds = read.events.flatMap((event) =>
                event.kind === 'turn.completed'
                    ? ['turn']
                    : event.kind === 'item.completed' && (event.payload as { item: Item }).item.type === 'subagent'
                      ? ['card']
                      : [],
            );
            expect(kinds).toEqual(['card', 'turn']);
            expect(bodies().filter(hasAgentTool)).toHaveLength(1);
        } finally {
            release();
        }
    }, 60_000);

    it('hands a message that mentions a defined agent to it', async () => {
        const reviewer = [
            '---',
            'name: reviewer',
            'description: 审查代码改动，指出问题',
            'model: kimi-k3',
            '---',
            '你是代码审查员reviewer-bot：只指出问题，不改代码。',
            '',
        ].join('\n');
        server.respondWith((request) => {
            const body = request.body as Body | undefined;
            if (!body?.messages) return undefined;
            if (!hasAgentTool(body)) {
                return say(systemOf(body).includes('reviewer-bot') ? '没有发现问题。' : '我不是reviewer。');
            }
            if (lastOf(body)?.role === 'tool') {
                return say(`reviewer的结论：${textOf(lastOf(body)?.content)}`);
            }
            // The scripted agent does what the hand-off asks.
            const text = userText(body);
            return text.includes('<agent_handoff>') && text.includes('@reviewer')
                ? call({
                      name: 'agent',
                      arguments: { agent: 'reviewer', description: '审查改动', prompt: '审查最近的改动，指出问题。' },
                  })
                : say('没有交给agent。');
        });
        const { ui, thread } = await setUp({ '.xora/agents/reviewer.md': reviewer });
        const text = '请@reviewer看看最近的改动';
        const { turnId } = await ui.request('turn.start', { threadId: thread.id, text });
        expect((await turnEnd(ui, thread.id, turnId)).kind).toBe('turn.completed');

        const read = await ui.request('thread.read', { threadId: thread.id });
        // The user's message stays as written; the hand-off only went to the model.
        const input = read.events.find((event) => event.kind === 'turn.started')?.payload as {
            input: { text: string };
        };
        expect(input.input.text).toBe(text);
        const first = bodies().find(hasAgentTool) as Body;
        expect(userText(first)).toContain('<agent_handoff>');
        expect(first.tools?.find((tool) => tool.function.name === 'agent')?.function.description).toContain(
            '- reviewer：审查代码改动，指出问题',
        );

        const card = itemsOf(read.events).find((item): item is ItemOf<'subagent'> => item.type === 'subagent');
        expect(card).toMatchObject({ status: 'completed', agent: 'reviewer', summary: '没有发现问题。' });
        const [child] = await childrenOf(ui, thread.id);
        expect(child).toMatchObject({
            id: card?.threadId,
            agentId: 'reviewer',
            mode: 'plan',
            model: { model: 'kimi-k3' },
        });
        const prompt = await ui.request('prompt.get', { scope: 'thread', threadId: child?.id ?? '' });
        expect(prompt.text).toContain('reviewer-bot');
        expect(bodies().find((body) => !hasAgentTool(body))?.model).toBe('kimi-k3');
        expect(
            itemsOf(read.events)
                .filter((item) => item.type === 'agent_message')
                .at(-1),
        ).toMatchObject({
            text: 'reviewer的结论：没有发现问题。',
        });
    }, 60_000);

    it('reads mentions and modes', () => {
        const names = ['code', 'code-reviewer', '数据分析', '数据分析师', 'plugin:scout'];
        expect(mentionedAgents('请@code-reviewer看看', names)).toEqual(['code-reviewer']);
        expect(mentionedAgents('@数据分析师和@数据分析，@CODE.', names).sort()).toEqual(
            ['code', '数据分析', '数据分析师'].sort(),
        );
        expect(mentionedAgents('看看@code.ts和me@code，还有@plugin:scout', names)).toEqual(['plugin:scout']);
        expect(subagentMode('full', false)).toBe('plan');
        expect(subagentMode('auto_edit', true)).toBe('auto_edit');
        expect(subagentMode('full', true, 'ask')).toBe('ask');
        expect(subagentMode('ask', true, 'full')).toBe('ask');
        expect(subagentMode('full', true, 'auto-edit')).toBe('auto_edit');
    });
});
