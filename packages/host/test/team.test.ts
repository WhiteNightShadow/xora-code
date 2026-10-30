import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    type Approval,
    domPortTransport,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    RpcPeer,
} from '@xora/protocol';
import { XoraDatabase } from '@xora/storage';
import {
    type MockModelServer,
    type MockTurn,
    type OpenAiToolCall,
    openaiText,
    openaiToolCalls,
    startMockModelServer,
} from '@xora/test-kit';
import { createTeamRun, findAgent, loadTeamState, TaskBoard } from '@xora/workflows';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HostCore } from '../src/core.ts';
import type { Logger } from '../src/log.ts';
import { MemoryShell } from '../src/shell.ts';
import { loadTeamOrganization } from '../src/team-agents.ts';
import { SqliteTeamStore } from '../src/team-store.ts';

/**
 * M4-7 acceptance, headless: the real host and xora engine against a scripted model server. The supervisor plans
 * two cards (one depending on the other) through its tools, the host dispatches them to executors in worktrees,
 * sends one back after a failed acceptance command and re-dispatches the other a tier up after it escalates,
 * then integrates both after a restart and writes the delivery report.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSource = path.resolve(here, '../../engine/src/main.ts');
const work = mkdtempSync(path.join(tmpdir(), 'xora-team-'));
const engineEntry = path.join(work, 'engine.cjs');
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type Ui = RpcPeer<HostMethods, HostNotifications>;

interface Harness {
    readonly core: HostCore;
    readonly ui: Ui;
    close(): Promise<void>;
}

const shells = new Map<string, MemoryShell>();
const harnesses: Harness[] = [];
let server: MockModelServer;

async function startHost(dataDir: string): Promise<Harness> {
    const shell = shells.get(dataDir) ?? new MemoryShell({ dataDir });
    shells.set(dataDir, shell);
    const core = await HostCore.create({
        dataDir,
        shell,
        bundleVersion: '1.0.0-test',
        shellVersion: '1.0.0-test',
        engineEntry,
        skipShellEnv: true,
        log: quiet,
    });
    const channel = new MessageChannel();
    const hostSide = core.connectUi(domPortTransport(channel.port1));
    const ui: Ui = new RpcPeer(domPortTransport(channel.port2), { methods, notifications, timeoutMs: 60_000 });
    const harness: Harness = {
        core,
        ui,
        close: async () => {
            ui.dispose();
            hostSide.dispose();
            channel.port1.close();
            channel.port2.close();
            await core.dispose();
        },
    };
    harnesses.push(harness);
    return harness;
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 60_000) {
    const started = Date.now();
    for (;;) {
        const value = await probe();
        if (value !== undefined && value !== false) {
            return value as T;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

function gitRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-team-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'README.md'), '# demo\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
}

// The scripted team --------------------------------------------------------------------------------------

const USAGE = { prompt_tokens: 3000, completion_tokens: 400 };
const CHECK_A = `node -e "process.exit(require('fs').readFileSync('a.txt','utf8').trim()==='final'?0:1)"`;
const CHECK_B = `node -e "const f=require('fs');process.exit(f.existsSync('b.txt')&&f.readFileSync('a.txt','utf8').trim()==='final'?0:1)"`;
const CARDS = [
    {
        id: 'T1',
        title: 'Write a.txt',
        goal: 'a.txt holds the final text',
        category: 'coding',
        tier: 'economy',
        ownership: ['a.txt'],
        acceptance: [
            { type: 'command', run: CHECK_A },
            { type: 'review', by: 'reviewer' },
        ],
        deliverable: { kind: 'code-change' },
        budget: { cost: 2 },
        workspace: 'worktree',
    },
    {
        id: 'T2',
        title: 'Write b.txt',
        goal: 'b.txt sits next to the final a.txt',
        category: 'coding',
        tier: 'economy',
        dependsOn: ['T1'],
        ownership: ['b.txt'],
        acceptance: [{ type: 'command', run: CHECK_B }],
        deliverable: { kind: 'code-change' },
        budget: { cost: 2 },
        workspace: 'worktree',
    },
];

interface ChatMessage {
    readonly role: string;
    readonly content: unknown;
    readonly tool_calls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
}
interface ChatBody {
    readonly model: string;
    readonly messages: readonly ChatMessage[];
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('\n');
    return '';
}

/** Which roster agent a request comes from: the engine renders the agent layer with its title. */
function agentOf(body: ChatBody | undefined): string {
    const system = textOf(body?.messages?.find((message) => message.role === 'system')?.content);
    return /<agent_instructions title="agent：([^"]+)"/.exec(system)?.[1] ?? 'none';
}

