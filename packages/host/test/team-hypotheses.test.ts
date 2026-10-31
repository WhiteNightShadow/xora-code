import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    userText,
    waitFor,
} from './harness.ts';

/**
 * Competing hypotheses and the team conversation (06 §7, M5): the supervisor opens one read-only investigation
 * per hypothesis, one member challenges the other, the challenged member reads the challenge at its next turn,
 * and a message the user sends mid-run reaches the supervisor. The conversation keeps all of it.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

const PASS = `node -e "process.exit(0)"`;
const card = (id: string, title: string, dependsOn: string[] = []) => ({
    id,
    title,
    goal: `Confirm or refute: ${title}`,
    category: 'research',
    tier: 'fast',
    dependsOn,
    acceptance: [{ type: 'command', run: PASS }],
    deliverable: { kind: 'findings' },
    budget: { cost: 1 },
    workspace: 'readonly',
});

function supervisor(body: ChatBody): MockTurn {
    const last = body.messages.at(-1);
    if (last?.role === 'tool') {
        return say(lastCall(body) === 'task_create' ? 'Planned.' : 'Noted.');
    }
    if (textOf(last?.content).includes('<team_goal>')) {
        return call(
            {
                name: 'task_create',
                arguments: { tasks: [card('H1', 'the cache is stale'), card('H2', 'clock skew', ['H1'])] },
            },
            {
                name: 'ledger_update',
                arguments: { reason: 'hypotheses', assumptions: ['H1 the cache is stale', 'H2 clock skew'] },
            },
        );
    }
    return say('Noted.');
}

function scout(body: ChatBody): MockTurn {
    const first = textOf(body.messages.find((message) => message.role === 'user')?.content);
    const taskId = /<task_card id="([^"]+)"/.exec(first)?.[1];
    const last = body.messages.at(-1);
    const deliver = (summary: string) =>
        call({
            name: 'deliver',
            arguments: { status: 'done', summary, evidence: [{ type: 'note', text: summary }] },
        });
    if (taskId === 'H1') {
        if (last?.role !== 'tool') {
            return call({ name: 'challenge', arguments: { to: 'H2', text: 'H2 ignores the stack trace' } });
        }
        return lastCall(body) === 'challenge' ? deliver('H1 confirmed: the cache keeps entries forever') : say('done');
    }
    return last?.role === 'tool' ? say('done') : deliver('H2 refuted; the stack trace points at the cache');
}

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }, { id: 'deepseek-flash' }] });
}, 60_000);

afterEach(() => host.closeAll());

afterAll(async () => {
    await server?.close();
});

describe('competing hypotheses', () => {
    it('investigates rival hypotheses, lets members challenge each other and passes the user’s word on', async () => {
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            switch (agentOf(body)) {
                case 'Supervisor':
                    return supervisor(body);
                case 'Scout':
                    return scout(body);
                default:
                    return say('ok');
            }
        });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-hypotheses-data-'));
        const { ui } = await host.start(dataDir);
        approveAll(ui);
        await connectMock(ui, server);
        const project = await ui.request('project.add', { path: gitRepo() });

        const started = await ui.request('team.start', {
            projectId: project.id,
            goal: '查清为什么偶尔读到旧数据',
            autonomy: 'L2',
            budget: 50,
            mode: 'hypotheses',
        });
        expect(started.mode).toBe('hypotheses');
        await ui.request('team.message', { runId: started.id, to: 'supervisor', text: '先看日志' });

        const done = await waitFor(async () => {
            const run = await ui.request('team.get', { runId: started.id });
            return ['done', 'failed', 'cancelled'].includes(run.status) ? run : undefined;
        }, 'run done');
        expect(done.status).toBe('done');
        expect(done.tasks.map((task) => [task.id, task.status])).toEqual([
            ['H1', 'done'],
            ['H2', 'done'],
        ]);

        const requests = server.requests.map((request) => request.body as ChatBody);
        const supervisorText = requests.filter((body) => agentOf(body) === 'Supervisor').map(userText);
        expect(supervisorText[0]).toContain('<competing_hypotheses>');
        expect(supervisorText.some((text) => text.includes('Message from the user: 先看日志'))).toBe(true);
        expect(supervisorText.some((text) => text.includes('H1 challenged H2: H2 ignores the stack trace'))).toBe(true);
        // Only investigation members of this mode get the tool; the challenged one reads it at its next turn.
        const h1 = requests.find((body) => agentOf(body) === 'Scout' && userText(body).includes('<task_card id="H1"'));
        expect(h1?.tools?.map((tool) => tool.function.name)).toContain('challenge');
        const h2 = requests.find((body) => agentOf(body) === 'Scout' && userText(body).includes('<task_card id="H2"'));
        expect(userText(h2 as ChatBody)).toContain(
            '<team_messages>\nChallenge from H1: H2 ignores the stack trace\nAnswer it in your deliverable',
        );

        expect(done.conversation?.map((entry) => [entry.from, entry.to, entry.kind, entry.text])).toEqual([
            ['user', 'supervisor', 'user', '先看日志'],
            ['H1', 'H2', 'challenge', 'H2 ignores the stack trace'],
        ]);
        await expect(ui.request('team.message', { runId: started.id, to: 'supervisor', text: 'hi' })).rejects.toThrow(
            '运行已经结束',
        );
    }, 120_000);
});
