import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { repoRoot } from './keys.ts';
import { makeBundle } from './make-bundle.ts';

/**
 * Rollback drill: runs the real shell against throwaway data directories and checks the recorded boot state.
 *
 *   node build/drill.ts                         unpackaged shell (apps/desktop) with dist/app-bundle
 *   node build/drill.ts --app <executable>      a packaged build, e.g. ".../Xora Code.app/Contents/MacOS/Xora Code"
 *   node build/drill.ts --keep                  keep the temporary directories for inspection
 */

const { values } = parseArgs({
    options: {
        app: { type: 'string' },
        keep: { type: 'boolean', default: false },
    },
});

interface BootStateFile {
    current?: string;
    previous?: string;
    pending?: string;
    lastGood?: string;
    bad: Array<{ id: string; reason: string }>;
    lastFailure?: { id: string; reason: string };
    lastSafeMode?: { reason: string };
}

interface RunResult {
    readonly code: number | null;
    readonly output: string;
}

const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const packagedApp = values.app ? path.resolve(values.app) : undefined;
const electronBinary = packagedApp ?? (createRequire(path.join(desktopDir, 'package.json'))('electron') as string);
const workDir = await mkdtemp(path.join(tmpdir(), 'xora-drill-'));

function runShell(
    dataDir: string,
    args: readonly string[] = [],
    extraEnv: Record<string, string> = {},
): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        XORA_DATA_DIR: dataDir,
        XORA_TEST_HIDE_WINDOWS: '1',
        XORA_TEST_EXIT_AFTER_GOOD: '1',
        XORA_TEST_EXIT_ON_SAFE_MODE: '1',
        XORA_TEST_PLAIN_SECRETS: '1',
        XORA_GOOD_AFTER_MS: '1500',
        XORA_UI_READY_TIMEOUT_MS: '20000',
        XORA_HOST_READY_TIMEOUT_MS: '10000',
        ...extraEnv,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const argv = packagedApp ? [...args] : [desktopDir, ...args];
    return new Promise((resolve, reject) => {
        const child = spawn(electronBinary, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`shell did not exit within 90s:\n${output}`));
        }, 90_000);
        child.on('error', reject);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
    });
}

async function readState(dataDir: string): Promise<BootStateFile> {
    return JSON.parse(await readFile(path.join(dataDir, 'app', 'state.json'), 'utf8')) as BootStateFile;
}

