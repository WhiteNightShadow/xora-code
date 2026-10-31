import { lstatSync } from 'node:fs';
import path from 'node:path';
import { RpcPeer } from '@xora/protocol/rpc';
import { type ShellMethods, type ShellNotifications, shellMethods, shellNotifications } from '@xora/protocol/shell';
import { electronPortTransport } from '@xora/protocol/transport';
import { isSafeRelativePath, type TrustedKeys } from '@xora/updater';
import {
    app,
    type BrowserWindow,
    dialog,
    MessageChannelMain,
    Notification,
    powerSaveBlocker,
    shell,
    type UtilityProcess,
    utilityProcess,
} from 'electron';
import { stageBundle } from './install.ts';
import type { BootLog } from './log.ts';
import type { DataPaths } from './paths.ts';
import { SecretStore } from './secrets.ts';
import { setLanguageSetting, shellStrings } from './strings.ts';
import type { AppTray } from './tray.ts';

export type ShellPeer = RpcPeer<ShellMethods, ShellNotifications>;

export interface ShellServiceDeps {
    readonly log: BootLog;
    readonly paths: DataPaths;
    readonly shellVersion: string;
    readonly bundleVersion: string;
    readonly bundleDir: string;
    readonly trustedKeys: TrustedKeys;
    readonly window: () => BrowserWindow | undefined;
    /** Relaunch so a staged bundle is tried by the boot loop. */
    readonly relaunch: () => void;
    readonly tray: AppTray;
    readonly plainSecrets: boolean;
}

let sleepBlocker: number | undefined;

/**
 * What only the main process can do for the host (02 §1): keychain secrets, native dialogs, notifications,
 * power management, opening files and links, forking the engine, and staging verified updates. Served over a
 * private MessagePort that the host receives right after it starts.
 */
export function attachShellServices(host: UtilityProcess, deps: ShellServiceDeps): ShellPeer {
    const { port1, port2 } = new MessageChannelMain();
    host.postMessage({ type: 'xora:shell' }, [port1]);
    const peer: ShellPeer = new RpcPeer(electronPortTransport(port2), {
        methods: shellMethods,
        notifications: shellNotifications,
        onProtocolError: (error) => deps.log.warn(`shell channel: ${error.message}`),
    });
    const secrets = new SecretStore(path.join(deps.paths.root, 'secrets'), {
        plain: deps.plainSecrets && !app.isPackaged,
    });
    const ok = { ok: true as const };

    peer.handle('shell.info', () => ({
        shellVersion: deps.shellVersion,
        bundleVersion: deps.bundleVersion,
        bundleDir: deps.bundleDir,
        dataDir: deps.paths.root,
        execPath: process.execPath,
        shellModulesDir: path.join(app.getAppPath(), 'node_modules'),
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
        secureStorage: secrets.secure,
        languages: [app.getLocale(), ...app.getPreferredSystemLanguages()],
    }));
    peer.handle('shell.secret.get', ({ name }) => ({ value: secrets.get(name) }));
    peer.handle('shell.secret.set', ({ name, value }) => {
        secrets.set(name, value);
        return ok;
    });
    peer.handle('shell.secret.delete', ({ name }) => {
        secrets.delete(name);
        return ok;
    });
    peer.handle('shell.dialog.directory', async ({ title }) => {
        const window = deps.window();
        const options = {
            title: title ?? shellStrings().chooseFolder,
            properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
        };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
    });
    peer.handle('shell.notify', ({ title, body, threadId }) => {
        if (Notification.isSupported()) {
            const notification = new Notification({ title, body, silent: false });
            notification.on('click', () => {
                const window = deps.window();
                if (window && !window.isDestroyed()) {
                    if (window.isMinimized()) window.restore();
                    window.show();
                    window.focus();
                }
                if (threadId) {
                    peer.notify('shell.openThread', { threadId });
                }
            });
            notification.show();
        }
        return ok;
    });
    peer.handle('shell.power', ({ preventSleep }) => {
        if (preventSleep && sleepBlocker === undefined) {
            sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
        } else if (!preventSleep && sleepBlocker !== undefined) {
            powerSaveBlocker.stop(sleepBlocker);
            sleepBlocker = undefined;
        }
        return ok;
    });
    peer.handle('shell.language', ({ language }) => {
        setLanguageSetting(language);
        return ok;
    });
    peer.handle('shell.open', async ({ kind, target }) => {
        if (kind === 'external') {
            if (!/^https?:\/\//i.test(target)) {
                throw new Error('only http(s) links can be opened');
            }
            await shell.openExternal(target);
        } else if (kind === 'reveal') {
            shell.showItemInFolder(target);
        } else {
            const error = await shell.openPath(target);
            if (error) {
                throw new Error(error);
            }
        }
        return ok;
    });
    peer.handle('shell.update.stage', async ({ dir }) => {
        const result = await stageBundle({
            source: dir,
            paths: deps.paths,
            trustedKeys: deps.trustedKeys,
            shellVersion: deps.shellVersion,
            log: deps.log,
        });
        return result.ok ? { ok: true, version: result.version } : { ok: false, error: result.error };
    });
    peer.handle('shell.tray.update', ({ running }) => {
        deps.tray.update(running);
        return ok;
    });
    peer.handle('shell.update.restart', () => {
        deps.log.info('restarting to apply a staged update');
        setTimeout(() => deps.relaunch(), 50);
        return ok;
    });

    // The xora engine runs as a utility process so that the Electron binary never has to run as plain Node
    // (10 §6). Its ACP port goes straight to the host: turns do not pass through the main process.
    const engines = new Map<string, UtilityProcess>();
    peer.handle('shell.engine.start', ({ id, entry, env }) => {
        const file = bundleFile(deps.bundleDir, entry);
        if (engines.has(id)) {
            throw new Error(`engine ${id} is already running`);
        }
        const childEnv = { ...env };
        delete childEnv.ELECTRON_RUN_AS_NODE;
        const child = utilityProcess.fork(file, [], { env: childEnv, stdio: 'pipe', serviceName: 'Xora Engine' });
        engines.set(id, child);
        const { port1, port2 } = new MessageChannelMain();
        child.postMessage({ type: 'xora:acp' }, [port1]);
        host.postMessage({ type: 'xora:engine', id }, [port2]);
        for (const output of [child.stdout, child.stderr]) {
            output?.setEncoding('utf8');
            output?.on('data', (text: string) => peer.notify('shell.engine.output', { id, text }));
        }
        return new Promise<{ pid: number }>((resolve, reject) => {
            child.once('spawn', () => resolve({ pid: child.pid ?? -1 }));
            child.once('exit', (code) => {
                engines.delete(id);
                peer.notify('shell.engine.exit', { id, code });
                reject(new Error(`engine exited with code ${code} before it started`));
            });
        });
    });
    peer.handle('shell.engine.stop', ({ id }) => {
        engines.get(id)?.kill();
        return ok;
    });
    // Engines belong to this host: they end when it is replaced and when the app quits.
    peer.onDispose(() => {
        for (const child of engines.values()) {
            child.kill();
        }
        engines.clear();
    });
    return peer;
}

/** A regular file of the verified bundle this shell serves; the host cannot have anything else started. */
function bundleFile(bundleDir: string, entry: string): string {
    const file = path.join(bundleDir, ...entry.split('/'));
    if (!isSafeRelativePath(entry) || !lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`not a file of the app bundle: ${entry}`);
    }
    return file;
}

export function releasePowerBlocker(): void {
    if (sleepBlocker !== undefined) {
        powerSaveBlocker.stop(sleepBlocker);
        sleepBlocker = undefined;
    }
}
