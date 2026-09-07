import { app } from 'electron';
import { ChildProcess, spawn } from 'child_process';
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
        let child: ChildProcess;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (error?: CredentialAccessError, result?: CredentialHelperResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            app?.removeListener?.('will-quit', shutdown);
            // Killing this isolated process also cancels a synchronous OS
            // keychain prompt; it can never freeze the application event loop.
            try { child?.kill('SIGKILL'); } catch { /* already exited */ }
            if (error) reject(error);
            else resolve(result!);
        };
        const shutdown = (): void => finish(new CredentialAccessError('CREDENTIAL_UNLOCK_REQUIRED'));
        try {
            child = options.spawnHelper ? options.spawnHelper() : spawnHelper();
        } catch {
            finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
            return;
        }
        timer = setTimeout(() => finish(new CredentialAccessError('CREDENTIAL_ACCESS_TIMEOUT')), options.timeoutMs ?? 15_000);
        app?.once?.('will-quit', shutdown);
        child.once('error', () => finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED')));
        child.once('exit', () => finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED')));
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
            finish(undefined, { decrypted: response.decrypted, encrypted: response.encrypted });
        });
        try {
            child.send(request, error => {
                if (error) finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
            });
        } catch {
            finish(new CredentialAccessError('CREDENTIAL_ACCESS_DENIED'));
        }
    });
}

function spawnHelper(): ChildProcess {
    const entry = process.env.XORA_CREDENTIAL_HELPER_ENTRY
        ?? path.join(app.getAppPath(), 'scripts', 'theia-electron-main.js');
    const args = [...(app.isPackaged ? [] : [entry]), '--xora-credential-helper'];
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        XORA_CREDENTIAL_USER_DATA: app.getPath('userData'),
        XORA_CREDENTIAL_APP_NAME: app.getName()
    };
    // A parent launched by a Node tool can inherit this variable. The helper
    // needs the Electron main process API, never its run-as-Node mode.
    delete environment.ELECTRON_RUN_AS_NODE;
    return spawn(process.execPath, args, {
        env: environment,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true
    });
}
