import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HostCore } from '../packages/host/src/core.ts';
import type { Logger } from '../packages/host/src/log.ts';
import { MemoryShell } from '../packages/host/src/shell.ts';
import {
    type Approval,
    domPortTransport,
    type EventEnvelope,
    type HostMethods,
    type HostNotifications,
    type Item,
    methods,
    notifications,
    RpcPeer,
    type UsageTotals,
} from '../packages/protocol/src/index.ts';

/**
 * Real-model evaluation (14 §3): runs each task through the real host and xora engine against a live provider,
 * then checks the result in the task's repository. The agents run the commands they write, so this runs in the VM
 * (evals/vm.sh), never on a working machine.
 *
 *   node dist/eval/run.mjs --engine dist/eval/engine.cjs [--tasks a,b] [--model deepseek-v4-pro] [--out dir]
 *
 * The API key comes from XORA_EVAL_DEEPSEEK_KEY and is never written anywhere.
 */

type Ui = RpcPeer<HostMethods, HostNotifications>;

interface TaskSpec {
    readonly id: string;
    readonly title: string;
    readonly kind: 'thread' | 'team' | 'workflow';
    /** First message of a thread, or the team's goal. */
    readonly prompt?: string;
    /** Later messages of a thread, one turn each. */
    readonly followUps?: readonly string[];
    readonly mode?: 'ask' | 'auto_edit' | 'plan' | 'full';
    readonly workflow?: string;
    readonly inputs?: Readonly<Record<string, string | number | boolean>>;
    /** Settings for this task, e.g. a small `softContextWindow` to force compaction. */
    readonly settings?: Readonly<Record<string, unknown>>;
    /** Budget of a team or workflow run, in CNY. */
    readonly budget?: number;
    /** Team runs: `hypotheses` investigates rival causes in parallel (06 §7). */
    readonly teamMode?: 'standard' | 'hypotheses';
    readonly timeoutMinutes?: number;
    /** Run in the repository after the agents finish; exit code 0 passes. */
    readonly check: string;
    /** The default model is a local server that always answers 503; the real model is the fallback. */
    readonly brokenPrimary?: boolean;
    /** What the run should show besides a passing check. */
    readonly expect?: { readonly compaction?: boolean; readonly fallback?: boolean; readonly subagents?: number };
}

interface ThreadStats {
    readonly threadId: string;
    readonly title: string;
    turns: number;
    failedTurns: number;
    toolCalls: number;
    failedToolCalls: number;
    readonly toolKinds: Record<string, number>;
    compactions: number;
    subagents: number;
    fallbacks: number;
    notices: string[];
    errors: string[];
}

interface TaskResult {
    readonly id: string;
    readonly title: string;
    readonly kind: TaskSpec['kind'];
    readonly model: string;
    status: string;
    note?: string;
    checkPassed: boolean;
    checkOutput: string;
    expectations: string[];
    readonly durationMs: number;
    usage?: UsageTotals;
    threads: ThreadStats[];
    approvals: Array<{ title: string; command?: string; risks: readonly string[]; decision: string }>;
    error?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
    options: {
        engine: { type: 'string' },
        tasks: { type: 'string' },
        'tasks-dir': { type: 'string', default: path.join(here, 'tasks') },
        model: { type: 'string', default: 'deepseek-v4-pro' },
        'fast-model': { type: 'string', default: 'deepseek-flash' },
        out: { type: 'string', default: path.join(tmpdir(), 'xora-eval') },
    },
});
const apiKey = process.env.XORA_EVAL_DEEPSEEK_KEY?.trim();
if (!apiKey) {
    throw new Error('set XORA_EVAL_DEEPSEEK_KEY');
}
if (!values.engine || !existsSync(values.engine)) {
    throw new Error('--engine <engine.cjs> is required (node evals/build.ts makes it)');
}
const engineEntry = path.resolve(values.engine);
const tasksDir = path.resolve(values['tasks-dir']);
const outDir = path.resolve(values.out);
const wanted = values.tasks?.split(',').map((id) => id.trim());
const taskIds = readdirSync(tasksDir)
    .filter((id) => existsSync(path.join(tasksDir, id, 'task.json')))
    .filter((id) => !wanted || wanted.includes(id))
    .sort();
