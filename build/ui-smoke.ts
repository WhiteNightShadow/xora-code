import { execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { type ElectronApplication, _electron as electron, type Page } from 'playwright-core';
import { openaiText, openaiToolCalls, startMockModelServer } from '../packages/test-kit/src/index.ts';
import { secretStoreSwitches } from './app-switches.ts';

/**
 * UI smoke test in the real app (M1 acceptance): connect a model, open a project, ask for a change, approve it,
 * review the diff and undo it — all through the UI, against a scripted model server and throwaway data. Then the
 * M4 extensions: a project command shows up in the composer and on the settings page. Last, a fresh start with an
 * English app locale: the UI and the menus follow the system's language until one is picked in the settings.
 *
 *   node build/ui-smoke.ts                 unpackaged shell with dist/app-bundle (run `pnpm build && pnpm bundle`)
 *   node build/ui-smoke.ts --app <exe>     a packaged build
 *   node build/ui-smoke.ts --shots <dir>   save screenshots of each step
 */

const { values } = parseArgs({
    options: {
        app: { type: 'string' },
        shots: { type: 'string' },
        keep: { type: 'boolean', default: false },
        show: { type: 'boolean', default: false },
        // Multiplies every wait, for slow machines such as the x64 Windows VM under software emulation.
        'timeout-scale': { type: 'string', default: '1' },
    },
});
const scale = Math.max(1, Number(values['timeout-scale']) || 1);
const ms = (value: number): number => value * scale;

// Not from keys.ts: this file also runs bundled on test machines without the repository (build/vm/harness.ts).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const work = await mkdtemp(path.join(tmpdir(), 'xora-smoke-'));

/**
 * Playwright drives Electron through the Node inspector, which a packaged build switches off with the
 * EnableNodeCliInspectArguments fuse. Such a build runs from a copy with only that fuse switched back on.
 */
async function inspectable(executable: string): Promise<string> {
    const wire = await getCurrentFuseWire(executable);
    // @electron/fuses reports each fuse as the ASCII digit stored in the binary.
    if (wire[FuseV1Options.EnableNodeCliInspectArguments] !== '0'.charCodeAt(0)) {
        return executable;
    }
    const appDir =
        process.platform === 'darwin'
            ? executable.slice(0, executable.lastIndexOf('.app') + '.app'.length)
            : path.dirname(executable);
    const copyDir = path.join(work, 'app', path.basename(appDir));
    await cp(appDir, copyDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const copy = path.join(copyDir, path.relative(appDir, executable));
    await flipFuses(copy, {
        version: FuseVersion.V1,
        [FuseV1Options.EnableNodeCliInspectArguments]: true,
        resetAdHocDarwinSignature: process.platform === 'darwin',
    });
    console.log(`(running a copy with the inspector fuse on: ${copy})`);
    return copy;
}

const executablePath = values.app
    ? await inspectable(path.resolve(values.app))
    : (createRequire(path.join(desktopDir, 'package.json'))('electron') as string);
const dataDir = path.join(work, 'data');
const repo = path.join(work, 'repo');
const steps: string[] = [];

function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

await mkdir(repo, { recursive: true });
git('init', '-q');
git('config', 'user.email', 'smoke@example.com');
git('config', 'user.name', 'Smoke');
await writeFile(path.join(repo, 'hello.txt'), 'hello\n');
git('add', '.');
git('commit', '-q', '-m', 'init');
// A user workflow (any project, no trust needed): a command and an agent that hands in a file, then a human gate.
await mkdir(path.join(dataDir, 'workflows'), { recursive: true });
await writeFile(
    path.join(dataDir, 'workflows', 'smoke.yaml'),
    [
        'name: smoke',
        'title: 冒烟工作流',
        'steps:',
        '  - id: status',
        '    run: git branch xora-smoke',
        '  - id: note',
        '    agent: scout',
        '    task: 交回hello.txt',
        '    outputs: [report, facts]',
        '  - id: confirm',
        '    needs: [status, note]',
        '    gate: human',
        '    message: 冒烟确认',
        '',
    ].join('\n'),
);

const server = await startMockModelServer();
// A page for the preview panel, served on loopback only.
const site = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Smoke page</title><h1 id="hello">hello preview</h1>');
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
server.respondWith((request) => {
    if (request.method !== 'POST') {
        // Let the server answer `/models` itself.
        return undefined;
    }
    const body = request.body as
        | { messages?: Array<{ role: string }>; tools?: Array<{ function?: { name?: string } }> }
        | undefined;
    const messages = body?.messages ?? [];
    // The brief of a finished run: a request without tools that asks for the three headings.
    if (!body?.tools?.length && JSON.stringify(messages).includes('## 结论')) {
        return openaiText(
            '## 结论\n冒烟工作流跑完了，交回了hello.txt。\n\n## 问题\n- 无\n\n## 下一步\n- 打开hello.txt看一眼',
        );
    }
    // A member asked to remember something writes it into its memory.
    if (
        body?.tools?.some((tool) => tool.function?.name === 'remember') &&
        messages.at(-1)?.role === 'user' &&
        JSON.stringify(messages.at(-1)).includes('记住：')
    ) {
        return openaiToolCalls([{ name: 'remember', arguments: JSON.stringify({ note: 'hello.txt是冒烟用的文件' }) }]);
    }
    // A workflow step's agent hands its result in.
    if (body?.tools?.some((tool) => tool.function?.name === 'step_result')) {
        return messages.at(-1)?.role === 'tool'
            ? openaiText('交回了。')
            : openaiToolCalls([
                  {
                      name: 'step_result',
                      arguments: JSON.stringify({
                          summary: '交回了hello.txt',
                          // Long, like real findings: the card folds it until it is opened.
                          outputs: { report: 'hello.txt', facts: '1. hello.txt只有一行。'.repeat(60) },
                      }),
                  },
              ]);
    }
    if (messages.at(-1)?.role === 'tool') {
        return openaiText('已经把hello.txt改成hello world。');
    }
    return openaiToolCalls([
        {
            name: 'edit',
            arguments: JSON.stringify({ path: 'hello.txt', oldString: 'hello', newString: 'hello world' }),
        },
    ]);
});

let shot = 0;
async function step(page: Page, name: string): Promise<void> {
    steps.push(name);
    console.log(`✓ ${name}`);
    if (values.shots) {
        shot++;
        await page
            .screenshot({ path: path.join(values.shots, `${String(shot).padStart(2, '0')}-${name}.png`) })
            .catch(() => undefined);
    }
}

/** Calls the host directly over a fresh port, for what the UI only offers through a native dialog. */
async function hostCall(page: Page, method: string, params: unknown): Promise<unknown> {
    return page.evaluate(
        ([method, params]) =>
            new Promise((resolve, reject) => {
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
                    port.postMessage({ jsonrpc: '2.0', id: 'smoke', method, params });
                };
                window.addEventListener('message', onMessage);
                (window as unknown as { xoraShell: { requestPort(): void } }).xoraShell.requestPort();
            }),
        [method, params] as const,
    );
}

let failed = false;
let current: Page | undefined;

/** Starts the app on a data folder, with `lang` as the app locale: Chromium's --lang works on every platform. */
function launch(data: string, lang: string): Promise<ElectronApplication> {
    return electron.launch({
        executablePath,
        args: [
            ...(values.app ? [] : [desktopDir]),
            ...secretStoreSwitches(),
            // On Linux the copy has neither the setuid sandbox helper nor the AppArmor profile that lets the
            // installed app create its sandbox (Ubuntu 24.04); the update drill checks the installed app with it.
            ...(process.platform === 'linux' && values.app && executablePath !== path.resolve(values.app)
                ? ['--no-sandbox']
                : []),
            `--lang=${lang}`,
        ],
        env: {
            ...process.env,
            XORA_DATA_DIR: data,
            XORA_TEST_PLAIN_SECRETS: '1',
            ...(values.show ? {} : { XORA_TEST_HIDE_WINDOWS: '1' }),
            ELECTRON_RUN_AS_NODE: '',
        } as Record<string, string>,
        timeout: ms(60_000),
    });
}

/** Closes the windows the way a user does; false when the app did not quit on its own and had to be killed. */
async function closeApp(instance: ElectronApplication): Promise<boolean> {
    const exited = new Promise<boolean>((resolve) => instance.process().once('exit', () => resolve(true)));
    await instance
        .evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) window.close();
        })
        .catch(() => undefined);
    const quit = await Promise.race([
        exited,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms(20_000))),
    ]);
    if (!quit) {
        instance.process().kill('SIGKILL');
    }
    return quit;
}

