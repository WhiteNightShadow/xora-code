// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import type { FrontendApplicationConfig } from '@theia/application-package/lib/application-props';
import { ElectronMainApplication, ElectronMainCommandOptions } from '@theia/core/lib/electron-main/electron-main-application';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { TheiaBrowserWindowOptions } from '@theia/core/lib/electron-main/theia-electron-window';
import { injectable } from '@theia/core/shared/inversify';
import { applyXoraWindowChrome, xoraTitleBarStyle } from './xora-window-chrome';
import { workspaceDeadline } from '../common/workspace-startup';

@injectable()
export class XoraElectronMainApplication extends ElectronMainApplication {
    protected readonly workspacePathTimeout = 1500;

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
