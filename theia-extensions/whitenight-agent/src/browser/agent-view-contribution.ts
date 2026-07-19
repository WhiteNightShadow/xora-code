import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { WhiteNightAgentWidget } from './agent-widget';

export const TOGGLE_AGENT_COMMAND: Command = {
    id: 'whitenight-code.agent.toggle',
    label: 'Toggle Agent'
};

@injectable()
export class AgentViewContribution extends AbstractViewContribution<WhiteNightAgentWidget> implements FrontendApplicationContribution {
    constructor() {
        super({
            widgetId: WhiteNightAgentWidget.ID,
            widgetName: WhiteNightAgentWidget.LABEL,
            defaultWidgetOptions: { area: 'right', rank: 1000 },
            toggleCommandId: TOGGLE_AGENT_COMMAND.id
        });
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: true });
    }
}
