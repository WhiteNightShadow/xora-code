import path from 'node:path';
import type { BundleManifest, Candidate } from '@xora/updater';
import {
    app,
    BrowserWindow,
    dialog,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    ipcMain,
    MessageChannelMain,
    shell,
    type UtilityProcess,
    utilityProcess,
} from 'electron';
import { APP_ORIGIN, setBundleRoot } from './app-protocol.ts';
import type { ShellEnv } from './env.ts';
import type { BootLog } from './log.ts';

export type LaunchOutcome =
    | { readonly kind: 'good' }
    /** The UI was up and the user closed the window before the stability period ended. */
    | { readonly kind: 'good-then-closed' }
    /** The user closed the window before the UI was ready: this launch neither passes nor fails. */
    | { readonly kind: 'closed' }
    | { readonly kind: 'failed'; readonly reason: string }
    | { readonly kind: 'rollback-requested'; readonly reason: string }
    | { readonly kind: 'safe-mode-requested' };

export interface RuntimeOptions {
    readonly env: ShellEnv;
    readonly log: BootLog;
    readonly dataDir: string;
    readonly shellVersion: string;
    readonly preloadPath: string;
    readonly bundleDir: string;
    readonly manifest: BundleManifest;
    readonly candidate: Candidate;
    /** Called once the bundle is good and keeps crashing anyway. */
    readonly onCrashLoop: (component: 'host' | 'renderer') => void;
    /** Called when the UI asks to restart into safe mode. */
    readonly onSafeModeRequest: () => void;
}

const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_RESTARTS = 3;

/**
 * Runs one app bundle: starts its host as a utility process, opens the window, and settles as good once the
 * UI has talked to the host and stayed up for `goodAfterMs`. Any earlier crash settles as a failure.
 */
export class BundleRuntime {
    readonly #options: RuntimeOptions;
    readonly #cleanups: Array<() => void> = [];
    readonly #timers = new Set<ReturnType<typeof setTimeout>>();
    readonly #hostRestarts: number[] = [];
    readonly #rendererRestarts: number[] = [];
    #resolve: (outcome: LaunchOutcome) => void = () => undefined;
    #host: UtilityProcess | undefined;
    #window: BrowserWindow | undefined;
    #uiReady = false;
    #good = false;
    #settled = false;
    #disposed = false;

    constructor(options: RuntimeOptions) {
        this.#options = options;
    }

    get window(): BrowserWindow | undefined {
        return this.#window;
    }

    start(): Promise<LaunchOutcome> {
        return new Promise((resolve) => {
            this.#resolve = resolve;
            void this.#launch();
        });
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        for (const timer of this.#timers) {
            clearTimeout(timer);
        }
        this.#timers.clear();
        for (const cleanup of this.#cleanups.splice(0)) {
            cleanup();
        }
        this.#host?.kill();
        this.#host = undefined;
        const window = this.#window;
        this.#window = undefined;
        if (window && !window.isDestroyed()) {
            window.destroy();
        }
        setBundleRoot(undefined);
    }

    async #launch(): Promise<void> {
        setBundleRoot(this.#options.bundleDir);
        const started = await this.#startHost();
        if (!started || this.#settled) {
            return;
        }
        this.#createWindow();
        this.#armUiWatchdog();
    }

