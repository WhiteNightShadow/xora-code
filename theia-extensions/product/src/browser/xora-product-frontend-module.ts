// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FrontendApplicationContribution, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { MenuContribution } from '@theia/core/lib/common';
import { NavigatorWidgetFactory } from '@theia/navigator/lib/browser/navigator-widget-factory';
import { ContainerModule } from '@theia/core/shared/inversify';
import { XoraWelcomeContribution } from './xora-welcome-contribution';
import { XoraWelcomeWidget } from './xora-welcome-widget';
import { XoraAboutDialog } from './xora-about-dialog';
import { XoraShellContribution } from './xora-shell-contribution';
import { XoraNavigatorWidgetFactory } from './xora-navigator-widget-factory';
import { XoraExplorerContribution } from './xora-explorer-contribution';
import { XoraMenuI18nContribution } from './xora-menu-i18n-contribution';
import '../../src/browser/style/xora-code.css';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    rebind(AboutDialog).to(XoraAboutDialog).inSingletonScope();
    rebind(NavigatorWidgetFactory).to(XoraNavigatorWidgetFactory).inSingletonScope();
    bind(XoraWelcomeWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: XoraWelcomeWidget.ID,
        createWidget: () => context.container.get(XoraWelcomeWidget)
    })).inSingletonScope();

    bindViewContribution(bind, XoraWelcomeContribution);
    bind(FrontendApplicationContribution).toService(XoraWelcomeContribution);
    bind(XoraShellContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(XoraShellContribution);
    bind(XoraExplorerContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(XoraExplorerContribution);
    bind(XoraMenuI18nContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(XoraMenuI18nContribution);
    bind(FrontendApplicationContribution).toService(XoraMenuI18nContribution);
});
