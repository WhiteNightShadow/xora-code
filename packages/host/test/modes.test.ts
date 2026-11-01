import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EventEnvelope, Item, ItemOf, Settings } from '@xora/protocol';
import { type MockModelServer, type MockTurn, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    agentOf,
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
 * The permissions the user picks hold until they pick others: a new thread starts in the mode picked last, a switch
 * reaches the calls already waiting for an answer, a workflow run's permissions reach its steps (read-only agents
 * stay read-only), and the team and workflow dialogs start from what was chosen the time before.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'deepseek-flash' }] });
}, 60_000);

afterEach(() => host.closeAll());

afterAll(async () => {
    await server?.close();
});

/** A host with the mock model connected and a project; `settings` collects what `settings.changed` tells after that. */
async function setUp(files: Record<string, string> = {}) {
    const harness = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-modes-data-')));
    await connectMock(harness.ui, server);
    const settings: Settings[] = [];
    harness.ui.onNotification('settings.changed', ({ settings: next }) => settings.push(next));
    const repo = gitRepo(files);
    const project = await harness.ui.request('project.add', { path: repo });
    return { ...harness, repo, project, settings };
}

async function turnsDone(ui: Ui, threadId: string, count = 1) {
    return waitFor(async () => {
        const snapshot = await ui.request('thread.read', { threadId });
        const ended = snapshot.events.filter(
            (event) => event.kind === 'turn.completed' || event.kind === 'turn.failed',
        );
        return ended.length >= count ? snapshot : undefined;
    }, `turn ${count} of ${threadId}`);
}

function approvalItems(events: readonly EventEnvelope[]): ItemOf<'approval'>[] {
    return events
        .filter((event) => event.kind === 'item.completed')
        .map((event) => (event.payload as { item: Item }).item)
        .filter((item): item is ItemOf<'approval'> => item.type === 'approval');
}

function body(request: { body: unknown }): ChatBody | undefined {
    const value = request.body as ChatBody | undefined;
    return value?.messages ? value : undefined;
}

/** Writes a workflow file, checks it with `workflow_check`, then reports what the check said. */
function writeWorkflow(chat: ChatBody, file: string, content: string): MockTurn {
    const last = chat.messages.at(-1);
    if (last?.role !== 'tool') {
        return call({ name: 'write', arguments: { path: file, content } });
    }
    return lastCall(chat) === 'write'
        ? call({ name: 'workflow_check', arguments: { path: file } })
        : say(`checked: ${textOf(last.content)}`);
}

// Workflow runs -------------------------------------------------------------------------------------------------

const BUILD = `node -e "require('fs').writeFileSync('built.txt','ok')"`;

/** A gate next to a coder whose command asks in its own mode; a reviewer and a writer after it; then a command. */
const MODES = `
name: modes
steps:
  - id: approve
    gate: human
    message: 继续吗？
  - id: build
    agent: coder
    task: 构建
  - id: check
    agent: reviewer
    needs: [build]
    task: 审查
  - id: docs
    agent: writer
    needs: [build]
    task: 写文档
  - id: script
    needs: [check, docs]
    run: |-
      node -e "require('fs').writeFileSync('script.txt','ok')"
`;

/** A debugger (ask mode), a scout (plan mode) and a sub-workflow with another debugger. */
const EDITS = `
name: edits
steps:
  - id: fix
    agent: debugger
    task: 修
  - id: look
    agent: scout
    task: 看
  - id: sub
    workflow: child
`;

const CHILD = `
name: child
steps:
  - id: again
    agent: debugger
    task: 再修
`;

/** The coder runs its command, then every agent hands in its step. */
function stepAgents(request: { body: unknown }): MockTurn | undefined {
    const chat = body(request);
    if (!chat) return undefined;
    const agent = agentOf(chat);
    if (chat.messages.at(-1)?.role === 'tool') {
        return agent === 'Coder' && lastCall(chat) === 'bash'
            ? call({ name: 'step_result', arguments: { summary: 'built' } })
            : say('done');
    }
    return agent === 'Coder'
        ? call({ name: 'bash', arguments: { command: BUILD } })
        : call({ name: 'step_result', arguments: { summary: `${agent}: done` } });
}

async function runDone(ui: Ui, runId: string) {
    return waitFor(async () => {
        const run = await ui.request('workflow.get', { runId });
        return ['completed', 'failed', 'cancelled'].includes(run.status) ? run : undefined;
    }, `run ${runId}`);
}

