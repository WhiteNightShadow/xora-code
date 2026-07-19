import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { injectable } from '@theia/core/shared/inversify';
import { FSWatcher, mkdirSync, watch } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { AgentHostClient } from '../common/agent-protocol';
import { GrokAgentHostService } from './grok-agent-host-service';
import { ProviderRegistry } from './provider-registry';
import { SecretVault } from './secret-vault';
import { WorkspaceSecurityStore } from './workspace-security';
import { SidecarUpdateCoordinator } from './sidecar-update-coordinator';

@injectable()
export class AgentHostManager implements ElectronMainApplicationContribution {
    protected readonly services = new Set<GrokAgentHostService>();
    protected readonly vault = new SecretVault();
    protected readonly providers = new ProviderRegistry(this.vault);
    protected readonly security = new WorkspaceSecurityStore();
    protected readonly updates = new SidecarUpdateCoordinator();
    protected grokHomeWatcher: FSWatcher | undefined;
    protected grokHomeNotification: NodeJS.Timeout | undefined;

    onStart(_application: ElectronMainApplication): void {
        const grokHome = join(homedir(), '.grok');
        // Grok Build treats ~/.grok as its authoritative shared home. Creating
        // only the directory lets us observe future CLI writes without ever
        // opening authentication, OAuth or session files.
        try {
            mkdirSync(grokHome, { recursive: true, mode: 0o700 });
            this.grokHomeWatcher = watch(grokHome, { persistent: false }, (_event, filename) => {
                const name = filename?.toString();
                if (name && !/(?:^|[/\\])(config\.toml|[^/\\]*(?:auth|oauth|credential)[^/\\]*)$/iu.test(name)) {
                    return;
                }
                if (this.grokHomeNotification) {
                    clearTimeout(this.grokHomeNotification);
                }
                this.grokHomeNotification = setTimeout(() => {
                    this.grokHomeNotification = undefined;
                    for (const service of this.services) {
                        service.notifySharedGrokStateChanged();
                    }
                }, 200);
                this.grokHomeNotification.unref();
            });
        } catch {
            // Read-only homes are diagnosed by the first operation that needs
            // Grok state; observation itself must not prevent app startup.
            this.grokHomeWatcher = undefined;
            return;
        }
        this.grokHomeWatcher.on('error', () => {
            // A deleted/replaced home is reported in the UI on the next Grok
            // operation. The watcher must never crash Electron main.
            this.grokHomeWatcher?.close();
            this.grokHomeWatcher = undefined;
        });
    }

    create(client: AgentHostClient): GrokAgentHostService {
        let service: GrokAgentHostService;
        service = new GrokAgentHostService(
            this.providers,
            this.security,
            () => this.broadcastAuthentication(service),
            this.updates,
            () => ![...this.services].some(candidate => candidate.runtimeActive)
        );
        service.setClient(client);
        this.services.add(service);
        return service;
    }

    async disconnect(service: GrokAgentHostService): Promise<void> {
        if (!this.services.has(service)) return;
        try {
            await service.dispose();
        } finally {
            this.services.delete(service);
        }
    }

    onStop(_application: ElectronMainApplication): void {
        if (this.grokHomeNotification) {
            clearTimeout(this.grokHomeNotification);
            this.grokHomeNotification = undefined;
        }
        this.grokHomeWatcher?.close();
        this.grokHomeWatcher = undefined;
        for (const service of [...this.services]) {
            service.disposeSync();
            this.services.delete(service);
        }
    }

    protected broadcastAuthentication(source: GrokAgentHostService): void {
        for (const service of this.services) {
            if (service !== source) {
                service.notifyAuthenticationChanged();
            }
        }
    }
}
