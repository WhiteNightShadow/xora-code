import { AcpClient, createNodeWritableSink } from '@xora-code/acp-client';
import {
    AcpInitializeSmokeRequest,
    ArtifactStagingRequest,
    InstalledSidecarRelease,
    OfficialGrokSource,
    OfficialGrokUpdater,
    OfficialGrokRelease,
    PlatformSignatureRequest,
    SidecarInstaller,
    SidecarUpdateManager,
    SidecarUpdateResult,
    StagingDownloadRequest,
    TrustedManifestKey,
    VersionSmokeRequest,
    verifySignedSidecarManifest
} from '@xora-code/update-build-tools';
import { app } from 'electron';
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ComponentUpdateStatus } from '../common/agent-protocol';
import { GrokSidecarSupervisor } from './sidecar-supervisor';

const EMPTY_PATCH_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface UpdateConfig {
    schemaVersion: 1;
    enabled: boolean;
    source?: 'official-npm' | 'xora-signed';
    channel: 'stable' | 'beta' | 'nightly';
    manifestUrl: string;
    homeCompatEpoch: number;
}

interface TrustedKeysFile {
    schemaVersion: 1;
    keys: TrustedManifestKey[];
}

/** Electron-main-only coordinator for independently signed Grok components. */
export class SidecarUpdateCoordinator {
    constructor(
        protected readonly prepareActivation: () => Promise<void> = async () => undefined,
        protected readonly activationSettled: () => void = () => undefined
    ) {}
    protected readonly supervisor = new GrokSidecarSupervisor();
    protected readonly componentRoot = path.join(app.getPath('userData'), 'components', 'grok');

    protected readonly officialSource = new OfficialGrokSource();
    protected latestOfficial: OfficialGrokRelease | undefined;
    protected latestSignedVersion: string | undefined;
    protected updateBusy = false;
    get busy(): boolean { return this.updateBusy; }

    status(): ComponentUpdateStatus {
        try {
            const config = this.readConfig();
            const official = config.source === 'official-npm';
            const keys = official ? [] : this.readKeys();
            const binary = this.embeddedBinaryPath();
            const installed = this.installedVersion();
            const configured = fs.existsSync(binary) && (official || keys.length > 0);
            const statePath = path.join(this.componentRoot, 'update-state.json');
            const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : undefined;
            return {
                enabled: config.enabled, configured, channel: config.channel,
                source: official ? 'official-npm' : 'xora-signed',
                currentVersion: installed,
                availableVersion: official ? this.latestOfficial?.version : this.latestSignedVersion,
                canRollback: !!state?.active,
                manifestUrl: official ? 'https://registry.npmjs.org/@xai-official/grok/latest' : config.manifestUrl,
                message: !fs.existsSync(binary) ? '当前构建缺少内置 Grok 组件，请使用完整安装包。'
                    : !config.enabled ? '产品配置已关闭组件更新。'
                    : official ? `当前 Grok CLI ${installed}。从 xAI 官方 npm 分发源检查稳定版，校验 SHA-512 和 ACP 后安装；安装时自动切换空闲 Agent，正在执行任务时请先结束任务。`
                    : keys.length === 0 ? `当前 Grok CLI ${installed}。Xora 签名更新公钥尚未配置。`
                    : 'Grok 组件签名更新已就绪。'
            };
        } catch (error) {
            return { enabled: false, configured: false, channel: 'stable', message: errorMessage(error) };
        }
    }

    async checkLatest(): Promise<ComponentUpdateStatus> {
        const config = this.readConfig();
        if (!config.enabled) throw new Error('Grok 组件更新已关闭。');
        if (config.source === 'official-npm') {
            this.latestOfficial = await this.officialSource.latest(platformTarget());
        } else {
            const keys = this.readKeys();
            if (!keys.length) throw new Error('Xora 签名更新公钥尚未配置。');
            const manifest = await fetchJson(config.manifestUrl, 1024 * 1024);
            this.latestSignedVersion = verifySignedSidecarManifest(manifest, keys, { expectedChannel: config.channel }).payload.version;
        }
        return this.status();
    }

