import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    buildEngine,
    type ChatBody,
    call,
    connectMock,
    gitRepo,
    hosts,
    lastCall,
    say,
    textOf,
    waitFor,
} from './harness.ts';

/**
 * The organization chart (06 §24): groups with a lead and members the way a company has teams, members that can be
 * deleted (built-in ones too, and brought back), a regular software team from a template, team runs handed to a
 * group, and the chief assistant changing all that on request.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

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

async function setUp() {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-org-data-'));
    const harness = await host.start(dataDir);
    await connectMock(harness.ui, server);
    const project = await harness.ui.request('project.add', { path: gitRepo({ 'hello.txt': 'hello\n' }) });
    return { ...harness, dataDir, project };
}

describe('the organization chart', () => {
    it('starts as one team the supervisor leads, and deletes and brings back built-in members', async () => {
        const { ui, project } = await setUp();
        const chart = await ui.request('org.get', {});
        expect(chart.groups).toHaveLength(1);
        expect(chart.groups[0]).toMatchObject({ id: 'default', name: '研发团队', leaderId: 'supervisor' });
        expect(chart.groups[0]?.memberIds).toContain('coder');
        expect(chart.groups[0]?.memberIds).not.toContain('supervisor');
        expect(chart.removed).toEqual([]);

        await ui.request('member.delete', { projectId: project.id, memberId: 'writer' });
        expect((await ui.request('member.list', { projectId: project.id })).map((member) => member.id)).not.toContain(
            'writer',
        );
        expect((await ui.request('org.get', {})).removed).toEqual([{ id: 'writer', name: '文档' }]);
        await ui.request('member.reset', { memberId: 'writer' });
        expect((await ui.request('member.list', { projectId: project.id })).map((member) => member.id)).toContain(
            'writer',
        );

        // A team keeps a lead: the last supervisor stays.
        await expect(ui.request('member.delete', { projectId: project.id, memberId: 'supervisor' })).rejects.toThrow(
            '最后一个主管',
        );
    });

    it('builds a regular software team from the template, replacing what was there', async () => {
        const { ui, project, dataDir } = await setUp();
        const mine = await ui.request('member.save', {
            projectId: project.id,
            scope: 'user',
            member: { name: '日报员', role: 'executor', tier: 'economy', mode: 'auto_edit', prompt: '写日报。' },
        });
        const chart = await ui.request('org.applyTemplate', { template: 'dev-team', replace: true });
        expect(chart.groups).toEqual([
            {
                id: 'dev',
                name: '开发组',
                description: '需求、设计、开发、测试、部署和审查，交付可用的软件',
                leaderId: 'supervisor',
                memberIds: [
                    'planner',
                    'plan-reviewer',
                    'frontend',
                    'coder',
                    'tester',
                    'devops',
                    'reviewer',
                    'scout',
                    'specialist',
                ],
            },
        ]);
        expect(chart.removed.map((item) => item.id).sort()).toEqual(['debugger', 'writer']);
        const members = await ui.request('member.list', { projectId: project.id });
        expect(members.map((member) => member.name)).toEqual(
            expect.arrayContaining(['技术负责人', '产品经理', '架构师', '前端工程师', '后端工程师', '运维工程师']),
        );
        expect(members.find((member) => member.id === 'frontend')).toMatchObject({
            role: 'executor',
            category: 'frontend',
            source: 'user',
        });
        expect(members.find((member) => member.id === 'coder')).toMatchObject({
            category: 'backend',
            customized: true,
        });
        // The member that was there is gone, its file kept in the trash.
        expect(members.some((member) => member.id === mine.id)).toBe(false);
        const trash = path.join(dataDir, 'orgs', 'default', '.trash');
        expect(readdirSync(trash).some((name) => name.startsWith(mine.id))).toBe(true);
        expect(existsSync(path.join(dataDir, 'orgs', 'default', 'agents', `${mine.id}.md`))).toBe(false);
    });

    it('makes groups with their own lead, moves members, and keeps a lead until the group has another', async () => {
        const { ui, project } = await setUp();
        const lead = await ui.request('member.save', {
            projectId: project.id,
            scope: 'user',
            member: { id: undefined, name: '数据组长', role: 'supervisor', tier: 'flagship', mode: 'plan', prompt: '' },
        });
        const group = await ui.request('org.saveGroup', {
            projectId: project.id,
            name: 'Data',
            description: '抓数据、清洗、入库',
            leaderId: lead.id,
            memberIds: ['scout', 'coder'],
        });
        expect(group).toMatchObject({ id: 'data', leaderId: lead.id, memberIds: ['scout', 'coder'] });
        const chart = await ui.request('org.get', {});
        expect(chart.groups.find((item) => item.id === 'default')?.memberIds).not.toContain('coder');
        // A new member joins the first group unless told where.
        const tester = await ui.request('member.save', {
            projectId: project.id,
            scope: 'user',
            member: { name: '爬虫手', role: 'executor', tier: 'economy', mode: 'auto_edit', prompt: '' },
            groupId: 'data',
        });
        expect((await ui.request('org.get', {})).groups.find((item) => item.id === 'data')?.memberIds).toContain(
            tester.id,
        );
        await ui.request('org.moveMember', { projectId: project.id, memberId: 'coder', groupId: null });
        expect((await ui.request('org.get', {})).groups.some((item) => item.memberIds.includes('coder'))).toBe(false);
        await expect(ui.request('member.delete', { projectId: project.id, memberId: lead.id })).rejects.toThrow('Data');
        await ui.request('org.deleteGroup', { groupId: 'data' });
        await ui.request('member.delete', { projectId: project.id, memberId: lead.id });
    });

    it('hands a team run to a group: its lead supervises and only its members work', async () => {
        server.respondWith((request) =>
            (request.body as ChatBody | undefined)?.messages ? say('先看看。') : undefined,
        );
        const { ui, project } = await setUp();
        const lead = await ui.request('member.save', {
            projectId: project.id,
            scope: 'user',
            member: { name: '前端组长', role: 'supervisor', tier: 'flagship', mode: 'plan', prompt: '' },
        });
        await ui.request('org.saveGroup', {
            projectId: project.id,
            name: 'Web',
            leaderId: lead.id,
            memberIds: ['coder', 'tester'],
        });
        const run = await ui.request('team.start', { projectId: project.id, goal: '做个首页', groupId: 'web' });
        expect(run.group).toEqual({ id: 'web', name: 'Web' });
        expect(run.members?.map((member) => member.memberId)).toEqual(['coder', 'tester']);
        const supervisor = await ui.request('thread.read', { threadId: run.supervisorThreadId as string });
        expect(supervisor.thread).toMatchObject({ agentId: lead.id, role: 'supervisor' });
        await ui.request('team.stop', { runId: run.id });
    });

    it('lets the chief build the team when asked', async () => {
        const chief = (body: ChatBody) =>
            textOf(body.messages.find((message) => message.role === 'system')?.content).includes(
                'You are the chief assistant of Xora Code',
            );
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (!chief(body)) return say('好的。');
            if (body.messages.at(-1)?.role !== 'tool') return call({ name: 'member_list', arguments: {} });
            return lastCall(body) === 'member_list'
                ? call({ name: 'org_template', arguments: { template: 'dev-team', replace: true } })
                : say('建好了开发组。');
        });
        const { ui, project } = await setUp();
        const thread = await ui.request('chief.start', {
            projectId: project.id,
            text: '清空已有成员，建个正常的开发团队',
        });
        await waitFor(async () => {
            const read = await ui.request('thread.read', { threadId: thread.id });
            return read.events.some((event) => event.kind === 'turn.completed');
        }, 'the chief to finish');
        // What it saw of the organization before.
        const listed = server.requests
            .map((entry) => entry.body as ChatBody)
            .find((body) => body?.messages && chief(body) && lastCall(body) === 'member_list');
        expect(textOf(listed?.messages.at(-1)?.content)).toContain('Group "研发团队" (id default)');
        const chart = await ui.request('org.get', {});
        expect(chart.groups.map((group) => group.name)).toEqual(['开发组']);
    }, 60_000);
});
