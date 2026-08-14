// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FrontendApplication, FrontendApplicationContribution, ViewContainer, WidgetManager } from '@theia/core/lib/browser';
import { isOSX, isWindows } from '@theia/core/lib/common/os';
import { EXPLORER_VIEW_CONTAINER_ID } from '@theia/navigator/lib/browser/navigator-widget-factory';
import { OpenEditorsWidget } from '@theia/navigator/lib/browser/open-editors-widget/navigator-open-editors-widget';
import { inject, injectable } from '@theia/core/shared/inversify';

const FRAMELESS_CLASS = 'xora-electron-frameless';
const COMPACT_WORKBENCH_CLASS = 'xora-compact-workbench';
const PRODUCT_SHELL_CLASS = 'xora-product-shell';
const HIDDEN_ACTIVITY_RAIL_CLASS = 'xora-activity-rail-hidden';
const PLATFORM_CLASSES = ['xora-platform-darwin', 'xora-platform-win32', 'xora-platform-linux'];

@injectable()
export class XoraShellContribution implements FrontendApplicationContribution {
    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    configure(_app: FrontendApplication): void {
        if (typeof document === 'undefined' || !document.body) {
            return;
        }

        // Compact Xora chrome is a product invariant, not an Electron preload
        // capability. In particular, a delayed/missing bridge must not expose
        // Theia's Activity Bar on Windows while the rest of the app still runs.
        document.body.classList.add(PRODUCT_SHELL_CLASS, COMPACT_WORKBENCH_CLASS);
        if (typeof window !== 'undefined' && 'electronTheiaCore' in window) {
            document.body.classList.add(FRAMELESS_CLASS, this.platformClass());
        }
        this.hideActivityRail();
    }

    onStop(_app: FrontendApplication): void {
        if (typeof document === 'undefined' || !document.body) {
            return;
        }
        document.body.classList.remove(
            FRAMELESS_CLASS,
            COMPACT_WORKBENCH_CLASS,
            PRODUCT_SHELL_CLASS,
            ...PLATFORM_CLASSES
        );
        const activityRail = this.activityRail();
        activityRail?.classList.remove(HIDDEN_ACTIVITY_RAIL_CLASS);
        activityRail?.removeAttribute('aria-hidden');
    }

    onDidInitializeLayout(_app: FrontendApplication): void {
        // A restored layout and late plugin view-container registrations reuse
        // Theia's existing rail. Keep that node mounted for shell bookkeeping,
        // but re-assert the product-only hidden state after restoration.
        document.body?.classList.add(PRODUCT_SHELL_CLASS, COMPACT_WORKBENCH_CLASS);
        this.hideActivityRail();

        // Older saved layouts can still contain this pane even though the Xora
        // navigator factory no longer creates it. Remove that restored part so
        // the project tree receives the full Explorer height immediately.
        const explorer = this.widgetManager.tryGetWidget<ViewContainer>(EXPLORER_VIEW_CONTAINER_ID);
        const openEditors = this.widgetManager.tryGetWidget<OpenEditorsWidget>(OpenEditorsWidget.ID);
        if (explorer && openEditors) {
            explorer.removeWidget(openEditors);
        }
    }

    protected hideActivityRail(): void {
        const activityRail = this.activityRail();
        if (!activityRail) {
            return;
        }
        activityRail.classList.add(HIDDEN_ACTIVITY_RAIL_CLASS);
        activityRail.setAttribute('aria-hidden', 'true');
    }

    protected activityRail(): HTMLElement | undefined {
        if (typeof document === 'undefined') {
            return undefined;
        }
        return document.querySelector<HTMLElement>(
            '#theia-left-content-panel .theia-app-sidebar-container'
        ) ?? undefined;
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
