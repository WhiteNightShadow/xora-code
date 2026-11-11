import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, type MockTurn, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_REQUESTS } from '../src/team-agents.ts';
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
    USAGE,
    userText,
    waitFor,
} from './harness.ts';

/**
 * The supervision loop (06 §20), headless against a scripted model: a member hands in part of its card, the
 * supervisor reviews the stage with task_guide and the member finishes in the same thread; and a member that
 * repeats itself is reported by the host's watch, and the supervisor's guidance reaches it at its next step.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

const BOTH = `node -e "const f=require('fs');process.exit(f.existsSync('a.txt')&&f.existsSync('b.txt')?0:1)"`;
const ONLY_A = `node -e "process.exit(require('fs').existsSync('a.txt')?0:1)"`;
const STEER = 'From the supervisor: Stop reading; write a.txt.';

function card(acceptance: string, ownership: string[]) {
    return {
        id: 'T1',
        title: 'Write the files',
        goal: 'The files exist',
        category: 'coding',
        tier: 'economy',
        ownership,
        acceptance: [{ type: 'command', run: acceptance }],
        deliverable: { kind: 'code-change' },
        budget: { cost: 2 },
        workspace: 'worktree',
    };
}

/** The last message of a request, as the model sees it. */
function lastText(body: ChatBody): string {
    return textOf(body.messages.at(-1)?.content);
}

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }, { id: 'deepseek-flash' }] });
}, 60_000);

afterEach(() => host.closeAll());

afterAll(async () => {
    await server?.close();
});

async function startRun(
    goal: string,
    options: {
        permission?: 'default' | 'auto_edit' | 'full';
        hold?: ReadonlySet<string>;
        /** Runs on the project before the run starts, e.g. to leave uncommitted changes. */
        prepare?: (repo: string) => void;
    } = {},
) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-supervision-data-'));
    const { ui } = await host.start(dataDir);
    const seen = approveAll(ui, [], options.hold);
    await connectMock(ui, server);
    const repo = gitRepo();
    options.prepare?.(repo);
    const project = await ui.request('project.add', { path: repo });
    const started = await ui.request('team.start', {
        projectId: project.id,
        goal,
        autonomy: 'L2',
        budget: 50,
        ...(options.permission ? { permission: options.permission } : {}),
    });
    const done = await waitFor(
        async () => {
            const run = await ui.request('team.get', { runId: started.id });
            return ['done', 'failed', 'cancelled', 'paused'].includes(run.status) ? run : undefined;
        },
        'run done',
        90_000,
    );
    return { ui, repo, done, seen, started };
}

/** A coder that writes a.txt with a shell command, then hands it in. */
function shellCoder(body: ChatBody): MockTurn {
    const last = body.messages.at(-1);
    if (last?.role === 'tool' && lastCall(body) === 'bash') {
        return call({
            name: 'deliver',
            arguments: {
                status: 'done',
                summary: 'wrote a.txt',
                changes: [{ file: 'a.txt', kind: 'added' }],
                evidence: [{ type: 'diff' }],
            },
        });
    }
    if (last?.role === 'tool') {
        return say('Handed in.');
    }
    return call({
        name: 'bash',
        arguments: { command: `node -e "require('fs').writeFileSync('a.txt','one\\n')"` },
    });
}

