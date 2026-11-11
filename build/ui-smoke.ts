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
import { forgetAppCopy, secretStoreSwitches } from './app-switches.ts';

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
/** The copy of the app a packaged build runs from, which LaunchServices must forget afterwards. */
let appCopy: string | undefined;

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
    appCopy = copyDir;
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
    // The supervisor answers an approval for the user (06 §24): it allows the edit the task asked for.
    if (
        JSON.stringify(messages[0] ?? '').includes(
            "You are the supervisor who answers an AI agent's permission requests",
        )
    ) {
        return openaiText('{"decision":"allow","reason":"冒烟：改文件是任务要的"}');
    }
    // The chief assistant (06 §23) starts the workflow it is asked to run, or hands the job to the scout; then says so.
    if (body?.tools?.some((tool) => tool.function?.name === 'member_dispatch')) {
        const request = JSON.stringify(messages[messages.map((message) => message.role).lastIndexOf('user')] ?? '');
        const workflow = request.includes('跑一下冒烟工作流');
        if (messages.at(-1)?.role === 'tool') {
            return openaiText(
                workflow ? '冒烟工作流开始跑了，到了要你确认的那步我告诉你。' : '交给侦察了，它看完我告诉你。',
            );
        }
        return openaiToolCalls([
            workflow
                ? { name: 'workflow_start', arguments: JSON.stringify({ workflow: 'smoke' }) }
                : {
                      name: 'member_dispatch',
                      arguments: JSON.stringify({ member: 'scout', brief: '看看hello.txt里写了什么' }),
                  },
        ]);
    }
    // 03: waiting messages and editing a sent one, in plain words; the first answer takes a while.
    const asked = messages.at(-1)?.role === 'user' ? JSON.stringify(messages.at(-1)) : '';
    if (asked.includes('慢慢数到三')) {
        return { ...openaiText('一、二、三。'), delayMs: 2500 };
    }
    if (asked.includes('数到五')) {
        return openaiText('一、二、三、四、五。');
    }
    if (asked.includes('数到十')) {
        return openaiText('一到十，数完了。');
    }
    // 03: thinking shows as it comes, its newest lines in view.
    if (asked.includes('想一想怎么数')) {
        const thinking = Array.from(
            { length: 60 },
            (_, index) => `第${index + 1}步：先想想${index + 1}后面是几。`,
        ).join('\n');
        return openaiText('想好了。', { reasoning: thinking, chunkSize: 16, delayMs: 60 });
    }
    // 03: a plan the agent keeps up to date as it goes; it waits a moment after its first version.
    const userAt = messages.map((message) => message.role).lastIndexOf('user');
    if (userAt >= 0 && JSON.stringify(messages[userAt]).includes('按计划数两步')) {
        const done = messages.slice(userAt).filter((message) => message.role === 'tool').length;
        const todo = (first: string, second: string) =>
            openaiToolCalls([
                {
                    name: 'todo',
                    arguments: JSON.stringify({
                        items: [
                            { content: '数到一', status: first },
                            { content: '数到二', status: second },
                        ],
                    }),
                },
            ]);
        if (done === 0) return todo('in_progress', 'pending');
        // The delay is before each streamed frame: a few frames, two seconds or so.
        if (done === 1) return { ...todo('completed', 'in_progress'), delayMs: 400 };
        if (done === 2) return todo('completed', 'completed');
        return openaiText('一、二，数完了。');
    }
    // The scout the chief handed the job to answers it.
    if (messages.at(-1)?.role === 'user' && JSON.stringify(messages.at(-1)).includes('看看hello.txt里写了什么')) {
        return openaiText('hello.txt里只有一行：hello world。');
    }
    // The brief of a finished run: a request without tools that asks for the three headings.
    if (!body?.tools?.length && JSON.stringify(messages).includes('## 目标达成')) {
        return openaiText(
            '## 目标达成\n冒烟工作流跑完了，交回了hello.txt。\n\n## 已完成\n- 写好了hello.txt（`hello.txt`）\n\n## 下一步\n- 打开hello.txt看一眼',
        );
    }
    // A member asked to remember something writes it into its memory.
    if (
        body?.tools?.some((tool) => tool.function?.name === 'remember') &&
        messages.at(-1)?.role === 'user' &&
        JSON.stringify(messages.at(-1)).includes('记住：')
    ) {
        return openaiToolCalls([{ name: 'remember', arguments: JSON.stringify({ note: 'hello.txt是冒烟用的文件' }) }], {
            usage: { prompt_tokens: 3000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 2000 } },
        });
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
    // The first steps answer approval cards by hand; the supervisor's review comes at the end (06 §24).
    await hostCall(page, 'settings.update', { patch: { approvals: { reviewer: 'user' } } });
    // With a model and a project, the home is the chief assistant (06 §23). A conversation with it belongs to no
    // project: there is none to pick, but the model and thinking level are picked as under a conversation.
    await page.locator('.chief-home textarea').waitFor();
    await page.locator('.chief-home__bar .picker__trigger', { hasText: 'mock-model' }).waitFor();
    if ((await page.locator('.chief-home select').count()) !== 0) throw new Error('the chief home asks for a project');
    // Its model list opens over the blank part below, which then drags nothing: Electron gives an overlap to the later
    // region, and a click on the list would move the window.
    const appRegion = () =>
        page
            .locator('.chief-home__grid')
            .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region').trim());
    if ((await appRegion()) !== 'drag') throw new Error('the blank part of the chief home does not drag the window');
    await page.locator('.chief-home__bar .picker__trigger', { hasText: 'mock-model' }).click();
    await page.locator('.chief-home .popover__panel').waitFor();
    if ((await appRegion()) !== 'no-drag') throw new Error('an open list lies under a drag region');
    await page.keyboard.press('Escape');
    await page.locator('.chief-home .popover__panel').waitFor({ state: 'detached' });
    await page.locator('.chief-home__example', { hasText: '把repo的测试补齐' }).waitFor();
    await step(page, '首页是总助手');

    // New things start from the project's "+": a thread, a team or a workflow.
    await page.locator('.project__header').getByRole('button', { name: '新建', exact: true }).first().click();
    await page.getByRole('menuitemradio', { name: /新建对话/ }).click();
    // 03: a new conversation opens in the main area; its composer starts it. Typed key by key: a box that takes the
    // focus back on every render loses all but the first character.
    // `@` offers the team's members to hand the message to (06 §19).
    // The thinking level is picked here too, but only for a model with levels: the mock model has none.
    await page.locator('.new-thread select[aria-label="模型"]').waitFor();
    if ((await page.locator('.new-thread select[aria-label="思考强度"]').count()) !== 0) {
        throw new Error('a new conversation offers thinking levels for a model that has none');
    }
    await page.locator('.new-thread textarea').pressSequentially('@');
    await page.locator('.new-thread .mention--members button').first().waitFor();
    await step(page, '新建对话里@出成员候选');
    await page.keyboard.press('Escape');
    await page.locator('.new-thread textarea').fill('');
    await page.locator('.new-thread textarea').pressSequentially('把hello.txt里的hello改成hello world');
    await step(page, '新建对话直接在主区域里写，不弹框');
    await page.locator('.new-thread').getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '允许一次' }).waitFor();
    // The card waits on the user: the conversation is in the inbox.
    await page.locator('.inbox__count', { hasText: '1' }).waitFor();
    await step(page, '出现审批卡片');
    if ((await readFile(path.join(repo, 'hello.txt'), 'utf8')) !== 'hello\n') {
        throw new Error('the file changed before approval');
    }

    await page.getByRole('button', { name: '允许一次' }).click();
    await page.locator('.changes-card').waitFor();
    if ((await readFile(path.join(repo, 'hello.txt'), 'utf8')) !== 'hello world\n') {
        throw new Error('the approved edit was not applied');
    }
    // Work that finished is not something to handle (03 §4): its row is marked for review, and the inbox is empty.
    await page.locator('.thread-row .mark--review').waitFor();
    await page.locator('.inbox').waitFor({ state: 'detached' });
    await step(page, '批准后文件被修改并显示改动卡片');

    await page.locator('.changes-card').click();
    await page.locator('.changes__file', { hasText: 'hello.txt' }).waitFor();
    await page.locator('.diff__row--add').first().waitFor();
    await step(page, '变更面板显示diff');

    await page.getByRole('button', { name: '撤销这一轮' }).click();
    await page.locator('.confirm').getByRole('button', { name: '确定', exact: true }).click();
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

    // 03: a message sent while a turn runs waits for it, then goes by itself; a sent message can be edited.
    await page.locator('.composer textarea').pressSequentially('慢慢数到三');
    await page.keyboard.press('Enter');
    await page.locator('.composer').getByRole('button', { name: '停止' }).waitFor();
    await page.locator('.composer textarea').pressSequentially('再补一句，数到五');
    await page.locator('.composer').getByRole('button', { name: '排队' }).click();
    await page.locator('.queued__item', { hasText: '再补一句，数到五' }).waitFor();
    await step(page, '跑着的时候发的消息排队等着');
    await page.locator('.queued').waitFor({ state: 'detached', timeout: 30_000 });
    await page.locator('.user-message', { hasText: '再补一句，数到五' }).waitFor();
    await page.locator('.turn', { hasText: '一、二、三、四、五。' }).waitFor();
    await step(page, '这一轮结束后排队的消息自动发出');
    const last = page.locator('.turn', { hasText: '再补一句，数到五' }).last();
    await last.hover();
    await last.getByRole('button', { name: '编辑' }).click();
    await page.locator('.user-message__editor').fill('改过了，数到十');
    await page.locator('.user-message--editing').getByRole('button', { name: '发送' }).click();
    await page.locator('.turn', { hasText: '一到十，数完了。' }).waitFor();
    await page.locator('.turn--rewound', { hasText: '再补一句，数到五' }).waitFor();
    await step(page, '编辑刚发的消息后从这里重新开始');

    // 03: while the model thinks, its newest lines are in view and followed, not its first few.
    await page.locator('.composer textarea').pressSequentially('想一想怎么数');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
        () => {
            const box = document.querySelector('.reasoning.is-live .reasoning__text.is-tail');
            return (
                box !== null &&
                box.scrollHeight > box.clientHeight + 40 &&
                box.scrollHeight - box.clientHeight - box.scrollTop < 4 &&
                box.hasAttribute('data-scrolled')
            );
        },
        undefined,
        { timeout: ms(30_000) },
    );
    await step(page, '思考时实时显示最新的内容');
    await page.locator('.turn', { hasText: '想好了。' }).waitFor();
    await page.locator('.reasoning.is-live').waitFor({ state: 'detached' });

    // 03: the plan sits above the composer and follows the agent's updates; each update is a line where it was made.
    await page.locator('.composer textarea').pressSequentially('按计划数两步');
    await page.keyboard.press('Enter');
    const dock = page.locator('.plan-dock');
    await dock.locator('.plan-dock__now', { hasText: '正在：数到一' }).waitFor();
    await dock.locator('.plan-dock__count', { hasText: '0/2' }).waitFor();
    await step(page, '计划在输入框上方，显示做到哪一步');
    await page.locator('.turn', { hasText: '一、二，数完了。' }).waitFor();
    await dock.locator('.plan-dock__count', { hasText: '2/2' }).waitFor();
    await page.locator('.plan-dock.is-done .plan-dock__now', { hasText: '全部完成' }).waitFor();
    await dock.locator('.plan-dock__head').click();
    if ((await dock.locator('.plan__entry--completed').count()) !== 2) throw new Error('the plan did not follow');
    const planTurn = page.locator('.turn', { hasText: '按计划数两步' });
    if ((await planTurn.locator('.todo-step').count()) !== 3) throw new Error('each version of the plan is a line');
    if ((await planTurn.locator('.plan-card').count()) !== 0) throw new Error('the plan card stays at the top');
    await planTurn
        .locator('.todo-step', { hasText: '1/2' })
        .locator('.todo-step__now', { hasText: '正在：数到二' })
        .waitFor();
    await step(page, '计划随进度更新，对话里每次更新是一行进度');

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

    // 08 §1.4: global prompts are .md files in the prompt directory; one of them, picked here, is in use.
    await page.locator('.settings__nav').getByRole('button', { name: '提示词' }).click();
    await page.getByRole('button', { name: '+ 新建提示词' }).click();
    await page.locator('.prompt-editor input.input').fill('mac/日常');
    await page.locator('.prompt-editor textarea').fill('命令按zsh写');
    await page.locator('.prompt-editor').getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.prompt-item.is-active', { hasText: 'mac/日常' }).waitFor();
    if ((await readFile(path.join(dataDir, 'prompts', 'mac', '日常.md'), 'utf8')) !== '命令按zsh写') {
        throw new Error('the new prompt is not a .md file in the prompt directory');
    }
    await step(page, '设置里新建全局提示词，第一个直接用上');
    await mkdir(path.join(dataDir, 'prompts', 'linux'), { recursive: true });
    await writeFile(path.join(dataDir, 'prompts', 'linux', '日常.md'), '命令按bash写');
    await page.locator('.prompt-library__dir').getByRole('button', { name: '刷新' }).click();
    await page.locator('.prompt-item', { hasText: 'linux/日常' }).getByRole('radio').click();
    await page.locator('.prompt-item.is-active', { hasText: 'linux/日常' }).waitFor();
    await step(page, '放进提示词目录的md文件能选来用');
    await page.locator('.prompt-item', { hasText: '不用全局提示词' }).getByRole('radio').click();
    await page.locator('.prompt-item.is-active', { hasText: '不用全局提示词' }).waitFor();
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
    // A run that is over can be archived; the team board lists it apart and can delete it (03).
    await page.locator('.team').getByRole('button', { name: '归档', exact: true }).click();
    await page.locator('.sidebar__nav', { hasText: '团队' }).click();
    await page.getByRole('tab', { name: '团队任务' }).click();
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

    // Workflows have no entry of their own (06 §23): the chief starts one the project or the user has, and the card in
    // its conversation opens the run. Its command and its human gate are answered in the run view, whose flow draws
    // the steps as they go.
    if ((await page.locator('.sidebar__nav', { hasText: '工作流' }).count()) !== 0) {
        throw new Error('the sidebar still has an entry for workflows');
    }
    await page.locator('.sidebar__nav', { hasText: '总助手' }).click();
    await page.locator('.chief-home textarea').pressSequentially('跑一下冒烟工作流');
    await page.locator('.chief-home').getByRole('button', { name: '发送', exact: true }).click();
    const workflowCard = page.locator('.delegation', { hasText: '冒烟工作流' }).first();
    await workflowCard.waitFor();
    await step(page, '总助手能跑工作流，对话里有跟进卡片');
    await workflowCard.locator('.delegation__open').click();
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
    // 19 §11: the team's page is the organization lying on its side, organizations and members are made in dialogs
    // right there, and a click on a member shows five things. Then the member is handed work, writes down what it
    // learned, and gets a routine that can also run right away.
    await page.locator('.sidebar__nav', { hasText: '团队' }).click();
    await page.locator('.onode', { hasText: '研发团队' }).locator('.omember', { hasText: '侦察' }).first().waitFor();
    await step(page, '团队页是横向的组织树，成员在组织里');
    await page.getByRole('button', { name: '新建组织', exact: true }).click();
    // The supervisor leads the default team, and can lead this one too (19 §4).
    const leadOptions = await page.locator('select[aria-label="负责人"] option').allTextContents();
    if (!leadOptions.includes('主管')) {
        throw new Error(`the new organization cannot have the lead of another: ${leadOptions.join(', ')}`);
    }
    // An empty choice shows under its own name, not as a dash.
    const leadShown = await page.locator('select[aria-label="负责人"] option:checked').textContent();
    if (leadShown !== '稍后再设') throw new Error(`no lead yet shows as "${leadShown}"`);
    const groupDialog = page.locator('.group-editor');
    await groupDialog.getByPlaceholder('比如：研发中心、前端组、运营组').fill('冒烟中心');
    await groupDialog.getByRole('button', { name: '保存', exact: true }).click();
    const centre = page.locator('.onode', { hasText: '冒烟中心' });
    await centre.waitFor();
    await step(page, '弹窗里新建组织，不开对话');
    await centre.getByRole('button', { name: '新建', exact: true }).click();
    await page.locator('.menu-list').getByRole('button', { name: '新建子组织' }).click();
    await groupDialog.getByPlaceholder('比如：研发中心、前端组、运营组').fill('冒烟小队');
    await groupDialog.getByRole('button', { name: '保存', exact: true }).click();
    const squad = page.locator('.onode', { hasText: '冒烟小队' });
    await squad.waitFor();
    const [above, below, root] = await Promise.all([
        centre.boundingBox(),
        squad.boundingBox(),
        page.locator('.onode--root').boundingBox(),
    ]);
    if (!above || !below || !root || !(root.x < above.x && above.x < below.x)) {
        throw new Error('the tree does not run from the left: root, organization, sub-organization');
    }
    await step(page, '子组织挂在上级的右边，最左边是我和总助手');
    await squad.locator('.onode__name').click();
    const squadPanel = page.locator('.org-panel', { hasText: '组织提示词' });
    await squadPanel.locator('textarea').fill('冒烟小队只看文件');
    await squadPanel.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.toast', { hasText: '已保存' }).first().waitFor();
    const groups = (await hostCall(page, 'org.get', {})) as { groups: { id: string; name: string }[] };
    const squadId = groups.groups.find((group) => group.name === '冒烟小队')?.id ?? '';
    const read = (await hostCall(page, 'org.readGroup', { groupId: squadId })) as { prompt: string; dir: string };
    if ((await readFile(path.join(read.dir, 'prompt.md'), 'utf8')).trim() !== '冒烟小队只看文件') {
        throw new Error('the organization prompt is not in its folder');
    }
    await step(page, '组织提示词能改，存在组织自己的目录里');
    await squad.getByRole('button', { name: '新建', exact: true }).click();
    await page.locator('.menu-list').getByRole('button', { name: '新建成员' }).click();
    const memberEditor = page.locator('.member-editor');
    await memberEditor.getByPlaceholder('比如：抓包侦察、日报员').pressSequentially('冒烟侦察');
    await memberEditor.getByRole('combobox', { name: '岗位' }).selectOption('scout');
    await memberEditor.getByRole('button', { name: '保存', exact: true }).click();
    const panel = page.locator('.org-panel', { hasText: '主管评分' });
    await panel.locator('h2', { hasText: '冒烟侦察' }).waitFor();
    await squad.locator('.omember', { hasText: '冒烟侦察' }).waitFor();
    const blocks = await panel
        .locator('.org-panel__block')
        .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.block));
    if (blocks.join() !== 'prompt,projects,score,tokens') {
        throw new Error(`the member panel shows ${blocks.join()}`);
    }
    await step(page, '弹窗里建成员，点开只看到名字、提示词、最近项目、主管评分、token');
    await panel.locator('.org-panel__actions').getByRole('button', { name: '派活' }).click();
    await page.locator('.modal textarea').pressSequentially('记住：hello.txt是冒烟用的文件');
    await page.getByRole('button', { name: '派给它', exact: true }).click();
    await page.locator('.thread-header .member-chip', { hasText: '冒烟侦察' }).waitFor();
    await step(page, '派活给成员会开一个它的线程');
    await page.locator('.composer').getByRole('button', { name: '停止' }).waitFor({ state: 'detached' });
    await page.locator('.thread-header .member-chip').click();
    await panel.locator('[data-block=projects]', { hasText: 'repo' }).waitFor();
    // 3000 in, 2000 of them from the cache, 400 out: cache hits show beside the headline, not in it (19 §10).
    const tokens = panel.locator('[data-block=tokens] .org-panel__tokens').first();
    const headline = await tokens.locator('strong').first().textContent();
    if (headline !== '1.4k') throw new Error(`the member panel counts ${headline} tokens, not 1.4k`);
    if (!(await tokens.textContent())?.includes('缓存命中 2.0k')) {
        throw new Error('the member panel does not show its cache hits');
    }
    // The mock model has no price: a cost not known, not a cost of zero.
    const cost = await tokens.locator('.org-panel__cost').textContent();
    if (cost !== '—') throw new Error(`the member panel prices unpriced work at ${cost}`);
    await panel.locator('[data-block=tokens] .badge', { hasText: '部分价格未知' }).waitFor();
    await step(page, '干完活后面板上有最近的项目和token');
    const panelMenu = async (item: string) => {
        await panel.locator('.org-panel__actions').getByRole('button', { name: '更多' }).click();
        await page.locator('.menu-list').getByRole('button', { name: item }).click();
    };
    await panelMenu('记忆');
    await page.locator('.member-memory', { hasText: 'hello.txt是冒烟用的文件' }).waitFor();
    await step(page, '成员会把学到的事记进自己的记忆');
    await page.keyboard.press('Escape');
    await panelMenu('例行任务');
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
    await panelMenu('例行任务');
    // The switch follows the saved routine, so it flips once the change is saved.
    await routine.locator('.toggle').click();
    await page.locator('.routine.is-off', { hasText: '冒烟早检' }).waitFor();
    await step(page, '停用例行任务');
    await page.keyboard.press('Escape');
    // The chief assistant (06 §23): one place to say what is needed. It hands the job to a member, and a card in its
    // conversation follows the work to its answer and opens it.
    // The workflow's conversation is the chief's latest: "+" starts another one from its home.
    await page.locator('.sidebar__nav-row').getByRole('button', { name: '新对话', exact: true }).click();
    await page.locator('.chief-home textarea').pressSequentially('让侦察看看hello.txt');
    await page.locator('.chief-home').getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.thread-header h1', { hasText: '总助手：' }).waitFor();
    // The conversation is marked as the chief's and listed under its entry, not among the project's conversations;
    // it shows no project, no permissions to pick and none of a project's panels.
    await page.locator('.thread-header__chief').waitFor();
    if ((await page.locator('.thread-header__project').count()) !== 0) throw new Error('the chief shows a project');
    if ((await page.locator('.composer .mode-chip').count()) !== 0) throw new Error('the chief has permissions');
    await page.locator('.composer .picker__trigger', { hasText: 'mock-model' }).waitFor();
    await page.locator('.thread-header').getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: /提示词/ }).waitFor();
    if ((await page.getByRole('menuitemcheckbox', { name: /终端/ }).count()) !== 0)
        throw new Error("the chief's menu offers a project's panels");
    await page.keyboard.press('Escape');
    const chiefRow = page.locator('.sidebar__chief-threads .thread-row', { hasText: '总助手：让侦察' });
    await chiefRow.waitFor();
    const delegation = page.locator('.delegation', { hasText: '侦察' }).first();
    await delegation.waitFor();
    await step(page, '总助手把活派给成员，对话里有跟进卡片');
    await delegation.locator('.badge', { hasText: '已完成' }).waitFor();
    await delegation.locator('.delegation__summary', { hasText: 'hello world' }).waitFor();
    await step(page, '派出的活做完，卡片上就是结果');
    await delegation.locator('.delegation__open').click();
    await page.locator('.thread-header .member-chip', { hasText: '侦察' }).waitFor();
    await step(page, '卡片能打开成员的对话');
    // The chief's conversations are archived and brought back like a project's: from the row's menu, found again on
    // the chief's home, and restored from the conversation's own menu.
    await chiefRow.hover();
    await chiefRow.getByRole('button', { name: '更多', exact: true }).click();
    // The whole menu shows over what is below it: its last item can be clicked too.
    await chiefRow.getByRole('button', { name: '删除', exact: true }).click({ trial: true });
    await chiefRow.getByRole('button', { name: '归档', exact: true }).click();
    await chiefRow.waitFor({ state: 'detached' });
    await page.locator('.sidebar__nav-row').getByRole('button', { name: '新对话', exact: true }).click();
    await page.locator('.chief-home__archived', { hasText: '已归档 (1)' }).click();
    await page.locator('.chief-home__row.is-archived', { hasText: '总助手：' }).click();
    await page.locator('.thread-header__chief').waitFor();
    await page.locator('.thread-header').getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: '取消归档', exact: true }).click();
    await chiefRow.waitFor();
    await step(page, '总助手的对话能归档，也能从它的首页找回来');
    // 19 §15: the talent market lists every built-in persona, searchable; one is hired into an organization from it.
    await page.locator('.sidebar__nav', { hasText: '团队' }).click();
    await page.getByRole('tab', { name: '人才市场' }).click();
    const personas = page.locator('.talent');
    await personas.first().waitFor();
    if ((await personas.count()) < 12)
        throw new Error(`the talent market lists only ${await personas.count()} personas`);
    await page.locator('.talent-page__search').fill('前端');
    const frontend = page.locator('.talent', { hasText: '前端工程师' });
    await frontend.locator('.badge', { hasText: '可聘用' }).waitFor();
    if ((await personas.count()) !== 1) throw new Error('the search did not narrow the market down');
    await frontend.getByRole('button', { name: '看提示词' }).click();
    await frontend.locator('.talent__prompt').waitFor();
    await step(page, '人才市场能搜系统自带的人选，看它的提示词');
    await frontend.getByRole('button', { name: '聘用', exact: true }).click();
    await page.locator('.member-editor').getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.onode', { hasText: '研发团队' }).locator('.omember', { hasText: '前端工程师' }).waitFor();
    await page.getByRole('tab', { name: '人才市场' }).click();
    await page.locator('.talent', { hasText: '前端工程师' }).locator('.badge', { hasText: '已在：研发团队' }).waitFor();
    await step(page, '从人才市场聘的人进了组织，市场上标成已在职');

    // 06 §24: a regular software team from the template; any member can be deleted, a built-in one comes back.
    await page.locator('.sidebar__nav', { hasText: '团队' }).click();
    await page.getByRole('button', { name: '用模板建团队', exact: true }).click();
    await page.locator('.modal').getByRole('button', { name: '建团队', exact: true }).click();
    const devGroup = page.locator('.onode', { hasText: '开发组' });
    await devGroup.locator('.omember', { hasText: '前端工程师' }).waitFor();
    await devGroup.locator('.omember.is-lead', { hasText: '技术负责人' }).waitFor();
    await step(page, '用模板建出常规开发团队');
    const expert = devGroup.locator('.omember', { hasText: '资深专家' });
    await expert.click();
    await page.locator('.org-panel__actions').getByRole('button', { name: '更多' }).click();
    await page.locator('.menu-list').getByRole('button', { name: '删除' }).click();
    await page.locator('.confirm').getByRole('button', { name: '确定', exact: true }).click();
    await expert.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /已删除的成员/ }).click();
    await page.locator('.org__removed li', { hasText: '专家' }).getByRole('button', { name: '恢复' }).click();
    await page.locator('.omember', { hasText: '专家' }).first().waitFor();
    await step(page, '内置成员也能删，删了还能恢复');
    // The supervisor answers approvals for the user: an edit the task asks for goes ahead without a question.
    await hostCall(page, 'settings.update', { patch: { approvals: { reviewer: 'supervisor' } } });
    await page.locator('.project__header').getByRole('button', { name: '新建', exact: true }).first().click();
    await page.getByRole('menuitemradio', { name: /新建对话/ }).click();
    await page.locator('.new-thread textarea').pressSequentially('把hello.txt里的hello改一下');
    await page.keyboard.press('Enter');
    await page.locator('.approval .badge', { hasText: '主管已批准' }).waitFor();
    await page.locator('.approval__message', { hasText: '冒烟：改文件是任务要的' }).waitFor();
    // The turn goes on after the approval; it ends before the window closes, or the app stays in the tray for it.
    await page.locator('.composer').getByRole('button', { name: '停止' }).waitFor({ state: 'detached' });
    await step(page, '审批交给主管：改文件由主管批了，不打扰你');
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
forgetAppCopy(appCopy);
if (values.keep || failed) {
    console.log(`临时目录：${work}`);
} else {
    // On Windows the app's last child processes can hold the copied executable for a moment after it quits.
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((error: unknown) =>
        console.warn(`(临时目录没删掉：${error instanceof Error ? error.message : String(error)})`),
    );
}
process.exitCode = failed ? 1 : 0;
