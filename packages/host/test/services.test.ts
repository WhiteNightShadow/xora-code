import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XoraDatabase } from '@xora/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { type ApprovalOutcome, ApprovalService, type FollowsMode } from '../src/approvals.ts';
import { Bus, type Subscriber } from '../src/bus.ts';
import type { CallFacts } from '../src/policy.ts';
import { PromptService, promptName } from '../src/prompts.ts';
import { SettingsService } from '../src/settings.ts';
import { ThreadStore } from '../src/threads.ts';
import { UsageService } from '../src/usage.ts';

const open: XoraDatabase[] = [];

function database(): XoraDatabase {
    const db = new XoraDatabase(':memory:');
    db.migrate();
    open.push(db);
    return db;
}

function recorder(bus: Bus): Array<{ method: string; params: unknown }> {
    const seen: Array<{ method: string; params: unknown }> = [];
    const subscriber: Subscriber = { notify: (method, params) => seen.push({ method, params }) };
    bus.add(subscriber);
    return seen;
}

afterEach(() => {
    for (const db of open.splice(0)) db.close();
});

describe('ThreadStore', () => {
    it('creates threads, appends events with increasing seq and broadcasts metadata', () => {
        const bus = new Bus();
        const seen = recorder(bus);
        const store = new ThreadStore(database(), bus, mkdtempSync(path.join(tmpdir(), 'xora-threads-')));
        const thread = store.create({
            projectId: 'p1',
            title: '新线程',
            engine: 'xora',
            model: null,
            mode: 'ask',
            effort: 'high',
        });
        expect(thread.lastSeq).toBe(1);
        const event = store.append(thread.id, 'thread.renamed', { title: 'x' });
        expect(event.seq).toBe(2);
        store.update(thread.id, { title: 'x', status: 'running' });
        expect(store.get(thread.id)).toMatchObject({ title: 'x', status: 'running', lastSeq: 2 });
        expect(seen.some((entry) => entry.method === 'thread.meta')).toBe(true);
        expect(store.events(thread.id, 1).map((item) => item.kind)).toEqual(['thread.renamed']);
    });

    it('marks threads left running by a crash as failed', () => {
        const store = new ThreadStore(database(), new Bus(), mkdtempSync(path.join(tmpdir(), 'xora-threads-')));
        const thread = store.create({
            projectId: 'p1',
            title: 't',
            engine: 'xora',
            model: null,
            mode: 'ask',
            effort: 'high',
        });
        store.update(thread.id, { status: 'running' });
        expect(store.recoverInterrupted()).toEqual([thread.id]);
        expect(store.get(thread.id).status).toBe('failed');
    });

    it('indexes messages for search', () => {
        const store = new ThreadStore(database(), new Bus(), mkdtempSync(path.join(tmpdir(), 'xora-threads-')));
        const thread = store.create({
            projectId: 'p1',
            title: '登录改造',
            engine: 'xora',
            model: null,
            mode: 'ask',
            effort: 'high',
        });
        store.append(thread.id, 'turn.started', {
            turnId: 'turn_1',
            input: {
                id: 'i1',
                turnId: 'turn_1',
                ts: 1,
                type: 'user_message',
                text: '给登录加短信验证码',
                attachments: [],
            },
            model: null,
            mode: 'ask',
            effort: 'high',
        });
        expect(store.search('短信验证码').map((hit) => hit.threadId)).toEqual([thread.id]);
        expect(store.search('登录').map((hit) => hit.threadId)).toEqual([thread.id]);
        expect(store.search('100%').map((hit) => hit.threadId)).toEqual([]);
    });
});

describe('SettingsService', () => {
    it('returns defaults and persists valid patches only', () => {
        const db = database();
        const settings = new SettingsService(db);
        expect(settings.get().language).toBe('system');
        settings.update({ theme: 'dark' });
        expect(new SettingsService(db).get().theme).toBe('dark');
        db.run('update settings set value_json = ? where key = ?', [
            JSON.stringify({ theme: 'neon', density: 'compact' }),
            'settings',
        ]);
        const reloaded = new SettingsService(db).get();
        expect(reloaded.theme).toBe('system');
        expect(reloaded.density).toBe('compact');
    });

    it('keeps team concurrency between 1 and 8, 3 by default', () => {
        const db = database();
        const settings = new SettingsService(db);
        expect(settings.get().team.maxParallel).toBe(3);
        expect(settings.update({ team: { maxParallel: 5 } }).team.maxParallel).toBe(5);
        expect(() => settings.update({ team: { maxParallel: 9 } })).toThrow();
        expect(() => settings.update({ team: { maxParallel: 0 } })).toThrow();
        db.run('update settings set value_json = ? where key = ?', [
            JSON.stringify({ team: { maxParallel: 20 } }),
            'settings',
        ]);
        expect(new SettingsService(db).get().team.maxParallel).toBe(3);
    });
});