/** The run's step threads by step id: their modes. */
async function stepModes(ui: Ui, runId: string): Promise<Record<string, string>> {
    const threads = await ui.request('thread.list', { includeArchived: true });
    return Object.fromEntries(
        threads
            .filter((thread) => thread.workflowRunId === runId && thread.taskId)
            .map((thread) => [thread.taskId, thread.mode]),
    );
}

describe('workflow run permissions', () => {
    it('gives the steps the permissions the run starts with; read-only agents stay read-only', async () => {
        server.respondWith(stepAgents);
        const { ui, repo, project, settings } = await setUp({ '.xora/workflows/modes.yaml': MODES });
        const seen = approveAll(ui);
        await ui.request('project.trust', { projectId: project.id, trusted: true });

        const run = await ui.request('workflow.start', { projectId: project.id, key: 'project:modes', mode: 'full' });
        expect(run.mode).toBe('full');
        // The next run starts from it.
        expect(settings.at(-1)?.lastChoices.workflowMode).toBe('full');
        const done = await runDone(ui, run.id);
        expect(done.status).toBe('completed');
        // Only the human gate asked: the coder's command and the script step ran with full access.
        expect(seen.map((approval) => approval.toolName)).toEqual(['workflow_gate']);
        expect(existsSync(path.join(repo, 'built.txt')) && existsSync(path.join(repo, 'script.txt'))).toBe(true);
        expect(await stepModes(ui, run.id)).toEqual({ build: 'full', check: 'plan', docs: 'full' });
        // Its threads are the run's, not the user's: the default mode stays.
        expect((await ui.request('settings.get', {})).defaultMode).toBe('ask');
    }, 120_000);

    it('lets every agent edit with auto edit, sub-workflows included, and keeps read-only agents read-only', async () => {
        server.respondWith(stepAgents);
        const { ui, project } = await setUp({
            '.xora/workflows/edits.yaml': EDITS,
            '.xora/workflows/child.yaml': CHILD,
        });
        approveAll(ui);
        await ui.request('project.trust', { projectId: project.id, trusted: true });

        const run = await ui.request('workflow.start', {
            projectId: project.id,
            key: 'project:edits',
            mode: 'auto_edit',
        });
        const done = await runDone(ui, run.id);
        expect(done.status).toBe('completed');
        expect(await stepModes(ui, run.id)).toEqual({ fix: 'auto_edit', look: 'plan' });
        const childId = done.steps.find((step) => step.id === 'sub')?.childRunId as string;
        expect((await ui.request('workflow.get', { runId: childId })).mode).toBe('auto_edit');
        expect(await stepModes(ui, childId)).toEqual({ again: 'auto_edit' });
    }, 120_000);

    it('reaches a live run: the waiting calls of its working steps and the steps after, not its own cards', async () => {
        server.respondWith(stepAgents);
        const { ui, repo, project, settings } = await setUp({ '.xora/workflows/modes.yaml': MODES });
        const seen = approveAll(ui, [], new Set(['bash', 'workflow_gate']));
        await ui.request('project.trust', { projectId: project.id, trusted: true });

        const run = await ui.request('workflow.start', { projectId: project.id, key: 'project:modes' });
        expect(run.mode).toBe('default');
        const gate = await waitFor(() => seen.find((approval) => approval.toolName === 'workflow_gate'), 'gate card');
        const command = await waitFor(() => seen.find((approval) => approval.toolName === 'bash'), 'coder command');
        expect((await ui.request('thread.read', { threadId: command.threadId })).thread).toMatchObject({
            workflowRunId: run.id,
            taskId: 'build',
            mode: 'auto_edit',
        });

        // The run's own thread is not the user's: switching it is not remembered, and its gate keeps waiting.
        await ui.request('thread.update', { threadId: run.threadId, mode: 'full' });
        expect((await ui.request('approval.list', {})).map((approval) => approval.id).sort()).toEqual(
            [gate.id, command.id].sort(),
        );

        const changed = await ui.request('workflow.setMode', { runId: run.id, mode: 'full' });
        expect(changed.mode).toBe('full');
        expect((await ui.request('approval.list', {})).map((approval) => approval.id)).toEqual([gate.id]);
        await waitFor(async () => {
            const current = await ui.request('workflow.get', { runId: run.id });
            return current.steps.find((step) => step.id === 'script')?.status === 'succeeded' ? true : undefined;
        }, 'script step');
        await ui.request('approval.respond', { approvalId: gate.id, decision: 'allow_once' });
        const done = await runDone(ui, run.id);
        expect(done).toMatchObject({ status: 'completed', mode: 'full' });

        // The coder's command went ahead without an answer; the steps after ran with full access, the script step
        // without a card; the reviewer stayed read-only.
        expect(existsSync(path.join(repo, 'built.txt')) && existsSync(path.join(repo, 'script.txt'))).toBe(true);
        expect(seen.map((approval) => approval.toolName).sort()).toEqual(['bash', 'workflow_gate']);
        expect(await stepModes(ui, run.id)).toEqual({ build: 'full', check: 'plan', docs: 'full' });
        const coder = await ui.request('thread.read', { threadId: command.threadId });
        expect(coder.events.some((event) => event.kind === 'thread.config')).toBe(true);
        expect(approvalItems(coder.events)).toEqual([
            expect.objectContaining({
                approvalId: command.id,
                status: 'allowed',
                decision: 'allow_once',
                decidedBy: 'policy',
                message: '全权模式',
            }),
        ]);
        const own = await ui.request('thread.read', { threadId: run.threadId });
        expect(approvalItems(own.events)).toEqual([
            expect.objectContaining({ approvalId: gate.id, status: 'allowed', decidedBy: 'user' }),
        ]);
        expect(
            own.events.some(
                (event) =>
                    event.kind === 'item.completed' &&
                    (event.payload as { item: Item }).item.type === 'notice' &&
                    (event.payload as { item: ItemOf<'notice'> }).item.title === '权限改为全权',
            ),
        ).toBe(true);

        // Picked for this run, so the next one starts from it; the default thread mode did not move.
        expect(settings.map((next) => [next.defaultMode, next.lastChoices.workflowMode])).toEqual([['ask', 'full']]);
        await expect(ui.request('workflow.setMode', { runId: run.id, mode: 'auto_edit' })).rejects.toThrow(
            '运行已经结束，不能再改权限',
        );
    }, 120_000);

    it("lets a command waiting on the run's own thread go ahead once the run gets full access", async () => {
        const { ui, repo, project } = await setUp({
            '.xora/workflows/command.yaml': `
name: command
steps:
  - id: write
    run: |-
      node -e "require('fs').writeFileSync('command.txt','ok')"
`,
        });
        const seen = approveAll(ui, [], new Set(['workflow_command']));
        await ui.request('project.trust', { projectId: project.id, trusted: true });

        const run = await ui.request('workflow.start', { projectId: project.id, key: 'project:command' });
        const card = await waitFor(() => seen.find((approval) => approval.toolName === 'workflow_command'), 'card');
        expect(existsSync(path.join(repo, 'command.txt'))).toBe(false);
        await ui.request('workflow.setMode', { runId: run.id, mode: 'full' });

        expect(await runDone(ui, run.id)).toMatchObject({ status: 'completed', mode: 'full' });
        expect(readFileSync(path.join(repo, 'command.txt'), 'utf8')).toBe('ok');
        const own = await ui.request('thread.read', { threadId: run.threadId });
        expect(approvalItems(own.events)).toEqual([
            expect.objectContaining({ approvalId: card.id, status: 'allowed', decidedBy: 'policy' }),
        ]);
    }, 60_000);
});

