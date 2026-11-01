import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
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
// A user workflow (any project, no trust needed): a read-only command, then a human gate.
await mkdir(path.join(dataDir, 'workflows'), { recursive: true });
await writeFile(
    path.join(dataDir, 'workflows', 'smoke.yaml'),
    'name: smoke\ntitle: 冒烟工作流\nsteps:\n  - id: status\n    run: git branch xora-smoke\n  - id: confirm\n    needs: [status]\n    gate: human\n    message: 冒烟确认\n',
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
    const messages = (request.body as { messages?: Array<{ role: string }> } | undefined)?.messages ?? [];
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

    // M3-3: fork the thread from its turn, then go back to before that turn in the fork (files untouched).
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

    // M5: the project's workflow board; "new workflow" asks for a description (not sent here).
    await page.locator('.project__board').first().click();
    await page.locator('.wf-board').getByRole('button', { name: '新建工作流', exact: true }).click();
    await page.locator('.modal textarea').pressSequentially('每天跑一遍测试');
    if ((await page.locator('.modal textarea').inputValue()) !== '每天跑一遍测试') {
        throw new Error('the new workflow dialog lost what was typed');
    }
    await page.locator('.modal').getByRole('button', { name: '取消', exact: true }).click();
    await step(page, '工作流看板能新建工作流');
    // Run a workflow from the board; its command and its human gate are answered in the run view.
    const card = page.locator('.workflow-card', { hasText: '冒烟工作流' });
    await card.getByRole('button', { name: '运行', exact: true }).click();
    await card.getByRole('button', { name: '开始运行', exact: true }).click();
    const command = page.locator('.workflow__approval', { hasText: 'git branch xora-smoke' });
    await command.getByRole('button', { name: '允许', exact: true }).click();
    const gate = page.locator('.workflow__approval', { hasText: '冒烟确认' });
    await gate.getByRole('button', { name: '允许', exact: true }).click();
    await page.locator('.team__goal .badge', { hasText: '完成' }).waitFor();
    await step(page, '工作流运行到人工关卡，确认后完成');
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
