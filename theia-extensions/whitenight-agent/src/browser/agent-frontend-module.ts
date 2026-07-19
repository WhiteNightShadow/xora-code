import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { ContainerModule } from '@theia/core/shared/inversify';
import { AGENT_HOST_PATH, AgentHostClient, AgentHostService } from '../common/agent-protocol';
import { AgentHostClientImpl } from './agent-client';
import { AgentManagementContribution } from './agent-management-contribution';
import { AgentManagementWidget } from './agent-management-widget';
import { AgentViewContribution } from './agent-view-contribution';
import { AgentViewModel } from './agent-view-model';
import { WhiteNightAgentWidget } from './agent-widget';
import { WorkspaceTrustGuard } from './workspace-trust-guard';

export default new ContainerModule(bind => {
    bind(AgentHostClientImpl).toSelf().inSingletonScope();
    bind(AgentHostClient).toService(AgentHostClientImpl);
    bind(AgentHostService).toDynamicValue(context => {
        const provider = context.container.get(WebSocketConnectionProvider);
        const client = context.container.get(AgentHostClientImpl);
        return provider.createProxy(AGENT_HOST_PATH, client);
    }).inSingletonScope();

    bind(AgentViewModel).toSelf().inSingletonScope();
    bind(WhiteNightAgentWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: WhiteNightAgentWidget.ID,
        createWidget: () => context.container.get(WhiteNightAgentWidget)
    })).inSingletonScope();

    bind(AgentManagementWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: AgentManagementWidget.ID,
        createWidget: () => context.container.get(AgentManagementWidget)
    })).inSingletonScope();

    bind(AgentViewContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(AgentViewContribution);
    bind(FrontendApplicationContribution).toService(AgentViewContribution);
    bind(AgentManagementContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(AgentManagementContribution);
    bind(WorkspaceTrustGuard).toSelf().inSingletonScope();
    bind(CommandContribution).toService(WorkspaceTrustGuard);
    bind(FrontendApplicationContribution).toService(WorkspaceTrustGuard);
});