// Threads -------------------------------------------------------------------------------------------------------

/** Writes the file named in the latest request ("写hello.txt"), then says so. */
function fileWriter(request: { body: unknown }): MockTurn | undefined {
    const chat = body(request);
    if (!chat) return undefined;
    if (chat.messages.at(-1)?.role === 'tool') {
        return say('written');
    }
    const asked = textOf([...chat.messages].reverse().find((message) => message.role === 'user')?.content);
    const file = /写(\S+)/.exec(asked)?.[1] ?? 'hello.txt';
    return call({ name: 'write', arguments: { path: file, content: 'hi\n' } });
}

describe('thread modes', () => {
    it('settles a waiting call when the thread switches to a mode that decides it', async () => {
        server.respondWith(fileWriter);
        const { ui, repo, project, settings } = await setUp();
        const seen = approveAll(ui, [], new Set(['write']));
        const thread = await ui.request('thread.create', { projectId: project.id });
        expect(thread.mode).toBe('ask');

        await ui.request('turn.start', { threadId: thread.id, text: '写hello.txt' });
        const first = await waitFor(() => seen[0], 'the first card');
        await ui.request('thread.update', { threadId: thread.id, mode: 'full' });
        await turnsDone(ui, thread.id);
        expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi\n');

        // Plan mode refuses a waiting edit with its reason.
        await ui.request('thread.update', { threadId: thread.id, mode: 'ask' });
        await ui.request('turn.start', { threadId: thread.id, text: '写bye.txt' });
        const second = await waitFor(() => seen[1], 'the second card');
        await ui.request('thread.update', { threadId: thread.id, mode: 'plan' });
        const snapshot = await turnsDone(ui, thread.id, 2);
        expect(existsSync(path.join(repo, 'bye.txt'))).toBe(false);
        expect(approvalItems(snapshot.events)).toEqual([
            expect.objectContaining({
                approvalId: first.id,
                status: 'allowed',
                decision: 'allow_once',
                decidedBy: 'policy',
                message: '全权模式',
            }),
            expect.objectContaining({
                approvalId: second.id,
                status: 'denied',
                decision: 'deny',
                decidedBy: 'policy',
                message: '计划模式不修改文件',
            }),
        ]);
        expect(await ui.request('approval.list', {})).toEqual([]);
        // Each switch of the user's own thread is the next thread's default.
        expect(settings.map((next) => next.defaultMode)).toEqual(['full', 'ask', 'plan']);
    }, 60_000);

    it('starts new threads in the mode picked last; team, workflow and subagent threads do not count', async () => {
        const { ui, core, project, settings } = await setUp();
        const picked = await ui.request('thread.create', { projectId: project.id, mode: 'auto_edit' });
        expect(picked.mode).toBe('auto_edit');
        expect(settings.map((next) => next.defaultMode)).toEqual(['auto_edit']);
        const next = await ui.request('thread.create', { projectId: project.id });
        expect(next.mode).toBe('auto_edit');
        await ui.request('thread.update', { threadId: next.id, mode: 'full' });
        expect((await ui.request('settings.get', {})).defaultMode).toBe('full');
        // Picking the mode the default already has tells the windows nothing new.
        await ui.request('thread.update', { threadId: picked.id, mode: 'full' });
        expect(settings).toHaveLength(2);

        const owned = [
            { teamRunId: 'team-x', role: 'executor' },
            { workflowRunId: 'wf-x', role: 'workflow' },
            { parent: { threadId: picked.id, turnId: 'turn-x' } },
        ];
        for (const extra of owned) {
            const thread = core.threads.create({
                projectId: project.id,
                title: 'owned',
                engine: 'xora',
                model: null,
                mode: 'plan',
                effort: 'medium',
                extra,
            });
            const updated = await ui.request('thread.update', { threadId: thread.id, mode: 'ask' });
            expect(updated.mode).toBe('ask');
        }
        expect((await ui.request('settings.get', {})).defaultMode).toBe('full');
        expect(settings).toHaveLength(2);
    });
});

