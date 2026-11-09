import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OrgGroup, ThreadMeta } from '@xora/protocol';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { groupChain, leadOf, MAX_GROUP_DEPTH, readGroups, supervisorOf } from '../src/org-groups.ts';
import { workerOf } from '../src/threads.ts';
import { buildEngine, gitRepo, hosts, type Ui } from './harness.ts';

/** The organization tree (19 §4, §5): groups in groups, their folders and prompts, and what keeps the tree whole. */

let engineEntry = '';
const host = hosts(() => engineEntry);

beforeAll(async () => {
    engineEntry = await buildEngine();
}, 60_000);

afterEach(async () => {
    await host.closeAll();
});

const newData = () => mkdtempSync(path.join(tmpdir(), 'xora-org-tree-'));

const lead = (ui: Ui, name: string) =>
    ui.request('member.save', {
        scope: 'user',
        member: { name, role: 'supervisor', tier: 'flagship', mode: 'plan', prompt: '' },
        groupId: null,
    });

const worker = (ui: Ui, name: string, groupId: string | null) =>
    ui.request('member.save', {
        scope: 'user',
        member: { name, role: 'executor', tier: 'economy', mode: 'auto_edit', prompt: '' },
        groupId,
    });

const groupsOf = async (ui: Ui) => (await ui.request('org.get', {})).groups;

