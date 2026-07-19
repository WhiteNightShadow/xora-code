import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { ContainerModule } from '@theia/core/shared/inversify';
import { AGENT_HOST_PATH, AgentHostService } from '../common/agent-protocol';
import { AgentHostClientImpl } from '../browser/agent-client';

export default new ContainerModule((_bind, _unbind, isBound, rebind) => {
    if (isBound(AgentHostService)) {
        rebind(AgentHostService).toDynamicValue(context => {
            const client = context.container.get(AgentHostClientImpl);
            return ElectronIpcConnectionProvider.createProxy(context.container, AGENT_HOST_PATH, client);
        }).inSingletonScope();
    }
});