describe('ApprovalService', () => {
    const facts: CallFacts = {
        toolName: 'bash',
        kind: 'execute',
        readOnly: false,
        command: 'pnpm test --run',
        readOnlyCommand: false,
        paths: [],
        outside: [],
        sensitive: [],
        external: false,
    };
    const base = {
        threadId: 't1',
        turnId: 'turn_1',
        projectId: 'p1',
        title: 'pnpm test --run',
        toolKind: 'execute' as const,
        summary: 'pnpm test --run',
        paths: [],
        risks: [],
        engine: 'xora',
    };
    const context = { mode: 'ask' as const, projectId: 'p1', projectRoot: '/work' };

    it('holds a call until the user answers and remembers "allow for this session"', async () => {
        const bus = new Bus();
        const seen = recorder(bus);
        const approvals = new ApprovalService(database(), bus);
        expect(approvals.evaluate('t1', facts, context).decision).toBe('ask');
        let id = '';
        const outcome = approvals.request(base, facts, (approval) => {
            id = approval.id;
        });
        expect(approvals.list()).toHaveLength(1);
        approvals.respond(id, 'allow_session');
        await expect(outcome).resolves.toMatchObject({ status: 'allowed', decision: 'allow_session' });
        expect(approvals.list()).toHaveLength(0);
        expect(approvals.evaluate('t1', facts, context).decision).toBe('allow');
        expect(approvals.evaluate('t2', facts, context).decision).toBe('ask');
        expect(seen.map((entry) => entry.method)).toEqual(['approval.requested', 'approval.resolved']);
    });

    it('"always allow" writes a project rule', async () => {
        const approvals = new ApprovalService(database(), new Bus());
        let id = '';
        const outcome = approvals.request(base, facts, (approval) => {
            id = approval.id;
        });
        approvals.respond(id, 'allow_always', 'project');
        await outcome;
        expect(approvals.rules()).toEqual([
            expect.objectContaining({ tool: 'bash', pattern: 'pnpm test', decision: 'allow', projectId: 'p1' }),
        ]);
        expect(approvals.evaluate('t9', facts, context).decision).toBe('allow');
    });

    it('never offers "always" for calls outside the workspace and rejects forged answers', async () => {
        const approvals = new ApprovalService(database(), new Bus());
        const outside = { ...facts, paths: ['/etc/hosts'], outside: ['/etc/hosts'] };
        let id = '';
        let scopes: string[] = [];
        const outcome = approvals.request(base, outside, (approval) => {
            id = approval.id;
            scopes = [...approval.alwaysScopes];
        });
        expect(scopes).toEqual([]);
        expect(() => approvals.respond(id, 'allow_always', 'global')).toThrow();
        expect(() => approvals.respond('a_forged', 'allow_once')).toThrow();
        approvals.cancelThread('t1');
        await expect(outcome).resolves.toEqual({ status: 'cancelled' });
    });

    it('decides the waiting tool calls of a thread again when its mode changes, and leaves every other card', async () => {
        const approvals = new ApprovalService(database(), new Bus());
        const follows: FollowsMode = { projectId: 'p1', projectRoot: '/work' };
        const outcomes = new Map<string, Promise<ApprovalOutcome>>();
        const ask = (title: string, threadId: string, follow?: FollowsMode) =>
            outcomes.set(
                title,
                approvals.request({ ...base, threadId, title }, facts, () => undefined, follow),
            );
        ask('tool call', 't1', follows);
        // A PreToolUse hook asked for this one: no mode lets it through without the user.
        ask('hook asked', 't1', { ...follows, hookAsked: true });
        // A team's or a workflow's card does not follow the thread's mode.
        ask('run card', 't1');
        ask('other thread', 't2', follows);

        approvals.reconsider('t1', 'full');
        await expect(outcomes.get('tool call')).resolves.toEqual({
            status: 'allowed',
            decision: 'allow_once',
            message: '全权模式',
            decidedBy: 'policy',
        });
        expect(approvals.list().map((approval) => approval.title)).toEqual(['hook asked', 'run card', 'other thread']);
        // "Allow once": nothing is remembered for the next call.
        expect(approvals.evaluate('t1', facts, context).decision).toBe('ask');

        approvals.reconsider('t1', 'plan');
        await expect(outcomes.get('hook asked')).resolves.toEqual({
            status: 'denied',
            decision: 'deny',
            message: '计划模式不运行会改动状态的命令',
            decidedBy: 'policy',
        });
        expect(approvals.list().map((approval) => approval.title)).toEqual(['run card', 'other thread']);
        approvals.dispose();
    });
});