// Team runs -----------------------------------------------------------------------------------------------------

describe('team runs', () => {
    it('start from how the user started the last one', async () => {
        server.respondWith((request) => (body(request) ? say('ok') : undefined));
        const { ui, project, settings } = await setUp();
        expect((await ui.request('settings.get', {})).lastChoices).toEqual({
            teamAutonomy: 'L1',
            teamMode: 'standard',
            teamBudget: null,
            workflowMode: 'default',
        });
        // A run that does not start remembers nothing.
        await expect(
            ui.request('team.start', { projectId: project.id, goal: '没有预算', autonomy: 'L3' }),
        ).rejects.toThrow('L3 needs a budget');
        expect(settings).toEqual([]);

        const first = await ui.request('team.start', {
            projectId: project.id,
            goal: '查一查',
            autonomy: 'L2',
            mode: 'hypotheses',
            budget: 5,
        });
        expect(settings.at(-1)?.lastChoices).toEqual({
            teamAutonomy: 'L2',
            teamMode: 'hypotheses',
            teamBudget: 5,
            workflowMode: 'default',
        });
        await ui.request('team.stop', { runId: first.id });
        const second = await ui.request('team.start', { projectId: project.id, goal: '再查一查', autonomy: 'L1' });
        expect(settings.at(-1)?.lastChoices).toEqual({
            teamAutonomy: 'L1',
            teamMode: 'standard',
            teamBudget: null,
            workflowMode: 'default',
        });
        await ui.request('team.stop', { runId: second.id });
        // The supervisor threads are the runs': the default thread mode stays.
        expect(settings.every((next) => next.defaultMode === 'ask')).toBe(true);
    }, 60_000);
});