async function factoryVersion(): Promise<string> {
    const manifestFile = packagedApp
        ? process.platform === 'darwin'
            ? path.resolve(packagedApp, '..', '..', 'Resources', 'app-bundle', 'manifest.json')
            : path.resolve(packagedApp, '..', 'resources', 'app-bundle', 'manifest.json')
        : path.join(repoRoot, 'dist', 'app-bundle', 'manifest.json');
    return (JSON.parse(await readFile(manifestFile, 'utf8')) as { version: string }).version;
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function scenario(name: string, body: () => Promise<string>): Promise<void> {
    try {
        results.push({ name, ok: true, detail: await body() });
    } catch (error) {
        results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
}

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function install(dataDir: string, bundleDir: string): Promise<void> {
    const result = await runShell(dataDir, ['--install-bundle', bundleDir]);
    expect(result.code === 0, `--install-bundle exited with ${result.code}:\n${result.output}`);
}

const base = await factoryVersion();
const factory = `factory:${base}`;
const bundles = path.join(workDir, 'bundles');
const broken = await makeBundle({
    out: path.join(bundles, 'broken'),
    version: `${base}.drill.broken`,
    breakHost: true,
});
const good2 = await makeBundle({ out: path.join(bundles, 'good-2'), version: `${base}.drill.2` });
const good3 = await makeBundle({ out: path.join(bundles, 'good-3'), version: `${base}.drill.3` });
const feedBundle = await makeBundle({ out: path.join(bundles, 'feed', 'bundle'), version: `${base}.drill.4` });
const brokenFactory = await makeBundle({ out: path.join(bundles, 'factory-broken'), version: base, breakHost: true });
const dataDir = path.join(workDir, 'data');

await scenario('首次启动：内置基线正常启动', async () => {
    await runShell(dataDir);
    const state = await readState(dataDir);
    expect(state.lastGood === factory, `lastGood=${state.lastGood}`);
    return `lastGood=${state.lastGood}`;
});

await scenario('坏的更新包：连续两次启动失败后标记为坏，回到内置基线', async () => {
    await install(dataDir, broken.dir);
    await runShell(dataDir);
    const state = await readState(dataDir);
    const id = `slot:${broken.manifest.version}`;
    expect(
        state.bad.some((mark) => mark.id === id),
        `bad=${JSON.stringify(state.bad)}`,
    );
    expect(state.pending === undefined, `pending=${state.pending}`);
    expect(state.lastGood === factory, `lastGood=${state.lastGood}`);
    expect(state.lastFailure?.reason.startsWith('host-exit'), `lastFailure=${JSON.stringify(state.lastFailure)}`);
    return `bad=${id}（${state.lastFailure?.reason}），lastGood=${state.lastGood}`;
});

await scenario('好的更新包：启动成功后成为当前版本', async () => {
    await install(dataDir, good2.dir);
    await runShell(dataDir);
    const state = await readState(dataDir);
    expect(state.current === good2.manifest.version, `current=${state.current}`);
    expect(state.lastGood === `slot:${good2.manifest.version}`, `lastGood=${state.lastGood}`);
    return `current=${state.current}`;
});

await scenario('被篡改的更新包：校验失败、不重试，继续用当前版本', async () => {
    await install(dataDir, good3.dir);
    const slotIndex = path.join(dataDir, 'app', 'slots', good3.manifest.version, 'ui', 'index.html');
    await writeFile(slotIndex, '<!doctype html><script>document.title="tampered"</script>\n', 'utf8');
    await runShell(dataDir);
    const state = await readState(dataDir);
    const mark = state.bad.find((entry) => entry.id === `slot:${good3.manifest.version}`);
    expect(mark?.reason.startsWith('verify:'), `bad=${JSON.stringify(state.bad)}`);
    expect(state.current === good2.manifest.version, `current=${state.current}`);
    return `${mark?.reason}，current=${state.current}`;
});

/** Serves `<root>/feed-stable.json` and the bundle next to it, like a release host would. */
async function serveFeed(root: string): Promise<{ url: string; server: Server }> {
    const server = createServer((request, response) => {
        const relative = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '');
        const file = path.resolve(root, relative);
        if (!file.startsWith(path.resolve(root))) {
            response.writeHead(403).end();
            return;
        }
        readFile(file)
            .then((body) => response.writeHead(200).end(body))
            .catch(() => response.writeHead(404).end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

await scenario('在线更新：从更新源下载、校验、暂存，下次启动生效', async () => {
    const feedRoot = path.join(bundles, 'feed');
    await writeFile(
        path.join(feedRoot, 'feed-stable.json'),
        `${JSON.stringify({ schemaVersion: 1, channel: 'stable', version: feedBundle.manifest.version, manifest: 'bundle/manifest.json' })}\n`,
        'utf8',
    );
    const { url, server } = await serveFeed(feedRoot);
    try {
        const env = {
            XORA_UPDATE_FEED: `${url}/feed-{channel}.json`,
            XORA_UPDATE_CHECK_ON_START: '1',
            XORA_GOOD_AFTER_MS: '8000',
        };
        await runShell(dataDir, [], env);
        const staged = await readState(dataDir);
        expect(staged.pending === feedBundle.manifest.version, `pending=${staged.pending}`);
        await runShell(dataDir);
        const state = await readState(dataDir);
        expect(state.current === feedBundle.manifest.version, `current=${state.current}`);
        return `pending→current=${state.current}`;
    } finally {
        server.close();
    }
});

await scenario('--safe-mode：直接进入修复模式', async () => {
    await runShell(dataDir, ['--safe-mode']);
    const state = await readState(dataDir);
    expect(state.lastSafeMode?.reason === 'requested', `lastSafeMode=${JSON.stringify(state.lastSafeMode)}`);
    return `lastSafeMode=${state.lastSafeMode?.reason}`;
});

await scenario('修复模式页面：能读出状态并列出版本', async () => {
    await rm(path.join(dataDir, 'safe-mode-probe.json'), { force: true });
    await runShell(dataDir, ['--safe-mode'], { XORA_TEST_EXIT_ON_SAFE_MODE: '0', XORA_TEST_SAFE_MODE_PROBE: '1' });
    const probe = JSON.parse(await readFile(path.join(dataDir, 'safe-mode-probe.json'), 'utf8')) as {
        state: string;
        candidates: number;
        reason: string;
    };
    expect(probe.state === 'ready', `probe=${JSON.stringify(probe)}`);
    expect(probe.candidates >= 3, `probe=${JSON.stringify(probe)}`);
    return `页面已就绪，列出${probe.candidates}个版本`;
});

await scenario('离开修复模式后正常启动当前版本', async () => {
    await runShell(dataDir);
    const state = await readState(dataDir);
    expect(state.lastGood === `slot:${feedBundle.manifest.version}`, `lastGood=${state.lastGood}`);
    return `lastGood=${state.lastGood}`;
});

if (!packagedApp) {
    await scenario('内置基线也坏了：所有版本都失败后进入修复模式', async () => {
        const freshDir = path.join(workDir, 'data-broken-factory');
        await runShell(freshDir, [], { XORA_FACTORY_BUNDLE: brokenFactory.dir });
        const state = await readState(freshDir);
        expect(state.lastSafeMode?.reason === 'all-failed', `lastSafeMode=${JSON.stringify(state.lastSafeMode)}`);
        expect(
            state.bad.some((mark) => mark.id === factory),
            `bad=${JSON.stringify(state.bad)}`,
        );
        return `lastSafeMode=${state.lastSafeMode?.reason}`;
    });
}

for (const result of results) {
    console.log(`${result.ok ? '通过' : '失败'}  ${result.name}\n      ${result.detail.split('\n').join('\n      ')}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length}通过（${packagedApp ? '安装包' : '开发构建'}）`);
if (values.keep || failed > 0) {
    console.log(`演练目录：${workDir}`);
} else {
    await rm(workDir, { recursive: true, force: true });
}
process.exitCode = failed > 0 ? 1 : 0;