    protected installedVersion(): string {
        const release = path.join(this.componentRoot, 'active', 'release.json');
        return fs.existsSync(release) ? JSON.parse(fs.readFileSync(release, 'utf8')).version : '0.2.102';
    }

    async applyLatest(): Promise<SidecarUpdateResult> {
        return this.exclusive(() => this.applyLatestUnlocked());
    }

    protected async applyLatestUnlocked(): Promise<SidecarUpdateResult> {
        const config = this.readConfig();
        if (config.source === 'official-npm') return this.applyOfficial(config);
        const keys = this.readKeys();
        if (!config.enabled) throw new Error('Grok component updates are disabled.');
        if (!keys.length) throw new Error('No trusted Ed25519 sidecar manifest key is configured; release remains blocked.');
        const manifest = await fetchJson(config.manifestUrl, 1024 * 1024);
        const metadata = await this.bootstrapEmbedded(config);
        const fixturePath = this.updateContractPath('acp-initialize-fixture.json');
        const fixtureSha256 = sha256File(fixturePath);
        const manager = new SidecarUpdateManager({
            beforeActivate: this.prepareActivation,
            installer: new SidecarInstaller(this.componentRoot),
            downloader: { download: request => downloadArtifact(request) },
            artifactStager: { stage: request => stageRawExecutable(request) },
            platformSignatureVerifier: request => verifyPlatformSignature(request),
            versionSmoke: request => smokeVersion(request),
            acpInitializeSmoke: request => this.smokeAcp(request, fixturePath),
            trustedKeys: keys,
            embeddedRelease: metadata,
            appVersion: app.getVersion(),
            channel: config.channel,
            target: platformTarget(),
            homeCompatEpoch: config.homeCompatEpoch,
            expectedAcpFixtureSha256: fixtureSha256,
            acceptedPatchSha256: [EMPTY_PATCH_SHA256],
            smokeWorkspaceRoot: os.tmpdir()
        });
        return manager.apply(manifest);
    }

    protected async applyOfficial(config: UpdateConfig): Promise<SidecarUpdateResult> {
        if (!config.enabled) throw new Error('Grok 组件更新已关闭。');
        this.latestOfficial = await this.officialSource.latest(platformTarget());
        const embedded = await this.bootstrapEmbedded(config);
        const fixturePath = this.updateContractPath('acp-initialize-fixture.json');
        return new OfficialGrokUpdater({
            beforeActivate: this.prepareActivation,
            installer: new SidecarInstaller(this.componentRoot), source: this.officialSource, embedded,
            verifyVersion: async (binary, version) => {
                const actual = await smokeVersion({ binaryPath: binary, args: ['--version'], expectedVersion: version });
                if (actual !== version) throw new Error(`下载的 Grok 版本 ${actual} 与官方版本 ${version} 不一致。`);
            },
            verifyAcp: binary => this.smokeAcp({ binaryPath: binary,
                args: ['--no-auto-update', '--cwd', os.tmpdir(), 'agent', '--no-leader', 'stdio'],
                workspaceRoot: os.tmpdir(), fixtureSha256: sha256File(fixturePath) }, fixturePath)
        }).apply(this.latestOfficial);
    }

    async rollback(): Promise<InstalledSidecarRelease> {
        return this.exclusive(async () => {
            const embedded = await this.bootstrapEmbedded(this.readConfig());
            await this.prepareActivation();
            return new SidecarInstaller(this.componentRoot).rollbackToPrevious(embedded);
        });
    }

