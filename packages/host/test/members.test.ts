import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Item, ItemOf, ThreadMeta } from '@xora/protocol';
import { type MockModelServer, startMockModelServer } from '@xora/test-kit';
import { SCOUT_PROMPT } from '@xora/workflows';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MEMORY_FILE_CHARS, routineKey } from '../src/members.ts';
import { fakeGitHub, SHA } from './github-fake.ts';
import {
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
 * Members (06 §18): the organization's agents as the user sees them, with their files, a memory each keeps itself,
 * conversations, routines on a schedule and `@` mentions. The real host and xora engine against a scripted model.
 */

let engineEntry = '';
let server: MockModelServer;
const host = hosts(() => engineEntry);

const bodies = () =>
    server.requests.flatMap((request) => {
        const body = request.body as ChatBody | undefined;
        return body?.messages ? [body] : [];
    });
const systemOf = (body: ChatBody | undefined) =>
    textOf(body?.messages.find((message) => message.role === 'system')?.content);
const toolNames = (body: ChatBody | undefined) => body?.tools?.map((tool) => tool.function.name) ?? [];
const signal = () => new AbortController().signal;

function today(): string {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function setUp(files: Record<string, string> = {}, connect = true, hub?: typeof fetch) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-members-data-'));
    const harness = await host.start(dataDir, hub ? { fetch: hub } : {});
    if (connect) await connectMock(harness.ui, server);
    const project = await harness.ui.request('project.add', { path: gitRepo(files) });
    return { ...harness, dataDir, project };
}

/** The end of a thread's latest turn. */
async function settled(ui: Ui, threadId: string): Promise<string> {
    return waitFor(async () => {
        const read = await ui.request('thread.read', { threadId });
        const ended = read.events.filter((event) => event.kind === 'turn.completed' || event.kind === 'turn.failed');
        const started = read.events.filter((event) => event.kind === 'turn.started');
        return ended.length > 0 && ended.length === started.length ? (ended.at(-1)?.kind as string) : undefined;
    }, `the turn of ${threadId}`);
}

async function firstUserText(ui: Ui, threadId: string): Promise<string> {
    const read = await ui.request('thread.read', { threadId });
    const started = read.events.find((event) => event.kind === 'turn.started')?.payload as { input: { text: string } };
    return started.input.text;
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

describe('members', () => {
    it('lists the built-in members by their names in the UI language, then the user’s and the project’s', async () => {
        const packet = '---\nname: 抓包侦察\nrole: scout\ndescription: 抓app的接口\n---\n只抓包，不改代码。\n';
        const { ui, dataDir, project } = await setUp({ '.xora/agents/packet.md': packet });
        const userAgents = path.join(dataDir, 'orgs', 'default', 'agents');
        mkdirSync(userAgents, { recursive: true });
        writeFileSync(
            path.join(userAgents, 'daily.md'),
            '---\nname: 日报员\nrole: executor\ncategory: docs\n---\n写日报。\n',
        );

        const mine = await ui.request('member.list', {});
        expect(mine.find((member) => member.id === 'scout')).toMatchObject({
            name: '侦察',
            role: 'scout',
            tier: 'fast',
            mode: 'plan',
            prompt: SCOUT_PROMPT,
            source: 'builtin',
            customized: false,
            memory: { chars: 0 },
            routines: [],
        });
        expect(mine.find((member) => member.id === 'supervisor')?.name).toBe('主管');
        expect(mine.find((member) => member.id === 'daily')).toMatchObject({
            name: '日报员',
            role: 'executor',
            category: 'docs',
            mode: 'auto_edit',
            prompt: '写日报。',
            source: 'user',
            customized: false,
            file: path.join(userAgents, 'daily.md'),
        });
        // A project's member files only count once the project is trusted, and only in that project.
        expect((await ui.request('member.list', { projectId: project.id })).map((member) => member.id)).not.toContain(
            'packet',
        );
        await ui.request('project.trust', { projectId: project.id, trusted: true });
        const theirs = await ui.request('member.list', { projectId: project.id });
        expect(theirs.find((member) => member.id === 'packet')).toMatchObject({
            name: '抓包侦察',
            description: '抓app的接口',
            source: 'project',
            role: 'scout',
            tier: 'fast',
            mode: 'plan',
        });
        expect(theirs.map((member) => member.id)).toEqual(expect.arrayContaining(['supervisor', 'daily', 'packet']));
        expect(mine.map((member) => member.id)).not.toContain('packet');

        // English names in English.
        await ui.request('settings.update', { patch: { language: 'en' } });
        expect((await ui.request('member.list', {})).find((member) => member.id === 'scout')?.name).toBe('Scout');
    }, 60_000);

    it('saves members into files: an id from the name, a changed built-in one, one only for a project', async () => {
        const { ui, dataDir, project } = await setUp();
        const userAgents = path.join(dataDir, 'orgs', 'default', 'agents');
        const changed: string[] = [];
        ui.onNotification('member.changed', ({ memberId }) => changed.push(memberId));
        const input = {
            name: "Bob's #1 QA",
            role: 'scout',
            tier: 'fast',
            model: 'kimi-k3',
            mode: 'plan' as const,
            description: '看: 文件 # 不是注释',
            prompt: '只看不改。',
        };
        const bob = await ui.request('member.save', { scope: 'user', member: input });
        expect(bob).toMatchObject({
            id: 'bob-s-1-qa',
            model: 'kimi-k3',
            name: "Bob's #1 QA",
            description: '看: 文件 # 不是注释',
            prompt: '只看不改。',
            source: 'user',
            file: path.join(userAgents, 'bob-s-1-qa.md'),
        });
        expect(changed).toContain('bob-s-1-qa');
        // Names are unique (agent files override a member of the same name); ids too.
        await expect(ui.request('member.save', { scope: 'user', member: input })).rejects.toThrow(
            "已经有成员叫“Bob's #1 QA”了",
        );
        await expect(ui.request('member.save', { scope: 'user', member: { ...input, name: 'scout' } })).rejects.toThrow(
            '已经有成员叫',
        );
        await expect(ui.request('member.save', { scope: 'user', member: { ...input, name: '侦察' } })).rejects.toThrow(
            '已经有成员叫',
        );
        expect((await ui.request('member.save', { scope: 'user', member: { ...input, name: 'Bob s 1 QA' } })).id).toBe(
            'bob-s-1-qa-2',
        );
        const chinese = await ui.request('member.save', { scope: 'user', member: { ...input, name: '冒烟侦察' } });
        expect(chinese).toMatchObject({ name: '冒烟侦察' });
        expect(chinese.id).toMatch(/^member-[0-9a-f]{6}$/);

        // Changing a built-in member writes the user's file over it; its prompt left as it was stays out of the
        // file, so it follows the app's updates.
        const scout = (await ui.request('member.list', {})).find((member) => member.id === 'scout');
        const custom = await ui.request('member.save', {
            scope: 'user',
            member: {
                id: 'scout',
                name: '抓包侦察',
                role: 'scout',
                tier: 'standard',
                mode: 'plan',
                prompt: scout?.prompt ?? '',
            },
        });
        expect(custom).toMatchObject({
            id: 'scout',
            name: '抓包侦察',
            tier: 'standard',
            source: 'builtin',
            customized: true,
            prompt: SCOUT_PROMPT,
        });
        expect(readFileSync(path.join(userAgents, 'scout.md'), 'utf8')).not.toContain('You are a scout');

        await expect(ui.request('member.save', { scope: 'user', member: { ...input, role: 'boss' } })).rejects.toThrow(
            '角色boss不对',
        );
        await expect(
            ui.request('member.save', { scope: 'user', member: { ...input, id: 'nobody', name: 'x' } }),
        ).rejects.toThrow('没有成员nobody');
        // A member of one project only: written into the project once it is trusted.
        const local = { projectId: project.id, scope: 'project' as const, member: { ...input, name: 'Local helper' } };
        await expect(ui.request('member.save', local)).rejects.toThrow('还没有被信任');
        await ui.request('project.trust', { projectId: project.id, trusted: true });
        expect(await ui.request('member.save', local)).toMatchObject({
            id: 'local-helper',
            source: 'project',
            file: path.join(project.path, '.xora', 'agents', 'local-helper.md'),
        });
        expect((await ui.request('member.list', {})).map((member) => member.id)).not.toContain('local-helper');
        // Moved to every project: the project's file goes.
        const moved = await ui.request('member.save', {
            projectId: project.id,
            scope: 'user',
            member: { ...input, id: 'local-helper', name: 'Local helper' },
        });
        expect(moved).toMatchObject({ source: 'user', file: path.join(userAgents, 'local-helper.md') });
        expect((await ui.request('member.list', {})).map((member) => member.id)).toContain('local-helper');

        // 06 §24: a built-in member leaves the team when deleted and comes back with a reset; a changed one goes back
        // to its default with a reset; the user's goes.
        await ui.request('member.delete', { memberId: 'coder' });
        expect((await ui.request('member.list', {})).map((member) => member.id)).not.toContain('coder');
        await ui.request('member.reset', { memberId: 'coder' });
        expect((await ui.request('member.list', {})).map((member) => member.id)).toContain('coder');
        await ui.request('member.reset', { memberId: 'scout' });
        expect((await ui.request('member.list', {})).find((member) => member.id === 'scout')).toMatchObject({
            name: '侦察',
            tier: 'fast',
            customized: false,
        });
        await ui.request('member.delete', { memberId: 'bob-s-1-qa' });
        expect((await ui.request('member.list', {})).map((member) => member.id)).not.toContain('bob-s-1-qa');
    }, 60_000);

    it('keeps a memory: notes go in and are replaced, the oldest make room, secrets stay out', async () => {
        const { core, ui, project } = await setUp();
        const provider = core.members.withMemory(
            { tools: [], handle: async () => ({ content: 'own tool' }) },
            { id: 'scout', name: 'Scout' },
            project.id,
        );
        const remember = (input: unknown) => provider.handle('remember', input, signal());
        expect(provider.tools.map((tool) => tool.name)).toEqual(['remember', 'recall']);
        expect(await remember({ note: '  测试用 pnpm test\n跑  ' })).toEqual({ content: '记下了。' });
        expect(await remember({ note: '测试用 pnpm test 跑' })).toEqual({ content: '这条已经记过了。' });
        // A note goes to the member's notes in the project by default (06 §21).
        const here = { memberId: 'scout', scope: 'project' as const, projectId: project.id };
        expect((await ui.request('member.memory', { memberId: 'scout' })).text).toBe('');
        const memory = await ui.request('member.memory', here);
        expect(memory.text).toBe(`- [${project.name} ${today()}] 测试用 pnpm test 跑\n`);
        expect(memory.updatedAt).toBeGreaterThan(0);
        expect(await remember({ note: '测试用 pnpm vitest 跑', replaces: 'PNPM TEST' })).toEqual({
            content: '换掉了原来那条。',
        });
        expect((await ui.request('member.memory', here)).text).toBe(
            `- [${project.name} ${today()}] 测试用 pnpm vitest 跑\n`,
        );
        expect(await remember({ note: '别的', replaces: '没有这条' })).toMatchObject({ isError: true });
        expect(await remember({ note: 'key是sk-abcdefghijklmnopqrstuvwx' })).toMatchObject({
            isError: true,
            content: expect.stringContaining('密钥'),
        });
        expect(await remember({ note: '长'.repeat(501) })).toMatchObject({ isError: true });
        expect(await remember({})).toMatchObject({ isError: true });
        expect(await provider.handle('step_result', {}, signal())).toEqual({ content: 'own tool' });

        // The user's edit; past the size limit a new note pushes out the oldest.
        const old = Array.from(
            { length: 200 },
            (_, index) => `- [旧项目 2026-10-01] 第${index}条：${'很长的笔记'.repeat(16)}`,
        );
        await ui.request('member.setMemory', { ...here, text: old.join('\r\n') });
        expect((await ui.request('member.memory', here)).text.length).toBeGreaterThan(MEMORY_FILE_CHARS);
        expect((await remember({ note: '新的一条' })).content).toMatch(
            /^记下了。 记忆超过16000字，删掉了最早的\d+条。$/,
        );
        const capped = (await ui.request('member.memory', here)).text;
        expect(capped.length).toBeLessThanOrEqual(MEMORY_FILE_CHARS);
        expect(capped).not.toContain('第0条：');
        expect(capped.trim().split('\n').at(-1)).toBe(`- [${project.name} ${today()}] 新的一条`);
        // The prompt carries the latest notes, read afresh for every turn.
        const layer = provider.layers?.at(-1);
        expect(layer).toMatchObject({ id: 'member_memory', title: '记忆：侦察' });
        expect(layer?.text).toContain('新的一条');
        expect(layer?.text).toContain('（更早的笔记没有放进来）');
        expect(layer?.text).not.toContain('第0条：');

        await ui.request('member.setMemory', { ...here, text: '  ' });
        expect(await ui.request('member.memory', here)).toEqual({ text: '', projects: [] });
        expect((await ui.request('member.list', {})).find((member) => member.id === 'scout')?.memory).toEqual({
            chars: 0,
        });
        expect(provider.layers?.at(-1)?.text).toContain('（还没有笔记）');
    }, 60_000);

    it('splits the memory: general, per project and the team’s; old notes move to their project; recall finds them all', async () => {
        const { core, ui, dataDir, project } = await setUp();
        // The single memory file of before: one note names this project, one an unknown project, one none.
        const folder = path.join(dataDir, 'members', 'coder');
        mkdirSync(folder, { recursive: true });
        writeFileSync(
            path.join(folder, 'memory.md'),
            [
                `- [${project.name} 2026-10-30] 构建用 pnpm build`,
                '- [别的项目 2026-10-01] 那边用 make',
                '- 回答先给结论',
            ].join('\n'),
        );
        // Untagged notes stay general; a removed project's notes keep its name as a project of their own.
        expect((await ui.request('member.memory', { memberId: 'coder' })).text).toBe('- 回答先给结论\n');
        const moved = await ui.request('member.memory', { memberId: 'coder', scope: 'project', projectId: project.id });
        expect(moved.text).toBe(`- [${project.name} 2026-10-30] 构建用 pnpm build\n`);
        expect(moved.projects).toEqual(
            expect.arrayContaining([
                { projectId: project.id, name: project.name, chars: moved.text.trim().length },
                expect.objectContaining({ name: '别的项目' }),
            ]),
        );

        const coder = core.members.withMemory(
            { tools: [], handle: async () => ({ content: '' }) },
            { id: 'coder', name: 'Coder' },
            project.id,
        );
        const scout = core.members.withMemory(
            { tools: [], handle: async () => ({ content: '' }) },
            { id: 'scout', name: 'Scout' },
            project.id,
        );
        expect(await coder.handle('remember', { note: '用户要求提交信息写中文', scope: 'member' }, signal())).toEqual({
            content: '记下了。',
        });
        expect(await scout.handle('remember', { note: '接口文档在 docs/api.md', scope: 'team' }, signal())).toEqual({
            content: '记下了。',
        });
        // Each prompt carries the three parts of this project; the team's notes reach every member.
        const layer = coder.layers?.at(-1)?.text ?? '';
        expect(layer).toContain('【通用】');
        expect(layer).toContain('用户要求提交信息写中文');
        expect(layer).toContain('构建用 pnpm build');
        expect(layer).toContain('接口文档在 docs/api.md');
        expect(layer).not.toContain('那边用 make');
        expect(scout.layers?.at(-1)?.text).toContain('接口文档在 docs/api.md');
        expect(scout.layers?.at(-1)?.text).not.toContain('构建用 pnpm build');
        // recall reaches another member's notes, says whose they are, and finds Chinese words inside a note.
        const found = await scout.handle('recall', { query: '构建' }, signal());
        expect(found.content).toContain('找到1条');
        expect(found.content).toContain(`(编码 · ${project.name})`);
        expect(found.content).toContain('构建用 pnpm build');
        expect((await scout.handle('recall', { query: '接口文档' }, signal())).content).toContain('(全体 · ');
        expect((await scout.handle('recall', { query: '不存在的事' }, signal())).content).toBe(
            '记忆里没有和“不存在的事”有关的笔记',
        );
        expect((await ui.request('member.list', {})).find((member) => member.id === 'coder')?.memory).toMatchObject({
            projects: 2,
        });
        // A general note carries its date alone.
        expect((await ui.request('member.memory', { memberId: 'coder' })).text).toContain(
            `- [${today()}] 用户要求提交信息写中文`,
        );
    }, 60_000);

    it('designs a member in a conversation: finds a skill on GitHub, installs it once approved, and the member brings it', async () => {
        const assistant = (body: ChatBody) => systemOf(body).includes('You are the organization assistant');
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (!assistant(body)) {
                return say(systemOf(body).includes('<member_skills') ? '我有web-scraper。' : '没有skill。');
            }
            const last = body.messages.at(-1);
            if (last?.role !== 'tool') return call({ name: 'member_list', arguments: {} });
            switch (lastCall(body)) {
                case 'member_list':
                    return call({ name: 'skill_search', arguments: { query: 'web scraping' } });
                case 'skill_search':
                    return call({
                        name: 'skill_install',
                        arguments: { repo: 'acme/skills', path: 'skills/web-scraper/SKILL.md', ref: SHA },
                    });
                case 'skill_install':
                    return call({
                        name: 'member_save',
                        arguments: {
                            name: '爬虫手',
                            role: 'executor',
                            category: 'data',
                            job: '抓网页数据',
                            prompt: '你负责抓取网页数据，先看robots.txt，控制频率。',
                            tier: 'economy',
                            mode: 'auto_edit',
                            skills: ['web-scraper'],
                        },
                    });
                default:
                    return say('建好了“爬虫手”，在线程里@爬虫手就能派活。');
            }
        });
        const github = fakeGitHub();
        const { ui, dataDir, project } = await setUp({}, true, github.fetch);
        const seen = approveAll(ui);
        const thread = await ui.request('member.assistant', {
            projectId: project.id,
            text: '我要一个会爬网页的成员',
        });
        expect(thread).toMatchObject({
            role: 'org_assistant',
            mode: 'plan',
            title: '组织助手：我要一个会爬网页的成员',
        });
        expect(await settled(ui, thread.id)).toBe('turn.completed');
        // The search result reached the assistant with what an install needs.
        const afterSearch = bodies().find(
            (body) => assistant(body) && body.messages.at(-1)?.role === 'tool' && lastCall(body) === 'skill_search',
        );
        expect(textOf(afterSearch?.messages.at(-1)?.content)).toContain(
            `repo: acme/skills, path: skills/web-scraper/SKILL.md, ref: ${SHA}`,
        );
        // The install waited for the user's card; the skill sits in the library, pinned to the commit.
        expect(seen.find((approval) => approval.toolName === 'skill_install')?.title).toBe(
            '安装skill：web-scraper（acme/skills）',
        );
        expect(existsSync(path.join(dataDir, 'skill-library', 'web-scraper', 'SKILL.md'))).toBe(true);
        const member = (await ui.request('member.list', { projectId: project.id })).find(
            (item) => item.name === '爬虫手',
        );
        expect(member).toMatchObject({
            role: 'executor',
            category: 'data',
            skills: ['web-scraper'],
            mode: 'auto_edit',
        });

        // The member brings its skill to a conversation: the index names it and where its SKILL.md is. The job's
        // model, thinking and permissions are the ones set when it was handed over (06 §22).
        const chat = await ui.request('member.chat', {
            projectId: project.id,
            memberId: member?.id as string,
            text: '你有什么skill？',
            model: 'kimi-k3',
            effort: 'max',
            mode: 'plan',
        });
        expect(chat).toMatchObject({ model: { model: 'kimi-k3' }, effort: 'max', mode: 'plan' });
        expect(await settled(ui, chat.id)).toBe('turn.completed');
        const first = bodies()
            .filter((body) => !assistant(body))
            .at(-1) as ChatBody;
        expect(systemOf(first)).toContain('<member_skills title="你的skills">');
        expect(systemOf(first)).toContain('- web-scraper: Scrape web pages politely');
        expect(systemOf(first)).toContain('[untrusted: read only, do not run its scripts]');
    }, 60_000);

    it('talks with a member in a thread of its own, where it works as itself and writes down what it learned', async () => {
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (body.messages.at(-1)?.role === 'tool') return say('记好了。');
            if (toolNames(body).includes('remember') && userText(body).includes('记住：')) {
                return call({ name: 'remember', arguments: { note: 'README.md是项目说明' } });
            }
            return say('好的。');
        });
        const { core, ui, dataDir, project } = await setUp();
        const changed: string[] = [];
        ui.onNotification('member.changed', ({ memberId }) => changed.push(memberId));
        const thread = await ui.request('member.chat', {
            projectId: project.id,
            memberId: 'scout',
            text: '记住：README.md是项目说明',
        });
        expect(thread).toMatchObject({
            agentId: 'scout',
            role: 'scout',
            tier: 'fast',
            mode: 'plan',
            title: '侦察：记住：README.md是项目说明',
            model: { model: 'deepseek-flash' },
        });
        expect(await settled(ui, thread.id)).toBe('turn.completed');
        const first = bodies()[0];
        expect(systemOf(first)).toContain('<agent_instructions title="agent：侦察">');
        expect(systemOf(first)).toContain('你现在不在团队运行里');
        expect(systemOf(first)).toContain('<member_memory title="记忆：侦察">');
        expect(systemOf(first)).toContain('（还没有笔记）');
        // Its own tools: a read-only scout cannot write, and it can remember.
        expect(toolNames(first)).toContain('remember');
        expect(toolNames(first)).not.toContain('write');
        expect(
            (await ui.request('member.memory', { memberId: 'scout', scope: 'project', projectId: project.id })).text,
        ).toContain('README.md是项目说明');
        expect(changed).toContain('scout');

        // The next conversation knows it; another tier's member works on that tier's model.
        const before = bodies().length;
        const second = await ui.request('member.chat', {
            projectId: project.id,
            memberId: 'scout',
            text: '项目说明在哪？',
        });
        await settled(ui, second.id);
        expect(systemOf(bodies()[before])).toContain(`- [${project.name} ${today()}] README.md是项目说明`);
        const review = await ui.request('member.chat', { projectId: project.id, memberId: 'reviewer', text: '看看' });
        expect(review).toMatchObject({ agentId: 'reviewer', model: { model: 'kimi-k3' }, mode: 'plan' });
        await settled(ui, review.id);
        await expect(
            ui.request('member.chat', { projectId: project.id, memberId: 'nobody', text: '在吗' }),
        ).rejects.toThrow('nobody不在项目');

        const work = await ui.request('member.threads', { memberId: 'scout' });
        expect(work.map((item) => item.id)).toEqual([second.id, thread.id]);
        expect(core.turns.hostLayers(thread.id).map((layer) => layer.id)).toContain('member_memory');

        // After a restart its conversations work as it again.
        await host.closeLast();
        const again = await host.start(dataDir);
        expect(again.core.turns.hostLayers(thread.id).map((layer) => layer.id)).toEqual(
            expect.arrayContaining(['agent_instructions', 'member_context', 'member_memory']),
        );
    }, 120_000);

    it('gives a workflow step’s agent its memory and the remember tool, and counts the step as its work', async () => {
        const flow = ['name: look', 'steps:', '  - id: look', '    agent: scout', '    task: 看一下README', ''].join(
            '\n',
        );
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (!toolNames(body).includes('step_result'))
                return say('## 结论\n看完了\n\n## 问题\n- 无\n\n## 下一步\n- 无');
            return body.messages.at(-1)?.role === 'tool'
                ? say('交了。')
                : call({ name: 'step_result', arguments: { summary: 'README只有标题' } });
        });
        const { ui, project } = await setUp({ '.xora/workflows/look.yaml': flow });
        approveAll(ui);
        await ui.request('member.setMemory', { memberId: 'scout', text: '- [demo 2026-11-01] README只有一行' });
        await ui.request('project.trust', { projectId: project.id, trusted: true });
        const run = await ui.request('workflow.start', { projectId: project.id, key: 'project:look' });
        await waitFor(async () => {
            const current = await ui.request('workflow.get', { runId: run.id });
            return current.status === 'completed' || current.status === 'failed' ? current.status : undefined;
        }, 'the workflow run');
        const step = bodies().find((body) => toolNames(body).includes('step_result'));
        expect(toolNames(step)).toContain('remember');
        expect(systemOf(step)).toContain('<member_memory title="记忆：侦察">');
        expect(systemOf(step)).toContain('README只有一行');
        const work = await ui.request('member.threads', { memberId: 'scout' });
        expect(work.some((thread) => thread.workflowRunId === run.id)).toBe(true);
    }, 90_000);

    it('keeps routines: checks and schedules them, runs them now or when they fire, and stops them', async () => {
        server.respondWith((request) =>
            (request.body as ChatBody | undefined)?.messages
                ? say('## 结论\n一切正常\n\n## 问题\n- 无\n\n## 下一步\n- 无')
                : undefined,
        );
        const { core, ui, dataDir, project } = await setUp();
        const routine = {
            title: '早检',
            schedule: '0 9 * * 1-5',
            projectId: project.id,
            instruction: '看一眼README.md',
            enabled: true,
        };
        const saved = await ui.request('member.saveRoutine', { memberId: 'scout', routine });
        const first = saved.routines[0] as NonNullable<(typeof saved.routines)[number]>;
        expect(first).toMatchObject({ title: '早检', schedule: '0 9 * * 1-5', projectId: project.id, enabled: true });
        expect(first.problem).toBeUndefined();
        expect(first.nextRunAt).toBeGreaterThan(Date.now());
        const key = routineKey('scout', first.id);
        // On the trigger service's schedule, keeping the app in the background.
        await waitFor(() => core.triggers.nextScheduledAt(key), 'the routine on the schedule');
        expect(core.activity().workflowTriggers).toBe(1);

        // A schedule that cannot be read is kept with its problem, not scheduled.
        const broken = await ui.request('member.saveRoutine', {
            memberId: 'scout',
            routine: { ...routine, title: '坏的', schedule: '0 25 * * *' },
        });
        expect(broken.routines.find((item) => item.title === '坏的')?.problem).toContain('时间写得不对');
        // A member of another project cannot have one here.
        await expect(ui.request('member.saveRoutine', { memberId: 'nobody', routine })).rejects.toThrow(
            'nobody不在项目',
        );

        // Now, whatever its schedule.
        const thread = await ui.request('member.runRoutine', { memberId: 'scout', routineId: first.id });
        expect(thread).toMatchObject({ title: '例行：早检', agentId: 'scout', role: 'scout', mode: 'plan' });
        expect(await settled(ui, thread.id)).toBe('turn.completed');
        const prompt = await firstUserText(ui, thread.id);
        expect(prompt).toContain('这次运行没有人在看');
        expect(prompt).toContain('看一眼README.md');
        for (const heading of ['## 结论', '## 问题', '## 下一步']) expect(prompt).toContain(heading);
        const after = (await ui.request('member.list', {})).find((member) => member.id === 'scout');
        expect(after?.routines.find((item) => item.id === first.id)).toMatchObject({ lastThreadId: thread.id });

        // A fire runs it and keeps the time it fired for, so a restart does not run it twice.
        const fired = (await core.members.fire(key, 1_800_000_000_000)) as ThreadMeta;
        expect(fired.title).toBe('例行：早检');
        await settled(ui, fired.id);
        const file = JSON.parse(readFileSync(path.join(dataDir, 'members', 'scout', 'routines.json'), 'utf8')) as {
            routines: Array<{ id: string; lastScheduledAt?: number; lastThreadId?: string }>;
        };
        expect(file.routines.find((item) => item.id === first.id)).toMatchObject({
            lastScheduledAt: 1_800_000_000_000,
            lastThreadId: fired.id,
        });
        expect((await ui.request('member.threads', { memberId: 'scout' })).map((item) => item.id)).toEqual([
            fired.id,
            thread.id,
        ]);

        // Switched off, a fire does nothing; deleted, it is off the schedule.
        await ui.request('member.saveRoutine', {
            memberId: 'scout',
            routine: { ...routine, id: first.id, enabled: false },
        });
        expect(await core.members.fire(key, 1_800_000_060_000)).toBeUndefined();
        await waitFor(() => (core.triggers.nextScheduledAt(key) === undefined ? true : undefined), 'switched off');
        await ui.request('member.deleteRoutine', { memberId: 'scout', routineId: first.id });
        const left = (await ui.request('member.list', {})).find((member) => member.id === 'scout')?.routines;
        expect(left?.map((item) => item.title)).toEqual(['坏的']);
    }, 90_000);

    it('runs a routine only on a pay-as-you-go model, and says so when there is none', async () => {
        const { core, ui, project } = await setUp({}, false);
        const kimi = await ui.request('provider.save', { presetId: 'kimi-code-cn', apiKey: 'test-key' });
        await ui.request('settings.update', { patch: { defaultModel: { connectionId: kimi.id, model: 'k3' } } });
        const saved = await ui.request('member.saveRoutine', {
            memberId: 'specialist',
            routine: { title: '夜检', schedule: '@daily', projectId: project.id, instruction: '检查', enabled: true },
        });
        const routine = saved.routines[0] as NonNullable<(typeof saved.routines)[number]>;
        await expect(
            ui.request('member.runRoutine', { memberId: 'specialist', routineId: routine.id }),
        ).rejects.toThrow('只用按量计费的模型');
        // A fire that cannot start leaves the reason on the routine.
        expect(await core.members.fire(routineKey('specialist', routine.id), Date.now())).toBeUndefined();
        const after = (await ui.request('member.list', {})).find((member) => member.id === 'specialist');
        expect(after?.routines[0]?.problem).toContain('只用按量计费的模型');
        expect(await ui.request('member.threads', { memberId: 'specialist' })).toEqual([]);
    }, 60_000);

    it('hands a message that mentions a member to it, and the subagent works as that member', async () => {
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (!toolNames(body).includes('agent')) {
                return say(systemOf(body).includes('<member_memory') ? 'README只有标题。' : '我不是成员。');
            }
            if (body.messages.at(-1)?.role === 'tool') {
                return say(`侦察说：${textOf(body.messages.at(-1)?.content)}`);
            }
            const text = userText(body);
            return text.includes('<agent_handoff>') && text.includes('@侦察')
                ? call({
                      name: 'agent',
                      arguments: { agent: '侦察', description: '看README', prompt: '看看README.md里写了什么。' },
                  })
                : say('没有交出去。');
        });
        const { ui, project } = await setUp();
        const thread = await ui.request('thread.create', { projectId: project.id, mode: 'ask' });
        await ui.request('turn.start', { threadId: thread.id, text: '@scout 看看README' });
        expect(await settled(ui, thread.id)).toBe('turn.completed');

        const parent = bodies().find((body) => toolNames(body).includes('agent'));
        const tool = parent?.tools?.find((item) => item.function.name === 'agent') as
            | { function: { description?: string; parameters?: { properties?: { agent?: { enum?: string[] } } } } }
            | undefined;
        expect(tool?.function.parameters?.properties?.agent?.enum).toContain('侦察');
        expect(tool?.function.parameters?.properties?.agent?.enum).not.toContain('主管');
        const read = await ui.request('thread.read', { threadId: thread.id });
        const items = read.events.flatMap((event) =>
            event.kind === 'item.completed' ? [(event.payload as { item: Item }).item] : [],
        );
        const card = items.find((item): item is ItemOf<'subagent'> => item.type === 'subagent');
        expect(card).toMatchObject({ status: 'completed', agent: '侦察', summary: 'README只有标题。' });
        const child = (await ui.request('thread.list', {})).find((item) => item.parent?.threadId === thread.id);
        expect(child).toMatchObject({
            id: card?.threadId,
            agentId: 'scout',
            role: 'scout',
            tier: 'fast',
            mode: 'plan',
            model: { model: 'deepseek-flash' },
        });
        const sub = bodies().find((body) => !toolNames(body).includes('agent'));
        expect(systemOf(sub)).toContain('<agent_instructions title="agent：侦察">');
        expect(systemOf(sub)).toContain('你是另一个agent启动的子agent');
        expect(systemOf(sub)).toContain('<member_memory title="记忆：侦察">');
        expect(toolNames(sub)).toContain('remember');
        expect(toolNames(sub)).not.toContain('write');
        expect(items.filter((item) => item.type === 'agent_message').at(-1)).toMatchObject({
            text: '侦察说：README只有标题。',
        });
        expect((await ui.request('member.threads', { memberId: 'scout' })).map((item) => item.id)).toEqual([child?.id]);
    }, 90_000);
});
