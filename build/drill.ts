import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { BundleManifest } from '../packages/updater/src/index.ts';
import { secretStoreSwitches } from './app-switches.ts';

/**
 * Rollback drill: runs the real shell against throwaway data directories and checks the recorded boot state.
 *
 *   node build/drill.ts                         unpackaged shell (apps/desktop) with dist/app-bundle
 *   node build/drill.ts --app <executable>      a packaged build, e.g. ".../Xora Code.app/Contents/MacOS/Xora Code"
 *   node build/drill.ts --keep                  keep the temporary directories for inspection
 *   node build/drill.ts --prepare <dir>         only make the update bundles, signed here, into <dir>
 *   node drill.mjs --app <exe> --bundles <dir>  on a test machine (build/vm/harness.ts): use bundles made with
 *                                               --prepare, so the signing key stays on this machine
 */

const { values } = parseArgs({
    options: {
        app: { type: 'string' },
        keep: { type: 'boolean', default: false },
        prepare: { type: 'string' },
        bundles: { type: 'string' },
        // Multiplies the app's start-up limits and the waits, for slow machines (software-emulated VMs).
        'timeout-scale': { type: 'string', default: '1' },
    },
});
const scale = Math.max(1, Number(values['timeout-scale']) || 1);
const ms = (value: number): string => String(value * scale);

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

// Not from keys.ts: this file also runs bundled on test machines without the repository.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
        XORA_GOOD_AFTER_MS: ms(1500),
        XORA_UI_READY_TIMEOUT_MS: ms(20_000),
        XORA_HOST_READY_TIMEOUT_MS: ms(10_000),
        ...extraEnv,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    // A packaged build ignores XORA_TEST_PLAIN_SECRETS: keep it away from the real keychain or keyring.
    const argv = [...(packagedApp ? [] : [desktopDir]), ...args, ...secretStoreSwitches()];
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
            reject(new Error(`shell did not exit within ${90 * scale}s:\n${output}`));
        }, 90_000 * scale);
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

interface DrillBundle {
    readonly dir: string;
    readonly manifest: BundleManifest;
}

/** The update bundles of the drill, by folder: version suffix and whether the host exits at once. */
const BUNDLES: Readonly<Record<string, { readonly suffix: string; readonly breakHost?: boolean }>> = {
    broken: { suffix: '.drill.broken', breakHost: true },
    'good-2': { suffix: '.drill.2' },
    'good-3': { suffix: '.drill.3' },
    'feed/bundle': { suffix: '.drill.4' },
    'factory-broken': { suffix: '', breakHost: true },
};

/**
 * The version of a drill bundle. After a pre-release the suffix extends it (`1.0.0-alpha.1.drill.2`); after a release
 * it becomes a pre-release of the next patch (`1.0.1-drill.2`): bundle versions must be semver, and the online update
 * only takes a version newer than the running one. An empty suffix is the build's own version.
 */
function drillVersion(base: string, suffix: string): string {
    if (!suffix) return base;
    if (base.includes('-')) return `${base}${suffix}`;
    const [major = 0, minor = 0, patch = 0] = (base.split('+')[0] ?? base).split('.').map(Number);
    return `${major}.${minor}.${patch + 1}-${suffix.replace(/^\./, '')}`;
}

/** Makes and signs the bundles; make-bundle.ts (and the signing key) only load here, never on a test machine. */
async function makeBundles(root: string, base: string): Promise<Record<string, DrillBundle>> {
    const { makeBundle } = await import('./make-bundle.ts');
    const made: Record<string, DrillBundle> = {};
    for (const [name, { suffix, breakHost }] of Object.entries(BUNDLES)) {
        made[name] = await makeBundle({ out: path.join(root, name), version: drillVersion(base, suffix), breakHost });
    }
    return made;
}

/** Copies bundles made with --prepare into `root`, after checking they were made for this build. */
async function loadBundles(from: string, root: string, base: string): Promise<Record<string, DrillBundle>> {
    await cp(path.resolve(from), root, { recursive: true });
    const loaded: Record<string, DrillBundle> = {};
    for (const [name, { suffix }] of Object.entries(BUNDLES)) {
        const dir = path.join(root, name);
        const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as BundleManifest;
        if (manifest.version !== drillVersion(base, suffix)) {
            throw new Error(`${name} is ${manifest.version}, made for another build than ${base}`);
        }
        loaded[name] = { dir, manifest };
    }
    return loaded;
}

const base = await factoryVersion();
const factory = `factory:${base}`;
if (values.prepare) {
    await makeBundles(path.resolve(values.prepare), base);
    console.log(`drill bundles for ${base} → ${values.prepare}`);
    await rm(workDir, { recursive: true, force: true });
    process.exit(0);
}
const bundles = path.join(workDir, 'bundles');
const made = values.bundles ? await loadBundles(values.bundles, bundles, base) : await makeBundles(bundles, base);
const pick = (name: string): DrillBundle => made[name] as DrillBundle;
const broken = pick('broken');
const good2 = pick('good-2');
const good3 = pick('good-3');
const feedBundle = pick('feed/bundle');
const brokenFactory = pick('factory-broken');
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
            XORA_GOOD_AFTER_MS: ms(8000),
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
    // On Windows the app's last child processes can hold files in it for a moment after the shell quits.
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((error: unknown) =>
        console.warn(`(演练目录没删掉：${error instanceof Error ? error.message : String(error)})`),
    );
}
process.exitCode = failed > 0 ? 1 : 0;