    protected async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.updateBusy) throw new Error('另一个窗口正在更新或回滚 Grok，请等待完成。');
        this.updateBusy = true;
        try { return await operation(); } finally { this.updateBusy = false; this.activationSettled(); }
    }

    protected async bootstrapEmbedded(config: UpdateConfig): Promise<InstalledSidecarRelease> {
        const source = this.embeddedBinaryPath();
        const sourceInfo = fs.lstatSync(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Embedded Grok baseline is not a regular file.');
        const embeddedDirectory = path.join(this.componentRoot, 'embedded');
        const binaryName = process.platform === 'win32' ? 'grok.exe' : 'grok';
        const target = path.join(embeddedDirectory, binaryName);
        fs.mkdirSync(embeddedDirectory, { recursive: true, mode: 0o700 });
        if (!fs.existsSync(target)) {
            const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
            try {
                fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
                if (process.platform !== 'win32') fs.chmodSync(temporary, 0o755);
                // Windows FlushFileBuffers requires a writable file handle.
                const descriptor = fs.openSync(temporary, 'r+');
                try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
                fs.renameSync(temporary, target);
            } finally {
                fs.rmSync(temporary, { force: true });
            }
        }
        const fixtureSha256 = sha256File(this.updateContractPath('acp-initialize-fixture.json'));
        return {
            version: '0.2.102',
            sequence: 0,
            channel: config.channel,
            target: platformTarget(),
            artifactSha256: sha256File(target),
            artifactSize: fs.statSync(target).size,
            sidecarLockSha256: sha256File(this.updateContractPath('sidecar.lock.json')),
            patchSha256: EMPTY_PATCH_SHA256,
            acpFixtureSha256: fixtureSha256,
            homeCompatEpoch: config.homeCompatEpoch,
            installedAt: '2026-07-19T00:00:00.000Z'
        };
    }

    protected async smokeAcp(request: AcpInitializeSmokeRequest, fixturePath: string): Promise<void> {
        if (sha256File(fixturePath) !== request.fixtureSha256) throw new Error('ACP fixture changed before smoke execution.');
        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-update-smoke-'));
        const args = request.args.map(argument => argument === request.workspaceRoot ? workspace : argument);
        const home = path.join(workspace, '.grok');
        fs.mkdirSync(home, { mode: 0o700 });
        fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nremote_fetch = false\n');
        const child = spawn(request.binaryPath, args, {
            cwd: workspace,
            env: this.supervisor.commandEnvironment({ HOME: workspace, USERPROFILE: workspace, GROK_HOME: home }),
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const client = new AcpClient({ write: createNodeWritableSink(child.stdin), defaultTimeoutMs: 15_000, maxLineBytes: 2 * 1024 * 1024 });
        const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.once('error', error => client.close(error));
        const consume = client.consume(child.stdout).catch(() => undefined);
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-32_000); });
        try {
            const response = await client.request<Record<string, unknown>>('initialize', fixture, { timeoutMs: 15_000 });
            if (response.protocolVersion !== fixture.protocolVersion || !response.agentCapabilities) throw new Error(`ACP initialize did not return a protocol version. ${stderr}`);
        } finally {
            client.close(new Error('ACP update smoke complete.'));
            this.supervisor.terminateProcessTree(child, true);
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([exited, new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('无法确认 Grok 验证进程已退出，未激活更新。请重试。')), 5_000);
                })]);
            } finally { if (timer) clearTimeout(timer); }
            await consume;
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    }

    protected readConfig(): UpdateConfig {
        const value = JSON.parse(fs.readFileSync(path.join(this.updateResourceRoot(), 'config.json'), 'utf8')) as UpdateConfig;
        if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !['stable', 'beta', 'nightly'].includes(value.channel) ||
            !Number.isSafeInteger(value.homeCompatEpoch) || value.homeCompatEpoch < 1) throw new Error('Invalid component update configuration.');
        if (value.source !== undefined && value.source !== 'official-npm' && value.source !== 'xora-signed') throw new Error('Invalid Grok update source.');
        if (value.source === 'official-npm' && value.channel !== 'stable') throw new Error('Official Grok updates currently require the stable channel.');
        const url = new URL(value.manifestUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Component manifest URL must be credential-free HTTPS.');
        return value;
    }

    protected readKeys(): TrustedManifestKey[] {
        const value = JSON.parse(fs.readFileSync(path.join(this.updateResourceRoot(), 'sidecar-trusted-keys.json'), 'utf8')) as TrustedKeysFile;
        if (value.schemaVersion !== 1 || !Array.isArray(value.keys)) throw new Error('Invalid sidecar trusted-key file.');
        return value.keys;
    }

    protected updateResourceRoot(): string {
        return app.isPackaged
            ? path.join(process.resourcesPath, 'update')
            : path.resolve(app.getAppPath(), '..', '..', 'resources', 'update');
    }

    protected embeddedBinaryPath(): string {
        const root = app.isPackaged
            ? path.join(process.resourcesPath, 'sidecars', 'grok')
            : path.resolve(app.getAppPath(), '..', '..', 'resources', 'sidecars', 'grok');
        return path.join(root, process.platform === 'win32' ? 'grok.exe' : 'grok');
    }

    protected updateContractPath(name: 'sidecar.lock.json' | 'acp-initialize-fixture.json'): string {
        return app.isPackaged
            ? path.join(this.updateResourceRoot(), name)
            : path.resolve(app.getAppPath(), '..', '..', 'build', 'grok', name);
    }
}

