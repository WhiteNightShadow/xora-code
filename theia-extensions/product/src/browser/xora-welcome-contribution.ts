// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

import {
    AbstractViewContribution,
    FrontendApplication,
    FrontendApplicationContribution
} from '@theia/core/lib/browser';
import { Command, CommandRegistry, CommandService } from '@theia/core/lib/common/command';
import { Disposable } from '@theia/core/lib/common/disposable';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { WelcomeCommandIds, shouldShowWelcome } from './xora-welcome-actions';
import { XoraWelcomeWidget } from './xora-welcome-widget';

export const XoraWelcomeCommand: Command = {
    id: 'xora-code.welcome',
    label: 'Xora Code：打开开始页'
};

@injectable()
export class XoraWelcomeContribution extends AbstractViewContribution<XoraWelcomeWidget>
    implements FrontendApplicationContribution {

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(CommandService)
    protected readonly commandService!: CommandService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    protected workspaceListener: Disposable | undefined;

    constructor() {
        super({
            widgetId: XoraWelcomeWidget.ID,
            widgetName: XoraWelcomeWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main'
            },
            toggleCommandId: XoraWelcomeCommand.id
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(XoraWelcomeCommand, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.workspaceService.ready;
        const roots = await this.workspaceService.roots;
        if (shouldShowWelcome(roots.length)) {
            await this.openView({ activate: true, reveal: true });
        }
    }

    onStart(_app: FrontendApplication): void {
        this.workspaceListener = this.workspaceService.onWorkspaceChanged(roots => {
            if (!shouldShowWelcome(roots.length)) {
                void this.leaveWelcomeForWorkspace().catch(error => this.logger.warn('无法完成项目工作台切换。', error));
            }
        });
    }

    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        await this.workspaceService.ready;
        const roots = await this.workspaceService.roots;
        if (!shouldShowWelcome(roots.length)) {
            await this.leaveWelcomeForWorkspace();
        }
    }

    onStop(_app: FrontendApplication): void {
        this.workspaceListener?.dispose();
        this.workspaceListener = undefined;
    }

    protected async leaveWelcomeForWorkspace(): Promise<void> {
        const welcome = this.tryGetWidget();
        if (!welcome) return;
        const shouldFocusExplorer = this.shell.activeWidget === welcome;
        try {
            await this.closeView();
        } catch (error) {
            this.logger.warn('无法关闭开始页。', error);
        }
        if (!shouldFocusExplorer) {
            return;
        }
        await this.focusExplorer();
    }

    protected async focusExplorer(): Promise<void> {
        try {
            await this.commandService.executeCommand(WelcomeCommandIds.focusExplorer);
        } catch {
            await this.shell.activateWidget('files');
        }
    }
}
