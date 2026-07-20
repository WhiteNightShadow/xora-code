// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import type { FrontendApplicationConfig } from '@theia/application-package/lib/application-props';
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application';
import type { TheiaBrowserWindowOptions } from '@theia/core/lib/electron-main/theia-electron-window';
import { injectable } from '@theia/core/shared/inversify';
import { applyXoraWindowChrome, xoraTitleBarStyle } from './xora-window-chrome';

@injectable()
export class XoraElectronMainApplication extends ElectronMainApplication {
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