describe('UsageService', () => {
    it('prices requests with the vendor table and converts to the display currency', () => {
        const db = database();
        const settings = new SettingsService(db);
        const usage = new UsageService(db, () => settings.get());
        const recorded = usage.record(
            {
                projectId: 'p1',
                threadId: 't1',
                turnId: 'turn_1',
                engine: 'xora',
                provider: 'deepseek',
                model: 'deepseek-flash',
                pricing: 'deepseek-flash@2026-10',
                usage: {
                    inputTokens: 1_000_000,
                    cachedTokens: 0,
                    cacheWriteTokens: 0,
                    outputTokens: 0,
                    reasoningTokens: 0,
                },
                latencyMs: 1000,
                status: 'ok',
                source: 'vendor',
            },
            // A Saturday: off-peak, half price.
            new Date('2026-10-31T04:00:00Z'),
        );
        expect(recorded.cost).toEqual({ amount: 1, currency: 'CNY' });
        const summary = usage.summary('all', 'model', { project: (id) => id, thread: (id) => id });
        expect(summary.totals.cost.amount).toBe(1);
        expect(summary.rows[0]?.key).toBe('deepseek/deepseek-flash');
        settings.update({ currency: 'USD', usdToCny: 8 });
        expect(usage.thread('t1').totals.cost).toEqual({ amount: 0.125, currency: 'USD' });
    });

    it('marks totals incomplete when a price is unknown', () => {
        const db = database();
        const settings = new SettingsService(db);
        const usage = new UsageService(db, () => settings.get());
        usage.record({
            projectId: 'p1',
            threadId: 't1',
            turnId: 'turn_1',
            engine: 'xora',
            provider: 'custom-openai',
            model: 'mystery',
            usage: { inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 },
            latencyMs: 10,
            status: 'ok',
            source: 'vendor',
        });
        expect(usage.thread('t1').totals.complete).toBe(false);
    });
});

describe('PromptService', () => {
    it('orders layers from global to session and walks AGENTS.md from the root down', () => {
        const data = mkdtempSync(path.join(tmpdir(), 'xora-prompts-'));
        const project = mkdtempSync(path.join(tmpdir(), 'xora-project-'));
        mkdirSync(path.join(project, 'pkg', 'web'), { recursive: true });
        writeFileSync(path.join(project, 'AGENTS.md'), 'root rules');
        writeFileSync(path.join(project, 'pkg', 'CLAUDE.md'), 'pkg rules');
        const prompts = new PromptService(path.join(data, 'prompts'), path.join(data, 'projects'));
        prompts.writeGlobal('always answer in Chinese');
        prompts.writeProject('p1', 'my private notes');
        const layers = prompts.layers({
            projectId: 'p1',
            projectRoot: project,
            cwd: path.join(project, 'pkg', 'web'),
            sessionPrompt: 'be brief',
        });
        expect(layers.map((layer) => layer.id)).toEqual([
            'user_global_instructions',
            'project_instructions',
            'project_private_instructions',
            'session_instructions',
        ]);
        const shared = layers.find((layer) => layer.id === 'project_instructions')?.text ?? '';
        expect(shared.indexOf('root rules')).toBeLessThan(shared.indexOf('pkg rules'));
    });
});