async function downloadArtifact(request: StagingDownloadRequest): Promise<void> {
    const response = await fetch(request.url, { redirect: 'follow', signal: request.signal });
    if (!response.ok || !response.body) throw new Error(`Artifact download failed with HTTP ${response.status}.`);
    if (new URL(response.url).protocol !== 'https:') throw new Error('Artifact redirects must remain on HTTPS.');
    const handle = await fs.promises.open(request.destinationPath, 'wx', 0o600);
    const reader = response.body.getReader();
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            size += chunk.length;
            if (size > request.expectedSize) throw new Error('Artifact exceeded its signed size.');
            hash.update(chunk);
            await handle.write(chunk);
        }
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (size !== request.expectedSize || hash.digest('hex') !== request.expectedSha256) {
        throw new Error('Artifact did not match its signed size and SHA-256.');
    }
}

async function stageRawExecutable(request: ArtifactStagingRequest): Promise<void> {
    const target = path.join(request.destinationDirectory, request.binaryName);
    await fs.promises.copyFile(request.artifactPath, target, fs.constants.COPYFILE_EXCL);
    if (request.binaryName !== 'grok.exe') await fs.promises.chmod(target, 0o755);
}

async function verifyPlatformSignature(request: PlatformSignatureRequest): Promise<void> {
    if (request.target.startsWith('darwin-')) {
        const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', request.binaryPath], { encoding: 'utf8', timeout: 15_000 });
        if (result.status !== 0) throw new Error(result.stderr || 'Invalid macOS signature.');
    } else if (request.target.startsWith('win32-')) {
        const escaped = request.binaryPath.replace(/'/g, "''");
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
        if (result.status !== 0 || result.stdout.trim() !== 'Valid') throw new Error('Invalid Windows Authenticode signature.');
    }
}

async function smokeVersion(request: VersionSmokeRequest): Promise<string> {
    const result = spawnSync(request.binaryPath, [...request.args], { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false });
    if (result.status !== 0) throw new Error(result.stderr || 'grok --version failed.');
    const match = `${result.stdout}\n${result.stderr}`.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
    if (!match) throw new Error('grok --version returned no semantic version.');
    return match[0];
}

async function fetchJson(url: string, maximumBytes: number): Promise<unknown> {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Manifest download failed with HTTP ${response.status}.`);
    if (new URL(response.url).protocol !== 'https:') throw new Error('Manifest redirects must remain on HTTPS.');
    if (!response.body) throw new Error('Manifest response had no body.');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maximumBytes) {
            await reader.cancel();
            throw new Error('Component manifest exceeded 1 MiB.');
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sha256File(target: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

function platformTarget(): string {
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `${process.platform}-${architecture}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
