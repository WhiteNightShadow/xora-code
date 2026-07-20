// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { TextReplacementContribution } from '@theia/core/lib/browser/preload/text-replacement-contribution';
import { ContainerModule } from '@theia/core/shared/inversify';
import { XoraTextReplacementContribution } from './xora-text-replacement-contribution';

export default new ContainerModule(bind => {
    bind(XoraTextReplacementContribution).toSelf().inSingletonScope();
    bind(TextReplacementContribution).toService(XoraTextReplacementContribution);
});
