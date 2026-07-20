// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { FrontendApplication, FrontendApplicationContribution, ViewContainer, WidgetManager } from '@theia/core/lib/browser';
import { DisposableCollection, ILogger } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import {
    EXPLORER_VIEW_CONTAINER_ID,
    EXPLORER_VIEW_CONTAINER_TITLE_OPTIONS
} from '@theia/navigator/lib/browser/navigator-widget-factory';
import { WorkspaceService } from '@theia/workspace/lib/browser';

/**
 * Keeps the project tree available when a folder/workspace is open.
 *
 * Theia only calls FileNavigatorContribution.initializeLayout when there is no
 * saved layout.  A workspace whose restored layout has a closed or collapsed
 * Explorer would otherwise start without a file tree.  Xora Code also hides
 * the activity rail, so the user would have to know about View -> Explorer to
 * recover it manually.
 */
@injectable()
export class XoraExplorerContribution implements FrontendApplicationContribution {
    @inject(FileNavigatorContribution)
    protected readonly fileNavigator!: FileNavigatorContribution;

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected readonly toDispose = new DisposableCollection();

    onStart(_app: FrontendApplication): void {
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(roots => {
            if (roots.length === 0) {
                return;
            }
            // Workspace changes can be emitted while the shell is processing a
            // layout update. Queueing avoids competing with that update, while
            // still restoring the Explorer before the user starts working.
            queueMicrotask(() => {
                void this.ensureExplorerVisible()
                    .catch(error => this.logger.warn('无法恢复项目文件树。', error));
            });
        }));
    }

    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        // Do not add workspace/file-system readiness to the startup critical
        // path. If roots are still resolving, onWorkspaceChanged above will
        // perform the same repair as soon as they become available.
        if (this.workspaceService.tryGetRoots().length > 0) {
            await this.ensureExplorerVisible();
        }
    }

    onStop(_app: FrontendApplication): void {
        this.toDispose.dispose();
    }

    protected async ensureExplorerVisible(): Promise<void> {
        // reveal expands a restored collapsed side panel without stealing
        // editor or Agent input focus; openView also re-attaches a missing
        // Explorer container to the left area.
        await this.fileNavigator.openView({ activate: false, reveal: true });

        // ViewContainer restores its serialized title after the factory runs.
        // Re-apply the non-closeable product policy so an old workspace layout
        // cannot overwrite it with Theia's default `closeable: true` value.
        const explorer = this.widgetManager.tryGetWidget<ViewContainer>(EXPLORER_VIEW_CONTAINER_ID);
        explorer?.setTitleOptions({
            ...EXPLORER_VIEW_CONTAINER_TITLE_OPTIONS,
            closeable: false
        });
    }
}
