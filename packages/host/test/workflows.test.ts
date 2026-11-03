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
import {
    errorTurn,
    type MockModelServer,
    type MockTurn,
    type OpenAiToolCall,
    openaiText,
    openaiToolCalls,
    startMockModelServer,
} from '@xora/test-kit';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HostCore } from '../src/core.ts';
import type { Logger } from '../src/log.ts';
import { MemoryShell } from '../src/shell.ts';

/**
 * M5 acceptance, headless: the real host and xora engine against a scripted model server run a three-step
 * workflow (reproduce → human gate → fix → review), are interrupted by a restart at the gate and continue
 * without redoing the finished step. Unattended runs must use API channels and stay within their budget.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const engineSource = path.resolve(here, '../../engine/src/main.ts');
const work = mkdtempSync(path.join(tmpdir(), 'xora-workflow-'));
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
        modelTitles: false,
        dataDir,
        shell,
        bundleVersion: '1.0.0-test',
        shellVersion: '1.0.0-test',
        engineEntry,
        skipShellEnv: true,
        log: quiet,
    });
    // These runs test the user's own answers to approval cards (06 §24 has the supervisor's).
    core.settings.update({
        approvals: { reviewer: 'user' },
        team: { ...core.settings.get().team, models: 'tiers' },
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

function gitRepo(workflows: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'README.md'), '# demo\n');
    mkdirSync(path.join(dir, '.xora', 'workflows'), { recursive: true });
    for (const [name, text] of Object.entries(workflows)) {
        writeFileSync(path.join(dir, '.xora', 'workflows', name), text);
    }
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
}

const BUGFIX = `
name: bugfix
title: 修缺陷
inputs:
  issue: { description: 问题描述 }
budget: { perRun: 50 }
steps:
  - id: reproduce
    agent: debugger
    task: "复现：{{inputs.issue}}，写一个现在会失败的检查脚本"
    outputs: [testFile]
    verify: { command: "node {{steps.reproduce.outputs.testFile}}", expect: fail }
  - id: approve
    needs: [reproduce]
    gate: human
    message: "检查脚本是{{steps.reproduce.outputs.testFile}}，继续修吗？"
  - id: fix
    agent: coder
    needs: [approve]
    task: "让{{steps.reproduce.outputs.testFile}}通过"
    verify: { command: "node {{steps.reproduce.outputs.testFile}}" }
  - id: review
    agent: reviewer
    needs: [fix]
    task: 审查fix这一步的改动
`;

const NIGHTLY = `
name: nightly
trigger:
  manual: true
  schedule: "0 2 * * *"
steps:
  - id: check
    agent: reviewer
    task: 看看有什么问题
`;

const NIGHTLY_FLAGSHIP = `
name: nightly-flagship
budget: { perRun: 5 }
trigger:
  schedule: "0 2 * * *"
steps:
  - id: plan
    agent: reviewer
    tier: flagship
    task: 想一想
`;

const NIGHTLY_BUDGET = `
name: nightly-budget
budget: { perRun: 0.000001 }
trigger:
  schedule: "0 2 * * *"
steps:
  - id: first
    agent: reviewer
    tier: economy
    task: 第一步
  - id: second
    agent: reviewer
    tier: economy
    needs: [first]
    task: 第二步
`;

const REPORT = `
name: report
title: 写周报
steps:
  - id: hold
    gate: human
    message: 开始写吗？
  - id: write
    agent: writer
    needs: [hold]
    task: 把这周的测试结果写进report.md
    outputs: [report]
`;

/** What the writer puts into report.md, which it hands in as an output. */
const REPORT_TEXT = '本周3个失败的测试都修好了，还剩1个不稳定的测试没查清。';

const BRIEF = [
    '## 结论',
    '周报写好了：report.md。',
    '',
    '## 问题',
    '- 1个不稳定的测试没查清',
    '',
    '## 下一步',
    '- 查清那个不稳定的测试',
].join('\n');

// The scripted agents ------------------------------------------------------------------------------------

const USAGE = { prompt_tokens: 3000, completion_tokens: 400 };

interface ChatMessage {
    readonly role: string;
    readonly content: unknown;
    readonly tool_calls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
}
interface ChatBody {
    readonly model: string;
    readonly messages: readonly ChatMessage[];
    readonly tools?: ReadonlyArray<{ function: { name: string; parameters?: unknown } }>;
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('\n');
    return '';
}

function systemText(body: ChatBody | undefined): string {
    return textOf(body?.messages?.find((message) => message.role === 'system')?.content);
}

function agentOf(body: ChatBody | undefined): string {
    return /<agent_instructions title="agent：([^"]+)"/.exec(systemText(body))?.[1] ?? 'none';
}

/** The request for a run's brief: the host asks it of the run's lead, no agent of the roster. */
function isBrief(body: ChatBody | undefined): boolean {
    return systemText(body).includes('你是这次工作流运行的负责人');
}