function lastCall(body: ChatBody): string | undefined {
    const assistant = [...body.messages].reverse().find((message) => message.role === 'assistant');
    return assistant?.tool_calls?.at(-1)?.function.name;
}

const say = (text: string): MockTurn => openaiText(text, { usage: USAGE });
const call = (...calls: OpenAiToolCall[]): MockTurn => openaiToolCalls(calls, { usage: USAGE });

function supervisor(body: ChatBody, listed: { done: boolean }): MockTurn {
    const last = body.messages.at(-1);
    if (last?.role === 'tool') {
        if (lastCall(body) === 'task_create' && textOf(last.content).includes('no acceptance criteria')) {
            // The board's quality gate answered verbatim: fix the cards and record the plan.
            return call(
                { name: 'task_create', arguments: { tasks: CARDS } },
                {
                    name: 'ledger_update',
                    arguments: {
                        reason: 'first plan',
                        plan: 'a.txt first, then b.txt next to it',
                        facts: ['the repository only has a README'],
                        risks: ['a.txt may need a second pass'],
                    },
                },
            );
        }
        return say('Done.');
    }
    const input = textOf(last?.content);
    if (input.includes('<team_goal>')) {
        return call({ name: 'task_create', arguments: { tasks: [{ ...CARDS[0], acceptance: [] }] } });
    }
    if (input.includes('Question from coder-T2 on T2')) {
        return call({ name: 'send_message', arguments: { to: 'T2', text: 'Write "next to a" into b.txt.' } });
    }
    if (input.includes('<team_update>') && !listed.done) {
        listed.done = true;
        return call({ name: 'task_list', arguments: {} });
    }
    return say('Noted.');
}

function coder(body: ChatBody): MockTurn {
    const first = textOf(body.messages.find((message) => message.role === 'user')?.content);
    const taskId = /<task_card id="([^"]+)"/.exec(first)?.[1] ?? 'T?';
    const file = taskId === 'T1' ? 'a.txt' : 'b.txt';
    const last = body.messages.at(-1);
    if (last?.role === 'tool') {
        if (lastCall(body) === 'ask_supervisor') {
            const answer = /"([^"]+)"/.exec(textOf(last.content))?.[1] ?? 'no answer';
            return call({ name: 'write', arguments: { path: 'b.txt', content: `${answer}\n` } });
        }
        if (lastCall(body) === 'write') {
            return call({
                name: 'deliver',
                arguments: {
                    status: 'done',
                    summary: `wrote ${file}`,
                    changes: [{ file, kind: 'added' }],
                    evidence: [{ type: 'diff' }],
                },
            });
        }
        return say(`Handed in ${taskId}.`);
    }
    if (taskId === 'T1') {
        const final = textOf(last?.content).includes('was not accepted');
        return call({ name: 'write', arguments: { path: 'a.txt', content: final ? 'final\n' : 'draft\n' } });
    }
    if (body.model === 'deepseek-flash') {
        return call({
            name: 'escalate',
            arguments: {
                to: 'standard',
                reason: 'b.txt needs a stronger model',
                findings: ['a.txt already holds the final text'],
            },
        });
    }
    return call({ name: 'ask_supervisor', arguments: { question: 'What goes into b.txt?' } });
}

function reviewer(): MockTurn {
    return say(
        'Read a.txt in the workspace.\n\n```json\n{"verdict": "pass", "summary": "a.txt holds the final text", "issues": []}\n```',
    );
}

function respond(listed: { done: boolean }) {
    return (request: { body: unknown }): MockTurn | undefined => {
        const body = request.body as ChatBody | undefined;
        if (!body?.messages) {
            return undefined;
        }
        switch (agentOf(body)) {
            case 'Supervisor':
                return supervisor(body, listed);
            case 'Coder':
                return coder(body);
            case 'Reviewer':
                return reviewer();
            default:
                return say('ok');
        }
    };
}

/** Answers approval cards the way a user would: plans and deliveries once, acceptance commands for the session. */
function approve(ui: Ui, seen: Approval[], hold: Set<string>): void {
    ui.onNotification('approval.requested', ({ approval }) => {
        seen.push(approval);
        if (approval.toolName && hold.has(approval.toolName)) {
            return;
        }
        void ui
            .request('approval.respond', {
                approvalId: approval.id,
                decision: approval.toolName === 'acceptance' ? 'allow_session' : 'allow_once',
            })
            .catch(() => undefined);
    });
}

