import { app, safeStorage } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type CredentialAccessCode = 'CREDENTIAL_ACCESS_TIMEOUT' | 'CREDENTIAL_ACCESS_DENIED'
    | 'CREDENTIAL_STORAGE_UNAVAILABLE' | 'CREDENTIAL_UNLOCK_REQUIRED' | 'CREDENTIAL_STORE_CHANGED';

export class CredentialAccessError extends Error {
    constructor(readonly code: CredentialAccessCode) {
        super(`${code}: Saved credentials could not be unlocked. Complete the system keychain authorization, then explicitly retry the connection or save the API key again.`);
        this.name = 'CredentialAccessError';
    }
}

export interface CredentialHelperRequest {
    decrypt: string[];
    encrypt: string[];
}

export interface CredentialHelperResult {
    decrypted: string[];
    encrypted: string[];
}

interface SessionOperation {
    requestId: number;
    request: CredentialHelperRequest;
    resolve: (value: CredentialHelperResult) => void;
    reject: (error: CredentialAccessError) => void;
    timer: NodeJS.Timeout;
}

interface SessionChild {
    child: ChildProcess;
    retiring: boolean;
    operation?: SessionOperation;
    shutdownTimer?: NodeJS.Timeout;
}

/**
 * macOS OSCrypt caches its derived key for one process lifetime. Keep that
 * process isolated from Electron main, and retain it after successful requests.
 * A failed process cannot be reused: Chromium also caches keychain failure.
 */
export class MacCredentialSession {
    protected childState: SessionChild | undefined;
    protected queue: Promise<void> = Promise.resolve();
    protected requestId = 0;
    protected failureEpoch = 0;
    protected lastFailure = new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED');
    protected disposed = false;
    protected readonly shutdown = (): void => {
        this.dispose();
        const state = this.childState;
        if (state) {
            if (state.shutdownTimer) clearTimeout(state.shutdownTimer);
            try { state.child.kill('SIGKILL'); } catch { /* the process is quitting */ }
        }
    };

    constructor(protected readonly createChild: () => ChildProcess = () => spawnHelper(true)) {
        app?.once?.('quit', this.shutdown);
    }

    run(request: CredentialHelperRequest, timeoutMs = 15_000): Promise<CredentialHelperResult> {
        const epoch = this.failureEpoch;
        const snapshot = { decrypt: [...request.decrypt], encrypt: [...request.encrypt] };
        const operation = this.queue.then(() => {
            if (this.disposed) throw new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED');
            // Requests which were already queued when authorization failed must
            // not turn into a sequence of fresh OS authorization prompts.
            if (epoch !== this.failureEpoch) throw this.lastFailure;
            return this.execute(snapshot, timeoutMs);
        });
        this.queue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const state = this.childState;
        if (!state) {
            app?.removeListener?.('quit', this.shutdown);
            return;
        }
        if (state.retiring) return;
        state.retiring = true;
        const error = new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED');
        this.failed(error);
        this.complete(state, error);
        state.shutdownTimer = setTimeout(() => {
            if (this.childState === state) {
                try { state.child.kill('SIGKILL'); } catch { /* close still required */ }
            }
        }, 1000);
        try {
            // Let the child close IPC. Parent-initiated disconnect does not
            // advance Node's IPC close counter and can strand the close fence.
            if (state.child.connected) state.child.send({ type: 'shutdown' }, failure => {
                if (failure && this.childState === state) {
                    try { state.child.kill('SIGKILL'); } catch { /* close still required */ }
                }
            });
            else state.child.kill('SIGTERM');
        } catch { /* the bounded shutdown timer will still clean up */ }
    }

