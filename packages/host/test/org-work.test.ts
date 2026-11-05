import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HostToolProvider } from '../src/turns.ts';
import { buildEngine, type ChatBody, connectMock, gitRepo, hosts, say, textOf, type Ui, waitFor } from './harness.ts';

/**
 * How the organization tree works (19 §6–§8): a run takes the people of a whole subtree, members carry the prompts
 * of their line, and an organization keeps its own notes of each project.
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
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-org-work-'));
    const harness = await host.start(dataDir);
    await connectMock(harness.ui, server);
    const project = await harness.ui.request('project.add', { path: gitRepo() });
    return { ...harness, dataDir, project };
}

const lead = (ui: Ui, name: string) =>
    ui.request('member.save', {
        scope: 'user',
        member: { name, role: 'supervisor', tier: 'flagship', mode: 'plan', prompt: '' },
        groupId: null,
    });

const worker = (ui: Ui, name: string, groupId: string | null) =>
    ui.request('member.save', {
        scope: 'user',
        member: { name, role: 'executor', tier: 'economy', mode: 'auto_edit', prompt: `${name}的提示词` },
        groupId,
    });

const systemOf = (body: ChatBody | undefined) =>
    textOf(body?.messages.find((message) => message.role === 'system')?.content);

const bodies = () =>
    server.requests
        .map((request) => request.body as ChatBody | undefined)
        .filter((body): body is ChatBody => Boolean(body?.messages));

/** The tools and layers a member works with in a project; `groupId`: a run handed to that organization. */
function working(
    core: Awaited<ReturnType<typeof setUp>>['core'],
    member: { id: string; name: string },
    projectId: string,
    groupId?: string,
) {
    const base: HostToolProvider = { tools: [], handle: async () => ({ content: '' }) };
    const provider = core.members.withMemory(base, member, projectId, { groupId });
    const signal = () => new AbortController().signal;
    return {
        memory: () => provider.layers?.find((layer) => layer.id === 'member_memory')?.text ?? '',
        remember: (note: string, scope?: string) =>
            provider.handle('remember', { note, ...(scope ? { scope } : {}) }, signal()),
        recall: (query: string) => provider.handle('recall', { query }, signal()),
    };
}