describe('the organization tree', () => {
    it('finds a group’s lead and a member’s supervisor up the tree', () => {
        const groups: OrgGroup[] = [
            { id: 'a', name: 'A', leaderId: 'lead-a', memberIds: ['one'] },
            { id: 'b', name: 'B', parentId: 'a', leaderId: '', memberIds: ['two'] },
            { id: 'c', name: 'C', parentId: 'b', leaderId: 'lead-c', memberIds: ['three'] },
        ];
        expect(groupChain(groups, 'c').map((group) => group.id)).toEqual(['a', 'b', 'c']);
        expect(leadOf(groups, 'b')).toBe('lead-a');
        expect(leadOf(groups, 'c')).toBe('lead-c');
        expect(supervisorOf(groups, 'two')).toBe('lead-a');
        expect(supervisorOf(groups, 'three')).toBe('lead-c');
        // A lead answers to the lead above it, the first level to the chief, and so do members in no group.
        expect(supervisorOf(groups, 'lead-c')).toBe('lead-a');
        expect(supervisorOf(groups, 'lead-a')).toBeUndefined();
        expect(supervisorOf(groups, 'nobody')).toBeUndefined();
    });

    it('nests groups three levels deep at most, and never in a circle', async () => {
        const { ui } = await host.start(newData());
        const top = await ui.request('org.saveGroup', { name: 'Top' });
        const middle = await ui.request('org.saveGroup', { name: 'Middle', parentId: top.id });
        const bottom = await ui.request('org.saveGroup', { name: 'Bottom', parentId: middle.id });
        expect(bottom).toMatchObject({ parentId: middle.id, leaderId: '', memberIds: [] });
        await expect(ui.request('org.saveGroup', { name: 'Fourth', parentId: bottom.id })).rejects.toThrow();
        await expect(ui.request('org.saveGroup', { id: top.id, name: 'Top', parentId: bottom.id })).rejects.toThrow();
        await expect(ui.request('org.saveGroup', { id: top.id, name: 'Top', parentId: top.id })).rejects.toThrow();
        // A whole subtree moves only where it fits.
        const other = await ui.request('org.saveGroup', { name: 'Other' });
        await expect(
            ui.request('org.saveGroup', { id: middle.id, name: 'Middle', parentId: other.id }),
        ).resolves.toMatchObject({ parentId: other.id });
        const deep = await ui.request('org.saveGroup', { name: 'Deep', parentId: other.id });
        await expect(
            ui.request('org.saveGroup', { id: middle.id, name: 'Middle', parentId: deep.id }),
        ).rejects.toThrow();
        // Saving without a parent leaves it where it is; null moves it to the first level.
        await ui.request('org.saveGroup', { id: middle.id, name: 'Middle', description: 'x' });
        expect((await groupsOf(ui)).find((group) => group.id === middle.id)?.parentId).toBe(other.id);
        await ui.request('org.saveGroup', { id: middle.id, name: 'Middle', parentId: null });
        expect((await groupsOf(ui)).find((group) => group.id === middle.id)?.parentId).toBeUndefined();
    });

    it('stays a tree whatever the moves: no circle, three levels, one group per member', async () => {
        const { ui } = await host.start(newData());
        const names = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
        for (const name of names) await ui.request('org.saveGroup', { name });
        const members = ['m1', 'm2', 'm3', 'm4'];
        for (const name of members) await worker(ui, name, 'g1');
        // A fixed sequence, the same on every run.
        let seed = 7;
        const next = (limit: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % limit;
        };
        const pick = <T>(items: readonly T[]) => items[next(items.length)] as T;
        for (let step = 0; step < 120; step++) {
            const groups = await groupsOf(ui);
            const known = groups.map((group) => group.id);
            if (next(3) === 0) {
                await ui
                    .request('org.moveMember', { memberId: pick(members), groupId: pick([...known, null]) })
                    .catch(() => undefined);
            } else {
                const id = pick(known);
                const name = groups.find((group) => group.id === id)?.name ?? id;
                await ui
                    .request('org.saveGroup', { id, name, parentId: pick([...known, null]) })
                    .catch(() => undefined);
            }
            const after = await groupsOf(ui);
            for (const group of after) {
                const chain = groupChain(after, group.id);
                expect(chain.at(-1)?.id).toBe(group.id);
                expect(chain.at(0)?.parentId).toBeUndefined();
                expect(chain.length).toBeLessThanOrEqual(MAX_GROUP_DEPTH);
            }
            const placed = after.flatMap((group) => group.memberIds);
            expect(new Set(placed).size).toBe(placed.length);
        }
    });

    it('moves what a deleted group held up a level and keeps its folder from the next group of that name', async () => {
        const data = newData();
        const { ui } = await host.start(data);
        const top = await ui.request('org.saveGroup', { name: 'Top' });
        const middle = await ui.request('org.saveGroup', { name: 'Middle', parentId: top.id, prompt: '旧的提示词' });
        const bottom = await ui.request('org.saveGroup', { name: 'Bottom', parentId: middle.id });
        const member = await worker(ui, '干活的', middle.id);
        const dir = (await ui.request('org.readGroup', { groupId: middle.id })).dir;
        expect(readFileSync(path.join(dir, 'prompt.md'), 'utf8')).toBe('旧的提示词\n');

        await ui.request('org.deleteGroup', { groupId: middle.id });
        const groups = await groupsOf(ui);
        expect(groups.find((group) => group.id === bottom.id)?.parentId).toBe(top.id);
        expect(groups.find((group) => group.id === top.id)?.memberIds).toContain(member.id);
        expect(existsSync(dir)).toBe(false);
        const trash = path.join(data, 'orgs', 'default', '.trash', 'groups');
        expect(readdirSync(trash).some((name) => name.startsWith(`${middle.id}-`))).toBe(true);

        const again = await ui.request('org.saveGroup', { name: 'Middle' });
        expect((await ui.request('org.readGroup', { groupId: again.id })).prompt).toBe('');

        // At the first level what it held reports to the chief.
        await ui.request('org.deleteGroup', { groupId: top.id });
        const left = await groupsOf(ui);
        expect(left.find((group) => group.id === bottom.id)?.parentId).toBeUndefined();
        expect(left.some((group) => group.memberIds.includes(member.id))).toBe(false);
    });

    it('never picks a folder left behind for a new group', async () => {
        const data = newData();
        const { ui } = await host.start(data);
        mkdirSync(path.join(data, 'orgs', 'default', 'groups', 'leftover'), { recursive: true });
        const group = await ui.request('org.saveGroup', { name: 'Leftover' });
        expect(group.id).not.toBe('leftover');
    });

    it('keeps leads apart from members', async () => {
        const { ui } = await host.start(newData());
        const boss = await lead(ui, '老大');
        const group = await ui.request('org.saveGroup', { name: 'Web', leaderId: boss.id });
        const other = await ui.request('org.saveGroup', { name: 'Api' });
        await expect(ui.request('org.moveMember', { memberId: boss.id, groupId: other.id })).rejects.toThrow('老大');
        await expect(ui.request('org.saveGroup', { name: 'Bad', leaderId: 'coder' })).rejects.toThrow('coder');

        // A supervisor is listed as a member nowhere, and a new one can take a group without a lead.
        const saved = await ui.request('org.saveGroup', { id: other.id, name: 'Api', memberIds: [boss.id, 'coder'] });
        expect(saved.memberIds).toEqual(['coder']);
        const second = await ui.request('member.save', {
            scope: 'user',
            member: { name: '接口负责人', role: 'supervisor', tier: 'flagship', mode: 'plan', prompt: '' },
            groupId: other.id,
        });
        expect((await groupsOf(ui)).find((item) => item.id === other.id)?.leaderId).toBe(second.id);
        await expect(
            ui.request('member.save', {
                scope: 'user',
                member: { name: '第二个负责人', role: 'supervisor', tier: 'flagship', mode: 'plan', prompt: '' },
                groupId: group.id,
            }),
        ).rejects.toThrow('Web');
    });

    it('reads what 1.1.0 wrote, and leaves a file 1.1.0 can read and the old one beside it', async () => {
        const data = newData();
        const dir = path.join(data, 'orgs', 'default');
        mkdirSync(dir, { recursive: true });
        const old = {
            version: 1,
            groups: [{ id: 'web', name: 'Web', leaderId: 'supervisor', memberIds: ['coder'] }],
        };
        writeFileSync(path.join(dir, 'groups.json'), JSON.stringify(old));
        const { ui } = await host.start(data);
        expect(await groupsOf(ui)).toEqual(old.groups);

        await ui.request('org.saveGroup', { name: 'Sub', parentId: 'web' });
        const written = JSON.parse(readFileSync(path.join(dir, 'groups.json'), 'utf8')) as {
            version: number;
            groups: OrgGroup[];
        };
        expect(written.version).toBe(2);
        // 1.1.0 keeps a group only with a string for its lead.
        expect(written.groups.every((group) => typeof group.leaderId === 'string')).toBe(true);
        expect(JSON.parse(readFileSync(path.join(dir, 'groups.v1.json'), 'utf8'))).toEqual(old);
        // The backup is of the old format only: saving again leaves it.
        await ui.request('org.saveGroup', { name: 'Sub2', parentId: 'web' });
        expect(JSON.parse(readFileSync(path.join(dir, 'groups.v1.json'), 'utf8'))).toEqual(old);
    });

    it('lets a lead take several organizations, the way 1.1.0 kept them', async () => {
        const data = newData();
        const dir = path.join(data, 'orgs', 'default');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            path.join(dir, 'groups.json'),
            JSON.stringify({
                version: 1,
                groups: [
                    { id: 'default', name: '研发团队', leaderId: 'supervisor', memberIds: ['writer'] },
                    { id: 'web', name: 'Web', leaderId: 'supervisor', memberIds: ['coder'] },
                    { id: 'ios', name: 'Ios', leaderId: 'supervisor', memberIds: ['scout'] },
                ],
            }),
        );
        const { ui } = await host.start(data);

        // Editing one keeps its lead, and a new one can have the same lead.
        await ui.request('org.saveGroup', { id: 'web', name: 'Web', prompt: '逆向的规矩' });
        const api = await ui.request('org.saveGroup', { name: 'Api', leaderId: 'supervisor' });
        expect(api.leaderId).toBe('supervisor');

        // A template led by the same supervisor takes it from nobody: a group without a lead takes no work.
        await ui.request('org.applyTemplate', { template: 'dev-team', replace: false });
        const leads = new Map((await groupsOf(ui)).map((group) => [group.id, group.leaderId]));
        for (const id of ['default', 'web', 'ios', api.id, 'dev']) expect(leads.get(id)).toBe('supervisor');

        // Leading the organization above as well, in either order in the file, it is nobody's supervisor but its own.
        const line: OrgGroup[] = [
            { id: 'top', name: 'Top', leaderId: 'boss', memberIds: [] },
            { id: 'mid', name: 'Mid', parentId: 'top', leaderId: 'boss', memberIds: [] },
            { id: 'low', name: 'Low', parentId: 'mid', leaderId: 'sub', memberIds: ['one'] },
        ];
        for (const groups of [line, [...line].reverse()]) {
            expect(supervisorOf(groups, 'one')).toBe('sub');
            expect(supervisorOf(groups, 'sub')).toBe('boss');
            expect(supervisorOf(groups, 'boss')).toBeUndefined();
        }
    });

    it('lists every built-in persona to hire, and which of them are in the organization (19 §15)', async () => {
        const { ui } = await host.start(newData());
        const { personas } = await ui.request('member.catalog', {});
        expect(personas.length).toBeGreaterThanOrEqual(12);
        const byId = new Map(personas.map((persona) => [persona.id, persona]));
        expect(byId.get('coder')).toMatchObject({ state: 'hired', groupId: 'default', name: '编码', role: 'executor' });
        expect(byId.get('frontend')).toMatchObject({ state: 'available', name: '前端工程师', role: 'executor' });
        expect(byId.get('frontend')?.prompt).toContain('frontend');
        expect(byId.get('frontend')?.groupId).toBeUndefined();

        // One hired from the market keeps its id, so the market knows it; a deleted built-in shows as such.
        await ui.request('member.delete', { memberId: 'scout' });
        const hired = await ui.request('member.save', {
            scope: 'user',
            member: {
                id: 'frontend',
                name: '前端工程师',
                role: 'executor',
                tier: 'economy',
                mode: 'auto_edit',
                prompt: byId.get('frontend')?.prompt ?? '',
            },
            groupId: 'default',
            allowNewId: true,
        });
        expect(hired.id).toBe('frontend');
        const after = new Map(
            (await ui.request('member.catalog', {})).personas.map((persona) => [persona.id, persona]),
        );
        expect(after.get('scout')?.state).toBe('removed');
        expect(after.get('frontend')).toMatchObject({ state: 'hired', groupId: 'default' });
        // An id that is not free, or not a persona's shape, is still refused.
        await expect(
            ui.request('member.save', {
                scope: 'user',
                member: {
                    id: 'Not Valid',
                    name: '怪名',
                    role: 'executor',
                    tier: 'economy',
                    mode: 'auto_edit',
                    prompt: '',
                },
                allowNewId: true,
            }),
        ).rejects.toThrow();
    });

    it('reads a file with a parent gone or a circle as a tree', async () => {
        const data = newData();
        const dir = path.join(data, 'orgs');
        mkdirSync(path.join(dir, 'default'), { recursive: true });
        writeFileSync(
            path.join(dir, 'default', 'groups.json'),
            JSON.stringify({
                version: 2,
                groups: [
                    { id: 'a', name: 'A', parentId: 'b', leaderId: '', memberIds: [] },
                    { id: 'b', name: 'B', parentId: 'a', leaderId: '', memberIds: [] },
                    { id: 'c', name: 'C', parentId: 'gone', leaderId: '', memberIds: [] },
                ],
            }),
        );
        const groups = (await readGroups(dir)) ?? [];
        expect(groups.find((group) => group.id === 'c')?.parentId).toBeUndefined();
        for (const group of groups) {
            expect(groupChain(groups, group.id).at(0)?.parentId).toBeUndefined();
        }
    });
});