    protected execute(request: CredentialHelperRequest, timeoutMs: number): Promise<CredentialHelperResult> {
        if (this.childState?.retiring) {
            // SIGKILL or 'exit' alone does not confirm that the old inherited
            // IPC channel is gone. Keep the fence until this exact child's
            // 'close' event; never overlap it with a replacement helper.
            return Promise.reject(new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED'));
        }
        let state = this.childState;
        if (!state) {
            try {
                state = { child: this.createChild(), retiring: false };
                this.childState = state;
                this.observe(state);
            } catch {
                const error = new CredentialAccessError('CREDENTIAL_ACCESS_DENIED');
                this.failed(error);
                return Promise.reject(error);
            }
        }
        if (!Number.isSafeInteger(this.requestId + 1)) {
            this.retire(state, new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
            return Promise.reject(this.lastFailure);
        }
        const active = state;
        return new Promise((resolve, reject) => {
            const requestId = ++this.requestId;
            const timer = setTimeout(() => {
                if (active.operation?.requestId === requestId) {
                    this.retire(active, new CredentialAccessError('CREDENTIAL_ACCESS_TIMEOUT'));
                }
            }, timeoutMs);
            active.operation = { requestId, request, resolve, reject, timer };
            try {
                active.child.send({ ...request, requestId }, error => {
                    if (error && active.operation?.requestId === requestId) {
                        this.retire(active, new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
                    }
                });
            } catch {
                if (active.operation?.requestId === requestId) {
                    this.retire(active, new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
                }
            }
        });
    }

    protected observe(state: SessionChild): void {
        const message = (value: unknown): void => this.receive(state, value);
        const error = (): void => this.retire(state, new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
        const disconnect = (): void => this.retire(state, new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
        const lease = state.child.stdio?.[4];
        lease?.on('error', error);
        state.child.on('message', message);
        state.child.on('error', error);
        state.child.once('disconnect', disconnect);
        state.child.once('close', () => {
            if (state.shutdownTimer) clearTimeout(state.shutdownTimer);
            // The extra pipe is an ownership lease, never a credential stream.
            // Keep its parent end alive until this exact process has closed.
            lease?.removeListener('error', error);
            lease?.destroy();
            state.child.removeListener('message', message);
            state.child.removeListener('error', error);
            state.child.removeListener('disconnect', disconnect);
            if (this.childState !== state) return;
            if (!state.retiring) {
                const failure = new CredentialAccessError('CREDENTIAL_ACCESS_DENIED');
                this.failed(failure);
                this.complete(state, failure);
            }
            this.childState = undefined;
            if (this.disposed) app?.removeListener?.('quit', this.shutdown);
        });
    }

    protected receive(state: SessionChild, value: unknown): void {
        if (this.childState !== state || state.retiring || !state.operation) return;
        const response = value as Partial<CredentialHelperResult> & { requestId?: unknown; error?: string };
        if (!response || !Number.isSafeInteger(response.requestId) || (response.requestId as number) < 1) {
            this.retire(state, new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
            return;
        }
        // A delayed/duplicate response, including one from an older request,
        // must never satisfy the current operation. Do not buffer future IDs.
        if (response.requestId !== state.operation.requestId) return;
        if (response.error) {
            this.retire(state, new CredentialAccessError(response.error === 'unavailable'
                ? 'CREDENTIAL_STORAGE_UNAVAILABLE' : 'CREDENTIAL_ACCESS_DENIED'));
            return;
        }
        const request = state.operation.request;
        if (!Array.isArray(response.decrypted) || !Array.isArray(response.encrypted)
            || response.decrypted.length !== request.decrypt.length
            || response.encrypted.length !== request.encrypt.length
            || !response.decrypted.every(entry => typeof entry === 'string' && Buffer.byteLength(entry, 'utf8') <= 16 * 1024)
            || !response.encrypted.every(entry => typeof entry === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(entry) && entry.length <= 64 * 1024)) {
            this.retire(state, new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
            return;
        }
        this.complete(state, undefined, { decrypted: response.decrypted, encrypted: response.encrypted });
    }

    protected failed(error: CredentialAccessError): void {
        this.failureEpoch++;
        this.lastFailure = error;
    }

    protected retire(state: SessionChild, error: CredentialAccessError): void {
        if (this.childState !== state || state.retiring) return;
        state.retiring = true;
        this.failed(error);
        this.complete(state, error);
        try { state.child.kill('SIGKILL'); } catch { /* close confirmation still required */ }
    }

    protected complete(state: SessionChild, error?: CredentialAccessError, result?: CredentialHelperResult): void {
        const operation = state.operation;
        if (!operation) return;
        state.operation = undefined;
        clearTimeout(operation.timer);
        if (error) operation.reject(error);
        else operation.resolve(result!);
    }
}

let macCredentialSession: MacCredentialSession | undefined;

/** Called by AgentHostManager only once real contribution shutdown begins. */
export function disposeMacCredentialSession(): void {
    macCredentialSession?.dispose();
}

/** No credentials are placed in arguments, environment variables or log streams. */
export function runCredentialHelper(
    request: CredentialHelperRequest,
    options: { timeoutMs?: number; spawnHelper?: () => ChildProcess } = {}
): Promise<CredentialHelperResult> {
    if (process.platform === 'darwin' && !options.spawnHelper) {
        return (macCredentialSession ??= new MacCredentialSession()).run(request, options.timeoutMs);
    }
    return new Promise((resolve, reject) => {
        let child: ChildProcess | undefined;
        let settled = false;
        let result: CredentialHelperResult | undefined;
        let timer: NodeJS.Timeout | undefined;
        const preparation = new AbortController();
        const finish = (error?: CredentialAccessError): void => {
            if (settled) return;
            settled = true;
            preparation.abort();
            if (timer) clearTimeout(timer);
            app?.removeListener?.('will-quit', shutdown);
            if (error) {
                // Only failure/timeout interrupts OS authorization. A successful
                // child must finish Electron shutdown and flush Local State.
                try { child?.kill('SIGKILL'); } catch { /* already exited */ }
                reject(error);
            } else resolve(result!);
        };
        const shutdown = (): void => finish(new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED'));
        timer = setTimeout(() => finish(new CredentialAccessError('CREDENTIAL_ACCESS_TIMEOUT')), options.timeoutMs ?? 15_000);
        app?.once?.('will-quit', shutdown);
        const launch = async (): Promise<void> => {
            try {
                if (process.platform === 'win32' && !options.spawnHelper) {
                    await app.whenReady();
                    if (settled) return;
                    // Electron 39 / Chromium 142 on Windows implements this as
                    // a cached encryption_key_.empty() check. It does not call
                    // DPAPI or open an OS prompt. Other platforms stay entirely
                    // inside the isolated helper for availability checks.
                    if (!safeStorage.isEncryptionAvailable()) {
                        throw new CredentialAccessError('CREDENTIAL_STORAGE_UNAVAILABLE');
                    }
                    // OSCrypt initializes before ready but coalesces its first
                    // Local State write. Never let a concurrent helper generate
                    // a second profile key while the parent's key is in memory.
                    await waitForWindowsStorageKey(
                        path.join(app.getPath('sessionData'), 'Local State'),
                        options.timeoutMs ?? 15_000,
                        preparation.signal
                    );
                }
                if (settled) return;
                child = options.spawnHelper ? options.spawnHelper() : spawnHelper();
            } catch (error) {
                finish(error instanceof CredentialAccessError ? error : new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
                return;
            }
            child.once('error', () => finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED')));
            child.once('close', (code, signal) => {
                if (code === 0 && signal === null && result) finish();
                else finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
            });
            child.once('message', (message: unknown) => {
                const response = message as Partial<CredentialHelperResult> & { error?: string };
                if (response?.error) {
                    finish(new CredentialAccessError(response.error === 'unavailable'
                        ? 'CREDENTIAL_STORAGE_UNAVAILABLE' : 'CREDENTIAL_ACCESS_DENIED'));
                    return;
                }
                if (!response || !Array.isArray(response.decrypted) || !Array.isArray(response.encrypted)
                    || response.decrypted.length !== request.decrypt.length
                    || response.encrypted.length !== request.encrypt.length
                    || !response.decrypted.every(value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 16 * 1024)
                    || !response.encrypted.every(value => typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 64 * 1024)) {
                    finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
                    return;
                }
                result = { decrypted: response.decrypted, encrypted: response.encrypted };
            });
            try {
                child.send(request, error => {
                    if (error) finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
                });
            } catch {
                finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
            }
        };
        void launch();
    });
}

/** Wait for observed persistence, not a guessed delay after app.ready. */
export function waitForWindowsStorageKey(localStatePath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let retry: NodeJS.Timeout | undefined;
        const readAbort = new AbortController();
        const finish = (error?: CredentialAccessError): void => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (retry) clearTimeout(retry);
            signal?.removeEventListener('abort', abort);
            readAbort.abort();
            if (error) reject(error);
            else resolve();
        };
        const abort = (): void => finish(new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED'));
        const deadline = setTimeout(() => finish(new CredentialAccessError('CREDENTIAL_ACCESS_TIMEOUT')), Math.max(0, timeoutMs));
        const read = async (): Promise<void> => {
            try {
                const contents = await fs.promises.readFile(localStatePath, { encoding: 'utf8', signal: readAbort.signal });
                if (settled) return;
                const state = JSON.parse(contents) as { os_crypt?: { encrypted_key?: unknown } };
                const key = state?.os_crypt?.encrypted_key;
                if (typeof key === 'string' && key.length <= 64 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
                    const wrapped = Buffer.from(key, 'base64');
                    if (wrapped.length > 5 && wrapped.subarray(0, 5).toString('ascii') === 'DPAPI') {
                        finish();
                        return;
                    }
                }
            } catch { /* Missing/in-flight state can become durable before the deadline. */ }
            if (!settled) retry = setTimeout(() => void read(), 100);
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else void read();
    });
}

function spawnHelper(session = false): ChildProcess {
    const entry = process.env.XORA_CREDENTIAL_HELPER_ENTRY
        ?? path.join(app.getAppPath(), 'scripts', 'theia-electron-main.js');
    const args = [...(app.isPackaged ? [] : [entry]), '--xora-credential-helper'];
    if (session) args.push('--xora-credential-session');
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        XORA_CREDENTIAL_USER_DATA: app.getPath('userData'),
        XORA_CREDENTIAL_SESSION_DATA: app.getPath('sessionData'),
        XORA_CREDENTIAL_APP_NAME: app.getName()
    };
    // A parent launched by a Node tool can inherit this variable. The helper
    // needs the Electron main process API, never its run-as-Node mode.
    delete environment.ELECTRON_RUN_AS_NODE;
    return spawn(process.execPath, args, {
        // Credential access is independent of a restored/offline workspace.
        cwd: path.dirname(process.execPath),
        env: environment,
        stdio: session ? ['ignore', 'ignore', 'ignore', 'ipc', 'pipe'] : ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true
    });
}
