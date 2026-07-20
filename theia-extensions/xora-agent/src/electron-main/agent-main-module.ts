import { JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { ElectronConnectionHandler } from '@theia/core/lib/electron-main/messaging/electron-connection-handler';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { ContainerModule } from '@theia/core/shared/inversify';
import { AGENT_HOST_PATH, AgentHostClient } from '../common/agent-protocol';
import { AgentHostManager } from './agent-host-manager';

interface ConnectionAwareClient extends AgentHostClient {
    onDidCloseConnection(listener: () => void): { dispose(): void };
}

export default new ContainerModule(bind => {
    bind(AgentHostManager).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(AgentHostManager);
    bind(ElectronConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<AgentHostClient>(AGENT_HOST_PATH, client => {
            const manager = context.container.get(AgentHostManager);
            const service = manager.create(client);
            const connectionClient = client as ConnectionAwareClient;
            connectionClient.onDidCloseConnection(() => {
                void manager.disconnect(service);
            });
            return service;
        })
    ).inSingletonScope();
});