async function connect(ui: Ui): Promise<string> {
    const connection = await ui.request('provider.save', {
        presetId: 'custom-openai',
        name: 'mock',
        apiKey: 'test-key',
        baseUrl: server.url,
    });
    await ui.request('provider.refreshModels', { connectionId: connection.id });
    await ui.request('settings.update', {
        patch: { defaultModel: { connectionId: connection.id, model: 'deepseek-flash' } },
    });
    return connection.id;
}

beforeAll(async () => {
    await build({
        entryPoints: [engineSource],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile: engineEntry,
        logLevel: 'silent',
    });
    server = await startMockModelServer({ models: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }, { id: 'deepseek-flash' }] });
}, 60_000);

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.close().catch(() => undefined);
    }
});

afterAll(async () => {
    await server?.close();
});

describe('agent team run', () => {
    it('plans, sends back, escalates, survives a restart, integrates and reports', async () => {
        const repo = gitRepo();
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-team-data-'));
        const listed = { done: false };
        server.respondWith(respond(listed));
        const first = await startHost(dataDir);
        const seen: Approval[] = [];
        approve(first.ui, seen, new Set(['team_delivery']));
        await connect(first.ui);
        const project = await first.ui.request('project.add', { path: repo });

        const started = await first.ui.request('team.start', {
            projectId: project.id,
            goal: '写a.txt和b.txt',
            autonomy: 'L1',
            budget: 50,
        });
        expect(started.status).toBe('planning');
        expect(started.supervisorThreadId).toBeDefined();

        // Both tasks finish; the host then waits for the user to confirm the delivery.
        await waitFor(() => seen.find((approval) => approval.toolName === 'team_delivery'), 'delivery card');
        const waiting = await first.ui.request('team.get', { runId: started.id });
        expect(waiting.status).toBe('integrating');
        const t1 = waiting.tasks.find((task) => task.id === 'T1');
        const t2 = waiting.tasks.find((task) => task.id === 'T2');
        expect(t1).toMatchObject({ status: 'done', tier: 'economy', attempts: 2 });
        expect(t2).toMatchObject({ status: 'done', tier: 'standard', attempts: 2, dependsOn: ['T1'] });
        expect(seen.find((approval) => approval.toolName === 'team_plan')?.summary).toContain('T2 Write b.txt');
        expect(seen.filter((approval) => approval.toolName === 'acceptance')).toHaveLength(1);
        // The quality gate's error went back to the supervisor verbatim, and the fixed plan was recorded.
        const planning = server.requests.find(
            (request) =>
                agentOf(request.body as ChatBody | undefined) === 'Supervisor' &&
                (request.body as ChatBody).messages.some(
                    (message) =>
                        message.role === 'tool' && textOf(message.content).includes('has no acceptance criteria'),
                ),
        );
        expect(planning).toBeDefined();
        expect((waiting.ledger as { plan?: string } | undefined)?.plan).toBe('a.txt first, then b.txt next to it');
        expect(waiting.progress.length).toBeGreaterThanOrEqual(4);

        // Threads: the supervisor plans read-only, T2 ran at economy and then a tier up, the reviewer is cross-family.
        const threads = await first.ui.request('thread.list', { includeArchived: true });
        const team = threads.filter((thread) => thread.teamRunId === started.id);
        const supervisorThread = team.find((thread) => thread.role === 'supervisor');
        expect(supervisorThread).toMatchObject({ mode: 'plan', tier: 'flagship', model: { model: 'glm-5.3' } });
        const t2Threads = team.filter((thread) => thread.taskId === 'T2' && thread.role === 'executor');
        expect(t2Threads.map((thread) => [thread.tier, thread.model?.model]).sort()).toEqual([
            ['economy', 'deepseek-flash'],
            ['standard', 'glm-5.3'],
        ]);
        expect(team.find((thread) => thread.role === 'reviewer')).toMatchObject({
            taskId: 'T1',
            tier: 'standard',
            model: { model: 'glm-5.3' },
        });
        const t1Thread = team.find((thread) => thread.taskId === 'T1' && thread.role === 'executor');
        expect(t1Thread?.location.kind).toBe('worktree');
        // The executor got its feedback on the same thread: two turns.
        expect(t1Thread?.turns).toBe(2);
        expect(existsSync(path.join(repo, 'a.txt'))).toBe(false);

        // Restart before the delivery is confirmed: the run is paused and nothing is run again.
        await harnesses.pop()?.close();
        const second = await startHost(dataDir);
        const again: Approval[] = [];
        approve(second.ui, again, new Set());
        const paused = await second.ui.request('team.get', { runId: started.id });
        expect(paused.status).toBe('paused');
        expect(paused.tasks.map((task) => task.status)).toEqual(['done', 'done']);
        expect((await second.ui.request('team.list', { projectId: project.id })).map((run) => run.id)).toEqual([
            started.id,
        ]);
        const before = server.requests.length;

        const resumed = await second.ui.request('team.resume', { runId: started.id });
        expect(resumed.status).toBe('integrating');
        const done = await waitFor(async () => {
            const run = await second.ui.request('team.get', { runId: started.id });
            return run.status === 'done' || run.status === 'failed' ? run : undefined;
        }, 'run done');
        expect(done.status).toBe('done');
        expect(again.map((approval) => approval.toolName)).toEqual(['team_delivery', 'acceptance']);
        expect(server.requests.slice(before).map((request) => agentOf(request.body as ChatBody | undefined))).toEqual(
            [],
        );
        expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('final\n');
        expect(readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('next to a\n');

        // The report and the costs.
        const report = done.report ?? '';
        expect(report).toContain('# 交付报告');
        expect(report).toContain('结果：完成2/2个任务。');
        // The report follows the user's style: english in lower case outside code.
        expect(report).toContain('- **t1 write a.txt**（已完成，退回或升级1次）：wrote a.txt');
        expect(report).toContain('- **t2 write b.txt**（已完成，退回或升级1次）：wrote b.txt');
        expect(report).toContain('| coder-t2 | 执行者 | 标准、经济 |');
        expect(report).toContain('## 全量验收');
        expect(report).toContain(`- \`${CHECK_B}\`：通过`);
        expect(report).toMatch(/\| 旗舰 \|/);
        expect(report).toMatch(/\| 标准 \|/);
        expect(report).toMatch(/\| 经济 \|/);

        const rows = second.core.db.all<{
            role: string | null;
            tier: string | null;
            task_id: string | null;
            agent_id: string | null;
            model: string;
            cost_amount: number | null;
        }>('select role, tier, task_id, agent_id, model, cost_amount from usage_events where workflow_run_id = ?', [
            started.id,
        ]);
        expect(rows.length).toBeGreaterThan(10);
        expect(rows.every((row) => row.role && row.tier && row.cost_amount !== null)).toBe(true);
        const sum = (filter: (row: (typeof rows)[number]) => boolean) =>
            rows.filter(filter).reduce((total, row) => total + (row.cost_amount ?? 0), 0);
        const supervisorRows = rows.filter((row) => row.role === 'supervisor');
        expect(supervisorRows.every((row) => row.tier === 'flagship' && row.agent_id === 'supervisor')).toBe(true);
        expect(
            new Set(rows.filter((row) => row.task_id === 'T2' && row.role === 'executor').map((row) => row.tier)),
        ).toEqual(new Set(['economy', 'standard']));
        expect(rows.filter((row) => row.role === 'reviewer').every((row) => row.model === 'glm-5.3')).toBe(true);
        const total = sum(() => true);
        expect(done.cost.amount).toBeCloseTo(total, 4);
        expect(done.costByTier.flagship).toBeCloseTo(
            sum((row) => row.tier === 'flagship'),
            4,
        );
        expect(done.costByTier.standard).toBeCloseTo(
            sum((row) => row.tier === 'standard'),
            4,
        );
        expect(done.costByTier.economy).toBeCloseTo(
            sum((row) => row.tier === 'economy'),
            4,
        );
        expect(done.supervisionShare).toBeCloseTo(sum((row) => row.role === 'supervisor') / total, 4);
        const t1Cost = done.tasks.find((task) => task.id === 'T1')?.cost?.amount ?? 0;
        expect(t1Cost).toBeCloseTo(
            sum((row) => row.task_id === 'T1'),
            4,
        );
    }, 120_000);
});

describe('agent team limits', () => {
    it('pauses when the budget is spent and stops on request', async () => {
        const repo = gitRepo();
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) {
                return undefined;
            }
            if (agentOf(body) !== 'Supervisor') {
                return say('not expected');
            }
            return body.messages.at(-1)?.role === 'tool'
                ? say('Planned.')
                : call({ name: 'task_create', arguments: { tasks: [CARDS[0]] } });
        });
        const { ui } = await startHost(mkdtempSync(path.join(tmpdir(), 'xora-team-data-')));
        const seen: Approval[] = [];
        approve(ui, seen, new Set());
        await connect(ui);
        const project = await ui.request('project.add', { path: repo });
        const before = server.requests.length;
        // L2 confirms no plan, so the plan goes straight to dispatch, which the budget stops.
        const run = await ui.request('team.start', {
            projectId: project.id,
            goal: '预算很小',
            autonomy: 'L2',
            budget: 0.0001,
        });
        const paused = await waitFor(async () => {
            const current = await ui.request('team.get', { runId: run.id });
            return current.status === 'paused' ? current : undefined;
        }, 'paused run');
        expect(paused.note).toContain('预算已用完');
        expect(paused.tasks.map((task) => task.status)).toEqual(['ready']);
        expect(seen).toEqual([]);
        expect(server.requests.slice(before).map((request) => agentOf(request.body as ChatBody | undefined))).toEqual([
            'Supervisor',
            'Supervisor',
        ]);
        await expect(ui.request('team.resume', { runId: run.id })).rejects.toThrow(/预算已用完/);

        const stopped = await ui.request('team.stop', { runId: run.id });
        expect(stopped.status).toBe('cancelled');
        expect(stopped.tasks.map((task) => task.status)).toEqual(['cancelled']);
    }, 60_000);
});

