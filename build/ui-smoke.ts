import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { _electron as electron, type Page } from 'playwright-core';
import { openaiText, openaiToolCalls, startMockModelServer } from '../packages/test-kit/src/index.ts';
import { repoRoot } from './keys.ts';

/**
 * UI smoke test in the real app (M1 acceptance): connect a model, open a project, ask for a change, approve it,
 * review the diff and undo it — all through the UI, against a scripted model server and throwaway data.
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
const executablePath = values.app
    ? path.resolve(values.app)
    : (createRequire(path.join(desktopDir, 'package.json'))('electron') as string);
const work = await mkdtemp(path.join(tmpdir(), 'xora-smoke-'));
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

const server = await startMockModelServer();
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
    args: values.app ? [] : [desktopDir],
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
    await app.close().catch(() => undefined);
    await server.close();
}

console.log(`\n${steps.length}步通过${failed ? '，有失败' : ''}`);
if (values.keep || failed) {
    console.log(`临时目录：${work}`);
} else {
    await rm(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
