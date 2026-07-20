// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application';
import { ContainerModule } from '@theia/core/shared/inversify';
import { XoraElectronMainApplication } from './xora-electron-main-application';

export default new ContainerModule((_bind, _unbind, _isBound, rebind) => {
    rebind(ElectronMainApplication).to(XoraElectronMainApplication).inSingletonScope();
});
