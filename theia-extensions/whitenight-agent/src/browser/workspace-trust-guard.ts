import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandContribution, CommandRegistry, DisposableCollection, MessageService } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service';
import { AgentHostService } from '../common/agent-protocol';
import { AgentViewModel } from './agent-view-model';

const EXECUTABLE_COMMANDS = [
    'terminal:new',
    'terminal:new:profile',
    'terminal:profile:default',
    'terminal:new:active:workspace',
    'terminal:context',
    'terminal:split',
    'workbench.action.terminal.openNativeConsole',
    'task:run',
    'task:run:build',
    'task:run:test',
    'workbench.action.tasks.runTask',
    'task:run:last',
    'task:attach',
    'task:run:text',
    'task:restart-running'
];

/** Adds a highest-priority command handler while the main root is untrusted. */
@injectable()
export class WorkspaceTrustGuard implements FrontendApplicationContribution, CommandContribution {
    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(WorkspaceTrustService)
    protected readonly workspaceTrustService!: WorkspaceTrustService;

    @inject(AgentHostService)
    protected readonly agentHost!: AgentHostService;

    @inject(AgentViewModel)
    protected readonly model!: AgentViewModel;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    protected readonly toDispose = new DisposableCollection();
    protected synchronizationTail: Promise<void> = Promise.resolve();

    async onStart(_app: FrontendApplication): Promise<void> {
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(roots => {
            void this.enqueue(() => this.synchronize(roots)).catch(error => this.reportSynchronizationError(error));
        }));
        this.toDispose.push(this.workspaceTrustService.onDidChangeWorkspaceTrust(trusted => {
            void this.enqueue(() => this.synchronizeTrust(trusted)).catch(error => this.reportSynchronizationError(error));
        }));
        await this.enqueue(async () => this.synchronize(await this.workspaceService.roots));
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    registerCommands(commands: CommandRegistry): void {
        for (const commandId of EXECUTABLE_COMMANDS) {
            commands.registerHandler(commandId, {
                isEnabled: () => !this.model.snapshot.workspaceTrusted,
                isVisible: () => !this.model.snapshot.workspaceTrusted,
                execute: () => this.messages.warn('Trust this project before running terminals, tasks, MCP servers, hooks or executable plugins.')
            });
        }
    }

    /** Uses Theia's native trust prompt; it never grants backend trust itself. */
    async requestWorkspaceTrust(): Promise<boolean> {
        const granted = await this.workspaceTrustService.requestWorkspaceTrust();
        if (granted !== true) return false;
        await this.enqueue(async () => this.synchronize(await this.workspaceService.roots, true));
        return true;
    }

    async selectWorkspaceRoot(root: string): Promise<void> {
        await this.enqueue(async () => {
            const roots = await this.workspaceService.roots;
            const paths = this.rootPaths(roots);
            if (!paths.includes(root)) {
                throw new Error('The selected Agent root is not part of the current Theia workspace.');
            }
            await this.agentHost.setWorkspaceRoot(root);
            const trusted = await this.workspaceTrustService.getWorkspaceTrust();
            await this.agentHost.synchronizeWorkspaceTrust({ workspaceRoots: paths, trusted });
            await this.model.refresh();
        });
    }

    protected async synchronize(
        roots: readonly { resource: { path: { toString(): string } } }[],
        knownTrust?: boolean
    ): Promise<void> {
        const paths = this.rootPaths(roots);
        const root = this.model.snapshot.workspaceRoot && paths.includes(this.model.snapshot.workspaceRoot)
            ? this.model.snapshot.workspaceRoot
            : paths[0];
        await this.agentHost.setWorkspaceRoot(root);
        const trusted = knownTrust ?? await this.workspaceTrustService.getWorkspaceTrust();
        // Empty windows never acquire executable Agent capabilities even when
        // Theia is configured to trust empty windows.
        await this.agentHost.synchronizeWorkspaceTrust({ workspaceRoots: paths, trusted: trusted && paths.length > 0 });
        await this.model.refresh();
    }

    protected async synchronizeTrust(trusted: boolean): Promise<void> {
        const roots = await this.workspaceService.roots;
        const paths = this.rootPaths(roots);
        await this.agentHost.synchronizeWorkspaceTrust({ workspaceRoots: paths, trusted: trusted && paths.length > 0 });
        await this.model.refresh();
    }

    protected rootPaths(roots: readonly { resource: { path: { toString(): string } } }[]): string[] {
        return roots.map(candidate => candidate.resource.path.toString());
    }

    protected enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.synchronizationTail.then(operation);
        this.synchronizationTail = result.then(() => undefined, () => undefined);
        return result;
    }

    protected reportSynchronizationError(error: unknown): void {
        this.messages.error(`Unable to synchronize workspace trust: ${error instanceof Error ? error.message : String(error)}`);
    }
}
