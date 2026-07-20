// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FrontendApplication, FrontendApplicationContribution, ViewContainer, WidgetManager } from '@theia/core/lib/browser';
import { isOSX, isWindows } from '@theia/core/lib/common/os';
import { EXPLORER_VIEW_CONTAINER_ID } from '@theia/navigator/lib/browser/navigator-widget-factory';
import { OpenEditorsWidget } from '@theia/navigator/lib/browser/open-editors-widget/navigator-open-editors-widget';
import { inject, injectable } from '@theia/core/shared/inversify';

const FRAMELESS_CLASS = 'xora-electron-frameless';
const COMPACT_WORKBENCH_CLASS = 'xora-compact-workbench';
const PLATFORM_CLASSES = ['xora-platform-darwin', 'xora-platform-win32', 'xora-platform-linux'];

@injectable()
export class XoraShellContribution implements FrontendApplicationContribution {
    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    configure(_app: FrontendApplication): void {
        if (typeof window === 'undefined' || !('electronTheiaCore' in window)) {
            return;
        }

        document.body.classList.add(FRAMELESS_CLASS, COMPACT_WORKBENCH_CLASS, this.platformClass());
    }

    onStop(_app: FrontendApplication): void {
        document.body.classList.remove(FRAMELESS_CLASS, COMPACT_WORKBENCH_CLASS, ...PLATFORM_CLASSES);
    }

    onDidInitializeLayout(_app: FrontendApplication): void {
        // Older saved layouts can still contain this pane even though the Xora
        // navigator factory no longer creates it. Remove that restored part so
        // the project tree receives the full Explorer height immediately.
        const explorer = this.widgetManager.tryGetWidget<ViewContainer>(EXPLORER_VIEW_CONTAINER_ID);
        const openEditors = this.widgetManager.tryGetWidget<OpenEditorsWidget>(OpenEditorsWidget.ID);
        if (explorer && openEditors) {
            explorer.removeWidget(openEditors);
        }
    }

    protected platformClass(): string {
        if (isOSX) {
            return PLATFORM_CLASSES[0];
        }
        if (isWindows) {
            return PLATFORM_CLASSES[1];
        }
        return PLATFORM_CLASSES[2];
    }
}