    #after(ms: number, callback: () => void): void {
        const timer = setTimeout(() => {
            this.#timers.delete(timer);
            callback();
        }, ms);
        this.#timers.add(timer);
    }

    /** Resolves true once the host reported ready, false if it failed first. */
    #startHost(): Promise<boolean> {
        const { manifest, bundleDir, dataDir, log, env } = this.#options;
        return new Promise((resolve) => {
            let ready = false;
            const child = utilityProcess.fork(path.join(bundleDir, ...manifest.entry.host.split('/')), [], {
                serviceName: 'Xora Code Host',
                stdio: 'pipe',
                env: { ...process.env, XORA_BUNDLE_VERSION: manifest.version, XORA_DATA_DIR: dataDir },
            });
            this.#host = child;
            child.stdout?.on('data', (chunk: Buffer) => log.info(`host: ${chunk.toString('utf8').trimEnd()}`));
            child.stderr?.on('data', (chunk: Buffer) => log.warn(`host: ${chunk.toString('utf8').trimEnd()}`));
            const timer = setTimeout(() => {
                if (!ready) {
                    child.kill();
                    this.#hostFailure('host-ready-timeout');
                    resolve(false);
                }
            }, env.hostReadyTimeoutMs);
            child.on('message', (message: unknown) => {
                if (!ready && (message as { type?: unknown } | null)?.type === 'xora:host-ready') {
                    ready = true;
                    clearTimeout(timer);
                    resolve(true);
                }
            });
            child.once('exit', (code) => {
                clearTimeout(timer);
                if (this.#host === child) {
                    this.#host = undefined;
                }
                if (this.#disposed) {
                    resolve(false);
                    return;
                }
                this.#hostFailure(`host-exit:${code}`);
                if (!ready) {
                    resolve(false);
                }
            });
        });
    }

    #hostFailure(reason: string): void {
        if (this.#disposed) {
            return;
        }
        if (!this.#good) {
            this.#settle({ kind: 'failed', reason });
            return;
        }
        this.#options.log.warn(`host stopped after a good boot (${reason}); restarting`);
        if (this.#tooMany(this.#hostRestarts)) {
            this.#options.onCrashLoop('host');
            return;
        }
        void this.#startHost().then((started) => {
            if (started) {
                this.#window?.webContents.send('xora:host-restarted');
            }
        });
    }

    #createWindow(): void {
        const { env, preloadPath, manifest, candidate, shellVersion, dataDir } = this.#options;
        const window = new BrowserWindow({
            width: 1180,
            height: 780,
            minWidth: 720,
            minHeight: 480,
            show: false,
            title: 'Xora Code',
            webPreferences: {
                preload: preloadPath,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                spellcheck: false,
                backgroundThrottling: !env.hideWindows,
            },
        });
        this.#window = window;
        const contents = window.webContents;
        window.once('ready-to-show', () => {
            if (!env.hideWindows) {
                window.show();
            }
        });
        contents.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//.test(url)) {
                void shell.openExternal(url);
            }
            return { action: 'deny' };
        });
        contents.on('will-navigate', (event, url) => {
            if (!url.startsWith(`${APP_ORIGIN}/`)) {
                event.preventDefault();
            }
        });
        contents.on('render-process-gone', (_event, details) => this.#rendererGone(details.reason));
        contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
            if (isMainFrame && !this.#good) {
                this.#settle({ kind: 'failed', reason: `ui-load-failed:${code}:${description}` });
            }
        });
        window.on('closed', () => this.#windowClosed(window));

        const fromThisWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === contents;
        const onRequestPort = (event: IpcMainEvent) => {
            if (fromThisWindow(event)) {
                this.#connectPort();
            }
        };
        const onUiReady = (event: IpcMainEvent) => {
            if (fromThisWindow(event)) {
                this.#uiBecameReady();
            }
        };
        const onSafeMode = (event: IpcMainEvent) => {
            if (fromThisWindow(event)) {
                this.#options.onSafeModeRequest();
            }
        };
        ipcMain.on('xora:request-port', onRequestPort);
        ipcMain.on('xora:ui-ready', onUiReady);
        ipcMain.on('xora:restart-safe-mode', onSafeMode);
        ipcMain.handle('xora:shell-info', (event) => {
            if (!fromThisWindow(event)) {
                throw new Error('forbidden');
            }
            return {
                shellVersion,
                bundleVersion: manifest.version,
                candidate: candidate.id,
                dataDir,
                platform: process.platform,
            };
        });
        this.#cleanups.push(() => {
            ipcMain.removeListener('xora:request-port', onRequestPort);
            ipcMain.removeListener('xora:ui-ready', onUiReady);
            ipcMain.removeListener('xora:restart-safe-mode', onSafeMode);
            ipcMain.removeHandler('xora:shell-info');
        });

        void window.loadURL(`${APP_ORIGIN}/${manifest.entry.ui}`).catch(() => undefined);
    }

    #connectPort(): void {
        const host = this.#host;
        const window = this.#window;
        if (!host || !window) {
            return;
        }
        const { port1, port2 } = new MessageChannelMain();
        host.postMessage({ type: 'xora:connect' }, [port1]);
        window.webContents.postMessage('xora:port', null, [port2]);
    }

    #uiBecameReady(): void {
        if (this.#uiReady || this.#settled) {
            return;
        }
        this.#uiReady = true;
        this.#options.log.info(`${this.#options.candidate.id}: ui ready`);
        this.#after(this.#options.env.goodAfterMs, () => {
            if (!this.#settled) {
                this.#good = true;
                this.#settle({ kind: 'good' });
            }
        });
    }

    #armUiWatchdog(): void {
        this.#after(this.#options.env.uiReadyTimeoutMs, () => void this.#uiTimedOut());
    }

    async #uiTimedOut(): Promise<void> {
        if (this.#uiReady || this.#settled) {
            return;
        }
        const window = this.#window;
        if (this.#options.env.hideWindows || !window) {
            this.#settle({ kind: 'failed', reason: 'ui-ready-timeout' });
            return;
        }
        const seconds = Math.round(this.#options.env.uiReadyTimeoutMs / 1000);
        const { response } = await dialog.showMessageBox(window, {
            type: 'warning',
            title: 'Xora Code',
            message: '界面启动时间过长',
            detail: `应用包${this.#options.manifest.version}在${seconds}秒内没有完成启动。可以继续等待，也可以回滚到上一个能用的版本，或者进入修复模式。`,
            buttons: ['继续等待', '回滚到上一版', '进入修复模式'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
        });
        if (this.#uiReady || this.#settled) {
            return;
        }
        if (response === 1) {
            this.#settle({ kind: 'rollback-requested', reason: 'ui-ready-timeout' });
        } else if (response === 2) {
            this.#settle({ kind: 'safe-mode-requested' });
        } else {
            this.#armUiWatchdog();
        }
    }

    #rendererGone(reason: string): void {
        if (this.#disposed) {
            return;
        }
        if (!this.#good) {
            this.#settle({ kind: 'failed', reason: `renderer-gone:${reason}` });
            return;
        }
        this.#options.log.warn(`renderer gone after a good boot (${reason}); reloading`);
        if (this.#tooMany(this.#rendererRestarts)) {
            this.#options.onCrashLoop('renderer');
            return;
        }
        this.#window?.reload();
    }

    #windowClosed(window: BrowserWindow): void {
        if (this.#disposed || this.#window !== window) {
            return;
        }
        this.#window = undefined;
        if (this.#settled) {
            if (this.#good) {
                app.quit();
            }
            return;
        }
        this.#settle({ kind: this.#uiReady ? 'good-then-closed' : 'closed' });
    }

    #settle(outcome: LaunchOutcome): void {
        if (this.#settled) {
            return;
        }
        this.#settled = true;
        if (outcome.kind !== 'good') {
            this.dispose();
        }
        this.#resolve(outcome);
    }

    #tooMany(history: number[]): boolean {
        const now = Date.now();
        history.push(now);
        while (history.length > 0 && now - (history[0] ?? now) > CRASH_WINDOW_MS) {
            history.shift();
        }
        return history.length > MAX_RESTARTS;
    }
}
