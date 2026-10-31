import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { _electron as electron, type Page } from 'playwright-core';
import { openaiText, openaiToolCalls, startMockModelServer } from '../packages/test-kit/src/index.ts';
import { repoRoot } from './keys.ts';

/**
 * UI smoke test in the real app (M1 acceptance): connect a model, open a project, ask for a change, approve it,
 * review the diff and undo it — all through the UI, against a scripted model server and throwaway data. Then the
 * M4 extensions: a project command shows up in the composer and on the settings page.
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
    },
});

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

execFileSync('mkdir', ['-p', repo]);
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
    'name: smoke\ntitle: 冒烟工作流\nsteps:\n  - id: status\n    run: git status --short\n  - id: confirm\n    needs: [status]\n    gate: human\n    message: 冒烟确认\n',
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

const app = await electron.launch({
    executablePath,
    // Chromium's mock keychain keeps safeStorage and cookie encryption away from the real macOS keychain.
    args: [...(values.app ? [] : [desktopDir]), '--use-mock-keychain'],
    env: {
        ...process.env,
        XORA_DATA_DIR: dataDir,
        XORA_TEST_PLAIN_SECRETS: '1',
        ...(values.show ? {} : { XORA_TEST_HIDE_WINDOWS: '1' }),
        ELECTRON_RUN_AS_NODE: '',
    } as Record<string, string>,
    timeout: 60_000,
});

let failed = false;
let current: Page | undefined;
try {
    const page = await app.firstWindow({ timeout: 60_000 });
    current = page;
    page.on('dialog', (dialog) => void dialog.accept());
    page.setDefaultTimeout(30_000);

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

    await page.getByRole('button', { name: '新线程' }).first().click();
    await page.locator('.dialog textarea').fill('把hello.txt里的hello改成hello world');
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

    // A real shell through node-pty in the thread's folder (M3-5).
    await page.getByRole('button', { name: '终端', exact: true }).click();
    await page.locator('.terminal-panel .xterm').waitFor();
    // Type only once the shell has drawn its prompt; some shells drop what was typed while they start.
    await page.waitForFunction(
        () => (document.querySelector('.terminal-panel .xterm-rows')?.textContent ?? '').trim().length > 0,
        undefined,
        { timeout: 30_000 },
    );
    let echoed = false;
    for (let attempt = 0; attempt < 3 && !echoed; attempt++) {
        await page.waitForTimeout(500);
        await page.locator('.terminal-panel .xterm').click();
        await page.keyboard.type('echo xora-smoke-$((40+2))\n');
        echoed = await page
            .locator('.terminal-panel .xterm-rows', { hasText: 'xora-smoke-42' })
            .waitFor({ timeout: 10_000 })
            .then(
                () => true,
                () => false,
            );
    }
    if (!echoed) throw new Error('the terminal did not run the command');
    await step(page, '终端能运行命令');

    // The preview panel loads a local page in its sandboxed view (M3-6). Screenshots need a window on screen, so
    // they are only checked with --show.
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.locator('.preview input[aria-label=url]').fill(siteUrl);
    await page.locator('.preview').getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('.preview__title', { hasText: 'Smoke page' }).waitFor();
    if (values.show) {
        await page.locator('.preview').getByRole('button', { name: '截图发给agent' }).click();
        await page.locator('.composer .chip', { hasText: 'preview.png' }).waitFor();
    }
    await step(page, '预览能打开本地页面');

    // M4: hand a goal to a team; the team view shows the run, which can be stopped.
    await page.getByRole('button', { name: '交给团队', exact: true }).first().click();
    await page.locator('.modal textarea').fill('把hello.txt整理一下');
    await page.locator('.modal').getByRole('button', { name: '开始', exact: true }).click();
    await page.locator('.team__goal', { hasText: '把hello.txt整理一下' }).waitFor();
    await step(page, '交给团队后显示团队视图');
    const stop = page.locator('.team').getByRole('button', { name: '停止', exact: true });
    if (await stop.isVisible()) {
        await stop.click();
        await page.locator('.team .badge', { hasText: /已停止|已暂停|失败/ }).waitFor();
    }

    // M5: run a workflow from the list; its command and its human gate are answered in the run view.
    await page.getByRole('button', { name: '工作流', exact: true }).first().click();
    const card = page.locator('.workflow-card', { hasText: '冒烟工作流' });
    await card.getByRole('button', { name: '运行', exact: true }).click();
    await card.getByRole('button', { name: '开始运行', exact: true }).click();
    const command = page.locator('.workflow__approval', { hasText: 'git status --short' });
    await command.getByRole('button', { name: '允许', exact: true }).click();
    const gate = page.locator('.workflow__approval', { hasText: '冒烟确认' });
    await gate.getByRole('button', { name: '允许', exact: true }).click();
    await page.locator('.team__goal .badge', { hasText: '完成' }).waitFor();
    await step(page, '工作流运行到人工关卡，确认后完成');
} catch (error) {
    failed = true;
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    console.error(
        `  模型服务收到：${server.requests.map((request) => `${request.method} ${request.path}`).join(', ') || '（无）'}`,
    );
    if (current) {
        const file = path.join(values.shots ?? work, 'failure.png');
        await current.screenshot({ path: file }).catch(() => undefined);
        console.error(`  失败截图：${file}`);
    }
} finally {
    // Close the window the way a user does and wait for the app to quit on its own.
    const exited = new Promise<boolean>((resolve) => app.process().once('exit', () => resolve(true)));
    await app
        .evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) window.close();
        })
        .catch(() => undefined);
    const quit = await Promise.race([
        exited,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!quit) {
        failed = true;
        console.error('✗ 关闭窗口后应用20秒内没有退出，已强制结束');
        app.process().kill('SIGKILL');
    }
    await server.close();
    site.close();
    site.closeAllConnections();
}

console.log(`\n${steps.length}步通过${failed ? '，有失败' : ''}`);
if (values.keep || failed) {
    console.log(`临时目录：${work}`);
} else {
    await rm(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
