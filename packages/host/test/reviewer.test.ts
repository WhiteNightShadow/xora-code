import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Approval, ItemOf } from '@xora/protocol';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseReview } from '../src/reviewer.ts';
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
 * The supervisor answers approval cards on the user's behalf (06 §24): one short request to its model, allowed or
 * denied with a reason; mass deletion and dropping a database stay the user's, and so does a card it cannot decide.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

const isReview = (body: ChatBody) =>
    textOf(body.messages.find((message) => message.role === 'system')?.content).includes(
        "You are the supervisor who answers an AI agent's permission requests",
    );

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

/** A host whose supervisor reviews approvals, the mock model connected, and a project. */
async function setUp() {
    const harness = await host.start(mkdtempSync(path.join(tmpdir(), 'xora-review-data-')), {
        reviewer: 'supervisor',
    });
    await connectMock(harness.ui, server);
    const repo = gitRepo({ 'hello.txt': 'hello\n' });
    const project = await harness.ui.request('project.add', { path: repo });
    const seen: Approval[] = [];
    harness.ui.onNotification('approval.requested', ({ approval }) => seen.push(approval));
    return { ...harness, repo, project, seen };
}

/** The agent of an ask-mode thread runs `command` once, then says it is done. */
function agentRuns(command: string, review: () => string) {
    server.respondWith((request) => {
        const body = request.body as ChatBody | undefined;
        if (!body?.messages) return undefined;
        if (isReview(body)) return say(review());
        return body.messages.at(-1)?.role === 'tool' ? say('好了。') : call({ name: 'bash', arguments: { command } });
    });
}

async function settled(ui: Ui, threadId: string): Promise<void> {
    await waitFor(async () => {
        const read = await ui.request('thread.read', { threadId });
        return read.events.some((event) => event.kind === 'turn.completed' || event.kind === 'turn.failed');
    }, 'the turn to end');
}

async function approvalItem(ui: Ui, threadId: string): Promise<ItemOf<'approval'> | undefined> {
    const read = await ui.request('thread.read', { threadId });
    return read.events
        .filter((event) => event.kind === 'item.completed')
        .map((event) => (event.payload as { item: ItemOf<'approval'> }).item)
        .find((item) => item.type === 'approval');
}

