import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XoraDatabase } from '@xora/storage';
import { type MockModelServer, type MockTurn, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseScore, finalScore, parseScores, ScoreService } from '../src/scores.ts';
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
    waitFor,
} from './harness.ts';

/** Supervisor scores (19 §9): a base from the facts, a small move by the supervisor, kept once, never made up. */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

const ONLY_A = `node -e "process.exit(require('fs').existsSync('a.txt')?0:1)"`;

const CARD = {
    id: 'T1',
    title: 'Write the file',
    goal: 'The file exists',
    category: 'coding',
    tier: 'economy',
    ownership: ['a.txt'],
    acceptance: [{ type: 'command', run: ONLY_A }],
    deliverable: { kind: 'code-change' },
    budget: { cost: 2 },
    workspace: 'worktree',
};

const isScoring = (body: ChatBody) => textOf(body.messages[0]?.content).includes('scoring how your members did');
const isBrief = (body: ChatBody) => textOf(body.messages[0]?.content).includes('现在向下达任务的人交付结果');

/** A run of one card that passes at once; `scoring` answers the request for scores. */
function script(scoring: () => MockTurn) {
    server.reset();
    server.respondWith((request) => {
        const body = request.body as ChatBody | undefined;
        if (!body?.messages) return undefined;
        if (isScoring(body)) return scoring();
        if (isBrief(body)) return say('## 目标达成\n已达成。\n## 已完成\n- a.txt\n## 下一步\n- 无');
        const last = body.messages.at(-1);
        switch (agentOf(body)) {
            case 'Supervisor':
                if (last?.role === 'tool') return say('Planned.');
                return textOf(last?.content).includes('<team_goal>')
                    ? call({ name: 'task_create', arguments: { tasks: [CARD] } })
                    : say('Noted.');
            case 'Coder':
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
                return last?.role === 'tool'
                    ? say('Handed in.')
                    : call({ name: 'write', arguments: { path: 'a.txt', content: 'one\n' } });
            default:
                return say('ok');
        }
    });
}

const scoringRequests = () =>
    server.requests
        .map((request) => request.body as ChatBody | undefined)
        .filter((body): body is ChatBody => Boolean(body?.messages) && isScoring(body as ChatBody));

async function run(dataDir: string, before?: (ui: Ui) => Promise<void>) {
    const harness = await host.start(dataDir);
    approveAll(harness.ui);
    await connectMock(harness.ui, server);
    await before?.(harness.ui);
    const project = await harness.ui.request('project.add', { path: gitRepo() });
    const started = await harness.ui.request('team.start', {
        projectId: project.id,
        goal: '写a.txt',
        autonomy: 'L2',
        budget: 50,
    });
    const done = await waitFor(
        async () => {
            const view = await harness.ui.request('team.get', { runId: started.id });
            return ['done', 'failed', 'cancelled', 'paused'].includes(view.status) ? view : undefined;
        },
        'run done',
        90_000,
    );
    return { ...harness, project, done };
}

const newData = () => mkdtempSync(path.join(tmpdir(), 'xora-scores-data-'));

beforeAll(async () => {
    engineEntry = await buildEngine();
    server = await startMockModelServer({ models: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }, { id: 'deepseek-flash' }] });
}, 60_000);

afterEach(() => host.closeAll());

afterAll(async () => {
    await server?.close();
});