describe('prompt directory', () => {
    const layersOf = (prompts: PromptService) =>
        prompts.layers({ projectId: 'p1', projectRoot: tmpdir(), cwd: tmpdir(), sessionPrompt: '' });

    it('lists every .md file, folders included, and skips hidden files, other files and deep folders', () => {
        const dir = path.join(mkdtempSync(path.join(tmpdir(), 'xora-prompt-dir-')), 'prompts');
        mkdirSync(path.join(dir, 'mac', 'work', 'deep'), { recursive: true });
        mkdirSync(path.join(dir, '.hidden'), { recursive: true });
        writeFileSync(path.join(dir, 'daily.md'), '每天');
        writeFileSync(path.join(dir, 'mac', 'shell.MD'), 'zsh');
        writeFileSync(path.join(dir, 'mac', 'work', 'review.md'), 'review');
        writeFileSync(path.join(dir, 'mac', 'work', 'deep', 'too-deep.md'), 'no');
        writeFileSync(path.join(dir, '.hidden', 'secret.md'), 'no');
        writeFileSync(path.join(dir, '.draft.md'), 'no');
        writeFileSync(path.join(dir, 'notes.txt'), 'no');
        const prompts = new PromptService(dir, path.join(dir, '..', 'projects'));
        expect(prompts.list().map((item) => [item.name, item.chars])).toEqual([
            ['daily', 2],
            ['mac/shell', 3],
            ['mac/work/review', 6],
        ]);
        expect(prompts.read('mac/shell').text).toBe('zsh');
    });

    it('keeps global.md of 1.1.0 in use until the user picks, and applies only the prompt picked', () => {
        const dir = path.join(mkdtempSync(path.join(tmpdir(), 'xora-prompt-dir-')), 'prompts');
        let selection: string | null | undefined;
        const prompts = new PromptService(dir, path.join(dir, '..', 'projects'), () => selection);
        expect(prompts.selected()).toBeUndefined();
        expect(layersOf(prompts)).toEqual([]);

        prompts.writeGlobal('always answer in Chinese');
        expect(prompts.selected()).toBe('global');
        expect(layersOf(prompts)[0]).toMatchObject({
            id: 'user_global_instructions',
            text: 'always answer in Chinese',
            source: path.join(dir, 'global.md'),
        });

        prompts.save('mac/daily', 'use zsh');
        selection = 'mac/daily';
        expect(layersOf(prompts)[0]).toMatchObject({ text: 'use zsh', source: path.join(dir, 'mac', 'daily.md') });
        expect(prompts.readGlobal()).toBe('use zsh');

        selection = null;
        expect(prompts.selected()).toBeUndefined();
        expect(layersOf(prompts)).toEqual([]);

        // A prompt in use that went away applies nothing.
        selection = 'gone';
        expect(prompts.selected()).toBe('gone');
        expect(prompts.selectedFile()).toBeUndefined();
        expect(layersOf(prompts)).toEqual([]);
    });

    it('creates, renames into folders and removes prompts, refusing names that are taken or unsafe', () => {
        const dir = path.join(mkdtempSync(path.join(tmpdir(), 'xora-prompt-dir-')), 'prompts');
        const prompts = new PromptService(dir, path.join(dir, '..', 'projects'));
        expect(prompts.save(' daily.md ', 'a').name).toBe('daily');
        expect(() => prompts.save('daily', 'b')).toThrow(/daily/);
        prompts.save('other', 'c');
        expect(() => prompts.save('other', 'd', 'daily')).toThrow(/other/);

        const moved = prompts.save('linux/daily', 'e', 'daily');
        expect(moved).toMatchObject({ name: 'linux/daily', path: path.join(dir, 'linux', 'daily.md'), chars: 1 });
        expect(existsSync(path.join(dir, 'daily.md'))).toBe(false);
        prompts.save('daily', 'f', 'linux/daily');
        // The folder the rename emptied is gone.
        expect(existsSync(path.join(dir, 'linux'))).toBe(false);
        expect(readFileSync(path.join(dir, 'daily.md'), 'utf8')).toBe('f');

        prompts.remove('other');
        expect(prompts.list().map((item) => item.name)).toEqual(['daily']);
        expect(() => prompts.remove('other')).toThrow(/other/);
        expect(() => prompts.read('../outside')).toThrow();
        for (const bad of ['', '.hidden', 'a/../b', 'what?', 'con', 'a/b/c/d', 'x'.repeat(81)]) {
            expect(() => prompts.save(bad, 'x')).toThrow();
        }
    });

    it('lets a file the user put there keep a name new prompts cannot have', () => {
        expect(promptName('notes: work')).toBeUndefined();
        expect(promptName('notes: work', false)).toBe('notes: work');
        expect(promptName('a\\b.md')).toBe('a/b');
        if (process.platform === 'win32') return;
        const dir = path.join(mkdtempSync(path.join(tmpdir(), 'xora-prompt-dir-')), 'prompts');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'notes: work.md'), 'old');
        const prompts = new PromptService(dir, path.join(dir, '..', 'projects'));
        expect(prompts.list().map((item) => item.name)).toEqual(['notes: work']);
        prompts.save('notes: work', 'new', 'notes: work');
        expect(prompts.read('notes: work').text).toBe('new');
        expect(() => prompts.save('notes: home', 'x', 'notes: work')).toThrow();
    });
});