describe('prompts of the organization', () => {
    it('keeps a group’s prompt in its folder and the settings of org.md when its body changes', async () => {
        const data = newData();
        const dir = path.join(data, 'orgs', 'default');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'org.md'), '---\nautonomy: L1\n---\n原来的全体提示词\n');
        const { ui } = await host.start(data);
        expect(await ui.request('org.root', {})).toEqual({ prompt: '原来的全体提示词', dir });
        await ui.request('org.saveRoot', { prompt: '新的全体提示词' });
        expect(readFileSync(path.join(dir, 'org.md'), 'utf8')).toBe('---\nautonomy: L1\n---\n新的全体提示词\n');

        const group = await ui.request('org.saveGroup', { name: 'Web', prompt: '  前端规范  ' });
        expect(await ui.request('org.readGroup', { groupId: group.id })).toEqual({
            prompt: '前端规范',
            dir: path.join(dir, 'groups', group.id),
        });
        // Saving without a prompt leaves it.
        await ui.request('org.saveGroup', { id: group.id, name: 'Web', description: '做页面' });
        expect((await ui.request('org.readGroup', { groupId: group.id })).prompt).toBe('前端规范');
        await expect(ui.request('org.readGroup', { groupId: 'nope' })).rejects.toThrow('nope');
    });

    it('shows the built-in prompt until the user writes one, and brings it back when emptied', async () => {
        const { ui } = await host.start(newData());
        const builtin = (await ui.request('org.root', {})).prompt;
        expect(builtin.length).toBeGreaterThan(0);
        await ui.request('org.saveRoot', { prompt: '我们的规矩' });
        expect((await ui.request('org.root', {})).prompt).toBe('我们的规矩');
        await ui.request('org.saveRoot', { prompt: '' });
        expect((await ui.request('org.root', {})).prompt).toBe(builtin);
    });
});

