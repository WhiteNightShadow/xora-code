// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceServer } from '@theia/workspace/lib/common/workspace-protocol';
import { DefaultWorkspaceServer } from '@theia/workspace/lib/node/default-workspace-server';
import { ContainerModule } from '@theia/core/shared/inversify';
import { XoraWorkspaceServer } from './xora-workspace-server';

export default new ContainerModule((_bind, _unbind, _isBound, rebind) => {
    rebind(DefaultWorkspaceServer).to(XoraWorkspaceServer).inSingletonScope();
    rebind(WorkspaceServer).toService(DefaultWorkspaceServer);
});
