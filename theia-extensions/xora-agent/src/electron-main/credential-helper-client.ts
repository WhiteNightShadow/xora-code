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

/** No credentials are placed in arguments, environment variables or log streams. */
export function runCredentialHelper(
    request: CredentialHelperRequest,
    options: { timeoutMs?: number; spawnHelper?: () => ChildProcess } = {}
): Promise<CredentialHelperResult> {
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

function spawnHelper(): ChildProcess {
    const entry = process.env.XORA_CREDENTIAL_HELPER_ENTRY
        ?? path.join(app.getAppPath(), 'scripts', 'theia-electron-main.js');
    const args = [...(app.isPackaged ? [] : [entry]), '--xora-credential-helper'];
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
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true
    });
}
