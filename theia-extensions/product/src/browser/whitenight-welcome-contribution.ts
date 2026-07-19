// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

import {
    AbstractViewContribution,
    FrontendApplication,
    FrontendApplicationContribution
} from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';
import { injectable } from '@theia/core/shared/inversify';
import { WhiteNightWelcomeWidget } from './whitenight-welcome-widget';

export const WhiteNightWelcomeCommand: Command = {
    id: 'whitenight-code.welcome',
    label: 'WhiteNight Code: Welcome'
};

@injectable()
export class WhiteNightWelcomeContribution extends AbstractViewContribution<WhiteNightWelcomeWidget>
    implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: WhiteNightWelcomeWidget.ID,
            widgetName: WhiteNightWelcomeWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main'
            },
            toggleCommandId: WhiteNightWelcomeCommand.id
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(WhiteNightWelcomeCommand, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: true });
    }
}
