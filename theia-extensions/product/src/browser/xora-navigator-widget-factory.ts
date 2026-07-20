// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { ViewContainer } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import { FILE_NAVIGATOR_ID } from '@theia/navigator/lib/browser/navigator-widget';
import {
    EXPLORER_VIEW_CONTAINER_ID,
    EXPLORER_VIEW_CONTAINER_TITLE_OPTIONS,
    NavigatorWidgetFactory
} from '@theia/navigator/lib/browser/navigator-widget-factory';

/**
 * Xora Code uses editor tabs for switching open files, so the duplicate
 * "Open Editors" pane only adds visual noise above the project tree.
 */
@injectable()
export class XoraNavigatorWidgetFactory extends NavigatorWidgetFactory {
    override async createWidget(): Promise<ViewContainer> {
        const viewContainer = this.viewContainerFactory({
            id: EXPLORER_VIEW_CONTAINER_ID,
            progressLocationId: 'explorer'
        });
        // The activity rail is intentionally hidden in Xora Code.  Making the
        // Explorer container closeable would therefore leave no visible way to
        // bring the project tree back after an accidental close or a restored
        // layout from another workspace.
        viewContainer.setTitleOptions({
            ...EXPLORER_VIEW_CONTAINER_TITLE_OPTIONS,
            closeable: false
        });

        const navigatorWidget = await this.widgetManager.getOrCreateWidget(FILE_NAVIGATOR_ID);
        viewContainer.addWidget(navigatorWidget, this.fileNavigatorWidgetOptions);
        return viewContainer;
    }
}