mkdirSync(outDir, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function gitRepo(fixture: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-eval-repo-'));
    cpSync(fixture, dir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'eval@example.com');
    git('config', 'user.name', 'Eval');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
}

function fileLogger(file: string): Logger {
    const write = (level: string, message: string) =>
        appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
    return {
        info: (message: string) => write('info', message),
        warn: (message: string) => write('warn', message),
        error: (message: string) => write('error', message),
    } as Logger;
}

/** Approves what stays in the task's repository; anything outside it, secrets or high-risk actions are denied. */
function answerApprovals(ui: Ui, log: TaskResult['approvals']): void {
    ui.onNotification('approval.requested', ({ approval }: { approval: Approval }) => {
        const outside = approval.risks.includes('outside_workspace') || approval.risks.includes('sensitive_file');
        const risky = /\bgit\s+push\b|\bnpm\s+publish\b|\bsudo\b|\bcurl\b[^|]*\|\s*(ba)?sh/.test(approval.command ?? '');
        const decision = outside || risky ? 'deny' : 'allow_session';
        log.push({
            title: approval.title,
            ...(approval.command ? { command: approval.command } : {}),
            risks: approval.risks,
            decision,
        });
        void ui
            .request('approval.respond', {
                approvalId: approval.id,
                decision,
                ...(decision === 'deny' ? { message: 'Not allowed in this evaluation: stay inside the repository.' } : {}),
            })
            .catch(() => undefined);
    });
}

/** An OpenAI-compatible server whose one model is always overloaded. */
async function brokenModelServer(): Promise<{ url: string; close(): void }> {
    const server = createServer((request, response) => {
        if (request.method === 'GET') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ object: 'list', data: [{ id: 'broken-model', object: 'model' }] }));
            return;
        }
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'overloaded (evaluation)', type: 'overloaded_error' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => {
            server.close();
            server.closeAllConnections();
        },
    };
}