describe('supervision loop', () => {
    it('lets a member that moved forward go on at once while the supervisor reads the stage on the side', async () => {
        server.reset();
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (textOf(body.messages[0]?.content).includes('现在向下达任务的人交付结果')) {
                return say(
                    '## 目标达成\n已达成：两个文件都写好了。\n## 已完成\n- a.txt和b.txt（`a.txt`、`b.txt`）\n## 下一步\n- 无',
                );
            }
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor': {
                    if (last?.role === 'tool') {
                        return say('Planned.');
                    }
                    if (textOf(last?.content).includes('<team_goal>')) {
                        return call({ name: 'task_create', arguments: { tasks: [card(BOTH, ['a.txt', 'b.txt'])] } });
                    }
                    return say(textOf(last?.content).includes('Stage report of T1') ? 'Saw the stage.' : 'Noted.');
                }
                case 'Coder': {
                    const second = userText(body).includes('Stage 1 of T1 is recorded');
                    if (last?.role === 'tool') {
                        if (lastCall(body) === 'write') {
                            return call({
                                name: 'deliver',
                                arguments: second
                                    ? {
                                          status: 'done',
                                          summary: 'wrote b.txt',
                                          changes: [{ file: 'b.txt', kind: 'added' }],
                                          evidence: [{ type: 'diff' }],
                                      }
                                    : {
                                          status: 'partial',
                                          summary: 'wrote a.txt',
                                          changes: [{ file: 'a.txt', kind: 'added' }],
                                          evidence: [{ type: 'diff' }],
                                          remaining: ['write b.txt'],
                                      },
                            });
                        }
                        return say('Handed in.');
                    }
                    // The second stage takes a while, so the stage reaches the supervisor on its own.
                    return second
                        ? { ...call({ name: 'write', arguments: { path: 'b.txt', content: 'two\n' } }), delayMs: 1500 }
                        : call({ name: 'write', arguments: { path: 'a.txt', content: 'one\n' } });
                }
                default:
                    return say('ok');
            }
        });

        const { ui, repo, done } = await startRun('写a.txt和b.txt');
        expect(done.status).toBe('done');
        const task = done.tasks[0];
        expect(task).toMatchObject({ id: 'T1', status: 'done', stage: 2, attempts: 1 });
        expect(task?.guidance).toBeUndefined();
        expect(existsSync(path.join(repo, 'a.txt')) && existsSync(path.join(repo, 'b.txt'))).toBe(true);

        const requests = server.requests.map((request) => request.body as ChatBody);
        // 06 §29: the stage goes to the supervisor on the side; the member does not wait for a decision.
        const report = requests.find(
            (body) => agentOf(body) === 'Supervisor' && lastText(body).includes('Stage report of T1'),
        ) as ChatBody;
        expect(lastText(report)).toContain('Stage report of T1 (stage 1');
        expect(lastText(report)).toContain('Acceptance commands: 0 of 1 pass.');
        expect(lastText(report)).toContain('- write b.txt');
        expect(lastText(report)).toContain('goes on now, without waiting for you');
        // Woken after the plan stands, it starts from the state of the run instead of its earlier turns.
        expect(JSON.stringify(report.messages)).toContain('<run_state>');
        expect(JSON.stringify(report.messages)).toContain('- T1 [');
        expect(JSON.stringify(report.messages)).not.toContain('<team_goal>');
        // The second stage runs in the same thread: its request still holds the card and the first write.
        const next = requests.find(
            (body) => agentOf(body) === 'Coder' && lastText(body).includes('Stage 1 of T1 is recorded'),
        ) as ChatBody;
        expect(lastText(next)).toContain('Still to do: write b.txt.');
        expect(userText(next)).toContain('<task_card id="T1"');
        expect(JSON.stringify(next.messages)).toContain('a.txt');

        expect(done.conversation?.map((entry) => [entry.from, entry.to, entry.kind, entry.text])).toEqual([
            ['T1', 'supervisor', 'stage', '第1阶段：wrote a.txt（还剩1项）'],
        ]);
        // The turn that only read the stage is not feedback to the user.
        expect(done.feedback?.map((entry) => entry.text)).not.toContain('Saw the stage.');
        // 06 §22: once over, the supervisor's model writes the report: outcome, done, next steps, from the record.
        const reported = await waitFor(async () => {
            const run = await ui.request('team.get', { runId: done.id });
            return run.brief?.status === 'ready' ? run : undefined;
        }, 'the report');
        expect(reported.brief?.text).toContain('## 目标达成');
        const material = server.requests
            .map((request) => request.body as ChatBody)
            .find((body) => textOf(body?.messages?.[0]?.content).includes('现在向下达任务的人交付结果'));
        expect(userText(material as ChatBody)).toContain('- T1 Write the files: done');
        expect(userText(material as ChatBody)).toContain('result: wrote b.txt');
        expect(reported.report).toContain('# 交付报告');
    }, 120_000);

    it('waits for the supervisor on a stage without progress, and a stuck hands-off run ends with what is done', async () => {
        server.reset();
        const only = (file: string) => `node -e "process.exit(require('fs').existsSync('${file}')?0:1)"`;
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (textOf(body.messages[0]?.content).includes('现在向下达任务的人交付结果')) {
                return say(
                    '## 目标达成\n达成一部分：a.txt写好了。\n## 已完成\n- a.txt（`a.txt`）\n## 下一步\n- 换个办法写b.txt',
                );
            }
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor': {
                    if (last?.role === 'tool') {
                        return say(lastCall(body) === 'task_guide' ? 'Stopped T2.' : 'Planned.');
                    }
                    const said = textOf(last?.content);
                    if (said.includes('<team_goal>')) {
                        return call({
                            name: 'task_create',
                            arguments: {
                                tasks: [
                                    { ...card(only('a.txt'), ['a.txt']), id: 'T1', title: 'Write a.txt' },
                                    { ...card(only('b.txt'), ['b.txt']), id: 'T2', title: 'Write b.txt' },
                                ],
                            },
                        });
                    }
                    if (said.includes('Stage review of T2')) {
                        return call({
                            name: 'task_guide',
                            arguments: { taskId: 'T2', decision: 'stop', guidance: 'b.txt cannot be written here.' },
                        });
                    }
                    if (said.includes('No card can go on')) {
                        return say('a.txt写好了；b.txt在这里写不了，要换个目录。');
                    }
                    return say('Noted.');
                }
                case 'Coder': {
                    const second = userText(body).includes('<task_card id="T2"');
                    if (second) {
                        return last?.role === 'tool'
                            ? say('Handed in.')
                            : call({
                                  name: 'deliver',
                                  arguments: {
                                      status: 'partial',
                                      summary: 'could not write b.txt',
                                      remaining: ['write b.txt'],
                                  },
                              });
                    }
                    if (last?.role === 'tool') {
                        return lastCall(body) === 'write'
                            ? call({
                                  name: 'deliver',
                                  arguments: {
                                      status: 'done',
                                      summary: 'wrote a.txt',
                                      changes: [{ file: 'a.txt', kind: 'added' }],
                                      evidence: [{ type: 'diff' }],
                                  },
                              })
                            : say('Handed in.');
                    }
                    return call({ name: 'write', arguments: { path: 'a.txt', content: 'one\n' } });
                }
                default:
                    return say('ok');
            }
        });

        const { ui, repo, done } = await startRun('写a.txt和b.txt');
        // 06 §29: nobody watches an L2 run, so it ends with what it finished instead of waiting.
        expect(done.status).toBe('done');
        expect(done.note).toContain('部分完成');
        expect(done.note).toContain('T2');
        expect(done.tasks.map((task) => [task.id, task.status])).toEqual([
            ['T1', 'done'],
            ['T2', 'blocked'],
        ]);
        expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
        expect(existsSync(path.join(repo, 'b.txt'))).toBe(false);

        const requests = server.requests.map((request) => request.body as ChatBody);
        // A stage without progress still waits for the supervisor's decision.
        expect(
            requests.some((body) => agentOf(body) === 'Supervisor' && lastText(body).includes('Stage review of T2')),
        ).toBe(true);
        const asked = requests.find(
            (body) => agentOf(body) === 'Supervisor' && lastText(body).includes('No card can go on'),
        ) as ChatBody;
        expect(lastText(asked)).toContain('T2 (blocked)');
        expect(lastText(asked)).toContain('Nobody watches this run (autonomy L2)');
        // Its answer is what it tells the user, and goes into the report.
        expect(done.feedback?.map((entry) => entry.text)).toContain('a.txt写好了；b.txt在这里写不了，要换个目录。');
        const reported = await waitFor(async () => {
            const run = await ui.request('team.get', { runId: done.id });
            return run.brief?.status === 'ready' ? run : undefined;
        }, 'the report');
        expect(reported.brief?.text).toContain('换个办法写b.txt');
        const material = requests.find((body) =>
            textOf(body?.messages?.[0]?.content).includes('现在向下达任务的人交付结果'),
        );
        const lastMaterial = server.requests
            .map((request) => request.body as ChatBody)
            .filter((body) => textOf(body?.messages?.[0]?.content).includes('现在向下达任务的人交付结果'))
            .at(-1);
        expect(userText((lastMaterial ?? material) as ChatBody)).toContain('- T2 Write b.txt: blocked');
    }, 120_000);

    it('reports a member that repeats itself and steers it at its next step', async () => {
        server.reset();
        let reads = 0;
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor': {
                    if (last?.role === 'tool') {
                        return say(lastCall(body) === 'task_guide' ? 'Steered T1.' : 'Planned.');
                    }
                    if (textOf(last?.content).includes('<team_goal>')) {
                        return call({ name: 'task_create', arguments: { tasks: [card(ONLY_A, ['a.txt'])] } });
                    }
                    if (textOf(last?.content).includes('Watch: coder-T1 on T1 made the same call')) {
                        return call({
                            name: 'task_guide',
                            arguments: { taskId: 'T1', decision: 'continue', guidance: 'Stop reading; write a.txt.' },
                        });
                    }
                    return say('Noted.');
                }
                case 'Coder': {
                    if (last?.role === 'user' && textOf(last.content).includes(STEER)) {
                        return call({ name: 'write', arguments: { path: 'a.txt', content: 'one\n' } });
                    }
                    if (last?.role === 'tool' && lastCall(body) === 'write') {
                        return call({
                            name: 'deliver',
                            arguments: {
                                status: 'done',
                                summary: 'wrote a.txt',
                                changes: [{ file: 'a.txt', kind: 'added' }],
                                evidence: [{ type: 'diff' }],
                            },
                        });
                    }
                    if (last?.role === 'tool' && lastCall(body) === 'deliver') {
                        return say('Handed in.');
                    }
                    // Goes round in circles until someone steers it; slow enough for the supervisor to answer.
                    reads += 1;
                    return openaiToolCalls([{ name: 'read', arguments: { path: 'README.md' } }], {
                        usage: USAGE,
                        delayMs: 40,
                    }) as MockTurn;
                }
                default:
                    return say('ok');
            }
        });

        const { ui, done } = await startRun('写a.txt');
        expect(done.status).toBe('done');
        expect(done.tasks[0]).toMatchObject({ id: 'T1', status: 'done', guidance: 'Stop reading; write a.txt.' });
        expect(reads).toBeGreaterThanOrEqual(3);
        expect(reads).toBeLessThan(60);
        expect(done.conversation?.map((entry) => [entry.from, entry.to, entry.kind, entry.text])).toEqual([
            ['host', 'T1', 'watch', '巡检：coder-T1连续3次做了一模一样的调用'],
            ['supervisor', 'T1', 'guide', 'continue: Stop reading; write a.txt.'],
        ]);
        const requests = server.requests.map((request) => request.body as ChatBody);
        const watch = requests.find(
            (body) => agentOf(body) === 'Supervisor' && lastText(body).includes('Watch: coder-T1 on T1'),
        );
        expect(lastText(watch as ChatBody)).toContain('Its last steps:');
        expect(lastText(watch as ChatBody)).toContain('read {"path":"README.md"} → completed');
        // The guidance arrived inside the running turn, after a tool result, and shows in the member's thread.
        const steered = requests.find((body) => agentOf(body) === 'Coder' && lastText(body).includes(STEER));
        expect(steered?.messages.at(-2)?.role).toBe('tool');
        const threadId = done.tasks[0]?.threadId as string;
        const read = await ui.request('thread.read', { threadId });
        expect(JSON.stringify(read.events)).toContain(STEER);
        expect(done.feedback?.map((entry) => entry.text)).not.toContain('Steered T1.');
    }, 120_000);

    it('lets members act without a card by default; high-risk actions are not involved', async () => {
        server.reset();
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor':
                    if (last?.role !== 'tool' && textOf(last?.content).includes('<team_goal>')) {
                        return call({ name: 'task_create', arguments: { tasks: [card(ONLY_A, ['a.txt'])] } });
                    }
                    return say('Noted.');
                case 'Coder':
                    return shellCoder(body);
                default:
                    return say('ok');
            }
        });
        const { repo, done, seen, started } = await startRun('写a.txt');
        expect(started.permission).toBe('full');
        expect(done.status).toBe('done');
        expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
        // The member's command needed no card; only the delivery of an L2 run asks the user.
        expect(seen.filter((approval) => approval.toolName === 'bash')).toEqual([]);
    }, 120_000);

    it('has the supervisor approve a member’s ordinary command when members only edit files', async () => {
        server.reset();
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor': {
                    if (last?.role === 'tool') {
                        return say(lastCall(body) === 'approval_decide' ? 'Approved.' : 'Planned.');
                    }
                    const input = textOf(last?.content);
                    if (input.includes('<team_goal>')) {
                        return call({ name: 'task_create', arguments: { tasks: [card(ONLY_A, ['a.txt'])] } });
                    }
                    const asked = /Approval request (\S+):/.exec(input);
                    if (asked) {
                        return call({
                            name: 'approval_decide',
                            arguments: { approvalId: asked[1], decision: 'allow', reason: 'the card needs a.txt' },
                        });
                    }
                    return say('Noted.');
                }
                case 'Coder':
                    return shellCoder(body);
                default:
                    return say('ok');
            }
        });
        // The user never answers the member's command: the supervisor does.
        const { ui, repo, done, seen } = await startRun('写a.txt', {
            permission: 'auto_edit',
            hold: new Set(['bash']),
        });
        expect(done.status).toBe('done');
        expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
        expect(seen.filter((approval) => approval.toolName === 'bash')).toHaveLength(1);
        expect(
            done.conversation?.filter((entry) => entry.kind === 'approval').map((entry) => [entry.from, entry.text]),
        ).toEqual([
            ['T1', `node -e "require('fs').writeFileSync('a.txt','one\\n')"`],
            ['supervisor', '主管批准：the card needs a.txt'],
        ]);
        const read = await ui.request('thread.read', { threadId: done.tasks[0]?.threadId as string });
        expect(JSON.stringify(read.events)).toContain('"decidedBy":"supervisor"');
        expect(done.feedback?.map((entry) => entry.text)).not.toContain('Approved.');
    }, 120_000);

    it('runs the members the user chose, with the model and settings set before a card starts', async () => {
        server.reset();
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor': {
                    if (last?.role === 'tool' && lastCall(body) === 'task_create') {
                        // A member the user did not choose is refused; the card goes to one who is in the run.
                        return textOf(last.content).includes('Only these members work in this run')
                            ? call({
                                  name: 'task_create',
                                  arguments: { tasks: [{ ...card(ONLY_A, ['a.txt']), assignee: 'coder' }] },
                              })
                            : say('Planned.');
                    }
                    if (last?.role !== 'tool' && textOf(last?.content).includes('<team_goal>')) {
                        return call({
                            name: 'task_create',
                            arguments: { tasks: [{ ...card(ONLY_A, ['a.txt']), assignee: 'tester' }] },
                        });
                    }
                    return say('Noted.');
                }
                case 'Coder': {
                    if (last?.role === 'tool' && lastCall(body) === 'write') {
                        return call({
                            name: 'deliver',
                            arguments: {
                                status: 'done',
                                summary: 'wrote a.txt',
                                changes: [{ file: 'a.txt', kind: 'added' }],
                                evidence: [{ type: 'diff' }],
                            },
                        });
                    }
                    if (last?.role === 'tool') return say('Handed in.');
                    return call({ name: 'write', arguments: { path: 'a.txt', content: 'one\n' } });
                }
                default:
                    return say('ok');
            }
        });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-supervision-data-'));
        const { ui } = await host.start(dataDir);
        // The plan waits for the user: the card is set while it waits.
        approveAll(ui, [], new Set(['team_plan']));
        await connectMock(ui, server);
        const repo = gitRepo();
        const project = await ui.request('project.add', { path: repo });
        const started = await ui.request('team.start', {
            projectId: project.id,
            goal: '写a.txt',
            autonomy: 'L1',
            budget: 50,
            members: [{ memberId: 'coder', model: 'kimi-k3', effort: 'low' }],
        });
        expect(started.members).toEqual([{ memberId: 'coder', name: '编码', model: 'kimi-k3', effort: 'low' }]);
        const planned = await waitFor(async () => {
            const run = await ui.request('team.get', { runId: started.id });
            return run.tasks.length > 0 ? run : undefined;
        }, 'a card');
        // Before it starts, the card shows who works it and with what.
        expect(planned.tasks[0]).toMatchObject({ memberId: 'coder', model: 'kimi-k3', effort: 'low', preset: true });
        const preset = await ui.request('team.presetTask', {
            runId: started.id,
            taskId: 'T1',
            effort: 'high',
            mode: 'auto_edit',
        });
        expect(preset.tasks[0]).toMatchObject({
            memberId: 'coder',
            model: 'kimi-k3',
            effort: 'high',
            mode: 'auto_edit',
        });
        await expect(
            ui.request('team.presetTask', { runId: started.id, taskId: 'T1', memberId: 'supervisor' }),
        ).rejects.toThrow('没有能干活的成员supervisor');
        const planCard = await waitFor(
            async () => (await ui.request('approval.list', {})).find((approval) => approval.toolName === 'team_plan'),
            'the plan card',
        );
        await ui.request('approval.respond', { approvalId: planCard.id, decision: 'allow_once' });
        const done = await waitFor(
            async () => {
                const run = await ui.request('team.get', { runId: started.id });
                return ['done', 'failed', 'cancelled', 'paused'].includes(run.status) ? run : undefined;
            },
            'run done',
            90_000,
        );
        expect(done.status).toBe('done');
        // It ran with what was set: the run's model for the member, the card's thinking level and permissions.
        expect(done.tasks[0]).toMatchObject({ memberId: 'coder', model: 'kimi-k3', effort: 'high', mode: 'auto_edit' });
        const coder = server.requests
            .map((request) => request.body as ChatBody)
            .find((body) => agentOf(body) === 'Coder');
        expect(coder?.model).toBe('kimi-k3');
        const supervisorBrief = server.requests
            .map((request) => request.body as ChatBody)
            .find((body) => agentOf(body) === 'Supervisor');
        expect(userText(supervisorBrief as ChatBody)).toContain(
            '- coder: executor (coding), model kimi-k3, thinking low',
        );
        await expect(ui.request('team.presetTask', { runId: started.id, taskId: 'T1', effort: 'low' })).rejects.toThrow(
            'T1已经开始了',
        );
    }, 120_000);
});

