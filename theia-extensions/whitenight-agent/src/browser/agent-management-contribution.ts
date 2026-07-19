import { AbstractViewContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import { AgentManagementWidget } from './agent-management-widget';

@injectable()
export class AgentManagementContribution extends AbstractViewContribution<AgentManagementWidget> {
    constructor() {
        super({
            widgetId: AgentManagementWidget.ID,
            widgetName: AgentManagementWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: 'whitenight-code.agent.management.toggle'
        });
    }
}
