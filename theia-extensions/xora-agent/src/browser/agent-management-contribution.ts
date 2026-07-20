import { AbstractViewContribution } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { OPEN_AGENT_SETTINGS_COMMAND } from './agent-entry-commands';
import { AgentManagementWidget } from './agent-management-widget';

@injectable()
export class AgentManagementContribution extends AbstractViewContribution<AgentManagementWidget> {
    constructor() {
        super({
            widgetId: AgentManagementWidget.ID,
            widgetName: 'Agent 设置',
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: 'xora-code.agent.management.toggle'
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(OPEN_AGENT_SETTINGS_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
}
