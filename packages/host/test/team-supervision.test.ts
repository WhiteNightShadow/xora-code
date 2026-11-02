import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, type MockTurn, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
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
    options: { permission?: 'default' | 'auto_edit' | 'full'; hold?: ReadonlySet<string> } = {},
) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-supervision-data-'));
    const { ui } = await host.start(dataDir);
    const seen = approveAll(ui, [], options.hold);
    await connectMock(ui, server);
    const repo = gitRepo();
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
    it('reviews a partial stage and lets the same member finish it with the guidance', async () => {
        server.reset();
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            const last = body.messages.at(-1);
            switch (agentOf(body)) {
                case 'Supervisor': {
                    if (last?.role === 'tool') {
                        return say(lastCall(body) === 'task_guide' ? 'Guided T1.' : 'Planned.');
                    }
                    if (textOf(last?.content).includes('<team_goal>')) {
                        return call({ name: 'task_create', arguments: { tasks: [card(BOTH, ['a.txt', 'b.txt'])] } });
                    }
                    if (textOf(last?.content).includes('Stage review of T1')) {
                        return call({
                            name: 'task_guide',
                            arguments: { taskId: 'T1', decision: 'continue', guidance: 'Now write b.txt with "two".' },
                        });
                    }
                    return say('Noted.');
                }
                case 'Coder': {
                    const second = userText(body).includes('Stage 1 of T1 is reviewed.');
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
                    return second
                        ? call({ name: 'write', arguments: { path: 'b.txt', content: 'two\n' } })
                        : call({ name: 'write', arguments: { path: 'a.txt', content: 'one\n' } });
                }
                default:
                    return say('ok');
            }
        });

        const { repo, done } = await startRun('写a.txt和b.txt');
        expect(done.status).toBe('done');
        const task = done.tasks[0];
        expect(task).toMatchObject({ id: 'T1', status: 'done', stage: 2, attempts: 1 });
        expect(task?.guidance).toBe('Now write b.txt with "two".');
        expect(existsSync(path.join(repo, 'a.txt')) && existsSync(path.join(repo, 'b.txt'))).toBe(true);

        const requests = server.requests.map((request) => request.body as ChatBody);
        const review = requests.find(
            (body) => agentOf(body) === 'Supervisor' && lastText(body).includes('Stage review of T1'),
        );
        expect(lastText(review as ChatBody)).toContain('Stage review of T1 (stage 1');
        expect(lastText(review as ChatBody)).toContain('Acceptance commands: 0 of 1 pass.');
        expect(lastText(review as ChatBody)).toContain('- write b.txt');
        // The second stage runs in the same thread: its request still holds the card and the first write.
        const next = requests.find(
            (body) => agentOf(body) === 'Coder' && lastText(body).includes('Stage 1 of T1 is reviewed.'),
        );
        expect(lastText(next as ChatBody)).toContain('From the supervisor: Now write b.txt with "two".');
        expect(userText(next as ChatBody)).toContain('<task_card id="T1"');
        expect(JSON.stringify(next?.messages)).toContain('a.txt');

        expect(done.conversation?.map((entry) => [entry.from, entry.to, entry.kind, entry.text])).toEqual([
            ['T1', 'supervisor', 'stage', '第1阶段：wrote a.txt（还剩1项）'],
            ['supervisor', 'T1', 'guide', 'continue: Now write b.txt with "two".'],
        ]);
        // The turn that only reviewed the stage is not feedback to the user.
        expect(done.feedback?.map((entry) => entry.text)).not.toContain('Guided T1.');
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
});