function eventItem(event: EventEnvelope): Item | undefined {
    if (event.kind !== 'item.completed') {
        return undefined;
    }
    return (event.payload as { item?: Item }).item;
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function threadStats(ui: Ui, threadId: string, transcript: string[]): Promise<ThreadStats> {
    const snapshot = await ui.request('thread.read', { threadId });
    const stats: ThreadStats = {
        threadId,
        title: snapshot.thread.title,
        turns: 0,
        failedTurns: 0,
        toolCalls: 0,
        failedToolCalls: 0,
        toolKinds: {},
        compactions: 0,
        subagents: 0,
        fallbacks: 0,
        notices: [],
        errors: [],
    };
    transcript.push(`\n## ${snapshot.thread.title} (${threadId})\n`);
    for (const event of snapshot.events) {
        if (event.kind === 'turn.completed') {
            stats.turns++;
            const payload = event.payload as { stopReason: string; durationMs: number };
            transcript.push(`--- turn completed: ${payload.stopReason}, ${Math.round(payload.durationMs / 1000)}s`);
        } else if (event.kind === 'turn.failed') {
            stats.turns++;
            stats.failedTurns++;
            const payload = event.payload as { error: { message?: string } };
            stats.errors.push(payload.error.message ?? 'turn failed');
            transcript.push(`--- turn FAILED: ${payload.error.message ?? ''}`);
        }
        const item = eventItem(event);
        if (!item) continue;
        switch (item.type) {
            case 'user_message':
                transcript.push(`\n**user**: ${clip((item as { text?: string }).text ?? '', 3000)}\n`);
                break;
            case 'agent_message':
                transcript.push(`\n**agent**: ${clip((item as { text?: string }).text ?? '', 3000)}\n`);
                break;
            case 'tool_call': {
                stats.toolCalls++;
                stats.toolKinds[item.kind] = (stats.toolKinds[item.kind] ?? 0) + 1;
                if (item.status === 'failed') stats.failedToolCalls++;
                transcript.push(`- [${item.kind}] ${clip(item.title, 300)} (${item.status})`);
                break;
            }
            case 'compaction':
                if (item.status === 'completed') stats.compactions++;
                transcript.push(`> compaction level ${item.level} ${item.status}: ${item.before ?? '?'} → ${item.after ?? '?'}`);
                break;
            case 'subagent': {
                const subagent = item as { agent?: string; title?: string; status?: string };
                if (subagent.status === 'completed') stats.subagents++;
                transcript.push(`> subagent ${subagent.agent ?? ''}: ${subagent.title ?? ''} (${subagent.status ?? ''})`);
                break;
            }
            case 'notice': {
                const notice = item as { title?: string; description?: string };
                if (/切换到备用模型|Switched to the fallback model/.test(notice.title ?? '')) stats.fallbacks++;
                stats.notices.push(clip(`${notice.title ?? ''} ${notice.description ?? ''}`.trim(), 300));
                transcript.push(`> notice: ${clip(`${notice.title ?? ''} ${notice.description ?? ''}`, 500)}`);
                break;
            }
            case 'error': {
                const error = item as { message?: string };
                stats.errors.push(clip(error.message ?? 'error', 300));
                transcript.push(`> ERROR: ${clip(error.message ?? '', 500)}`);
                break;
            }
            default:
                break;
        }
    }
    return stats;
}

async function waitTurn(ui: Ui, threadId: string, turnId: string, deadline: number): Promise<string> {
    for (;;) {
        const snapshot = await ui.request('thread.read', { threadId });
        const end = snapshot.events.find(
            (event) =>
                (event.kind === 'turn.completed' || event.kind === 'turn.failed') &&
                (event.payload as { turnId?: string }).turnId === turnId,
        );
        if (end) {
            return end.kind === 'turn.completed'
                ? (end.payload as { stopReason: string }).stopReason
                : `failed: ${(end.payload as { error: { message?: string } }).error.message ?? ''}`;
        }
        if (Date.now() > deadline) {
            await ui.request('turn.cancel', { threadId }).catch(() => undefined);
            return 'timeout';
        }
        await sleep(2000);
    }
}

async function runThread(ui: Ui, task: TaskSpec, projectId: string, deadline: number): Promise<string> {
    const thread = await ui.request('thread.create', {
        projectId,
        title: task.title,
        mode: task.mode ?? 'full',
    });
    let status = 'end_turn';
    for (const text of [task.prompt ?? '', ...(task.followUps ?? [])]) {
        const { turnId } = await ui.request('turn.start', { threadId: thread.id, text });
        status = await waitTurn(ui, thread.id, turnId, deadline);
        if (status !== 'end_turn') {
            break;
        }
    }
    return status;
}

async function runTeam(ui: Ui, task: TaskSpec, projectId: string, deadline: number): Promise<{ status: string; note?: string }> {
    let run = await ui.request('team.start', {
        projectId,
        goal: task.prompt ?? '',
        autonomy: 'L3',
        budget: task.budget ?? 3,
        ...(task.teamMode ? { mode: task.teamMode } : {}),
    });
    for (;;) {
        run = await ui.request('team.get', { runId: run.id });
        if (['done', 'failed', 'cancelled', 'paused'].includes(run.status)) {
            if (run.status === 'paused') {
                await ui.request('team.stop', { runId: run.id }).catch(() => undefined);
            }
            return { status: run.status, ...(run.note ? { note: run.note } : {}) };
        }
        if (Date.now() > deadline) {
            await ui.request('team.stop', { runId: run.id }).catch(() => undefined);
            return { status: 'timeout', ...(run.note ? { note: run.note } : {}) };
        }
        await sleep(5000);
    }
}

async function runWorkflow(ui: Ui, task: TaskSpec, projectId: string, deadline: number): Promise<{ status: string; note?: string }> {
    let run = await ui.request('workflow.start', {
        projectId,
        key: task.workflow ?? '',
        ...(task.inputs ? { inputs: { ...task.inputs } } : {}),
        budget: task.budget ?? 3,
    });
    for (;;) {
        run = await ui.request('workflow.get', { runId: run.id });
        if (['completed', 'failed', 'cancelled', 'paused'].includes(run.status)) {
            if (run.status === 'paused') {
                await ui.request('workflow.stop', { runId: run.id }).catch(() => undefined);
            }
            const note = (run as { note?: string }).note;
            return { status: run.status, ...(note ? { note } : {}) };
        }
        if (Date.now() > deadline) {
            await ui.request('workflow.stop', { runId: run.id }).catch(() => undefined);
            return { status: 'timeout' };
        }
        await sleep(5000);
    }
}

async function runTask(id: string): Promise<TaskResult> {
    const folder = path.join(tasksDir, id);
    const task = { id, ...JSON.parse(readFileSync(path.join(folder, 'task.json'), 'utf8')) } as TaskSpec;
    const out = path.join(outDir, id);
    mkdirSync(out, { recursive: true });
    const repo = gitRepo(path.join(folder, 'repo'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'xora-eval-data-'));
    const home = mkdtempSync(path.join(tmpdir(), 'xora-eval-home-'));
    const started = Date.now();
    const deadline = started + (task.timeoutMinutes ?? 15) * 60_000;
    const result: TaskResult = {
        id,
        title: task.title,
        kind: task.kind,
        model: values.model,
        status: 'not started',
        checkPassed: false,
        checkOutput: '',
        expectations: [],
        durationMs: 0,
        threads: [],
        approvals: [],
    };
    console.log(`\n▶ ${id}: ${task.title}`);
    const core = await HostCore.create({
        dataDir,
        shell: new MemoryShell({ dataDir }),
        bundleVersion: '1.0.0-eval',
        shellVersion: '1.0.0-eval',
        engineEntry,
        skipShellEnv: true,
        home,
        log: fileLogger(path.join(out, 'host.log')),
    });
    const channel = new MessageChannel();
    const hostSide = core.connectUi(domPortTransport(channel.port1));
    const ui: Ui = new RpcPeer(domPortTransport(channel.port2), { methods, notifications, timeoutMs: 120_000 });
    answerApprovals(ui, result.approvals);
    const broken = task.brokenPrimary ? await brokenModelServer() : undefined;
    try {
        const connection = await ui.request('provider.save', { presetId: 'deepseek', name: 'deepseek', apiKey });
        await ui.request('provider.refreshModels', { connectionId: connection.id });
        const real = { connectionId: connection.id, model: values.model };
        let primary = real;
        if (broken) {
            const failing = await ui.request('provider.save', {
                presetId: 'custom-openai',
                name: 'always-503',
                apiKey: 'none',
                baseUrl: broken.url,
            });
            await ui.request('provider.refreshModels', { connectionId: failing.id });
            primary = { connectionId: failing.id, model: 'broken-model' };
        }
        await ui.request('settings.update', {
            patch: {
                defaultModel: primary,
                fastModel: { connectionId: connection.id, model: values['fast-model'] },
                ...(broken ? { fallbackModels: [real] } : {}),
                ...(task.settings ?? {}),
            },
        });
        const project = await ui.request('project.add', { path: repo });
        await ui.request('project.trust', { projectId: project.id, trusted: true }).catch(() => undefined);
        if (task.kind === 'thread') {
            result.status = await runThread(ui, task, project.id, deadline);
        } else {
            const outcome =
                task.kind === 'team'
                    ? await runTeam(ui, task, project.id, deadline)
                    : await runWorkflow(ui, task, project.id, deadline);
            result.status = outcome.status;
            if (outcome.note) result.note = outcome.note;
        }
        const transcript: string[] = [`# ${id}: ${task.title}`];
        for (const thread of await ui.request('thread.list', { projectId: project.id, includeArchived: true })) {
            result.threads.push(await threadStats(ui, thread.id, transcript));
        }
        writeFileSync(path.join(out, 'transcript.md'), `${transcript.join('\n')}\n`);
        result.usage = (await ui.request('usage.summary', { range: 'all', groupBy: 'model' })).totals;
    } catch (error) {
        result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
        broken?.close();
        ui.dispose();
        hostSide.dispose();
        channel.port1.close();
        channel.port2.close();
        await core.dispose().catch(() => undefined);
    }
    const hidden = path.join(folder, 'hidden');
    if (existsSync(hidden)) {
        cpSync(hidden, repo, { recursive: true });
    }
    const check = spawnSync('bash', ['-lc', task.check], { cwd: repo, encoding: 'utf8', timeout: 300_000 });
    result.checkPassed = check.status === 0;
    result.checkOutput = clip(`${check.stdout ?? ''}${check.stderr ?? ''}`.trim(), 4000);
    if (task.expect?.compaction && !result.threads.some((thread) => thread.compactions > 0)) {
        result.expectations.push('expected a compaction, none happened');
    }
    if (task.expect?.fallback && !result.threads.some((thread) => thread.fallbacks > 0)) {
        result.expectations.push('expected a switch to the fallback model, none happened');
    }
    const subagents = result.threads.reduce((sum, thread) => sum + thread.subagents, 0);
    if (task.expect?.subagents !== undefined && subagents < task.expect.subagents) {
        result.expectations.push(`expected at least ${task.expect.subagents} subagents, got ${subagents}`);
    }
    writeFileSync(path.join(out, 'diff.patch'), execFileSync('git', ['diff', 'HEAD'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 }));
    (result as { durationMs: number }).durationMs = Date.now() - started;
    writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    const pass = result.checkPassed && result.expectations.length === 0 && !result.error;
    console.log(
        `${pass ? '✓' : '✗'} ${id}: ${result.status}, check ${result.checkPassed ? 'passed' : 'failed'}, ` +
            `${Math.round(result.durationMs / 1000)}s, ${result.usage?.requests ?? 0} requests, ` +
            `¥${(result.usage?.cost.amount ?? 0).toFixed(3)}${result.error ? `, error: ${result.error.split('\n')[0]}` : ''}`,
    );
    return result;
}

const results: TaskResult[] = [];
for (const id of taskIds) {
    results.push(await runTask(id));
}

const rows = results.map((result) => {
    const threads = result.threads;
    const sum = (pick: (thread: ThreadStats) => number) => threads.reduce((total, thread) => total + pick(thread), 0);
    const pass = result.checkPassed && result.expectations.length === 0 && !result.error;
    const usage = result.usage;
    return (
        `| ${result.id} | ${result.kind} | ${pass ? '通过' : '没过'} | ${result.status} | ` +
        `${Math.round(result.durationMs / 1000)}s | ${usage?.requests ?? 0} | ` +
        `${usage ? `${Math.round(usage.inputTokens / 1000)}k/${Math.round(usage.cachedTokens / 1000)}k/${Math.round(usage.outputTokens / 1000)}k` : '-'} | ` +
        `${usage ? `¥${usage.cost.amount.toFixed(3)}${usage.complete ? '' : '+'}` : '-'} | ${threads.length} | ` +
        `${sum((thread) => thread.toolCalls)}（失败${sum((thread) => thread.failedToolCalls)}） | ${sum((thread) => thread.compactions)} | ` +
        `${[result.note, ...result.expectations, result.error?.split('\n')[0]].filter(Boolean).join('；')} |`
    );
});
const summary = [
    `# 评测结果（${values.model}，${new Date().toISOString()}）`,
    '',
    '| 任务 | 类型 | 结果 | 结束状态 | 用时 | 请求数 | 输入/缓存/输出token | 花费 | 线程 | 工具调用 | 压缩 | 备注 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
].join('\n');
writeFileSync(path.join(outDir, 'summary.md'), summary);
console.log(`\n${summary}`);
const failed = results.filter((result) => !(result.checkPassed && result.expectations.length === 0 && !result.error));
process.exitCode = failed.length > 0 ? 1 : 0;
