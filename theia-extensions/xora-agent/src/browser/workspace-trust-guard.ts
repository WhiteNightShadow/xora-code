import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandContribution, CommandRegistry, DisposableCollection, MessageService } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service';
import { AgentHostService, RuntimeSnapshot } from '../common/agent-protocol';
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
    protected lastSynchronizationSignature: string | undefined;
    /** Starts ACP standby as soon as workspace attachment is authoritative,
     * before the comparatively heavy Agent widget has finished mounting and
     * loading its own metadata. The key coalesces trust/workspace events. */
    protected agentStandbyKey: string | undefined;

    onStart(_app: FrontendApplication): void {
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(roots => {
            void this.enqueue(() => this.synchronize(roots)).catch(error => this.reportSynchronizationError(error));
        }));
        this.toDispose.push(this.workspaceTrustService.onDidChangeWorkspaceTrust(trusted => {
            void this.enqueue(() => this.synchronizeTrust(trusted)).catch(error => this.reportSynchronizationError(error));
        }));
        // FrontendApplication awaits every contribution's onStart before it
        // mounts the shell. Keep the backend fail-closed and synchronize trust
        // just after startup instead of blocking the first usable frame on
        // workspace discovery plus several renderer/main-process round trips.
        void this.enqueue(async () => this.synchronize(await this.workspaceService.roots))
            .catch(error => this.reportSynchronizationError(error));
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    registerCommands(commands: CommandRegistry): void {
        for (const commandId of EXECUTABLE_COMMANDS) {
            commands.registerHandler(commandId, {
                isEnabled: () => !this.model.snapshot.workspaceTrusted,
                isVisible: () => !this.model.snapshot.workspaceTrusted,
                execute: () => this.messages.warn('请先信任此项目，再运行终端、任务、MCP、Hooks 或可执行插件。')
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
                throw new Error('所选 Agent 主目录不属于当前工作区。');
            }
            await this.agentHost.setWorkspaceRoot(root);
            const trusted = await this.workspaceTrustService.getWorkspaceTrust();
            const snapshot = await this.agentHost.synchronizeWorkspaceTrust({ workspaceRoots: paths, trusted });
            this.lastSynchronizationSignature = this.synchronizationSignature(paths, root, trusted);
            this.requestAgentStandby(snapshot);
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
        const trusted = knownTrust ?? await this.workspaceTrustService.getWorkspaceTrust();
        const effectiveTrust = trusted && paths.length > 0;
        const signature = this.synchronizationSignature(paths, root, effectiveTrust);
        if (signature === this.lastSynchronizationSignature) return;

        await this.agentHost.setWorkspaceRoot(root);
        // Empty windows never acquire executable Agent capabilities even when
        // Theia is configured to trust empty windows.
        const snapshot = await this.agentHost.synchronizeWorkspaceTrust({ workspaceRoots: paths, trusted: effectiveTrust });
        this.lastSynchronizationSignature = signature;
        this.requestAgentStandby(snapshot);
    }

    protected async synchronizeTrust(trusted: boolean): Promise<void> {
        const roots = await this.workspaceService.roots;
        await this.synchronize(roots, trusted);
    }

    protected rootPaths(roots: readonly { resource: { path: { toString(): string } } }[]): string[] {
        return roots.map(candidate => candidate.resource.path.toString());
    }

    protected synchronizationSignature(paths: readonly string[], root: string | undefined, trusted: boolean): string {
        return JSON.stringify({ paths, root, trusted });
    }

    protected enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.synchronizationTail.then(operation);
        this.synchronizationTail = result.then(() => undefined, () => undefined);
        return result;
    }

    protected requestAgentStandby(snapshot: RuntimeSnapshot): void {
        const root = snapshot.workspaceRoot;
        if (!root || !snapshot.workspaceAttached
            || snapshot.phase === 'ready'
            || snapshot.phase === 'auth-required'
            || snapshot.phase === 'starting'
            || snapshot.phase === 'initializing') {
            return;
        }
        const key = `${root}\0${snapshot.providerId}`;
        if (this.agentStandbyKey === key) return;
        this.agentStandbyKey = key;
        void this.prewarmAgent(root, snapshot.providerId, key);
    }

    protected async prewarmAgent(root: string, providerId: string, key: string): Promise<void> {
        try {
            const providers = await this.agentHost.listProviders();
            if (this.agentStandbyKey !== key) return;
            const provider = providers.find(candidate => candidate.id === providerId);
            if (!provider || (provider.kind !== 'grok-subscription' && provider.credentialConfigured !== true)) return;
            await this.agentHost.startRuntime({ workspaceRoot: root, providerId });
        } catch {
            // Standby is best-effort. The host publishes a safe runtime state,
            // and the Agent widget owns the bounded visible recovery path.
        } finally {
            if (this.agentStandbyKey === key) this.agentStandbyKey = undefined;
        }
    }

    protected reportSynchronizationError(error: unknown): void {
        this.messages.error(`无法同步项目信任状态：${error instanceof Error ? error.message : String(error)}`);
    }
}