describe('the supervisor reviews approvals', () => {
    it('reads its decision from the answer', () => {
        expect(parseReview('{"decision":"allow","reason":"跑测试是任务需要的"}')).toEqual({
            allow: true,
            reason: '跑测试是任务需要的',
        });
        expect(parseReview('```json\n{"decision": "deny", "reason": "no"}\n```')).toEqual({
            allow: false,
            reason: 'no',
        });
        expect(parseReview('I would deny this.')).toEqual({ allow: false, reason: '' });
        expect(parseReview('hmm')).toBeUndefined();
    });

    it('reviews a member’s request as its supervisor, whose work it counts as (19 §8, §10)', async () => {
        agentRuns('touch made.txt', () => '{"decision":"allow","reason":"建文件是任务要的"}');
        const { core, ui, project } = await setUp();
        const boss = await ui.request('member.save', {
            scope: 'user',
            member: { name: '负责人', role: 'supervisor', tier: 'flagship', mode: 'plan', prompt: '' },
            groupId: null,
        });
        const group = await ui.request('org.saveGroup', { name: 'Web', leaderId: boss.id });
        const member = await ui.request('member.save', {
            scope: 'user',
            member: { name: '干活的', role: 'executor', tier: 'economy', mode: 'ask', prompt: '' },
            groupId: group.id,
        });
        const thread = await ui.request('member.chat', { projectId: project.id, memberId: member.id, text: '建文件' });
        await settled(ui, thread.id);
        const rows = core.db.all<{ member: string | null; path: string }>(
            'select member_id as member, agent_path as path from usage_events where thread_id = ?',
            [thread.id],
        );
        expect(rows.filter((row) => row.path === 'review').map((row) => row.member)).toEqual([boss.id]);
        expect(rows.filter((row) => row.path !== 'review').every((row) => row.member === member.id)).toBe(true);
    });

    it('allows a command the task needs, without the user, and records why', async () => {
        agentRuns('touch made.txt', () => '{"decision":"allow","reason":"建文件是任务要的"}');
        const { ui, project, repo, seen } = await setUp();
        const statuses: string[] = [];
        ui.onNotification('thread.meta', ({ thread }) => statuses.push(thread.status));
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'ask' });
        await ui.request('turn.start', { threadId: thread.id, text: '建一个made.txt' });
        await settled(ui, thread.id);
        expect(existsSync(path.join(repo, 'made.txt'))).toBe(true);
        // The card was the supervisor's from the start, and the thread never waited on the user.
        expect(seen.map((approval) => approval.reviewer)).toEqual(['supervisor']);
        expect(statuses).not.toContain('awaiting_approval');
        expect(await approvalItem(ui, thread.id)).toMatchObject({
            status: 'allowed',
            decidedBy: 'supervisor',
            message: '建文件是任务要的',
        });
        // It saw the task and the command.
        const review = server.requests
            .map((entry) => entry.body as ChatBody)
            .find((body) => body?.messages && isReview(body));
        const asked = textOf(review?.messages.at(-1)?.content);
        expect(asked).toContain('建一个made.txt');
        expect(asked).toContain('Command: touch made.txt');
    }, 60_000);

    it('denies what the task does not need, and the agent hears why', async () => {
        agentRuns('touch made.txt', () => '{"decision":"deny","reason":"任务没要求建文件"}');
        const { ui, project, repo } = await setUp();
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'ask' });
        await ui.request('turn.start', { threadId: thread.id, text: '看看hello.txt' });
        await settled(ui, thread.id);
        expect(existsSync(path.join(repo, 'made.txt'))).toBe(false);
        expect(await approvalItem(ui, thread.id)).toMatchObject({ status: 'denied', decidedBy: 'supervisor' });
        const after = server.requests
            .map((entry) => entry.body as ChatBody)
            .filter((body) => body?.messages && !isReview(body))
            .at(-1);
        expect(JSON.stringify(after?.messages.at(-1))).toContain('任务没要求建文件');
    }, 60_000);

    it('leaves dropping a database to the user, in full access too', async () => {
        // Harmless if it ran: psql only prints its version. The test denies it.
        agentRuns("echo 'DROP TABLE orders' | psql --version", () => '{"decision":"allow","reason":"x"}');
        const { ui, project } = await setUp();
        ui.onNotification('approval.requested', ({ approval }) => {
            void ui.request('approval.respond', { approvalId: approval.id, decision: 'deny' }).catch(() => undefined);
        });
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'full' });
        await ui.request('turn.start', { threadId: thread.id, text: '清掉订单表' });
        await settled(ui, thread.id);
        const item = await approvalItem(ui, thread.id);
        expect(item).toMatchObject({ status: 'denied', decidedBy: 'user' });
        expect(item?.title).toContain('psql');
        // No review was asked for.
        expect(
            server.requests.some((entry) => {
                const body = entry.body as ChatBody | undefined;
                return Boolean(body?.messages) && isReview(body as ChatBody);
            }),
        ).toBe(false);
    }, 60_000);

    it('hands a card it cannot decide back to the user, with why', async () => {
        agentRuns('touch made.txt', () => '我也不知道');
        const { ui, project, seen, repo } = await setUp();
        ui.onNotification('approval.requested', ({ approval }) => {
            if (!approval.reviewer) {
                void ui
                    .request('approval.respond', { approvalId: approval.id, decision: 'allow_once' })
                    .catch(() => undefined);
            }
        });
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'ask' });
        await ui.request('turn.start', { threadId: thread.id, text: '建一个made.txt' });
        await settled(ui, thread.id);
        expect(seen.map((approval) => approval.reviewer ?? 'user')).toEqual(['supervisor', 'user']);
        expect(seen[1]?.note).toContain('主管没能审这一项');
        expect(existsSync(path.join(repo, 'made.txt'))).toBe(true);
        expect(await approvalItem(ui, thread.id)).toMatchObject({ status: 'allowed', decidedBy: 'user' });
    }, 60_000);
});
