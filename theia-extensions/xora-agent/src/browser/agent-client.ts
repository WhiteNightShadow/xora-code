import { Emitter, Event } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AgentHostClient, AgentHostEvent } from '../common/agent-protocol';

@injectable()
export class AgentHostClientImpl implements AgentHostClient {
    protected readonly eventEmitter = new Emitter<AgentHostEvent>();
    readonly onEvent: Event<AgentHostEvent> = this.eventEmitter.event;

    onAgentEvent(event: AgentHostEvent): void {
        this.eventEmitter.fire(event);
    }
}