describe('a member’s numbers', () => {
    const record = (
        core: Awaited<ReturnType<typeof host.start>>['core'],
        projectId: string,
        memberId: string | undefined,
        tokens: number,
        run?: string,
    ) =>
        core.usage.record({
            projectId,
            threadId: `t-${tokens}`,
            turnId: 'turn',
            ...(memberId ? { memberId } : {}),
            ...(run ? { workflowRunId: run } : {}),
            engine: 'xora',
            provider: 'deepseek',
            model: 'deepseek-flash',
            usage: {
                inputTokens: tokens,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 1,
                reasoningTokens: 0,
            },
            latencyMs: 1,
            status: 'ok',
            source: 'vendor',
        });

    it('adds up its tokens and its recent projects, a run counting once', async () => {
        const { ui, core } = await host.start(newData());
        const first = await ui.request('project.add', { path: gitRepo() });
        const second = await ui.request('project.add', { path: gitRepo() });
        record(core, first.id, 'coder', 100, 'team-1');
        record(core, first.id, 'coder', 200, 'team-1');
        record(core, second.id, 'coder', 300);
        // Another member, and a request of nobody's.
        record(core, first.id, 'coder-2', 400);
        record(core, first.id, undefined, 500);
        const stats = await ui.request('member.stats', { memberId: 'coder' });
        expect(stats.usage.all).toMatchObject({ requests: 3, inputTokens: 600, outputTokens: 3 });
        expect(stats.usage.recent.inputTokens).toBe(600);
        expect(stats.projects.map((project) => [project.projectId, project.name, project.works])).toEqual([
            [second.id, second.name, 1],
            [first.id, first.name, 1],
        ]);
        expect(existsSync(stats.dir)).toBe(true);
        expect(stats.score).toEqual({ count: 0, recent: [] });
    });

    it('counts a helper’s requests for the member it works for, and a member’s for itself', () => {
        const thread = (extra: Partial<ThreadMeta>) => ({ id: 't', ...extra }) as ThreadMeta;
        const member = thread({ id: 'parent', agentId: 'coder' });
        const find = (id: string) => (id === 'parent' ? member : undefined);
        const parent = { threadId: 'parent', turnId: 'x' };
        expect(workerOf(thread({ agentId: 'coder-T1', taskId: 'T1', teamRunId: 'r' }), find)).toBe('coder');
        expect(workerOf(thread({ agentId: 'coder-2' }), find)).toBe('coder-2');
        // An agent file's name, or no agent at all: the member that started it.
        expect(workerOf(thread({ parent, agentId: 'explore' }), find)).toBe('coder');
        expect(workerOf(thread({ parent }), find)).toBe('coder');
        // A member called as a subagent works for itself.
        expect(workerOf(thread({ parent, agentId: 'tester', role: 'executor' }), find)).toBe('tester');
        expect(workerOf(thread({}), find)).toBeUndefined();
    });
});
