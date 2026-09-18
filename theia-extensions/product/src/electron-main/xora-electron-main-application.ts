// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import type { FrontendApplicationConfig } from '@theia/application-package/lib/application-props';
import { ElectronMainApplication, ElectronMainCommandOptions } from '@theia/core/lib/electron-main/electron-main-application';
import { app, Event as ElectronEvent } from '@theia/core/electron-shared/electron';
import { fork } from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { TheiaBrowserWindowOptions } from '@theia/core/lib/electron-main/theia-electron-window';
import { injectable } from '@theia/core/shared/inversify';
import { applyXoraWindowChrome, xoraTitleBarStyle } from './xora-window-chrome';
import { workspaceDeadline } from '../common/workspace-startup';
import { OwnedBackendProcess } from './owned-backend-process';

@injectable()
export class XoraElectronMainApplication extends ElectronMainApplication {
    protected readonly workspacePathTimeout = 1500;
    protected ownedBackend: OwnedBackendProcess | undefined;
    protected backendShutdown: Promise<void> | undefined;
    protected backendShutdownComplete = false;
    protected mainContributionsStopped = false;

    protected override async startBackend(): Promise<number> {
        // Preserve Theia's Windows and explicit single-process behavior. The
        // detached Unix backend needs escalation when native IO ignores TERM.
        if (process.platform === 'win32' || process.argv.includes('--no-cluster')) return super.startBackend();
        process.env.THEIA_ELECTRON_VERSION = process.versions.electron;
        const options = await this.getForkOptions();
        const child = fork(this.globals.THEIA_BACKEND_MAIN_PATH, this.processArgv.getProcessArgvWithoutBin(), options);
        const backend = this.ownedBackend = new OwnedBackendProcess(child, options.detached === true);
        app.once('quit', () => {
            // Also retain cleanup for explicit immediate exits outside the
            // normal will-quit path; only our still-live fork can be signalled.
            try { backend.forceKill(); } catch { /* the main process is exiting */ }
        });
        return new Promise<number>((resolve, reject) => {
            // Keep Theia's existing backend IPC address/port handshake.
            child.on('message', (address: { port: number }) => resolve(address.port));
            child.on('error', reject);
            child.on('exit', reject);
        });
    }

    protected override onWillQuit(event: ElectronEvent): void {
        if (!this.ownedBackend) return super.onWillQuit(event);
        if (event.defaultPrevented) return;
        if (this.backendShutdownComplete) return;
        // will-quit is reached only after window close/beforeunload has allowed
        // exit. Do not intercept before-quit or bypass dirty-editor vetoes.
        event.preventDefault();
        if (this.backendShutdown) return;
        const backend = this.ownedBackend;
        // Install the shared sequence before invoking contributions: one can
        // synchronously request quit again or throw during its own cleanup.
        this.backendShutdown = Promise.resolve().then(() => backend.stop()).then(result => {
            if (!result.exited) console.warn('The owned Xora backend did not exit before the shutdown deadline.');
        }).catch(() => {
            console.warn('Unable to confirm the owned Xora backend shutdown.');
        }).finally(() => {
            this.backendShutdownComplete = true;
            // Re-enter Electron's normal quit lifecycle, rather than app.exit
            // which would bypass other quit/close handlers.
            app.quit();
        });
        if (!this.mainContributionsStopped) {
            this.mainContributionsStopped = true;
            // Theia's loop stops at the first thrown onStop. One failing
            // contribution must not skip Agent/runtime cleanup owned by others.
            for (const contribution of this.contributions.getContributions()) {
                try { contribution.onStop?.(this); } catch {
                    console.warn('An Electron main contribution failed during Xora shutdown.');
                }
            }
        }
    }

    protected override async handleMainCommand(options: ElectronMainCommandOptions): Promise<void> {
        if (!options.file) return super.handleMainCommand(options);
        const requested = path.resolve(options.cwd, options.file);
        // UNC paths and mounted volumes may hang in realpath before any window
        // exists. Preserve symlink normalization when available, then let the
        // renderer validate/recover the requested path under its own deadline.
        const resolved = await workspaceDeadline(fs.realpath(requested), this.workspacePathTimeout).catch(() => requested);
        await this.openWindowWithWorkspace(resolved);
    }

    protected override getTitleBarStyle(_config: FrontendApplicationConfig): 'native' | 'custom' {
        return xoraTitleBarStyle(process.platform);
    }

    override async getLastWindowOptions(): Promise<TheiaBrowserWindowOptions> {
        return applyXoraWindowChrome(await super.getLastWindowOptions(), process.platform);
    }

    protected override getDefaultTheiaWindowOptions(): TheiaBrowserWindowOptions {
        return applyXoraWindowChrome(super.getDefaultTheiaWindowOptions(), process.platform);
    }
}