/** A command that passes when `file` exists in the folder it runs in. */
const exists = (file: string) => `node -e "process.exit(require('fs').existsSync('${file}')?0:1)"`;

const isReport = (body: ChatBody) => textOf(body.messages[0]?.content).includes('现在向下达任务的人交付结果');
const REPORT = '## 目标达成\n已达成。\n## 已完成\n- 文件写好了\n## 下一步\n- 无';

/** A coder that writes `file` with `content`, then hands it in as done. */
function writer(body: ChatBody, file: string, content: string): MockTurn {
    const last = body.messages.at(-1);
    if (last?.role === 'tool') {
        return lastCall(body) === 'write'
            ? call({
                  name: 'deliver',
                  arguments: {
                      status: 'done',
                      summary: `wrote ${file}`,
                      changes: [{ file, kind: 'added' }],
                      evidence: [{ type: 'diff' }],
                  },
              })
            : say('Handed in.');
    }
    return call({ name: 'write', arguments: { path: file, content } });
}

describe('a faster team (06 §29)', () => {
    it('asks a supervisor for its cards once a planning turn used its requests', async () => {
        server.reset();
        let reads = 0;
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (isReport(body)) return say(REPORT);
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor': {
                    if (last?.role === 'tool') {
                        if (lastCall(body) === 'read' && !userText(body).includes('Planning time is up')) {
                            reads++;
                            return call({ name: 'read', arguments: { path: 'README.md' } });
                        }
                        return say('Planned.');
                    }
                    const said = textOf(last?.content);
                    if (said.includes('<team_goal>')) {
                        reads++;
                        return call({ name: 'read', arguments: { path: 'README.md' } });
                    }
                    if (said.includes('Planning time is up')) {
                        return call({ name: 'task_create', arguments: { tasks: [card(ONLY_A, ['a.txt'])] } });
                    }
                    return say('Noted.');
                }
                case 'Coder':
                    return writer(body, 'a.txt', 'one\n');
                default:
                    return say('ok');
            }
        });

        const { done } = await startRun('写a.txt');
        expect(done.status).toBe('done');
        // The planning turn ended at its limit, and the host asked for the cards.
        expect(reads).toBe(PLAN_REQUESTS);
        const asked = server.requests
            .map((request) => request.body as ChatBody)
            .filter((body) => agentOf(body) === 'Supervisor' && lastText(body).includes('Planning time is up'));
        expect(asked).toHaveLength(1);
    }, 120_000);

    it("starts every worktree from the project's uncommitted changes and integrates only a card's own", async () => {
        server.reset();
        const sees = `node -e "const f=require('fs');process.exit(f.readFileSync('README.md','utf8').includes('by the user')&&f.existsSync('notes.md')&&f.existsSync('c.txt')?0:1)"`;
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (isReport(body)) return say(REPORT);
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor':
                    if (last?.role === 'tool') return say('Planned.');
                    return textOf(last?.content).includes('<team_goal>')
                        ? call({ name: 'task_create', arguments: { tasks: [card(sees, ['c.txt'])] } })
                        : say('Noted.');
                case 'Coder':
                    return writer(body, 'c.txt', 'three\n');
                default:
                    return say('ok');
            }
        });

        const { repo, done } = await startRun('写c.txt', {
            prepare: (dir) => {
                writeFileSync(path.join(dir, 'README.md'), '# demo by the user\n');
                writeFileSync(path.join(dir, 'notes.md'), 'draft\n');
            },
        });
        expect(done.status).toBe('done');
        expect(done.warnings).toContain('项目里有没提交的改动：已带进各任务的worktree，整合时只合入任务自己的改动');
        // The card's acceptance passed in its worktree, which held the user's changes; the project got only c.txt.
        expect(done.tasks[0]).toMatchObject({ id: 'T1', status: 'done', attempts: 1 });
        expect(readFileSync(path.join(repo, 'c.txt'), 'utf8')).toBe('three\n');
        expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# demo by the user\n');
        expect(readFileSync(path.join(repo, 'notes.md'), 'utf8')).toBe('draft\n');
        expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('1');
    }, 120_000);

    it('keeps each local card to its own changes while they share the project folder', async () => {
        server.reset();
        let repo = '';
        const appears = async (file: string) => {
            for (let tries = 0; tries < 400 && !existsSync(path.join(repo, file)); tries++) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        };
        server.respondWith(async (request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (isReport(body)) return say(REPORT);
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor':
                    if (last?.role === 'tool') return say('Planned.');
                    return textOf(last?.content).includes('<team_goal>')
                        ? call({
                              name: 'task_create',
                              arguments: {
                                  tasks: [
                                      { ...card(exists('a.txt'), ['a.txt']), id: 'T1', workspace: 'local' },
                                      { ...card(exists('b.txt'), ['b.txt']), id: 'T2', workspace: 'local' },
                                  ],
                              },
                          })
                        : say('Noted.');
                case 'Coder': {
                    const mine = userText(body).includes('<task_card id="T2"') ? 'b.txt' : 'a.txt';
                    // Each hands in only once the other one's file is there: both turns see both files change.
                    if (last?.role === 'tool' && lastCall(body) === 'write') {
                        await appears(mine === 'a.txt' ? 'b.txt' : 'a.txt');
                    }
                    return writer(body, mine, `${mine}\n`);
                }
                default:
                    return say('ok');
            }
        });

        const { done } = await startRun('写a.txt和b.txt', {
            prepare: (dir) => {
                repo = dir;
            },
        });
        expect(done.status).toBe('done');
        // Neither card is blamed for the other's file: both pass at their first attempt. When one is tried again (it
        // happens now and then on Windows CI only), what the coder was told says why.
        const attempts = done.tasks.map((task) => [task.id, task.status, task.attempts]);
        const told = [
            ...new Set(
                server.requests.flatMap((request) => {
                    const body = request.body as ChatBody | undefined;
                    if (!body?.messages || agentOf(body) !== 'Coder') return [];
                    // Everything after the card: the feedback of each acceptance it did not pass.
                    return body.messages
                        .filter((message) => message.role === 'user')
                        .slice(1)
                        .map((message) => textOf(message.content).slice(0, 1_500));
                }),
            ),
        ];
        expect(
            attempts,
            `the coders were told:\n${told.join('\n---\n')}\nthe deliverables: ${JSON.stringify(done.tasks.map((task) => task.deliverable))}`,
        ).toEqual([
            ['T1', 'done', 1],
            ['T2', 'done', 1],
        ]);
    }, 120_000);
});