// Writing workflows ---------------------------------------------------------------------------------------------

describe('writing workflows', () => {
    it('distills a thread in the mode the user works in', async () => {
        const draft = 'name: greet\nsteps:\n  - id: hello\n    agent: writer\n    task: say hello\n';
        server.respondWith((request) => {
            const chat = body(request);
            if (!chat) return undefined;
            if (!userText(chat).includes('<thread_transcript')) return say('hello there');
            return writeWorkflow(chat, '.xora/workflows/greet.yaml', draft);
        });
        const { ui, repo, project } = await setUp();
        const seen = approveAll(ui);
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'auto_edit' });
        await ui.request('turn.start', { threadId: thread.id, text: '打个招呼' });
        await turnsDone(ui, thread.id);

        const distilled = await ui.request('thread.distill', { threadId: thread.id, kind: 'workflow' });
        expect(distilled).toMatchObject({ role: 'distill', mode: 'auto_edit' });
        const done = await turnsDone(ui, distilled.id);
        // Auto edit: the file is written without a card.
        expect(seen).toEqual([]);
        expect(readFileSync(path.join(repo, '.xora', 'workflows', 'greet.yaml'), 'utf8')).toBe(draft);
        expect(done.events.map((event) => event.kind)).toContain('turn.completed');
    }, 60_000);

    it('writes a new workflow from what the user describes', async () => {
        const draft = 'name: morning\nsteps:\n  - id: test\n    run: npm test\n';
        server.respondWith((request) => {
            const chat = body(request);
            return chat ? writeWorkflow(chat, '.xora/workflows/morning.yaml', draft) : undefined;
        });
        const { ui, repo, project } = await setUp();
        const seen = approveAll(ui);
        await expect(ui.request('workflow.draft', { projectId: project.id, description: ' \n ' })).rejects.toThrow(
            '先描述要写成工作流的流程',
        );

        const thread = await ui.request('workflow.draft', {
            projectId: project.id,
            description: '每天早上跑一遍测试，\n失败就告诉我',
        });
        expect(thread).toMatchObject({
            role: 'distill',
            mode: 'ask',
            title: '新工作流：每天早上跑一遍测试， 失败就告诉我',
            model: { model: 'deepseek-flash' },
        });
        const done = await turnsDone(ui, thread.id);
        // Ask mode: the user saw the file in a card before it existed.
        expect(seen.map((approval) => approval.toolName)).toEqual(['write']);
        expect(readFileSync(path.join(repo, '.xora', 'workflows', 'morning.yaml'), 'utf8')).toBe(draft);
        const first = server.requests
            .map((request) => body(request))
            .find((chat) => chat && userText(chat).includes('<request>')) as ChatBody;
        expect(userText(first)).toContain('<request>\n每天早上跑一遍测试，\n失败就告诉我\n</request>');
        expect(userText(first)).toContain('工作流看板');
        expect(first.tools?.map((tool) => tool.function.name)).toContain('workflow_check');
        const messages = done.events
            .filter((event) => event.kind === 'item.completed')
            .map((event) => (event.payload as { item: Item }).item)
            .filter((item) => item.type === 'agent_message');
        expect(messages.at(-1)).toMatchObject({ text: 'checked: OK: test(script)' });
        const [info] = await ui.request('workflow.list', { projectId: project.id });
        expect(info).toMatchObject({ key: 'project:morning', steps: [{ id: 'test', type: 'script' }] });
    }, 60_000);

    it('leaves no empty thread behind when the draft cannot start', async () => {
        const { ui } = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-modes-data-')));
        const project = await ui.request('project.add', { path: gitRepo() });
        await expect(
            ui.request('workflow.draft', { projectId: project.id, description: '每周清理合并过的分支' }),
        ).rejects.toThrow('还没有选择模型');
        expect(await ui.request('thread.list', { projectId: project.id })).toEqual([]);
    });
});