function lastCall(body: ChatBody): string | undefined {
    const assistant = [...body.messages].reverse().find((message) => message.role === 'assistant');
    return assistant?.tool_calls?.at(-1)?.function.name;
}

const say = (text: string): MockTurn => openaiText(text, { usage: USAGE });
const call = (...calls: OpenAiToolCall[]): MockTurn => openaiToolCalls(calls, { usage: USAGE });

/** Write a file, then hand in the step; then say done. */
function writer(body: ChatBody, file: string, content: string, result: Record<string, unknown>): MockTurn {
    const last = body.messages.at(-1);
    if (last?.role === 'tool') {
        return lastCall(body) === 'write' ? call({ name: 'step_result', arguments: result }) : say('done');
    }
    return call({ name: 'write', arguments: { path: file, content } });
}

function respond(request: { body: unknown }): MockTurn | undefined {
    const body = request.body as ChatBody | undefined;
    if (!body?.messages) {
        return undefined;
    }
    switch (agentOf(body)) {
        case 'Debugger':
            return writer(body, 'check.js', "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)\n", {
                summary: 'check.js fails until fixed.txt exists',
                outputs: { testFile: 'check.js' },
            });
        case 'Coder':
            return writer(body, 'fixed.txt', 'ok\n', { summary: 'wrote fixed.txt' });
        case 'Reviewer':
            return body.messages.at(-1)?.role === 'tool'
                ? say('reviewed')
                : call({ name: 'step_result', arguments: { summary: 'looks fine' } });
        default:
            return say('ok');
    }
}

/** The writer writes report.md and hands it in; the lead's brief is {@link BRIEF}. */
function reporter(request: { body: unknown }): MockTurn | undefined {
    const body = request.body as ChatBody | undefined;
    if (!body?.messages) {
        return undefined;
    }
    if (isBrief(body)) {
        return say(BRIEF);
    }
    if (agentOf(body) === 'Writer') {
        return writer(body, 'report.md', `${REPORT_TEXT}\n`, {
            summary: 'wrote report.md',
            outputs: { report: 'report.md' },
        });
    }
    return say('ok');
}

/** Answers approval cards like a user, except the tools in `hold`. */
function approve(ui: Ui, seen: Approval[], hold: Set<string>): void {
    ui.onNotification('approval.requested', ({ approval }) => {
        seen.push(approval);
        if (approval.toolName && hold.has(approval.toolName)) {
            return;
        }
        void ui
            .request('approval.respond', { approvalId: approval.id, decision: 'allow_session' })
            .catch(() => undefined);
    });
}

