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
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('\n');
    return '';
}

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

        // An untrusted project's workflows are listed with the reason they cannot run.
        const untrusted = await first.ui.request('workflow.list', { projectId: project.id });
        expect(untrusted.map((info) => [info.key, info.issues.map((issue) => issue.message)])).toEqual([
            ['project:bugfix', ['项目还没有被信任：信任后才能运行项目里的工作流']],
        ]);
        await first.ui.request('project.trust', { projectId: project.id, trusted: true });
        const [info] = await first.ui.request('workflow.list', { projectId: project.id });
        expect(info).toMatchObject({
            key: 'project:bugfix',
            title: '修缺陷',
            issues: [],
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
        const agents = server.requests.slice(before).map((request) => agentOf(request.body as ChatBody | undefined));
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

    it('starts unattended runs only on api channels, with a budget, and pauses when it is spent', async () => {
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

        // Only a custom endpoint and no budget: the run is recorded as failed, with the reasons.
        const refused = await host.core.workflows.fire({
            projectId: project.id,
            key: 'project:nightly',
            trigger: { reason: 'schedule' },
        });
        expect(refused?.status).toBe('failed');
        expect(refused?.note).toContain('not allowed: custom');
        expect(refused?.note).toContain('L3 needs a budget');
        // It would fail the same way every time: its triggers are switched off.
        expect(
            (await host.ui.request('workflow.list', { projectId: project.id })).find(
                (info) => info.key === 'project:nightly',
            )?.triggers,
        ).toEqual({ enabled: false, stale: false });

        // An api connection and a budget: the run starts on the api channel, then pauses once the budget is gone.
        const api = await host.ui.request('provider.save', {
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
        expect(step?.model?.connectionId).toBe(api.id);
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
        expect(distilled.title).toBe('沉淀工作流：打个招呼');
        expect(distilled.mode).toBe('ask');
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
});
