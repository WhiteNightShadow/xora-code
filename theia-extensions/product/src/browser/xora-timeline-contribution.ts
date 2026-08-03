// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { TimelineContribution } from '@theia/timeline/lib/browser/timeline-contribution';

/**
 * Xora Code keeps the Explorer focused on the project tree. Timeline providers
 * remain available to extensions, but their optional collapsed pane is not
 * attached to the left-side Explorer container.
 */
@injectable()
export class XoraTimelineContribution extends TimelineContribution implements CommandContribution, TabBarToolbarContribution {
    override registerCommands(_commands: CommandRegistry): void {
        // Deliberately omit Theia's Explorer attachment listener.
    }

    override registerToolbarItems(_registry: TabBarToolbarRegistry): void {
        // No Timeline widget means its refresh action has no product surface.
    }
}