async function connectCustom(ui: Ui): Promise<string> {
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

describe('workflow runs', () => {
    it('runs the steps in order, waits at the gate, survives a restart and finishes', async () => {
        const repo = gitRepo({ 'bugfix.yaml': BUGFIX });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith(respond);
        const first = await startHost(dataDir);
        const seen: Approval[] = [];
        approve(first.ui, seen, new Set(['workflow_gate']));
        await connectCustom(first.ui);
        const project = await first.ui.request('project.add', { path: repo });

        // An untrusted project's workflows are listed as waiting for trust, not as broken, and cannot start.
        const untrusted = await first.ui.request('workflow.list', { projectId: project.id });
        expect(untrusted.map((info) => [info.key, info.untrusted, info.issues])).toEqual([
            ['project:bugfix', true, []],
        ]);
        await expect(
            first.ui.request('workflow.start', {
                projectId: project.id,
                key: 'project:bugfix',
                inputs: { issue: 'x' },
            }),
        ).rejects.toThrow('项目还没有被信任：信任后才能运行项目里的工作流');
        await first.ui.request('project.trust', { projectId: project.id, trusted: true });
        const [info] = await first.ui.request('workflow.list', { projectId: project.id });
        expect(info).toMatchObject({
            key: 'project:bugfix',
            title: '修缺陷',
            issues: [],
            untrusted: false,
            inputs: [{ name: 'issue', type: 'string' }],
            triggers: { enabled: false, stale: false },
        });
        await expect(
            first.ui.request('workflow.start', { projectId: project.id, key: 'project:bugfix' }),
        ).rejects.toThrow('缺少输入issue');

        const started = await first.ui.request('workflow.start', {
            projectId: project.id,
            key: 'project:bugfix',
            inputs: { issue: "fixed.txt is missing; don't panic" },
        });
        expect(started.status).toBe('running');

        // The reproduction passes its inverted check and the run stops at the gate.
        const gate = await waitFor(() => seen.find((approval) => approval.toolName === 'workflow_gate'), 'gate card');
        expect(gate.summary).toBe('检查脚本是check.js，继续修吗？');
        const waiting = await first.ui.request('workflow.get', { runId: started.id });
        expect(waiting.status).toBe('waiting');
        expect(waiting.steps.map((step) => [step.id, step.status])).toEqual([
            ['reproduce', 'succeeded'],
            ['approve', 'waiting'],
            ['fix', 'pending'],
            ['review', 'pending'],
        ]);
        expect(waiting.steps[0]).toMatchObject({ outputs: { testFile: 'check.js' }, attempts: 1, agent: 'debugger' });
        expect(seen.find((approval) => approval.toolName === 'workflow_command')?.summary).toBe("node 'check.js'");
        expect(existsSync(path.join(repo, 'check.js'))).toBe(true);

        // Restart while the gate waits: the run is paused, nothing finished runs again.
        await harnesses.pop()?.close();
        const second = await startHost(dataDir);
        const again: Approval[] = [];
        approve(second.ui, again, new Set());
        const paused = await second.ui.request('workflow.get', { runId: started.id });
        expect(paused.status).toBe('paused');
        expect(paused.steps.map((step) => step.status)).toEqual(['succeeded', 'pending', 'pending', 'pending']);
        const before = server.requests.length;

        await second.ui.request('workflow.resume', { runId: started.id });
        const done = await waitFor(async () => {
            const run = await second.ui.request('workflow.get', { runId: started.id });
            return run.status === 'completed' || run.status === 'failed' ? run : undefined;
        }, 'run done');
        expect(done.status).toBe('completed');
        expect(done.steps.map((step) => [step.id, step.status, step.attempts])).toEqual([
            ['reproduce', 'succeeded', 1],
            // Asked once before the restart and again after it.
            ['approve', 'succeeded', 2],
            ['fix', 'succeeded', 1],
            ['review', 'succeeded', 1],
        ]);
        expect(readFileSync(path.join(repo, 'fixed.txt'), 'utf8')).toBe('ok\n');
        // The brief written once the run is over comes from the run's lead, not an agent of the roster.
        const agents = server.requests
            .slice(before)
            .map((request) => request.body as ChatBody | undefined)
            .filter((body) => !isBrief(body))
            .map(agentOf);
        expect(new Set(agents)).toEqual(new Set(['Coder', 'Reviewer']));

        // Step threads belong to the run; the run's own thread holds the notices and cards.
        const threads = await second.ui.request('thread.list', { includeArchived: true });
        const owned = threads.filter((thread) => thread.workflowRunId === started.id);
        expect(owned.map((thread) => [thread.role, thread.taskId ?? '']).sort()).toEqual([
            ['executor', 'fix'],
            ['executor', 'reproduce'],
            ['reviewer', 'review'],
            ['workflow', ''],
        ]);
        expect((await second.ui.request('workflow.runs', { projectId: project.id })).map((run) => run.id)).toEqual([
            started.id,
        ]);
    }, 120_000);

    it('starts unattended runs only with a budget and priced models, and pauses when the budget is spent', async () => {
        const repo = gitRepo({
            'nightly.yaml': NIGHTLY,
            'nightly-budget.yaml': NIGHTLY_BUDGET,
            'nightly-flagship.yaml': NIGHTLY_FLAGSHIP,
        });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith(respond);
        const host = await startHost(dataDir);
        approve(host.ui, [], new Set());
        await connectCustom(host.ui);
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });

        // A trigger does nothing until the user switches it on.
        expect(
            await host.core.workflows.fire({
                projectId: project.id,
                key: 'project:nightly',
                trigger: { reason: 'schedule' },
            }),
        ).toBeUndefined();
        const enabled = await host.ui.request('workflow.triggers', {
            projectId: project.id,
            key: 'project:nightly',
            enabled: true,
        });
        expect(enabled.triggers).toEqual({ enabled: true, stale: false });

        // A custom endpoint is fine unattended, but there is no budget: the run is recorded as failed, with the reason.
        const refused = await host.core.workflows.fire({
            projectId: project.id,
            key: 'project:nightly',
            trigger: { reason: 'schedule' },
        });
        expect(refused?.status).toBe('failed');
        expect(refused?.note).toBe('没有开始：L3 needs a budget for the run。已停用自动运行，解决后重新启用');
        // It would fail the same way every time: its triggers are switched off.
        expect(
            (await host.ui.request('workflow.list', { projectId: project.id })).find(
                (info) => info.key === 'project:nightly',
            )?.triggers,
        ).toEqual({ enabled: false, stale: false });

        // With a budget the run starts, then pauses once the budget is gone.
        await host.ui.request('provider.save', {
            presetId: 'deepseek',
            name: 'deepseek mock',
            apiKey: 'test-key',
            baseUrl: server.url,
        });
        // With Kimi connected too, a flagship step would start on kimi-k3.1-pro, which has no price table: no
        // budget could hold.
        const kimi = await host.ui.request('provider.save', {
            presetId: 'kimi-cn',
            name: 'kimi mock',
            apiKey: 'test-key',
            baseUrl: server.url,
        });
        await host.ui.request('workflow.triggers', {
            projectId: project.id,
            key: 'project:nightly-flagship',
            enabled: true,
        });
        const unpriced = await host.core.workflows.fire({
            projectId: project.id,
            key: 'project:nightly-flagship',
            trigger: { reason: 'schedule' },
        });
        expect(unpriced?.status).toBe('failed');
        expect(unpriced?.note).toBe(
            '没有开始：无人值守运行要能计价，这些模型没有价格表：kimi-k3.1-pro。已停用自动运行，解决后重新启用',
        );
        const switchedOff = await host.ui.request('workflow.list', { projectId: project.id });
        expect(switchedOff.find((info) => info.key === 'project:nightly-flagship')?.triggers.enabled).toBe(false);
        await host.ui.request('provider.remove', { connectionId: kimi.id });
        await host.ui.request('workflow.triggers', {
            projectId: project.id,
            key: 'project:nightly-budget',
            enabled: true,
        });
        const run = await host.core.workflows.fire({
            projectId: project.id,
            key: 'project:nightly-budget',
            trigger: { reason: 'schedule' },
        });
        expect(run).toMatchObject({ status: 'running', unattended: true, reason: 'schedule' });
        const paused = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run?.id as string });
            return current.status === 'paused' ? current : undefined;
        }, 'budget pause');
        expect(paused.note).toContain('预算用完');
        // The first turn already spent it: the step stops there and waits for more budget.
        expect(paused.steps.map((step) => step.status)).toEqual(['pending', 'pending']);
        const threads = await host.ui.request('thread.list', { includeArchived: true });
        const step = threads.find((thread) => thread.workflowRunId === run?.id && thread.taskId === 'first');
        expect(step?.model?.model).toBe('deepseek-flash');
        await expect(host.ui.request('workflow.resume', { runId: run?.id as string })).rejects.toThrow('预算还是不够');

        // More budget: the step continues in its thread, then the second step runs.
        await host.ui.request('workflow.resume', { runId: run?.id as string, budget: 100 });
        const finished = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run?.id as string });
            return current.status === 'completed' || current.status === 'failed' ? current : undefined;
        }, 'run after more budget');
        expect(finished.status).toBe('completed');
        expect(finished.steps.map((current) => [current.id, current.attempts, current.threadIds.length])).toEqual([
            ['first', 2, 1],
            ['second', 1, 1],
        ]);
        expect(finished.cost.amount).toBeGreaterThan(0);

        // A changed file switches its triggers off until they are switched on again.
        await host.ui.request('workflow.triggers', { projectId: project.id, key: 'project:nightly', enabled: true });
        writeFileSync(path.join(repo, '.xora', 'workflows', 'nightly.yaml'), `${NIGHTLY}\n# edited\n`);
        const listed = await host.ui.request('workflow.list', { projectId: project.id });
        expect(listed.find((info) => info.key === 'project:nightly')?.triggers).toEqual({ enabled: true, stale: true });
        expect(
            await host.core.workflows.fire({
                projectId: project.id,
                key: 'project:nightly',
                trigger: { reason: 'schedule' },
            }),
        ).toBeUndefined();
    }, 120_000);

    it('prices local models at zero, so an unattended run on them stays within any budget', async () => {
        const repo = gitRepo({ 'nightly-budget.yaml': NIGHTLY_BUDGET });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith(respond);
        const host = await startHost(dataDir);
        approve(host.ui, [], new Set());
        // An Ollama server with an open model under its vendor's id: the vendor's prices do not apply.
        const local = await host.ui.request('provider.save', {
            presetId: 'ollama',
            name: 'ollama mock',
            baseUrl: server.url,
        });
        await host.ui.request('provider.refreshModels', { connectionId: local.id });
        await host.ui.request('settings.update', {
            patch: { defaultModel: { connectionId: local.id, model: 'deepseek-flash' } },
        });
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        await host.ui.request('workflow.triggers', {
            projectId: project.id,
            key: 'project:nightly-budget',
            enabled: true,
        });
        const run = await host.core.workflows.fire({
            projectId: project.id,
            key: 'project:nightly-budget',
            trigger: { reason: 'schedule' },
        });
        expect(run).toMatchObject({ status: 'running', unattended: true });
        const finished = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run?.id as string });
            return current.status === 'completed' || current.status === 'failed' ? current : undefined;
        }, 'local run');
        expect(finished.status).toBe('completed');
        expect(finished.cost.amount).toBe(0);
        // Every request is priced, at zero.
        const usage = await host.ui.request('usage.summary', { range: 'all', groupBy: 'model' });
        expect(usage.totals.requests).toBeGreaterThan(0);
        expect(usage.totals).toMatchObject({ cost: { amount: 0 }, complete: true });
    }, 120_000);

    it('starts a run when its webhook is called', async () => {
        const hook = `
name: on-hook
budget: { perRun: 5 }
trigger:
  manual: false
  webhook: true
steps:
  - id: look
    agent: reviewer
    tier: economy
    task: "看看这个请求：{{trigger.payload}}"
`;
        const repo = gitRepo({ 'on-hook.yaml': hook });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith(respond);
        const host = await startHost(dataDir);
        approve(host.ui, [], new Set());
        await connectCustom(host.ui);
        await host.ui.request('provider.save', {
            presetId: 'deepseek',
            name: 'deepseek mock',
            apiKey: 'test-key',
            baseUrl: server.url,
        });
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        await host.ui.request('workflow.triggers', { projectId: project.id, key: 'project:on-hook', enabled: true });
        const webhook = await waitFor(
            () =>
                host.ui
                    .request('workflow.webhook', { projectId: project.id, key: 'project:on-hook' })
                    .catch(() => undefined),
            'webhook address',
        );
        expect(webhook.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//);

        const denied = await fetch(webhook.url, {
            method: 'POST',
            body: '{}',
            headers: { authorization: 'Bearer nope' },
        });
        expect(denied.status).toBe(401);
        const accepted = await fetch(webhook.url, {
            method: 'POST',
            body: JSON.stringify({ build: 42 }),
            headers: { authorization: `Bearer ${webhook.token}`, 'content-type': 'application/json' },
        });
        expect(accepted.status).toBe(202);
        const run = await waitFor(async () => {
            const [latest] = await host.ui.request('workflow.runs', { projectId: project.id });
            return latest?.status === 'completed' || latest?.status === 'failed' ? latest : undefined;
        }, 'webhook run');
        expect(run).toMatchObject({ status: 'completed', reason: 'webhook', unattended: true });
        const prompt = server.requests
            .map((request) => request.body as ChatBody | undefined)
            .find((body) => textOf(body?.messages.at(-1)?.content).includes('看看这个请求'));
        expect(textOf(prompt?.messages.at(-1)?.content)).toContain('看看这个请求：{"build":42}');
    }, 120_000);

    it('asks before a high-risk command whatever the permission mode', async () => {
        const repo = gitRepo({
            'ship.yaml': 'name: ship\nsteps:\n  - id: push\n    run: git push origin HEAD\n',
        });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith(respond);
        const host = await startHost(dataDir);
        const seen: Approval[] = [];
        approve(host.ui, seen, new Set(['workflow_command']));
        await connectCustom(host.ui);
        await host.ui.request('settings.update', { patch: { defaultMode: 'full' } });
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        const run = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:ship' });
        const card = await waitFor(
            () => seen.find((approval) => approval.toolName === 'workflow_command'),
            'push card',
        );
        expect(card.title).toBe('push：运行命令（高风险动作：推送）');
        await host.ui.request('approval.respond', { approvalId: card.id, decision: 'deny' });
        const done = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run.id });
            return current.status === 'failed' ? current : undefined;
        }, 'failed run');
        expect(done.steps[0]?.note).toBe('命令被权限规则拒绝或没有被批准');
    }, 60_000);

    it('writes its errors, cards and notes in English when the language setting says so', async () => {
        const repo = gitRepo({
            'ship.yaml': 'name: ship\nsteps:\n  - id: push\n    run: git push origin HEAD\n',
        });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        const host = await startHost(dataDir);
        const seen: Approval[] = [];
        approve(host.ui, seen, new Set(['workflow_command']));
        await host.ui.request('settings.update', { patch: { language: 'en' } });
        const project = await host.ui.request('project.add', { path: repo });
        const [untrusted] = await host.ui.request('workflow.list', { projectId: project.id });
        expect(untrusted).toMatchObject({ untrusted: true, issues: [] });
        await expect(host.ui.request('workflow.start', { projectId: project.id, key: 'project:ship' })).rejects.toThrow(
            'The project is not trusted yet: trust it to run its workflows',
        );
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        await expect(
            host.ui.request('workflow.triggers', { projectId: project.id, key: 'project:ship', enabled: true }),
        ).rejects.toThrow('This workflow has no schedule, file, git or webhook trigger');
        const run = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:ship' });
        const card = await waitFor(
            () => seen.find((approval) => approval.toolName === 'workflow_command'),
            'push card',
        );
        expect(card.title).toBe('push: run a command (high-risk action: push)');
        await host.ui.request('approval.respond', { approvalId: card.id, decision: 'deny' });
        const done = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run.id });
            return current.status === 'failed' ? current : undefined;
        }, 'failed run');
        expect(done.steps[0]?.note).toBe('The command was denied by a permission rule or not approved');
        expect(done.note).toBe('Step push failed: The command was denied by a permission rule or not approved');
    }, 60_000);

    it('deletes a workflow file, but not while one of its runs is under way', async () => {
        const hold = 'name: hold\nsteps:\n  - id: wait\n    gate: human\n    message: 继续吗？\n';
        const repo = gitRepo({ 'hold.yaml': hold, 'other.yaml': hold.replace('name: hold', 'name: other') });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        const host = await startHost(dataDir);
        const seen: Approval[] = [];
        approve(host.ui, seen, new Set(['workflow_gate']));
        const project = await host.ui.request('project.add', { path: repo });

        // Deleting runs nothing, so an untrusted project's workflow can go.
        await host.ui.request('workflow.delete', { projectId: project.id, key: 'project:other' });
        expect(existsSync(path.join(repo, '.xora', 'workflows', 'other.yaml'))).toBe(false);

        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        const run = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:hold' });
        await waitFor(() => seen.find((approval) => approval.toolName === 'workflow_gate'), 'gate card');
        await expect(
            host.ui.request('workflow.delete', { projectId: project.id, key: 'project:hold' }),
        ).rejects.toThrow('这个工作流还有没结束的运行：先停止它再删除');
        expect(existsSync(path.join(repo, '.xora', 'workflows', 'hold.yaml'))).toBe(true);

        await host.ui.request('workflow.stop', { runId: run.id });
        await host.ui.request('workflow.delete', { projectId: project.id, key: 'project:hold' });
        expect(await host.ui.request('workflow.list', { projectId: project.id })).toEqual([]);
        // Its runs stay in the history.
        const runs = await host.ui.request('workflow.runs', { projectId: project.id });
        expect(runs.map((item) => [item.id, item.status])).toEqual([[run.id, 'cancelled']]);
    }, 60_000);

    it('distills a thread into a workflow file that the check tool accepts', async () => {
        const repo = gitRepo({});
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        const draft = 'name: greet\nsteps:\n  - id: hello\n    agent: writer\n    task: say hello\n';
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            const first = textOf(body.messages.find((message) => message.role === 'user')?.content);
            if (!first.includes('<thread_transcript')) return say('hello there');
            const last = body.messages.at(-1);
            if (last?.role !== 'tool') {
                return call({ name: 'write', arguments: { path: '.xora/workflows/greet.yaml', content: draft } });
            }
            return lastCall(body) === 'write'
                ? call({ name: 'workflow_check', arguments: { path: '.xora/workflows/greet.yaml' } })
                : say(`checked: ${textOf(last.content)}`);
        });
        const host = await startHost(dataDir);
        approve(host.ui, [], new Set());
        await connectCustom(host.ui);
        const project = await host.ui.request('project.add', { path: repo });
        const thread = await host.ui.request('thread.create', { projectId: project.id });
        await host.ui.request('turn.start', { threadId: thread.id, text: '打个招呼' });
        await waitFor(async () => {
            const snapshot = await host.ui.request('thread.read', { threadId: thread.id });
            return snapshot.events.some((event) => event.kind === 'turn.completed') || undefined;
        }, 'first turn');

        const distilled = await host.ui.request('thread.distill', { threadId: thread.id, kind: 'workflow' });
        expect(distilled).toMatchObject({ title: '沉淀工作流：打个招呼', mode: 'ask', role: 'distill' });
        const done = await waitFor(async () => {
            const snapshot = await host.ui.request('thread.read', { threadId: distilled.id });
            return snapshot.events.some((event) => event.kind === 'turn.completed') ? snapshot : undefined;
        }, 'distill turn');
        expect(readFileSync(path.join(repo, '.xora', 'workflows', 'greet.yaml'), 'utf8')).toBe(draft);
        const prompt = server.requests
            .map((request) => request.body as ChatBody | undefined)
            .find((body) => textOf(body?.messages.at(-1)?.content).includes('<thread_transcript'));
        expect(textOf(prompt?.messages.at(-1)?.content)).toContain('## 用户\n打个招呼');
        const messages = done.events
            .filter((event) => event.kind === 'item.completed')
            .map((event) => (event.payload as { item: { type: string; text?: string } }).item)
            .filter((item) => item.type === 'agent_message');
        expect(messages.at(-1)?.text).toBe('checked: OK: hello(agent)');
        const [info] = await host.ui.request('workflow.list', { projectId: project.id });
        expect(info).toMatchObject({ key: 'project:greet', steps: [{ id: 'hello', type: 'agent' }] });
    }, 120_000);

    it('fails a step its agent hands in as blocked, with the reason, without asking for its outputs', async () => {
        const research = `
name: research
steps:
  - id: check
    agent: reviewer
    task: 看看现状
  - id: look
    agent: scout
    needs: [check]
    task: 查一下上游项目最新的发布说明
    outputs: [notes]
    onFailure: { retries: 0, escalate: false }
  - id: write
    agent: writer
    needs: [look]
    task: "根据{{steps.look.outputs.notes}}写更新说明"
`;
        const repo = gitRepo({ 'research.yaml': research });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith((request) => {
            const body = request.body as ChatBody | undefined;
            if (!body?.messages) return undefined;
            if (body.messages.at(-1)?.role === 'tool') return say('handed in');
            switch (agentOf(body)) {
                case 'Reviewer':
                    return call({ name: 'step_result', arguments: { summary: 'nothing to note' } });
                case 'Scout':
                    return call({
                        name: 'step_result',
                        arguments: { summary: '没有查到', blocked: '上游仓库的发布页打不开' },
                    });
                default:
                    return say('ok');
            }
        });
        const host = await startHost(dataDir);
        approve(host.ui, [], new Set());
        await connectCustom(host.ui);
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        const before = server.requests.length;
        const run = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:research' });
        const done = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run.id });
            return current.status === 'completed' || current.status === 'failed' ? current : undefined;
        }, 'blocked run');
        expect(done.status).toBe('failed');
        expect(done.note).toBe('步骤look失败：受阻：上游仓库的发布页打不开');
        expect(done.steps.map((step) => [step.id, step.status])).toEqual([
            ['check', 'succeeded'],
            ['look', 'failed'],
            ['write', 'cancelled'],
        ]);
        expect(done.steps[1]).toMatchObject({ note: '受阻：上游仓库的发布页打不开', attempts: 1 });

        const bodies = server.requests.slice(before).map((request) => request.body as ChatBody);
        // Handed in as blocked: nobody asked the scout for the outputs it did not give.
        expect(bodies.some((body) => JSON.stringify(body.messages).includes('还缺这些outputs'))).toBe(false);
        const scout = bodies.find((body) => agentOf(body) === 'Scout');
        expect(textOf(scout?.messages.at(-1)?.content)).toContain('在blocked里写明原因');
        expect(scout?.tools?.find((tool) => tool.function.name === 'step_result')?.function.parameters).toMatchObject({
            properties: { blocked: { type: 'string' } },
        });
        // The role lists decide who may go on the web: the scout may, the reviewer may not.
        const names = (body: ChatBody | undefined) => body?.tools?.map((tool) => tool.function.name) ?? [];
        expect(names(scout)).toEqual(expect.arrayContaining(['web_fetch', 'web_search']));
        const reviewer = bodies.find((body) => agentOf(body) === 'Reviewer');
        expect(names(reviewer)).toContain('read');
        expect(names(reviewer)).not.toContain('web_fetch');
        expect(names(reviewer)).not.toContain('web_search');
    }, 120_000);

    it('writes a brief once a run is over, from its record and the files it handed in, counted in its cost', async () => {
        const repo = gitRepo({ 'report.yaml': REPORT });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith(reporter);
        const host = await startHost(dataDir);
        const seen: Approval[] = [];
        approve(host.ui, seen, new Set(['workflow_gate']));
        await connectCustom(host.ui);
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        const before = server.requests.length;
        const run = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:report' });

        // Nothing to report while the run goes on.
        const gate = await waitFor(() => seen.find((approval) => approval.toolName === 'workflow_gate'), 'gate card');
        await expect(host.ui.request('workflow.brief', { runId: run.id })).rejects.toThrow(
            '运行还没结束：结束后才能写结论',
        );
        await host.ui.request('approval.respond', { approvalId: gate.id, decision: 'allow_once' });
        const done = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run.id });
            return current.brief?.status === 'ready' ? current : undefined;
        }, 'brief');
        expect(done.status).toBe('completed');
        expect(done.brief?.text).toBe(BRIEF);

        // The run's lead writes it under the three headings, from the record and the text of the file handed in.
        const briefs = server.requests
            .slice(before)
            .map((request) => request.body as ChatBody | undefined)
            .filter(isBrief);
        expect(briefs).toHaveLength(1);
        expect(systemText(briefs[0])).toMatch(/## 目标达成[\s\S]*## 已完成[\s\S]*## 下一步/);
        const material = textOf(briefs[0]?.messages.at(-1)?.content);
        expect(material).toContain('工作流：写周报（report）');
        expect(material).toContain('总结：wrote report.md');
        expect(material).toContain(`<file path="report.md" step="write">\n${REPORT_TEXT}\n</file>`);

        // Its request counts in the run's cost, besides the steps'.
        const usage = await host.ui.request('usage.thread', { threadId: run.threadId });
        expect(usage.requests.map((request) => request.agentPath)).toEqual(['workflow-brief']);
        expect(usage.totals.cost.amount).toBeGreaterThan(0);
        const steps = done.steps.reduce((sum, step) => sum + (step.cost?.amount ?? 0), 0);
        expect(done.cost.amount).toBeCloseTo(steps + usage.totals.cost.amount, 5);

        // Written again on demand: it says so at once, and the new one comes from a request of its own.
        const again = await host.ui.request('workflow.brief', { runId: run.id });
        expect(again.brief?.status).toBe('writing');
        await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run.id });
            return current.brief?.status === 'ready' || undefined;
        }, 'brief written again');
        expect(server.requests.slice(before).filter((request) => isBrief(request.body as ChatBody))).toHaveLength(2);
    }, 120_000);

    it('writes no brief for a stopped run, and says why one failed or was cut off by a quit', async () => {
        const hold = 'name: hold\nsteps:\n  - id: wait\n    gate: human\n    message: 继续吗？\n';
        const quick = 'name: quick\nsteps:\n  - id: look\n    agent: reviewer\n    task: 看看现状\n';
        const repo = gitRepo({ 'hold.yaml': hold, 'quick.yaml': quick });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith((request) =>
            isBrief(request.body as ChatBody | undefined)
                ? errorTurn(400, { error: { message: 'brief refused' } })
                : respond(request),
        );
        const host = await startHost(dataDir);
        const seen: Approval[] = [];
        approve(host.ui, seen, new Set(['workflow_gate']));
        await connectCustom(host.ui);
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        const before = server.requests.length;

        // Stopped while its gate waited: the user knows what happened, there is nothing to report.
        const held = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:hold' });
        await waitFor(() => seen.find((approval) => approval.toolName === 'workflow_gate'), 'gate card');
        const stopped = await host.ui.request('workflow.stop', { runId: held.id });
        expect(stopped.status).toBe('cancelled');
        expect(stopped.brief).toBeUndefined();

        // The model call fails: the brief says why, the run stays completed.
        const run = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:quick' });
        const done = await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run.id });
            return current.brief && current.brief.status !== 'writing' ? current : undefined;
        }, 'failed brief');
        expect(done.status).toBe('completed');
        expect(done.brief).toMatchObject({ status: 'failed', note: 'brief refused' });
        expect(done.brief?.text).toBeUndefined();
        // Only the completed run asked for one.
        const briefs = () => server.requests.slice(before).filter((request) => isBrief(request.body as ChatBody));
        expect(briefs()).toHaveLength(1);
        expect((await host.ui.request('workflow.get', { runId: held.id })).brief).toBeUndefined();

        // The app quits while a brief is being written: next time it shows as cut off, and can be written again.
        let release: () => void = () => undefined;
        const answered = new Promise<void>((resolve) => {
            release = resolve;
        });
        server.respondWith(async (request) => {
            if (!isBrief(request.body as ChatBody | undefined)) return respond(request);
            await answered;
            return say(BRIEF);
        });
        const cut = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:quick' });
        await waitFor(() => briefs().length === 2, 'brief request');
        expect((await host.ui.request('workflow.get', { runId: cut.id })).brief?.status).toBe('writing');
        await harnesses.pop()?.close();
        const restarted = await startHost(dataDir);
        expect((await restarted.ui.request('workflow.get', { runId: cut.id })).brief).toMatchObject({
            status: 'failed',
            note: '写到一半应用关了，重新生成就好',
        });
        release();
        await restarted.ui.request('workflow.brief', { runId: cut.id });
        const rewritten = await waitFor(async () => {
            const current = await restarted.ui.request('workflow.get', { runId: cut.id });
            return current.brief?.status === 'ready' ? current : undefined;
        }, 'brief written after the restart');
        expect(rewritten.brief?.text).toBe(BRIEF);
    }, 120_000);

    it('answers a question about a run in a read-only thread that has the run as its context', async () => {
        const repo = gitRepo({ 'report.yaml': REPORT });
        const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-workflow-data-'));
        server.respondWith(reporter);
        const host = await startHost(dataDir);
        approve(host.ui, [], new Set());
        await connectCustom(host.ui);
        const project = await host.ui.request('project.add', { path: repo });
        await host.ui.request('project.trust', { projectId: project.id, trusted: true });
        const run = await host.ui.request('workflow.start', { projectId: project.id, key: 'project:report' });
        await waitFor(async () => {
            const current = await host.ui.request('workflow.get', { runId: run.id });
            return current.brief?.status === 'ready' || undefined;
        }, 'brief');

        const question = '还有哪个测试没查清？';
        const thread = await host.ui.request('workflow.ask', { runId: run.id, question });
        expect(thread).toMatchObject({ projectId: project.id, title: '追问：写周报', mode: 'plan' });
        expect(thread.workflowRunId).toBeUndefined();
        await waitFor(async () => {
            const snapshot = await host.ui.request('thread.read', { threadId: thread.id });
            return snapshot.events.some((event) => event.kind === 'turn.completed') || undefined;
        }, 'answer');

        // Its first request: the brief, the steps and the files handed in, then the question.
        const first = server.requests
            .map((request) => request.body as ChatBody | undefined)
            .find((body) => body?.messages && textOf(body.messages.at(-1)?.content).includes(question));
        const context = systemText(first);
        expect(context).toContain('用户在追问工作流运行“写周报”');
        expect(context).toContain(`<brief>\n${BRIEF}\n</brief>`);
        expect(context).toContain('总结：wrote report.md');
        expect(context).toContain('产出report：report.md');
        expect(context).toContain('<handed_in_files>\n- report.md（write）\n</handed_in_files>');
        expect(isBrief(first)).toBe(false);
    }, 120_000);
});