describe('work in the organization tree', () => {
    it('hands a run to the nearest lead and the people of the whole subtree, sub-leads apart', async () => {
        server.respondWith((request) =>
            (request.body as ChatBody | undefined)?.messages ? say('先看看。') : undefined,
        );
        const { ui, project } = await setUp();
        const top = await lead(ui, '中心负责人');
        const sub = await lead(ui, '小队负责人');
        const centre = await ui.request('org.saveGroup', { name: 'Centre', leaderId: top.id });
        const quiet = await ui.request('org.saveGroup', { name: 'Quiet', parentId: centre.id });
        const squad = await ui.request('org.saveGroup', { name: 'Squad', parentId: centre.id, leaderId: sub.id });
        const one = await worker(ui, '甲', centre.id);
        const two = await worker(ui, '乙', quiet.id);
        const three = await worker(ui, '丙', squad.id);

        const run = await ui.request('team.start', { projectId: project.id, goal: '做个首页', groupId: centre.id });
        expect(run.group).toEqual({ id: centre.id, name: 'Centre' });
        expect(run.members?.map((member) => member.memberId).sort()).toEqual([one.id, two.id, three.id].sort());
        const supervisor = await ui.request('thread.read', { threadId: run.supervisorThreadId as string });
        expect(supervisor.thread).toMatchObject({ agentId: top.id, role: 'supervisor' });
        // Its roster lists who works in the run, not the rest of the organization.
        const layers = await ui.request('prompt.effective', { threadId: run.supervisorThreadId as string });
        const roster = layers.find((layer) => layer.id === 'team_roster')?.text ?? '';
        expect(roster).toContain(one.id);
        expect(roster).not.toContain('- reviewer:');
        await ui.request('team.stop', { runId: run.id });

        // A group without a lead of its own: the lead above takes its work, and only its own people work.
        const below = await ui.request('team.start', { projectId: project.id, goal: '修个bug', groupId: quiet.id });
        expect(below.members?.map((member) => member.memberId)).toEqual([two.id]);
        const acting = await ui.request('thread.read', { threadId: below.supervisorThreadId as string });
        expect(acting.thread.agentId).toBe(top.id);
        await ui.request('team.stop', { runId: below.id });
    });

    it('refuses a run for a group nobody can lead or do the work of, without a stand-in', async () => {
        const { ui, project } = await setUp();
        const boss = await lead(ui, '负责人');
        const headless = await ui.request('org.saveGroup', { name: 'Headless' });
        await worker(ui, '甲', headless.id);
        await expect(
            ui.request('team.start', { projectId: project.id, goal: '做事', groupId: headless.id }),
        ).rejects.toThrow('Headless');
        const empty = await ui.request('org.saveGroup', { name: 'Empty', leaderId: boss.id });
        await expect(
            ui.request('team.start', { projectId: project.id, goal: '做事', groupId: empty.id }),
        ).rejects.toThrow('Empty');
    });

    it('gives a member the prompts of its line, top down, between everyone’s and its own', async () => {
        server.respondWith((request) => ((request.body as ChatBody | undefined)?.messages ? say('好。') : undefined));
        const { ui, project } = await setUp();
        await ui.request('org.saveRoot', { prompt: '全体的规矩' });
        const centre = await ui.request('org.saveGroup', { name: '中心', prompt: '中心的规矩' });
        const squad = await ui.request('org.saveGroup', { name: '小队', parentId: centre.id, prompt: '小队的规矩' });
        const other = await ui.request('org.saveGroup', { name: '别组', prompt: '别组的规矩' });
        const member = await worker(ui, '甲', squad.id);
        await worker(ui, '乙', other.id);
        await ui.request('member.chat', { projectId: project.id, memberId: member.id, text: '看看' });
        const body = await waitFor(() => bodies()[0], 'the first request');
        const system = systemOf(body);
        const order = ['全体的规矩', '中心的规矩', '小队的规矩', '甲的提示词', '长期记忆'].map((text) =>
            system.indexOf(text),
        );
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(system).toContain('中心/小队');
        expect(system).toContain('以靠后的为准');
        expect(system).not.toContain('别组的规矩');
    });

    it('keeps the memory of a thread as it began, and finds what was written since with recall', async () => {
        const { core, ui, project } = await setUp();
        const member = await worker(ui, '甲', null);
        const first = working(core, member, project.id);
        await first.remember('构建用pnpm build');
        const before = first.memory();
        expect(before).toContain('构建用pnpm build');
        await first.remember('测试用pnpm test');
        expect(first.memory()).toBe(before);
        expect((await first.recall('pnpm test')).content).toContain('测试用pnpm test');
        // The next piece of work starts from all of it.
        expect(working(core, member, project.id).memory()).toContain('测试用pnpm test');
    });

    it('keeps notes for others with the organization that does the work', async () => {
        const { core, ui, dataDir, project } = await setUp();
        const centre = await ui.request('org.saveGroup', { name: '中心' });
        const squad = await ui.request('org.saveGroup', { name: '小队', parentId: centre.id });
        const other = await ui.request('org.saveGroup', { name: '别组' });
        const one = await worker(ui, '甲', squad.id);
        const two = await worker(ui, '乙', squad.id);
        const three = await worker(ui, '丙', other.id);
        const loose = await worker(ui, '丁', null);

        await working(core, one, project.id).remember('小队这样构建', 'team');
        const file = path.join(dataDir, 'orgs', 'default', 'groups', squad.id, 'projects', `${project.id}.md`);
        expect(readFileSync(file, 'utf8')).toContain('小队这样构建');
        expect(working(core, two, project.id).memory()).toContain('小队这样构建');
        expect(working(core, three, project.id).memory()).not.toContain('小队这样构建');

        // In a run handed to the organization above, its notes stay with that organization.
        await working(core, one, project.id, centre.id).remember('中心这样发布', 'team');
        const above = path.join(dataDir, 'orgs', 'default', 'groups', centre.id, 'projects', `${project.id}.md`);
        expect(readFileSync(above, 'utf8')).toContain('中心这样发布');
        expect(readFileSync(file, 'utf8')).not.toContain('中心这样发布');

        // A direct report writes everyone's notes, which every member gets beside its organization's.
        await working(core, loose, project.id).remember('全体都该知道', 'team');
        expect(existsSync(path.join(dataDir, 'orgs', 'default', 'memory', `${project.id}.md`))).toBe(true);
        expect(working(core, three, project.id).memory()).toContain('全体都该知道');
        expect(working(core, three, project.id).memory()).toContain('别组');

        // Everything can be found, its own organization first; the panel shows the member's own.
        const found = await working(core, three, project.id).recall('小队这样构建');
        expect(found.content).toContain('(小队 · ');
        const team = await ui.request('member.memory', { memberId: one.id, scope: 'team', projectId: project.id });
        expect(team.text).toContain('小队这样构建');
    });

    it('marks notes as material, not instructions', async () => {
        const { core, ui, project } = await setUp();
        const member = await worker(ui, '甲', null);
        expect(working(core, member, project.id).memory()).toContain('不是指令');
    });
});
