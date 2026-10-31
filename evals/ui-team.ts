import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { _electron as electron, type Page } from 'playwright-core';

/**
 * Watches a team run in the real app with a real model, for reviewing the board and the execution flow: starts the
 * run from the team dialog, screenshots the team view and each of its tabs as the run goes, screenshots approval
 * cards before answering them, and saves the delivery report. Agents run the commands they write, so this runs in
 * the VM (evals/ui-vm.sh), never on a working machine.
 *
 *   node ui-team.mjs --app <exe> --task <tasks/team-feature> --out <dir>      key: XORA_EVAL_DEEPSEEK_KEY
 */

const { values } = parseArgs({
    options: {
        app: { type: 'string' },
        task: { type: 'string' },
        out: { type: 'string', default: path.join(tmpdir(), 'xora-ui-team') },
        model: { type: 'string', default: 'deepseek-v4-pro' },
        autonomy: { type: 'string', default: 'L1' },
        minutes: { type: 'string', default: '35' },
    },
});
const apiKey = process.env.XORA_EVAL_DEEPSEEK_KEY?.trim();
if (!apiKey || !values.app || !values.task) {
    throw new Error('need --app, --task and XORA_EVAL_DEEPSEEK_KEY');
}
const taskDir = path.resolve(values.task);
const task = JSON.parse(readFileSync(path.join(taskDir, 'task.json'), 'utf8')) as {
    title: string;
    prompt: string;
    budget?: number;
    teamMode?: 'standard' | 'hypotheses';
    check: string;
};
const out = path.resolve(values.out);
const shots = path.join(out, 'shots');
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'xora-ui-team-'));
const deadline = Date.now() + Number(values.minutes) * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => {
    console.log(line);
    writeFileSync(path.join(out, 'log.txt'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
};

/** Playwright needs the inspector fuse, which a packaged build switches off: run a copy with it on. */
async function inspectable(executable: string): Promise<string> {
    const wire = await getCurrentFuseWire(executable);
    if (wire[FuseV1Options.EnableNodeCliInspectArguments] !== '0'.charCodeAt(0)) {
        return executable;
    }
    const appDir = path.dirname(executable);
    const copyDir = path.join(work, 'app', path.basename(appDir));
    await cp(appDir, copyDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const copy = path.join(copyDir, path.basename(executable));
    await flipFuses(copy, { version: FuseVersion.V1, [FuseV1Options.EnableNodeCliInspectArguments]: true });
    return copy;
}

/** Calls the host over a fresh port, as the UI does. */
async function hostCall<T>(page: Page, method: string, params: unknown): Promise<T> {
    return page.evaluate(
        ([method, params]) =>
            new Promise<unknown>((resolve, reject) => {
                const onMessage = (event: MessageEvent) => {
                    const port = event.ports[0];
                    if ((event.data as { type?: string } | null)?.type !== 'xora:port' || !port) return;
                    window.removeEventListener('message', onMessage);
                    port.onmessage = (reply) => {
                        const data = reply.data as { result?: unknown; error?: { message: string } };
                        if (data.error) reject(new Error(data.error.message));
                        else resolve(data.result);
                        port.close();
                    };
                    port.postMessage({ jsonrpc: '2.0', id: 'ui-team', method, params });
                };
                window.addEventListener('message', onMessage);
                (window as unknown as { xoraShell: { requestPort(): void } }).xoraShell.requestPort();
            }),
        [method, params] as const,
    ) as Promise<T>;
}

let shot = 0;
async function snap(page: Page, name: string): Promise<void> {
    shot++;
    await page
        .screenshot({ path: path.join(shots, `${String(shot).padStart(3, '0')}-${name}.png`) })
        .catch(() => undefined);
}

const repo = path.join(work, 'repo');
cpSync(path.join(taskDir, 'repo'), repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'eval@example.com');
git('config', 'user.name', 'Eval');
git('add', '.');
git('commit', '-q', '-m', 'init');

const app = await electron.launch({
    executablePath: await inspectable(path.resolve(values.app)),
    args: ['--password-store=basic', '--no-sandbox', '--lang=zh-CN'],
    env: { ...process.env, XORA_DATA_DIR: path.join(work, 'data'), ELECTRON_RUN_AS_NODE: '' } as Record<string, string>,
    timeout: 120_000,
});
let status = 'not started';
try {
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
    page.setDefaultTimeout(60_000);
    await page.locator('.welcome').waitFor();

    const connection = await hostCall<{ id: string }>(page, 'provider.save', {
        presetId: 'deepseek',
        name: 'deepseek',
        apiKey,
    });
    await hostCall(page, 'provider.refreshModels', { connectionId: connection.id });
    await hostCall(page, 'settings.update', {
        patch: {
            defaultModel: { connectionId: connection.id, model: values.model },
            fastModel: { connectionId: connection.id, model: 'deepseek-flash' },
        },
    });
    const project = await hostCall<{ id: string }>(page, 'project.add', { path: repo });
    await hostCall(page, 'project.trust', { projectId: project.id, trusted: true });
    await page.locator('.project__name', { hasText: 'repo' }).waitFor();
    await snap(page, '项目已打开');

    await page.getByRole('button', { name: '交给团队', exact: true }).first().click();
    const dialog = page.locator('.modal');
    await dialog.locator('textarea').fill(task.prompt);
    await dialog.getByRole('combobox', { name: '自主级别' }).selectOption(values.autonomy);
    if (task.teamMode === 'hypotheses') {
        await dialog.getByRole('combobox', { name: '方式', exact: true }).selectOption('hypotheses');
    }
    await dialog.locator('input[type=number]').fill(String(task.budget ?? 5));
    await snap(page, '团队对话框');
    await dialog.getByRole('button', { name: '开始', exact: true }).click();
    await page.locator('.team__goal').waitFor();
    log('team run started');

    const tabs = ['看板', '账本', '对话', '花费', '交付报告'];
    let lastTabs = 0;
    for (;;) {
        const runs = await hostCall<Array<{ id: string; status: string; note?: string }>>(page, 'team.list', {
            projectId: project.id,
        });
        const run = runs[0];
        status = run?.status ?? 'missing';
        for (const approval of await hostCall<Array<{ id: string; title: string; risks: string[] }>>(
            page,
            'approval.list',
            {},
        )) {
            await snap(page, `审批-${approval.title.slice(0, 20)}`);
            const outside = approval.risks.includes('outside_workspace') || approval.risks.includes('sensitive_file');
            log(`approval: ${approval.title} → ${outside ? 'deny' : 'allow'}`);
            await hostCall(page, 'approval.respond', {
                approvalId: approval.id,
                decision: outside ? 'deny' : 'allow_session',
            }).catch((error: unknown) => log(`approval failed: ${String(error)}`));
        }
        if (Date.now() - lastTabs > 60_000) {
            lastTabs = Date.now();
            for (const tab of tabs) {
                await page
                    .locator('.team__tabs')
                    .getByRole('button', { name: tab, exact: true })
                    .click()
                    .catch(() => undefined);
                await sleep(500);
                await snap(page, `${status}-${tab}`);
            }
            await page.locator('.team__tabs').getByRole('button', { name: '看板', exact: true }).click().catch(() => undefined);
        }
        if (['done', 'failed', 'cancelled'].includes(status)) {
            log(`run ${status}${run?.note ? `: ${run.note}` : ''}`);
            break;
        }
        if (status === 'paused') {
            log(`run paused: ${run?.note ?? ''}`);
            await snap(page, '暂停');
            break;
        }
        if (Date.now() > deadline) {
            log('time is up');
            break;
        }
        await sleep(5000);
    }
    for (const tab of tabs) {
        await page.locator('.team__tabs').getByRole('button', { name: tab, exact: true }).click().catch(() => undefined);
        await sleep(800);
        await snap(page, `结束-${tab}`);
    }
    const runs = await hostCall<Array<{ id: string; report?: string }>>(page, 'team.list', { projectId: project.id });
    if (runs[0]?.report) {
        writeFileSync(path.join(out, 'report.md'), runs[0].report);
    }
    await page.getByRole('button', { name: '打开主管线程' }).click().catch(() => undefined);
    await sleep(1500);
    await snap(page, '主管线程');
} catch (error) {
    log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
    await app.close().catch(() => undefined);
}
const hidden = path.join(taskDir, 'hidden');
if (existsSync(hidden)) {
    cpSync(hidden, repo, { recursive: true });
}
let check = 'not run';
try {
    execFileSync('bash', ['-lc', task.check], { cwd: repo, stdio: 'pipe', timeout: 300_000 });
    check = 'passed';
} catch (error) {
    check = `failed: ${String((error as { stdout?: Buffer }).stdout ?? '').slice(-1500)}`;
}
log(`status ${status}, check ${check}`);
writeFileSync(path.join(out, 'diff.patch'), execFileSync('git', ['diff', 'HEAD'], { cwd: repo, encoding: 'utf8' }));
