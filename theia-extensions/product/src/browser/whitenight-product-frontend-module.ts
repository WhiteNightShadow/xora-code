// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FrontendApplicationContribution, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { ContainerModule } from '@theia/core/shared/inversify';
import { WhiteNightWelcomeContribution } from './whitenight-welcome-contribution';
import { WhiteNightWelcomeWidget } from './whitenight-welcome-widget';
import { WhiteNightAboutDialog } from './whitenight-about-dialog';
import '../../src/browser/style/whitenight-code.css';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    rebind(AboutDialog).to(WhiteNightAboutDialog).inSingletonScope();
    bind(WhiteNightWelcomeWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: WhiteNightWelcomeWidget.ID,
        createWidget: () => context.container.get(WhiteNightWelcomeWidget)
    })).inSingletonScope();

    bindViewContribution(bind, WhiteNightWelcomeContribution);
    bind(FrontendApplicationContribution).toService(WhiteNightWelcomeContribution);
});
