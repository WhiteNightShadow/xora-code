import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { injectable } from '@theia/core/shared/inversify';
import { FSWatcher, mkdirSync, watch } from 'fs';
import { AgentHostClient } from '../common/agent-protocol';
import { GrokAgentHostService, ProviderRuntimeInvalidation } from './grok-agent-host-service';
import { ProviderRegistry } from './provider-registry';
import { SecretVault } from './secret-vault';
import { sharedGrokHome } from './shared-grok-home';
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
    protected grokAuthenticationNotificationPending = false;
    protected grokConfigurationNotificationPending = false;
    protected grokManagedAuthenticationNotificationPending = false;
    /** Sticky for one managed transaction, even after the normal UI debounce flushes. */
    protected grokManagedAuthenticationEventsObserved = false;
    protected readonly grokHomeNotificationDelayMs = 200;
    protected readonly subscriptionAuthenticationDrainQuietMs = 250;
    /** Windows can deliver the final rename notification after the CLI exits. */
    protected readonly managedSubscriptionAuthenticationGraceMs = 2_000;
    protected lastManagedSubscriptionAuthenticationAt = 0;
    protected subscriptionAuthenticationDrainTimer: NodeJS.Timeout | undefined;
    protected subscriptionAuthenticationDrainResolve: (() => void) | undefined;
    protected subscriptionAuthenticationMutationActive = false;
    protected readonly grokHomePath = sharedGrokHome();

    onStart(_application: ElectronMainApplication): void {
        const grokHome = this.grokHomePath;
        // Grok Build treats ~/.grok as its authoritative shared home. Creating
        // only the directory lets us observe future CLI writes without ever
        // opening authentication, OAuth or session files.
        try {
            mkdirSync(grokHome, { recursive: true, mode: 0o700 });
            this.grokHomeWatcher = watch(grokHome, { persistent: false }, (_event, filename) => {
                this.observeGrokHomeChange(filename?.toString());
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
            change => this.broadcastProviderRuntimeInvalidation(service, change),
            () => this.broadcastProviderDefaults(service),
            () => this.broadcastPermissionMode(service),
            status => this.broadcastSubscriptionAuthStatus(service, status),
            appSessionId => this.broadcastSessionDeleted(service, appSessionId),
            operation => this.coordinateSubscriptionAuthentication(service, operation),
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
        if (this.subscriptionAuthenticationDrainTimer) {
            clearTimeout(this.subscriptionAuthenticationDrainTimer);
            this.subscriptionAuthenticationDrainTimer = undefined;
        }
        const resolveDrain = this.subscriptionAuthenticationDrainResolve;
        this.subscriptionAuthenticationDrainResolve = undefined;
        resolveDrain?.();
        this.grokHomeWatcher?.close();
        this.grokHomeWatcher = undefined;
        for (const service of [...this.services]) {
            service.disposeSync();
            this.services.delete(service);
        }
    }

    protected broadcastProviderRuntimeInvalidation(
        source: GrokAgentHostService,
        change: ProviderRuntimeInvalidation
    ): void {
        for (const service of this.services) {
            if (service !== source) {
                try { service.notifyProviderRuntimeInvalidated(change); } catch { /* isolate peer notification failures */ }
            }
        }
    }

    protected async coordinateSubscriptionAuthentication<T>(
        source: GrokAgentHostService,
        operation: () => Promise<T>
    ): Promise<T> {
        if (this.subscriptionAuthenticationMutationActive) {
            throw new Error('另一个窗口正在更新 Grok 订阅登录，请等待其完成。');
        }
        this.subscriptionAuthenticationMutationActive = true;
        this.grokManagedAuthenticationNotificationPending = false;
        this.grokManagedAuthenticationEventsObserved = false;
        try {
            // Rotate before any shared auth mutation. Even a failed login or
            // app crash leaves every previous ACP session durably incompatible.
            this.providers.rotateRuntimeEpoch('grok-subscription');
            for (const service of this.services) {
                if (service !== source) await service.prepareSubscriptionAuthenticationMutation();
            }
            return await operation();
        } finally {
            // fs.watch delivery is asynchronous. Keep the transaction open for
            // one debounce-sized quiet window so writes made by this operation
            // are classified and drained before its RPC can return. Otherwise a
            // late self-notification could rotate the freshly-created epoch and
            // retire a session created immediately after login/logout.
            await this.drainManagedSubscriptionAuthenticationNotifications();
            this.lastManagedSubscriptionAuthenticationAt = Date.now();
            this.subscriptionAuthenticationMutationActive = false;
        }
    }

    /**
     * Observe only filenames supplied by fs.watch. Authentication contents are
     * never opened or read. Events are attributed when they arrive, rather than
     * when their debounce fires, so a managed mutation cannot later masquerade
     * as an external authentication change.
     */
    protected observeGrokHomeChange(name: string | undefined): void {
        // Node does not guarantee a filename for fs.watch events on Windows.
        // Unknown writes cannot be promoted to account changes because Grok
        // also writes caches, logs and sessions under this directory.
        if (!name) return;
        const leaf = name.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
        const authenticationChanged = leaf === 'auth.json';
        const configurationChanged = leaf === 'config.toml';
        // auth.json.lock, auth.json.<pid>.tmp and mcp_credentials.json are not
        // account changes. The final atomic rename still emits `auth.json`.
        if (!authenticationChanged && !configurationChanged) return;
        if (authenticationChanged) {
            const recentlyManaged = Date.now() - this.lastManagedSubscriptionAuthenticationAt
                <= this.managedSubscriptionAuthenticationGraceMs;
            const runtimeOwnedRefresh = [...this.services].some(service => service.subscriptionRuntimeActive);
            if (this.subscriptionAuthenticationMutationActive || recentlyManaged || runtimeOwnedRefresh) {
                this.grokManagedAuthenticationNotificationPending = true;
                if (this.subscriptionAuthenticationMutationActive) {
                    this.grokManagedAuthenticationEventsObserved = true;
                    this.restartSubscriptionAuthenticationDrainQuietPeriod();
                }
            } else {
                this.grokAuthenticationNotificationPending = true;
            }
        }
        if (configurationChanged) this.grokConfigurationNotificationPending = true;
        if (this.grokHomeNotification) clearTimeout(this.grokHomeNotification);
        this.grokHomeNotification = setTimeout(
            () => this.flushGrokHomeNotification(),
            this.grokHomeNotificationDelayMs
        );
        this.grokHomeNotification.unref();
    }

    protected flushGrokHomeNotification(): void {
        this.grokHomeNotification = undefined;
        const authenticationChanged = this.grokAuthenticationNotificationPending;
        const configurationChanged = this.grokConfigurationNotificationPending;
        this.grokAuthenticationNotificationPending = false;
        this.grokConfigurationNotificationPending = false;
        // A managed event was already covered by the coordinator's pre-rotation.
        // Clearing it here is the drain; it must not invalidate auth or sessions.
        this.grokManagedAuthenticationNotificationPending = false;
        if (authenticationChanged) {
            try { this.providers.invalidateSubscriptionAuthStatus(); } catch { /* next ACP initialize remains authoritative */ }
            try { this.providers.rotateRuntimeEpoch('grok-subscription'); } catch { /* read-only retirement remains the fallback */ }
        }
        for (const service of this.services) {
            if (authenticationChanged) {
                service.notifyProviderRuntimeInvalidated({
                    providerId: 'grok-subscription',
                    reason: 'subscription-auth',
                    invalidateSession: true
                });
            }
            if (authenticationChanged || configurationChanged) {
                service.notifySharedGrokStateChanged(authenticationChanged, configurationChanged);
            }
        }
    }

    protected async drainManagedSubscriptionAuthenticationNotifications(): Promise<void> {
        // onStart installs the watcher before any window can authenticate. The
        // guard keeps isolated manager fixtures and shutdown paths instantaneous.
        if (!this.grokHomeWatcher) {
            if (this.grokManagedAuthenticationNotificationPending && this.grokHomeNotification) {
                clearTimeout(this.grokHomeNotification);
                this.flushGrokHomeNotification();
            }
            return;
        }
        await new Promise<void>(resolve => {
            this.subscriptionAuthenticationDrainResolve = resolve;
            this.restartSubscriptionAuthenticationDrainQuietPeriod();
        });
        if (this.grokHomeNotification) {
            clearTimeout(this.grokHomeNotification);
            this.flushGrokHomeNotification();
        }
        this.grokManagedAuthenticationNotificationPending = false;
        if (this.grokManagedAuthenticationEventsObserved) {
            // Fold every auth-file write observed during the managed mutation
            // into one final epoch. This also safely accounts for an external
            // CLI write that happened concurrently and could not be
            // distinguished by filename alone. The RPC has not returned yet,
            // so no new session can be retired by this final rotation.
            this.providers.rotateRuntimeEpoch('grok-subscription');
            this.grokManagedAuthenticationEventsObserved = false;
        }
    }

    protected restartSubscriptionAuthenticationDrainQuietPeriod(): void {
        if (!this.subscriptionAuthenticationDrainResolve) return;
        if (this.subscriptionAuthenticationDrainTimer) {
            clearTimeout(this.subscriptionAuthenticationDrainTimer);
        }
        this.subscriptionAuthenticationDrainTimer = setTimeout(() => {
            this.subscriptionAuthenticationDrainTimer = undefined;
            const resolve = this.subscriptionAuthenticationDrainResolve;
            this.subscriptionAuthenticationDrainResolve = undefined;
            resolve?.();
        }, this.subscriptionAuthenticationDrainQuietMs);
    }

    protected broadcastProviderDefaults(source: GrokAgentHostService): void {
        for (const service of this.services) {
            if (service !== source) service.notifyProviderDefaultsChanged();
        }
    }

    protected broadcastPermissionMode(source: GrokAgentHostService): void {
        for (const service of this.services) {
            if (service !== source) service.notifyPermissionModeChanged();
        }
    }

    protected broadcastSessionDeleted(source: GrokAgentHostService, appSessionId: string): void {
        for (const service of this.services) {
            if (service !== source) {
                try { service.notifySessionDeleted(appSessionId); } catch { /* isolate peer notification failures */ }
            }
        }
    }

    protected broadcastSubscriptionAuthStatus(
        source: GrokAgentHostService,
        status: 'authenticated' | 'unauthenticated'
    ): void {
        for (const service of this.services) {
            if (service !== source) service.notifySubscriptionAuthStatusChanged(status);
        }
    }
}
