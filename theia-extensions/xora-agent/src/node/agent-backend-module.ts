import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { AGENT_HOST_PATH, AgentHostClient, AgentHostService } from '../common/agent-protocol';
import { FakeAgentHostService } from './fake-agent-host-service';

export default new ContainerModule(bind => {
    bind(FakeAgentHostService).toSelf().inSingletonScope();
    bind(AgentHostService).toService(FakeAgentHostService);
    bind(ConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<AgentHostClient>(AGENT_HOST_PATH, client => {
            const service = context.container.get<AgentHostService>(AgentHostService);
            service.setClient(client);
            client.onDidCloseConnection(() => service.setClient(undefined));
            return service;
        })
    ).inSingletonScope();
});
