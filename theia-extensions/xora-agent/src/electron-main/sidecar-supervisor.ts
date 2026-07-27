import { app } from 'electron';
import { ChildProcess, ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { deepRedact, StreamingOpaquePayloadRedactor } from './session-repository';
import { sharedGrokHome } from './shared-grok-home';
import { sidecarFilesystemError } from './sidecar-errors';

export const EMBEDDED_GROK_VERSION = '0.2.102';
const MAX_EXACT_REDACTION_VALUES = 4_096;
const MAX_EXACT_REDACTION_BYTES = 4 * 1024 * 1024;

export interface SidecarLaunch {
    process: ChildProcessWithoutNullStreams;
    binary: string;
    version: string;
}

export class GrokSidecarSupervisor {
    protected child: ChildProcessWithoutNullStreams | undefined;
    protected stopping = false;
    protected readonly logPath = path.join(app.getPath('userData'), 'logs', 'grok-sidecar.stderr.log');
    protected exactSecrets: string[] = [];
    protected stderrCarry = '';
    protected stderrDecoder = new StringDecoder('utf8');
    protected stderrOpaqueRedactor = new StreamingOpaquePayloadRedactor();

    get running(): boolean {
        return !!this.child && this.child.exitCode === null && !this.child.killed;
    }

    binaryPath(): string {
        return this.resolveBinary();
    }

    commandEnvironment(injected: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
        return this.sanitizedEnvironment(injected);
    }

    /**
     * Adds secrets learned after process launch (for example resolved MCP
     * headers/env) to the stderr boundary. Call this before the corresponding
     * ACP request is written. Values remain registered for the process
     * lifetime so rotated credentials cannot reappear in later diagnostics.
     */
    registerRedactionSecrets(values: Iterable<string>): void {
        const next = new Set(this.exactSecrets ?? []);
        let totalBytes = [...next].reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
        for (const value of values) {
            if (typeof value !== 'string') {
                throw new Error('An exact redaction value must be a string.');
            }
            if (!value || next.has(value)) continue;
            const bytes = Buffer.byteLength(value, 'utf8');
            if (next.size >= MAX_EXACT_REDACTION_VALUES || totalBytes + bytes > MAX_EXACT_REDACTION_BYTES) {
                throw new Error('The exact redaction set is too large.');
            }
            next.add(value);
            totalBytes += bytes;
        }
        this.exactSecrets = [...next].sort((left, right) =>
            right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
    }

    terminateProcessTree(child: ChildProcess, force = false): void {
        this.signalTree(child, force ? 'SIGKILL' : 'SIGTERM');
    }

    launch(root: string, providerEnvironment: NodeJS.ProcessEnv): SidecarLaunch {
        if (this.running) {
            throw new Error('This window already has a Grok sidecar.');
        }
        const binary = this.resolveBinary();
        this.exactSecrets = [];
        this.registerRedactionSecrets(
            Object.values(providerEnvironment).filter((value): value is string =>
                typeof value === 'string' && value.length > 0)
        );
        const args = ['--no-auto-update', '--cwd', root, 'agent', '--no-leader', 'stdio'];
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(binary, args, {
                cwd: root,
                env: this.sanitizedEnvironment(providerEnvironment),
                shell: false,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (error) {
            this.exactSecrets = [];
            throw error;
        }
        this.child = child;
        this.stopping = false;
        this.stderrCarry = '';
        this.stderrDecoder = new StringDecoder('utf8');
        this.stderrOpaqueRedactor = new StreamingOpaquePayloadRedactor();
        child.stderr.on('data', chunk => this.writeStderr(chunk));
        child.once('exit', () => {
            if (this.child === child) {
                this.flushStderr();
                this.exactSecrets = [];
                this.child = undefined;
            }
        });
        return { process: child, binary, version: this.resolvedVersion(binary) };
    }

    async stop(graceMs = 3000): Promise<void> {
        const child = this.child;
        if (!child || child.exitCode !== null) {
            this.child = undefined;
            return;
        }
        this.stopping = true;
        try { child.stdin.end(); } catch { /* already closed */ }
        this.signalTree(child, 'SIGTERM');
        const exited = await Promise.race([
            new Promise<boolean>(resolve => child.once('exit', () => resolve(true))),
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), graceMs))
        ]);
        if (!exited && child.exitCode === null) {
            this.signalTree(child, 'SIGKILL');
            await Promise.race([
                new Promise<void>(resolve => child.once('exit', () => resolve())),
                new Promise<void>(resolve => setTimeout(resolve, 1000))
            ]);
        }
        if (this.child === child) {
            this.child = undefined;
        }
        this.flushStderr();
        this.exactSecrets = [];
    }

    /** Last-resort shutdown path used by Electron's synchronous onStop hook. */
    stopSync(): void {
        const child = this.child;
        this.child = undefined;
        if (child?.pid !== undefined && child.exitCode === null) {
            if (process.platform === 'win32') {
                const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
                try {
                    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
                        shell: false, windowsHide: true, stdio: 'ignore', timeout: 3000
                    });
                } catch { try { child.kill(); } catch { /* gone */ } }
            } else {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
            }
        }
        this.flushStderr();
        this.exactSecrets = [];
    }

    protected resolveBinary(): string {
        const override = process.env.XORA_GROK_BINARY;
        if (override && !app.isPackaged) {
            return this.assertBinary(path.resolve(override), undefined);
        }

        const activeRoot = path.join(app.getPath('userData'), 'components', 'grok', 'active');
        const activeBinary = path.join(activeRoot, process.platform === 'win32' ? 'grok.exe' : 'grok');
        if (fs.existsSync(activeBinary)) {
            // The updater owns signature/hash verification before switching the
            // active directory. We still reject symlinks and path escapes here.
            const binary = this.assertBinary(activeBinary, activeRoot);
            this.verifyActiveRelease(binary, activeRoot);
            return binary;
        }

        const resourceRoot = path.join(process.resourcesPath, 'sidecars', 'grok');
        return this.assertBinary(path.join(resourceRoot, process.platform === 'win32' ? 'grok.exe' : 'grok'), resourceRoot);
    }

    protected assertBinary(candidate: string, allowedRoot: string | undefined): string {
        const stat = this.readSidecarFile(() => fs.lstatSync(candidate));
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('The selected Grok sidecar is not a regular file.');
        }
        const real = this.readSidecarFile(() => fs.realpathSync.native(candidate));
        if (allowedRoot) {
            const realRoot = this.readSidecarFile(() => fs.realpathSync.native(allowedRoot));
            const relative = path.relative(realRoot, real);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error('The Grok sidecar path escapes its verified component directory.');
            }
        }
        if (process.platform !== 'win32' && (this.readSidecarFile(() => fs.statSync(real)).mode & 0o111) === 0) {
            throw new Error('The Grok sidecar is not executable.');
        }
        return real;
    }

    protected readSidecarFile<T>(operation: () => T): T {
        try {
            return operation();
        } catch (error) {
            throw sidecarFilesystemError(error);
        }
    }

    protected verifyActiveRelease(binary: string, activeRoot: string): void {
        const metadataPath = path.join(activeRoot, 'release.json');
        const metadataInfo = fs.lstatSync(metadataPath);
        if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) throw new Error('Active Grok release metadata is unsafe.');
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { artifactSha256?: unknown; artifactSize?: unknown };
        const stat = fs.statSync(binary);
        if (!Number.isSafeInteger(metadata.artifactSize) || metadata.artifactSize !== stat.size ||
            typeof metadata.artifactSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(metadata.artifactSha256)) {
            throw new Error('Active Grok release metadata is invalid.');
        }
        const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
        if (digest !== metadata.artifactSha256) throw new Error('Active Grok sidecar failed its persisted SHA-256 check.');
    }

    protected resolvedVersion(binary: string): string {
        try {
            const release = JSON.parse(fs.readFileSync(path.join(path.dirname(binary), 'release.json'), 'utf8')) as { version?: unknown };
            return typeof release.version === 'string' ? release.version : EMBEDDED_GROK_VERSION;
        } catch {
            return EMBEDDED_GROK_VERSION;
        }
    }

    protected sanitizedEnvironment(injected: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const allowed = [
            'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
            'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
            'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
            'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'
        ];
        const environment: NodeJS.ProcessEnv = {};
        for (const name of allowed) {
            if (process.env[name] !== undefined) {
                environment[name] = process.env[name];
            }
        }
        // Always bind Grok CLI and ACP processes to the same user-global home.
        // Custom API Providers may deliberately override this with their
        // isolated, token-free home in `injected` below.
        environment.GROK_HOME = sharedGrokHome();
        for (const [name, value] of Object.entries(injected)) {
            if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof value !== 'string') {
                throw new Error('Unsafe provider environment entry.');
            }
            environment[name] = value;
        }
        // Product diagnostics are local and opt-in. Enforce these values after
        // Provider injection so no profile can accidentally re-enable Grok's
        // network telemetry, ANSI output, or implicit third-party MCP discovery
        // inside the ACP transport process. Xora Code passes an explicit,
        // workspace-scoped MCP list to ACP; scanning ~/.claude.json or
        // ~/.cursor/mcp.json here would bypass that trust boundary and repeat
        // expensive MCP startup work for every new session.
        environment.DISABLE_TELEMETRY = '1';
        environment.NO_COLOR = '1';
        environment.XORA_CODE = '1';
        environment.GROK_CURSOR_MCPS_ENABLED = 'false';
        environment.GROK_CLAUDE_MCPS_ENABLED = 'false';
        return environment;
    }

    protected signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
        if (child.pid === undefined) {
            return;
        }
        if (process.platform !== 'win32') {
            try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
            return;
        }
        const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const args = ['/PID', String(child.pid), '/T'];
        if (signal === 'SIGKILL') {
            args.push('/F');
        }
        try { spawn(taskkill, args, { shell: false, windowsHide: true, stdio: 'ignore' }); } catch { try { child.kill(); } catch { /* gone */ } }
    }

    protected writeStderr(chunk: Buffer | string): void {
        const decoded = typeof chunk === 'string' ? chunk : this.stderrDecoder.write(chunk);
        // The opaque-payload stream redactor runs before the bounded carry. If
        // a sidecar writes an image one byte at a time, no raw prefix can be
        // flushed while the value's final length is still unknown.
        this.stderrCarry += this.stderrOpaqueRedactor.write(decoded);
        // Also retain a bounded tail for generic Bearer/token patterns that
        // are not registered exact Provider/MCP credentials.
        const reserve = Math.max(256, ...this.exactSecrets.map(secret => secret.length - 1));
        const boundary = Math.max(0, this.stderrCarry.length - reserve);
        const consumed = this.writeRedactedPrefix(this.stderrCarry, boundary);
        this.stderrCarry = this.stderrCarry.slice(consumed);
    }

    protected flushStderr(): void {
        this.stderrCarry += this.stderrOpaqueRedactor.end(this.stderrDecoder.end());
        if (this.stderrCarry) {
            this.appendLog(deepRedact(this.stderrCarry, this.exactSecrets));
            this.stderrCarry = '';
        }
    }

    /** Emits only a prefix for which no exact secret can still span a future chunk. */
    protected writeRedactedPrefix(source: string, boundary: number): number {
        if (boundary <= 0) return 0;
        let cursor = 0;
        let output = '';
        while (cursor < boundary) {
            let nextIndex = -1;
            let nextSecret = '';
            for (const secret of this.exactSecrets) {
                const index = source.indexOf(secret, cursor);
                if (index >= 0 && (nextIndex < 0 || index < nextIndex || (index === nextIndex && secret.length > nextSecret.length))) {
                    nextIndex = index;
                    nextSecret = secret;
                }
            }
            if (nextIndex < 0 || nextIndex >= boundary) {
                output += source.slice(cursor, boundary);
                cursor = boundary;
                break;
            }
            output += source.slice(cursor, nextIndex);
            output += '[REDACTED]';
            cursor = nextIndex + nextSecret.length;
        }
        if (output) this.appendLog(deepRedact(output));
        return cursor;
    }

    protected appendLog(redacted: string): void {
        if (!redacted) return;
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
        try {
            const stat = fs.lstatSync(this.logPath);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing an unsafe sidecar log path.');
            if (stat.size > 5 * 1024 * 1024) {
                fs.renameSync(this.logPath, `${this.logPath}.${Date.now()}.previous`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
        const descriptor = fs.openSync(this.logPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, 0o600);
        try {
            fs.writeFileSync(descriptor, redacted, 'utf8');
        } finally {
            fs.closeSync(descriptor);
        }
        fs.chmodSync(this.logPath, 0o600);
    }
}