/** Waits until the application menu has a top-level item with this label. */
async function menuShows(instance: ElectronApplication, label: string): Promise<void> {
    const deadline = Date.now() + ms(10_000);
    let labels: string[] = [];
    while (Date.now() < deadline) {
        labels = await instance.evaluate(
            ({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [],
        );
        if (labels.includes(label)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`菜单里没有“${label}”：${labels.join('、')}`);
}

function reportFailure(error: unknown): void {
    failed = true;
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
}

async function failureShot(): Promise<void> {
    if (current) {
        const file = path.join(values.shots ?? work, 'failure.png');
        await current.screenshot({ path: file }).catch(() => undefined);
        console.error(`  失败截图：${file}`);
    }
}

// The steps find controls by their Chinese names, and the UI follows the system's language by default.
const app = await launch(dataDir, 'zh-CN');

try {
    const page = await app.firstWindow({ timeout: ms(60_000) });
    current = page;
    page.on('dialog', (dialog) => void dialog.accept());
    page.setDefaultTimeout(ms(30_000));

    await page.locator('.welcome').waitFor();
    // The shell starts under the keychain entry's name and must be back to the product name for menus and windows.
    const appName = await app.evaluate(({ app }) => app.name);
    if (appName !== 'Xora Code') {
        throw new Error(`app.name is "${appName}" after startup`);
    }
    await step(page, '首次启动显示引导页');

    await page.getByRole('button', { name: /连接一个模型/ }).click();
    const editor = page.locator('.connection-editor');
    await editor.locator('select').selectOption('custom-openai');
    await editor.locator('input').first().fill('mock');
    await editor.locator('input[type=password]').fill('test-key');
    await editor.locator('input').last().fill(server.url);
    await editor.getByRole('button', { name: '保存' }).click();
    await page.locator('.connection').first().waitFor();
    await page.getByRole('button', { name: '刷新模型列表' }).click();
    await Promise.race([
        page.locator('.connection__models select').waitFor(),
        page
            .locator('.toast--error')
            .first()
            .waitFor()
            .then(async () => {
                throw new Error(`刷新模型失败：${await page.locator('.toast--error').first().textContent()}`);
            }),
    ]);
    await step(page, '添加模型连接并刷新模型');

    const defaultModel = page.locator('.field', { hasText: '默认模型' }).locator('select');
    const value = await defaultModel.locator('option').nth(1).getAttribute('value');
    if (value) await defaultModel.selectOption(value);
    await page.keyboard.press('Escape');

    await hostCall(page, 'project.add', { path: repo });
    await page.locator('.project__name', { hasText: 'repo' }).waitFor();
    await step(page, '打开项目');

    // New things start from the project's "+": a thread, a team or a workflow.
    await page.locator('.project__header').getByRole('button', { name: '新建', exact: true }).first().click();
    await page.getByRole('menuitemradio', { name: /新建线程/ }).click();
    // Typed key by key: a dialog that takes the focus back on every render loses all but the first character.
    await page.locator('.dialog textarea').pressSequentially('把hello.txt里的hello改成hello world');
    await page.getByRole('button', { name: '创建' }).click();
    await page.getByRole('button', { name: '允许一次' }).waitFor();
    await step(page, '出现审批卡片');
    if ((await readFile(path.join(repo, 'hello.txt'), 'utf8')) !== 'hello\n') {
        throw new Error('the file changed before approval');
    }

    await page.getByRole('button', { name: '允许一次' }).click();
    await page.locator('.changes-card').waitFor();
    if ((await readFile(path.join(repo, 'hello.txt'), 'utf8')) !== 'hello world\n') {
        throw new Error('the approved edit was not applied');
    }
    await step(page, '批准后文件被修改并显示改动卡片');

    await page.locator('.changes-card').click();
    await page.locator('.changes__file', { hasText: 'hello.txt' }).waitFor();
    await page.locator('.diff__row--add').first().waitFor();
    await step(page, '变更面板显示diff');

    await page.getByRole('button', { name: '撤销这一轮' }).click();
    await page.locator('.toast', { hasText: '已恢复' }).waitFor();
    if ((await readFile(path.join(repo, 'hello.txt'), 'utf8')) !== 'hello\n') {
        throw new Error('undo did not restore the file');
    }
    await step(page, '撤销后文件恢复');

    // Compacting stays in this thread: a divider in the conversation, no "/compact" message, no new thread.
    const rows = await page.locator('.thread-row').count();
    await page.locator('.composer').getByRole('button', { name: '上下文', exact: true }).click();
    await page.locator('.context-card').getByRole('button', { name: '立即压缩', exact: true }).click();
    await page.locator('.turn--compaction .compaction.is-completed').waitFor();
    await page.keyboard.press('Escape');
    if ((await page.locator('.user-message', { hasText: '/compact' }).count()) > 0) {
        throw new Error('"/compact" shows up as a message');
    }
    if ((await page.locator('.thread-row').count()) !== rows) {
        throw new Error('compacting made another thread');
    }
    await step(page, '压缩留在当前线程');

    // M3-3: fork the thread from an earlier turn (the last one offers none: it would only copy the thread), then go
    // back to before that turn in the fork (files untouched).
    await page.getByRole('button', { name: '从这一轮分叉' }).first().click();
    await page.locator('.toast', { hasText: '已分叉到新线程' }).waitFor();
    await page.locator('.sidebar', { hasText: '（分叉）' }).waitFor();
    await step(page, '从一轮分叉出新线程');
    await page.getByRole('button', { name: '回到这一轮之前' }).first().click();
    await page.locator('.turn__confirm').getByRole('checkbox').uncheck();
    await page.locator('.turn__confirm').getByRole('button', { name: '确定' }).click();
    await page.locator('.turn--rewound').waitFor();
    if ((await readFile(path.join(repo, 'hello.txt'), 'utf8')) !== 'hello\n') {
        throw new Error('going back without files changed the files');
    }
    await step(page, '回到这一轮之前');

    await mkdir(path.join(repo, '.xora', 'commands'), { recursive: true });
    await writeFile(
        path.join(repo, '.xora', 'commands', 'greet.md'),
        '---\ndescription: 打个招呼\n---\nSay hello to $ARGUMENTS.\n',
    );
    const composer = page.locator('.composer__input');
    await composer.fill('/gr');
    await page.locator('.mention', { hasText: '/greet' }).waitFor();
    await composer.fill('');
    await step(page, '输入斜杠时提示项目里的命令');

    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings__nav').getByRole('button', { name: '扩展' }).click();
    await page.locator('.settings-section code', { hasText: '/greet' }).waitFor();
    await step(page, '设置的扩展页列出项目命令');
    await page.keyboard.press('Escape');

    // The composer's choices: the mode switches at once and becomes the default; the context meter opens.
    await page
        .locator('.composer')
        .getByRole('button', { name: /权限模式/ })
        .click();
    await page.getByRole('menuitemradio', { name: /全权/ }).click();
    await page.locator('.composer .mode-chip.is-full').waitFor();
    await page.locator('.composer').getByRole('button', { name: '上下文', exact: true }).click();
    await page.locator('.context-card', { hasText: '立即压缩' }).waitFor();
    await step(page, '输入框下面能切换模式、查看上下文');
    await page.keyboard.press('Escape');
    // Back to ask, which new work then starts with again: the workflow below expects its command to ask.
    await page
        .locator('.composer')
        .getByRole('button', { name: /权限模式/ })
        .click();
    await page.getByRole('menuitemradio', { name: /询问/ }).click();
    await page.locator('.composer .mode-chip.is-ask').waitFor();

    // Panels open from the thread's ⋯ menu.
    const openPanel = async (name: string) => {
        await page.locator('.thread-header').getByRole('button', { name: '更多', exact: true }).click();
        await page.getByRole('menuitemcheckbox', { name, exact: true }).click();
    };

    // A real shell through node-pty in the thread's folder (M3-5).
    await openPanel('终端');
    await page.locator('.terminal-panel .xterm').waitFor();
    // Type only once the shell has drawn its prompt; some shells drop what was typed while they start.
    await page.waitForFunction(
        () => (document.querySelector('.terminal-panel .xterm-rows')?.textContent ?? '').trim().length > 0,
        undefined,
        { timeout: ms(30_000) },
    );
    let echoed = false;
    for (let attempt = 0; attempt < 3 && !echoed; attempt++) {
        await page.waitForTimeout(500);
        await page.locator('.terminal-panel .xterm').click();
        // PowerShell on Windows, a POSIX shell elsewhere; either way the 42 only shows up in the output.
        await page.keyboard.type(
            process.platform === 'win32' ? 'echo "xora-smoke-$(40+2)"\n' : 'echo xora-smoke-$((40+2))\n',
        );
        echoed = await page
            .locator('.terminal-panel .xterm-rows', { hasText: 'xora-smoke-42' })
            .waitFor({ timeout: ms(10_000) })
            .then(
                () => true,
                () => false,
            );
    }
    if (!echoed) throw new Error('the terminal did not run the command');
    await step(page, '终端能运行命令');

    // The preview panel loads a local page in its sandboxed view (M3-6). Screenshots need a window on screen, so
    // they are only checked with --show.
    await openPanel('预览');
    await page.locator('.preview input[aria-label=url]').fill(siteUrl);
    await page.locator('.preview').getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('.preview__title', { hasText: 'Smoke page' }).waitFor();
    if (values.show) {
        await page.locator('.preview').getByRole('button', { name: '截图发给agent' }).click();
        await page.locator('.composer .chip', { hasText: 'preview.png' }).waitFor();
    }
    await step(page, '预览能打开本地页面');

    // M4: hand a goal to a team; the team view shows the run, which can be stopped.
    await page.locator('.project__header').getByRole('button', { name: '新建', exact: true }).first().click();
    await page.getByRole('menuitemradio', { name: /交给团队/ }).click();
    await page.locator('.modal textarea').pressSequentially('把hello.txt整理一下');
    await page.locator('.modal').getByRole('button', { name: '开始', exact: true }).click();
    await page.locator('.team__goal', { hasText: '把hello.txt整理一下' }).waitFor();
    await step(page, '交给团队后显示团队视图');
    // The team conversation: a message to the supervisor shows up in it.
    await page.locator('.team__tabs').getByRole('button', { name: '对话', exact: true }).click();
    await page.locator('.conversation__composer textarea').fill('先看日志');
    await page.locator('.conversation__composer').getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.conversation__entry', { hasText: '先看日志' }).waitFor();
    await step(page, '团队对话里能给主管发消息');
    const stop = page.locator('.team').getByRole('button', { name: '停止', exact: true });
    if (await stop.isVisible()) {
        await stop.click();
        await page.locator('.team .badge', { hasText: /已停止|已暂停|失败/ }).waitFor();
    }
    // A run that is over can be archived; the project's team board lists it apart and can delete it (03).
    await page.locator('.team').getByRole('button', { name: '归档', exact: true }).click();
    await page.locator('.project__board', { hasText: '团队' }).first().click();
    await page
        .locator('.team-board')
        .getByRole('button', { name: /已归档/ })
        .click();
    const archivedRun = page.locator('.team-board__run', { hasText: '把hello.txt整理一下' });
    await archivedRun.waitFor();
    await step(page, '团队看板列出归档的运行');
    await archivedRun.getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('.modal').getByRole('button', { name: '删除', exact: true }).click();
    await archivedRun.waitFor({ state: 'detached' });
    await step(page, '结束的团队运行能删除');

    // M5: the project's workflow board; "new workflow" asks for a description (not sent here).
    await mkdir(path.join(repo, '.xora', 'workflows'), { recursive: true });
    await writeFile(
        path.join(repo, '.xora', 'workflows', 'tidy.yaml'),
        'name: tidy\ntitle: 整理文件\nsteps:\n  - id: done\n    gate: human\n    message: 整理好了吗\n',
    );
    await page.locator('.project__board', { hasText: '工作流' }).first().click();
    await page.locator('.wf-board').getByRole('button', { name: '新建工作流', exact: true }).click();
    await page.locator('.modal textarea').pressSequentially('每天跑一遍测试');
    if ((await page.locator('.modal textarea').inputValue()) !== '每天跑一遍测试') {
        throw new Error('the new workflow dialog lost what was typed');
    }
    await page.locator('.modal').getByRole('button', { name: '取消', exact: true }).click();
    await step(page, '工作流看板能新建工作流');
    // A workflow of the project waits for the project to be trusted, right on the board; it can be deleted.
    const tidy = page.locator('.workflow-card', { hasText: '整理文件' });
    const trustBanner = page.locator('.wf-board__trust');
    await trustBanner.waitFor();
    if (await tidy.getByRole('button', { name: '运行', exact: true }).isEnabled()) {
        throw new Error('a workflow of an untrusted project can be run');
    }
    await trustBanner.getByRole('button', { name: '信任这个项目', exact: true }).click();
    await trustBanner.waitFor({ state: 'detached' });
    if (!(await tidy.getByRole('button', { name: '运行', exact: true }).isEnabled())) {
        throw new Error('the workflow cannot run once the project is trusted');
    }
    await tidy.getByRole('button', { name: '删除', exact: true }).click();
    await tidy.waitFor({ state: 'detached' });
    if (existsSync(path.join(repo, '.xora', 'workflows', 'tidy.yaml'))) {
        throw new Error('the deleted workflow file is still there');
    }
    await step(page, '看板上能信任项目、删除工作流');
    // Run a workflow from the board; its command and its human gate are answered in the run view, whose flow
    // draws the steps as they go.
    const card = page.locator('.workflow-card', { hasText: '冒烟工作流' });
    await card.getByRole('button', { name: '运行', exact: true }).click();
    await card.getByRole('button', { name: '开始运行', exact: true }).click();
    await page.locator('.flow-node').nth(2).waitFor();
    const command = page.locator('.team__approvals .approval', { hasText: 'git branch xora-smoke' });
    await command.getByRole('button', { name: '允许', exact: true }).click();
    const gate = page.locator('.team__approvals .approval', { hasText: '冒烟确认' });
    await page.locator('.flow-node.is-waiting', { hasText: 'confirm' }).waitFor();
    await step(page, '工作流停在人工关卡，执行流标出等你确认的一步');
    await gate.getByRole('button', { name: '确认，继续', exact: true }).click();
    await page.locator('.team__goal .badge', { hasText: '完成' }).waitFor();
    // Once it is over, the run opens on its conclusion; the process is folded under it.
    await page.locator('.wf-brief__conclusion', { hasText: '冒烟工作流跑完了' }).waitFor();
    await step(page, '运行结束后先给出结论：结果、问题、下一步');
    await page.locator('.wf-process__toggle').click();
    // The flow is drawn once its width is known.
    await page.locator('.flow-node.is-succeeded').nth(2).waitFor();
    if (
        (await page.locator('.flow-node.is-succeeded').count()) !== 3 ||
        (await page.locator('.wf-stage').count()) !== 3
    ) {
        throw new Error('the process does not show all three steps done');
    }
    await page.locator('.wf-stage', { hasText: 'note' }).locator('.wf-stage__row').click();
    await page.locator('.wf-stage__detail', { hasText: '交回了hello.txt' }).waitFor();
    await step(page, '展开过程：每个环节一行，点开看细节');
    // The file a step handed in opens in place, from the conclusion.
    await page.locator('.wf-brief .wf-file-chip', { hasText: 'hello.txt' }).click();
    await page.locator('.wf-preview__text', { hasText: 'hello' }).waitFor();
    await step(page, '结论里能直接查看产出的文件');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: '看板', exact: true }).click();
    const done = page.locator('.board__column', { hasText: '完成' }).locator('.task-card');
    await done.nth(2).waitFor();
    await step(page, '运行看板按状态分列步骤');
    // A question about the run opens a thread that has the run's record.
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await page.locator('.wf-ask textarea').fill('hello.txt里写的是什么？');
    await page.locator('.wf-ask').getByRole('button', { name: '提问', exact: true }).click();
    await page.locator('.user-message', { hasText: 'hello.txt里写的是什么？' }).waitFor();
    await step(page, '追问会开一个带着运行记录的线程');
    // Members (06 §19): the built-in ones are there; a new one made from a template is handed work, writes down
    // what it learned, and gets a routine that can also run right away.
    await page.locator('.sidebar__nav', { hasText: '成员' }).click();
    await page.locator('.member-card', { hasText: '侦察' }).first().waitFor();
    await step(page, '侧栏进成员页，内置成员都在');
    await page.getByRole('button', { name: '新建成员', exact: true }).click();
    const memberEditor = page.locator('.member-editor');
    await memberEditor.getByPlaceholder('比如：抓包侦察、日报员').pressSequentially('冒烟侦察');
    await memberEditor.getByPlaceholder('比如：抓app的接口、整理请求链路').fill('看冒烟仓库里的文件');
    await memberEditor.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.member-detail h1', { hasText: '冒烟侦察' }).waitFor();
    await step(page, '新建成员后进入它的页面');
    await page.locator('.member-detail__actions').getByRole('button', { name: '派活' }).click();
    await page.locator('.modal textarea').pressSequentially('记住：hello.txt是冒烟用的文件');
    await page.getByRole('button', { name: '派给它', exact: true }).click();
    await page.locator('.thread-header .member-chip', { hasText: '冒烟侦察' }).waitFor();
    await step(page, '派活给成员会开一个它的线程');
    await page.locator('.thread-header .member-chip').click();
    await page.locator('.member-memory', { hasText: 'hello.txt是冒烟用的文件' }).waitFor();
    await step(page, '成员会把学到的事记进自己的记忆');
    await page.getByRole('button', { name: '添加例行任务' }).click();
    const routineForm = page.locator('.routine-form');
    await routineForm.getByPlaceholder('比如：早上检查抓包链路').fill('冒烟早检');
    await routineForm.locator('textarea').fill('看一眼hello.txt');
    await routineForm.getByRole('button', { name: '保存', exact: true }).click();
    const routine = page.locator('.routine', { hasText: '冒烟早检' });
    await routine.locator('.routine__when', { hasText: '工作日09:00' }).waitFor();
    await step(page, '给成员设例行任务');
    await routine.getByRole('button', { name: '现在跑一次' }).click();
    await page.locator('.thread-header h1', { hasText: '例行：冒烟早检' }).waitFor();
    await step(page, '例行任务可以马上跑一次');
    // A routine on a schedule keeps the app in the tray when its window closes; switched off, it no longer does.
    await page.locator('.thread-header .member-chip').click();
    // The switch follows the saved routine, so it flips once the change is saved.
    await routine.locator('.toggle').click();
    await page.locator('.routine.is-off', { hasText: '冒烟早检' }).waitFor();
    await step(page, '停用例行任务');
    // Designing a member in a conversation starts from what the user needs (06 §21; not sent here).
    await page.locator('.sidebar__nav', { hasText: '成员' }).click();
    await page.getByRole('button', { name: '对话建人', exact: true }).click();
    await page.locator('.modal textarea').waitFor();
    await page.locator('.modal').getByRole('button', { name: '取消', exact: true }).click();
    await step(page, '成员页能对话建人');
} catch (error) {
    reportFailure(error);
    console.error(
        `  模型服务收到：${server.requests.map((request) => `${request.method} ${request.path}`).join(', ') || '（无）'}`,
    );
    await failureShot();
} finally {
    if (!(await closeApp(app))) {
        failed = true;
        console.error('✗ 关闭窗口后应用20秒内没有退出，已强制结束');
    }
    await server.close();
    site.close();
    site.closeAllConnections();
}

// A fresh start on an English system: the UI and the shell's menus are English until the user picks a language.
if (!failed) {
    const english = await launch(path.join(work, 'data-en'), 'en-US');
    try {
        const page = await english.firstWindow({ timeout: ms(60_000) });
        current = page;
        page.setDefaultTimeout(ms(30_000));
        await page.getByRole('button', { name: /Connect a model/ }).waitFor();
        await menuShows(english, 'Help');
        await step(page, '系统是英文时界面和菜单显示英文');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
        await page.getByRole('combobox', { name: '语言' }).waitFor();
        await menuShows(english, '帮助');
        await step(page, '设置里选中文后界面和菜单都换成中文');
    } catch (error) {
        reportFailure(error);
        await failureShot();
    } finally {
        if (!(await closeApp(english))) {
            failed = true;
            console.error('✗ 关闭窗口后应用20秒内没有退出，已强制结束');
        }
    }
}

console.log(`\n${steps.length}步通过${failed ? '，有失败' : ''}`);
if (values.keep || failed) {
    console.log(`临时目录：${work}`);
} else {
    // On Windows the app's last child processes can hold the copied executable for a moment after it quits.
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((error: unknown) =>
        console.warn(`(临时目录没删掉：${error instanceof Error ? error.message : String(error)})`),
    );
}
process.exitCode = failed ? 1 : 0;