describe('team persistence and organizations', () => {
    it('stores runs, board events and ledgers, and restores them', async () => {
        const db = new XoraDatabase(':memory:');
        db.migrate();
        const store = new SqliteTeamStore(db);
        const run = createTeamRun({ id: 'run-1', goal: 'demo', orgId: 'default', projectId: 'p1' }, 1);
        await store.saveRun(run);
        const board = new TaskBoard();
        board.onEvent((event) => store.writeEvents(run.id, [event]));
        const added = board.add({
            id: 'T1',
            title: 'one',
            goal: 'do one thing',
            category: 'coding',
            tier: 'economy',
            ownership: ['a.txt'],
            acceptance: [{ type: 'command', run: 'true' }],
            deliverable: { kind: 'code-change' },
            budget: { cost: 1 },
            workspace: 'worktree',
        });
        expect(added.ok).toBe(true);
        await store.saveBoard(run.id, board.snapshot());
        board.claim('T1', 'coder-T1');
        expect(await store.loadBoardEvents(run.id, 2)).toHaveLength(2);
        expect((await store.listRuns({ status: 'running' })).map((item) => item.id)).toEqual(['run-1']);
        expect(await store.listRuns({ projectId: 'other' })).toEqual([]);
        const restored = await loadTeamState(store, run.id);
        expect(restored?.board.get('T1')).toMatchObject({ status: 'assigned', owner: 'coder-T1' });
        await store.deleteRun(run.id);
        expect(await store.loadRun(run.id)).toBeUndefined();
        expect(await store.loadBoardEvents(run.id)).toEqual([]);
        db.close();
    });

    it('applies user and trusted project organization files only', async () => {
        const project = mkdtempSync(path.join(tmpdir(), 'xora-team-org-'));
        mkdirSync(path.join(project, '.xora', 'agents'), { recursive: true });
        writeFileSync(path.join(project, '.xora', 'agents', 'coder.md'), '---\ntier: standard\nmode: full\n---\n');
        const orgsDir = mkdtempSync(path.join(tmpdir(), 'xora-team-orgs-'));
        mkdirSync(path.join(orgsDir, 'default'), { recursive: true });
        writeFileSync(path.join(orgsDir, 'default', 'org.md'), '---\nname: 我的团队\n---\n');

        const untrusted = await loadTeamOrganization({ orgsDir, projectDir: project, trusted: false });
        expect(untrusted.org.name).toBe('我的团队');
        expect(findAgent(untrusted.org, 'coder')).toMatchObject({ tier: 'economy', mode: 'auto_edit' });
        expect(untrusted.warnings.some((warning) => warning.includes('没有被信任'))).toBe(true);

        const trusted = await loadTeamOrganization({ orgsDir, projectDir: project, trusted: true });
        expect(findAgent(trusted.org, 'coder')).toMatchObject({ tier: 'standard', mode: 'full' });
    });
});