describe('a score', () => {
    it('starts from the facts: what got done, and how often it went wrong', () => {
        const done = { status: 'done', fails: 0, escalations: 0, watches: 0 } as const;
        expect(baseScore(done)).toBe(85);
        expect(baseScore({ ...done, fails: 1 })).toBe(75);
        expect(baseScore({ ...done, watches: 2 })).toBe(79);
        expect(baseScore({ ...done, fails: 9, escalations: 9 })).toBe(50);
        expect(baseScore({ ...done, status: 'failed' })).toBe(40);
        expect(baseScore({ ...done, status: 'blocked', fails: 3 })).toBe(25);
        expect(baseScore({ ...done, status: 'failed', fails: 20 })).toBe(10);
    });

    it('moves ten points at most, and a card not done stays at 50', () => {
        expect(finalScore(85, 5, 'done')).toBe(90);
        expect(finalScore(85, 40, 'done')).toBe(95);
        expect(finalScore(95, 10, 'done')).toBe(100);
        expect(finalScore(85, -40, 'done')).toBe(75);
        expect(finalScore(45, 10, 'failed')).toBe(50);
        expect(finalScore(10, -10, 'blocked')).toBe(0);
    });

    it('reads only what the supervisor clearly said', () => {
        const answer = (text: string) => [...parseScores(text).entries()];
        expect(answer('{"scores":[{"task":"T1","adjust":3,"reason":"验收过了"}]}')).toEqual([
            ['T1', { adjust: 3, reason: '验收过了' }],
        ]);
        expect(answer('```json\n{"scores":[{"task":"T1","adjust":-2,"reason":"汇报含糊"}]}\n```')).toHaveLength(1);
        // No reason, no number, no JSON: nothing to keep.
        expect(answer('{"scores":[{"task":"T1","adjust":3}]}')).toEqual([]);
        expect(answer('{"scores":[{"task":"T1","adjust":"good","reason":"x"}]}')).toEqual([]);
        expect(answer('all fine')).toEqual([]);
        expect(answer('{"scores":')).toEqual([]);
    });

    it('adds up to an average of the last ten from three on, with where it is going', () => {
        const db = new XoraDatabase(':memory:');
        db.migrate();
        const scores = new ScoreService(db);
        const row = (member: string, index: number, score: number) => ({
            runId: `r${index}`,
            taskId: 'T1',
            memberId: member,
            at: index,
            projectId: 'p',
            scorerId: 's',
            title: `第${index}张`,
            base: score,
            adjust: 0,
            score,
            reason: '理由',
        });
        scores.add([row('a', 1, 70), row('a', 2, 80)]);
        expect(scores.summary('a')).toMatchObject({ count: 2, recent: [{ title: '第2张' }, { title: '第1张' }] });
        expect(scores.summary('a').average).toBeUndefined();
        expect(scores.averages().has('a')).toBe(false);

        scores.add([row('a', 3, 90)]);
        expect(scores.summary('a')).toMatchObject({ count: 3, average: 80 });
        expect(scores.averages().get('a')).toBe(80);
        // A card scored again changes nothing.
        scores.add([row('a', 3, 10)]);
        expect(scores.summary('a').count).toBe(3);

        const many = Array.from({ length: 10 }, (_, index) => row('b', index + 1, 60));
        const better = Array.from({ length: 10 }, (_, index) => row('b', index + 11, 80));
        scores.add([...many, ...better]);
        expect(scores.summary('b')).toMatchObject({ count: 20, average: 80, trend: 'up' });
        expect(scores.summary('b').recent).toHaveLength(5);
        expect(scores.averages().get('b')).toBe(80);
        db.close();
    });
});

describe('the supervisor scores a run', () => {
    it('scores each card once the report is written, and it counts as the supervisor’s work', async () => {
        script(() => say('{"scores":[{"task":"T1","adjust":5,"reason":"a.txt写好了，验收一次过"}]}'));
        const { ui, core, project, done } = await run(newData());
        expect(done.status).toBe('done');
        const stats = await waitFor(async () => {
            const read = await ui.request('member.stats', { memberId: 'coder' });
            return read.score.count > 0 ? read : undefined;
        }, 'the score');
        expect(stats.score.recent).toEqual([
            expect.objectContaining({
                score: 90,
                reason: 'a.txt写好了，验收一次过',
                title: 'Write the file',
                project: project.name,
                by: expect.any(String),
            }),
        ]);
        expect(stats.score.average).toBeUndefined();
        expect(textOf(scoringRequests()[0]?.messages.at(-1)?.content)).toContain('base score 85');
        expect(stats.usage.all.requests).toBeGreaterThan(0);
        const rows = core.db.all<{ member: string | null }>(
            "select member_id as member from usage_events where agent_path = 'score'",
        );
        expect(rows).toEqual([{ member: 'supervisor' }]);
    });

    it('makes up nothing when the answer cannot be read, and does not ask again', async () => {
        script(() => say('I think they did well.'));
        const { ui } = await run(newData());
        await waitFor(() => scoringRequests().length > 0 || undefined, 'the request for scores');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect((await ui.request('member.stats', { memberId: 'coder' })).score.count).toBe(0);
        expect(scoringRequests()).toHaveLength(1);
    });

    it('does not ask when scoring is off', async () => {
        script(() => say('{"scores":[{"task":"T1","adjust":0,"reason":"不该问"}]}'));
        const { ui, done } = await run(newData(), async (client) => {
            const { team } = await client.request('settings.get', {});
            await client.request('settings.update', { patch: { team: { ...team, scoring: false } } });
        });
        expect(done.status).toBe('done');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(scoringRequests()).toHaveLength(0);
        expect((await ui.request('member.stats', { memberId: 'coder' })).score.count).toBe(0);
    });

    it('asks again after a restart in the middle of scoring, and keeps one score', async () => {
        let asked = 0;
        script(() => {
            asked++;
            const answer = say('{"scores":[{"task":"T1","adjust":0,"reason":"验收过了"}]}');
            // The first request is still out when the app goes down.
            return asked === 1 ? { ...answer, delayMs: 30_000 } : answer;
        });
        const data = newData();
        await run(data);
        await waitFor(() => asked > 0 || undefined, 'the request for scores');
        await host.closeLast();
        const { ui } = await host.start(data);
        const stats = await waitFor(async () => {
            const read = await ui.request('member.stats', { memberId: 'coder' });
            return read.score.count > 0 ? read : undefined;
        }, 'the score after the restart');
        expect(stats.score.count).toBe(1);
        expect(asked).toBe(2);
    });
});
