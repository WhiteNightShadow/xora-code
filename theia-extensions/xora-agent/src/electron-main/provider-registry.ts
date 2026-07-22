import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { ProviderProfile, ProviderProtocol, XAI_MANAGED_MODEL_ID } from '../common/agent-protocol';
import { normalizeProviderBaseUrl } from './provider-network';
import {
    LEGACY_MANAGED_BLOCK_END as LEGACY_BLOCK_END,
    LEGACY_MANAGED_BLOCK_START as LEGACY_BLOCK_START,
    MANAGED_BLOCK_END as BLOCK_END,
    MANAGED_BLOCK_START as BLOCK_START,
    removeMarkedManagedBlocksFromToml,
    removeModelTablesFromToml
} from './provider-toml';
import { SecretVault } from './secret-vault';

// Read the pre-Xora identifiers during the rename transition. New profiles and
// generated TOML always use the Xora names, but existing profiles must keep
// their IDs because those IDs are also part of their encrypted secretRef.
const PROFILE_ID = /^(?:xora|wnc)-[a-z0-9][a-z0-9-]{0,48}$/;
const XAI_OFFICIAL_BASE_URL = 'https://api.x.ai/v1';
export { XAI_MANAGED_MODEL_ID } from '../common/agent-protocol';
const XAI_MANAGED_ENVIRONMENT = 'XORA_CODE_XAI_API_KEY';
const AUTHENTICATION_CONSENT_POLICY_VERSION = 1;
// This value can never be persisted as a valid runtime epoch. Its only purpose
// is to force ready-runtime and session comparisons to fail while a durable
// Provider transaction marker exists.
const PROVIDER_UPDATE_BLOCKED_RUNTIME_EPOCH = 'provider-update-blocked';

interface XaiApiSettings {
    protocol: ProviderProtocol;
    baseUrl: string;
    model: string;
    contextWindow: number;
    backendSearch: boolean;
}

interface AuthenticationConsent {
    fingerprint: string;
    policyVersion: number;
    confirmedAt: string;
}

interface SubscriptionAuthState {
    /** Last credential-free result confirmed by Grok Build, never a token probe. */
    status: 'authenticated' | 'unauthenticated';
    observedAt: string;
}

interface ProviderFile {
    schemaVersion: 1;
    providers: ProviderProfile[];
    /** Global default used by newly opened Xora Code windows. */
    selectedProviderId?: string;
    /** Optional explicit endpoint for the built-in xAI credential slot. */
    xaiApi?: XaiApiSettings;
    /** Safe confirmation state only. Credentials and credential hashes never enter this file. */
    authenticationConsents?: Record<string, AuthenticationConsent>;
    /** User-level defaults shared by every project/window. Model IDs are not credentials. */
    preferredModels?: Record<string, string>;
    /** Non-secret UUID generations used to prevent ACP sessions crossing credentials/endpoints. */
    runtimeEpochs?: Record<string, string>;
    /** Last known Grok result. Runtime initialization remains authoritative. */
    subscriptionAuthState?: SubscriptionAuthState;
    /** Prevents a legacy confirmation record from being reused after invalidation. */
    subscriptionAuthMigrationComplete?: boolean;
}

interface ProviderUpdateMarker {
    schemaVersion: 1;
    providerId: string;
    secretRef: string;
    startedAt: string;
}

interface McpCredentialRecord {
    workspaceRoot: string;
    server: string;
    environmentName: string;
    secretRef: string;
}

interface McpCredentialFile {
    schemaVersion: 1;
    credentials: McpCredentialRecord[];
}

export class ProviderRegistry {
    protected readonly metadataPath = path.join(app.getPath('userData'), 'providers.json');
    protected readonly mcpCredentialPath = path.join(app.getPath('userData'), 'mcp-credentials.json');
    protected readonly metadataLockPath = path.join(app.getPath('userData'), '.providers.lock');
    protected readonly providerUpdatePath = path.join(app.getPath('userData'), '.provider-update.json');
    protected readonly grokConfigPath = path.join(os.homedir(), '.grok', 'config.toml');
    // Keep using the legacy shared lock for one compatibility epoch so Xora
    // Code and an older desktop build cannot edit ~/.grok concurrently.
    protected readonly lockPath = path.join(os.homedir(), '.grok', '.whitenight-code.lock');

    constructor(protected readonly vault: SecretVault) {
        // A process may have stopped between the three atomic Provider writes.
        // Recovery never trusts the possibly mixed credential: it clears the
        // key first, reconciles Grok TOML from metadata, then removes the
        // marker. Any failure leaves the marker in place and API Providers
        // remain fail-closed until the user retries saving their settings.
        if (fs.existsSync(this.providerUpdatePath)) {
            try {
                this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
                    this.recoverInterruptedProviderUpdateUnlocked();
                });
            } catch {
                // list/environment/credential consult the durable marker, so
                // an unavailable lock or failed recovery cannot expose a key.
            }
        }
        // The built-in xAI credential slot was removed from the product UI in
        // v0.1. Keep its metadata and encrypted key for old session/history
        // compatibility, but never leave an invisible service as the active
        // application-wide default after an upgrade.
        try {
            this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
                const file = this.readMetadata();
                if (file.selectedProviderId === 'xai-api-key') {
                    file.selectedProviderId = 'grok-subscription';
                    this.writeMetadata(file);
                }
                // Remove the retired catalog alias from Xora's managed TOML
                // block on upgrade. Keep xaiApi metadata and its encrypted
                // credential untouched so old local history remains readable,
                // but Grok ACP must no longer advertise `xora-xai-api` to new
                // runtimes.
                if (file.xaiApi && !fs.existsSync(this.providerUpdatePath)) {
                    this.rewriteManagedBlock(file);
                }
            });
        } catch {
            // selectedProviderId() also fails closed to Grok subscription, so
            // a temporarily unavailable lock cannot reactivate the hidden
            // legacy service.
        }
    }

    list(): ProviderProfile[] {
        const file = this.readMetadata();
        const profiles: ProviderProfile[] = [
            { id: 'grok-subscription', name: 'Grok 订阅', kind: 'grok-subscription', managed: true },
            this.xaiProfile(file),
            ...file.providers.map(profile => ({ ...profile }))
        ];
        return profiles.map(profile => profile.kind === 'grok-subscription' ? profile : {
            ...profile,
            credentialConfigured: !this.isProviderUpdateBlocked(profile.id)
                && !!this.vault.get(profile.secretRef ?? `provider:${profile.id}`)
        });
    }

    get(id: string): ProviderProfile | undefined {
        return this.list().find(profile => profile.id === id);
    }

    selectedProviderId(): string {
        const file = this.readMetadata();
        const selected = file.selectedProviderId;
        if (typeof selected === 'string' && (selected === 'grok-subscription'
            || file.providers.some(profile => profile.id === selected))) {
            return selected;
        }
        return 'grok-subscription';
    }

    selectProvider(id: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            if (id === 'xai-api-key') {
                throw new Error('旧版 xAI / Grok API 服务已停用，请将其重新添加为自定义模型服务。');
            }
            const exists = id === 'grok-subscription'
                || file.providers.some(profile => profile.id === id);
            if (!exists) {
                throw new Error('所选模型服务已不存在。');
            }
            if (file.selectedProviderId === id) return;
            file.selectedProviderId = id;
            this.writeMetadata(file);
        });
    }

    preferredModelId(providerId: string): string | undefined {
        const file = this.readMetadata();
        const profile = this.profileFromFile(file, providerId);
        if (!profile) return undefined;
        // Custom profiles own a single ACP catalog alias (their id). Legacy
        // preferredModels entries may still store the upstream relay model name.
        if (profile.kind === 'custom' && profile.model) {
            return profile.id;
        }
        return file.preferredModels?.[providerId] ?? profile.model;
    }

    selectPreferredModel(providerId: string, modelId: string): void {
        const model = this.validateModelId(modelId);
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            const profile = this.profileFromFile(file, providerId);
            if (!profile) {
                throw new Error('所选模型服务已不存在。');
            }
            // Never persist an upstream relay id as the custom catalog preference.
            const preferred = profile.kind === 'custom' ? profile.id : model;
            file.preferredModels = file.preferredModels ?? {};
            if (file.preferredModels[providerId] === preferred) return;
            file.preferredModels[providerId] = preferred;
            this.writeMetadata(file);
        });
    }

    runtimeEpoch(providerId: string): string {
        const file = this.readMetadata();
        const profile = this.profileFromFile(file, providerId);
        if (profile?.kind !== 'grok-subscription' && this.isProviderUpdateBlocked(providerId)) {
            return PROVIDER_UPDATE_BLOCKED_RUNTIME_EPOCH;
        }
        return file.runtimeEpochs?.[providerId] ?? 'legacy-v1';
    }

    rotateRuntimeEpoch(providerId: string): string {
        return this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            if (!this.profileFromFile(file, providerId)) {
                throw new Error('The selected Provider no longer exists.');
            }
            const epoch = this.rotateRuntimeEpochUnlocked(file, providerId);
            this.writeMetadata(file);
            return epoch;
        });
    }

    subscriptionAuthStatus(): 'authenticated' | 'unauthenticated' | 'unknown' {
        const file = this.readMetadata();
        if (file.subscriptionAuthState) return file.subscriptionAuthState.status;
        if (file.subscriptionAuthMigrationComplete) return 'unknown';
        // Earlier Xora builds persisted only the credential-free confirmation
        // written after successful authenticate. Import it once as a UI hint;
        // ACP initialize is still the authority and any ~/.grok auth change
        // invalidates the hint without ever inspecting auth.json.
        try {
            return this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
                const current = this.readMetadata();
                if (current.subscriptionAuthState) return current.subscriptionAuthState.status;
                current.subscriptionAuthMigrationComplete = true;
                const status = current.authenticationConsents?.['grok-subscription'] ? 'authenticated' as const : undefined;
                if (status) current.subscriptionAuthState = { status, observedAt: new Date().toISOString() };
                this.writeMetadata(current);
                return status ?? 'unknown';
            });
        } catch {
            return 'unknown';
        }
    }

    rememberSubscriptionAuthStatus(status: 'authenticated' | 'unauthenticated'): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            // ACP initialize commonly confirms the same state on every cold
            // start. Avoid an atomic rewrite + fsync on the critical path when
            // the credential-free UI hint has not changed.
            if (file.subscriptionAuthState?.status === status && file.subscriptionAuthMigrationComplete) return;
            file.subscriptionAuthState = { status, observedAt: new Date().toISOString() };
            file.subscriptionAuthMigrationComplete = true;
            this.writeMetadata(file);
        });
    }

    invalidateSubscriptionAuthStatus(): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            if (!file.subscriptionAuthState) return;
            delete file.subscriptionAuthState;
            this.writeMetadata(file);
        });
    }

    authenticationConfirmationRequired(providerId: string): boolean {
        const file = this.readMetadata();
        const profile = this.profileFromFile(file, providerId);
        if (!profile) return true;
        const consent = file.authenticationConsents?.[providerId];
        return consent?.policyVersion !== AUTHENTICATION_CONSENT_POLICY_VERSION
            || consent.fingerprint !== this.authenticationFingerprint(profile);
    }

    rememberAuthenticationConfirmation(providerId: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            const profile = this.profileFromFile(file, providerId);
            if (!profile) throw new Error('The selected Provider no longer exists.');
            file.authenticationConsents = file.authenticationConsents ?? {};
            file.authenticationConsents[providerId] = {
                fingerprint: this.authenticationFingerprint(profile),
                policyVersion: AUTHENTICATION_CONSENT_POLICY_VERSION,
                confirmedAt: new Date().toISOString()
            };
            this.writeMetadata(file);
        });
    }

    clearAuthenticationConfirmation(providerId: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            if (this.clearAuthenticationConsentUnlocked(file, providerId)) {
                this.writeMetadata(file);
            }
        });
    }

    save(input: ProviderProfile, apiKey?: string): ProviderProfile {
        return this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            this.recoverInterruptedProviderUpdateUnlocked();
            return this.saveUnlocked(input, apiKey);
        });
    }

    protected saveUnlocked(input: ProviderProfile, apiKey?: string): ProviderProfile {
        const credential = apiKey === undefined ? undefined : this.validateCredential(apiKey);
        if (input.id === 'grok-subscription' || input.id === 'xai-api-key') {
            if (input.id !== 'xai-api-key' || input.kind !== 'xai-api-key') {
                throw new Error('Built-in providers cannot be changed.');
            }
            const file = this.readMetadata();
            const previousFile = structuredClone(file);
            const previous = file.xaiApi;
            const settings = this.validateXaiSettings(input);
            const previousBaseUrl = previous?.baseUrl ?? XAI_OFFICIAL_BASE_URL;
            const nextBaseUrl = settings?.baseUrl ?? XAI_OFFICIAL_BASE_URL;
            const currentCredential = this.vault.get('provider:xai-api-key');
            if (nextBaseUrl !== previousBaseUrl && currentCredential && !credential) {
                throw new Error('修改 Base URL 时需要重新输入 API 密钥。');
            }
            if (!credential && !currentCredential) {
                throw new Error('此模型服务需要 API 密钥。');
            }
            if (settings) {
                file.xaiApi = settings;
                file.preferredModels = file.preferredModels ?? {};
                file.preferredModels[input.id] = settings.model;
            } else {
                delete file.xaiApi;
                if (file.preferredModels) delete file.preferredModels[input.id];
            }
            if (credential || !sameXaiSettings(previous, settings)) {
                this.clearAuthenticationConsentUnlocked(file, input.id);
                this.rotateRuntimeEpochUnlocked(file, input.id);
            }
            this.commitProviderUpdate(previousFile, file, input.id, 'provider:xai-api-key', credential);
            return {
                ...this.xaiProfile(file),
                credentialConfigured: !!this.vault.get('provider:xai-api-key')
            };
        }
        if (input.managed || input.kind !== 'custom') {
            throw new Error('Renderer input cannot create or replace a built-in Provider.');
        }
        const profile = this.validate(input);
        const file = this.readMetadata();
        const previousFile = structuredClone(file);
        const existing = file.providers.findIndex(candidate => candidate.id === profile.id);
        const previous = existing >= 0 ? file.providers[existing] : undefined;
        if (previous?.baseUrl !== profile.baseUrl && !credential) {
            throw new Error('Changing a Provider endpoint requires entering its API key again.');
        }
        if (existing >= 0) {
            file.providers.splice(existing, 1, profile);
        } else {
            file.providers.push(profile);
        }
        // Custom providers are exposed to ACP under a local catalog alias
        // (profile.id). Persist that alias, not the upstream relay model name
        // (e.g. grok-4.5), so preferredModels never collides with subscription.
        file.preferredModels = file.preferredModels ?? {};
        file.preferredModels[profile.id] = profile.id;
        if (!credential && !this.vault.get(profile.secretRef!)) {
            throw new Error('This provider needs an API key.');
        }
        if (credential || !sameProviderConfiguration(previous, profile)) {
            this.clearAuthenticationConsentUnlocked(file, profile.id);
            this.rotateRuntimeEpochUnlocked(file, profile.id);
        }
        this.commitProviderUpdate(previousFile, file, profile.id, profile.secretRef!, credential);
        return { ...profile, credentialConfigured: !!this.vault.get(profile.secretRef!) };
    }

    /**
     * Commits the three Provider stores without ever installing a new key
     * while the old endpoint is still authoritative. Grok TOML is written
     * first, metadata second, and the credential last. Any later failure
     * restores the previous state; if rollback itself is incomplete, the
     * durable marker blocks all runtime access to the uncertain credential.
     */
    protected commitProviderUpdate(
        previousFile: ProviderFile,
        nextFile: ProviderFile,
        providerId: string,
        secretRef: string,
        credential?: string
    ): void {
        const previousCredential = this.vault.get(secretRef);
        let markerAttempted = false;
        let managedBlockAttempted = false;
        let metadataAttempted = false;
        let credentialAttempted = false;
        try {
            markerAttempted = true;
            this.writeProviderUpdateMarker({
                schemaVersion: 1,
                providerId,
                secretRef,
                startedAt: new Date().toISOString()
            });
            managedBlockAttempted = true;
            this.rewriteManagedBlock(nextFile);
            metadataAttempted = true;
            this.writeMetadata(nextFile);
            if (credential !== undefined) {
                credentialAttempted = true;
                this.vault.set(secretRef, credential);
            }
            this.clearProviderUpdateMarker();
        } catch (error) {
            const rollbackErrors: unknown[] = [];
            let credentialSafe = true;
            if (credentialAttempted) {
                credentialSafe = false;
                try {
                    if (previousCredential === undefined) this.vault.delete(secretRef);
                    else this.vault.set(secretRef, previousCredential);
                    credentialSafe = true;
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                    try {
                        this.vault.delete(secretRef);
                        credentialSafe = true;
                    } catch (deleteError) {
                        rollbackErrors.push(deleteError);
                    }
                }
            }
            // Never restore an old URL while the credential store may contain
            // the new key. The durable marker keeps every runtime blocked and
            // a later recovery/save can safely clear the uncertain credential.
            if (!credentialSafe) {
                throw new Error('模型服务保存未完成。为避免凭据与地址错配，已阻止该服务启动；请重启应用后重新保存 API 密钥。');
            }
            if (metadataAttempted) {
                try {
                    this.writeMetadata(previousFile);
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (managedBlockAttempted) {
                try {
                    this.rewriteManagedBlock(previousFile);
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (rollbackErrors.length > 0) {
                if (credentialAttempted) {
                    try { this.vault.delete(secretRef); } catch { /* the marker still blocks runtime access */ }
                }
                throw new Error('模型服务保存未完成。为避免凭据与地址错配，已阻止该服务启动；请重启应用后重新保存 API 密钥。');
            }
            if (markerAttempted) {
                try {
                    this.clearProviderUpdateMarker();
                } catch {
                    throw new Error('模型服务保存未完成。安全恢复已经完成，但事务标记无法清除；请重启应用后重试。');
                }
            }
            throw error;
        }
    }

    protected recoverInterruptedProviderUpdateUnlocked(): void {
        const marker = this.readProviderUpdateMarker();
        if (!marker) return;
        // Never attempt to infer which credential rename completed. Removing
        // it is the only crash-safe recovery that cannot cross endpoints.
        this.vault.delete(marker.secretRef);
        const file = this.readMetadata();
        // The transaction may have stopped before or after its first epoch
        // write. Rotate once more after the uncertain credential is gone, and
        // persist that boundary before unblocking any runtime.
        this.clearAuthenticationConsentUnlocked(file, marker.providerId);
        this.rotateRuntimeEpochUnlocked(file, marker.providerId);
        this.writeMetadata(file);
        this.rewriteManagedBlock(file);
        this.clearProviderUpdateMarker();
    }

    protected isProviderUpdateBlocked(providerId: string): boolean {
        try {
            const marker = this.readProviderUpdateMarker();
            return !!marker && marker.providerId === providerId;
        } catch {
            // A corrupt marker cannot identify one safe Provider, so every API
            // Provider fails closed until the marker is repaired or removed.
            return true;
        }
    }

    protected readProviderUpdateMarker(): ProviderUpdateMarker | undefined {
        let parsed: Partial<ProviderUpdateMarker>;
        try {
            parsed = JSON.parse(fs.readFileSync(this.providerUpdatePath, 'utf8')) as Partial<ProviderUpdateMarker>;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw new Error('Unable to read the Provider update transaction marker.');
        }
        const providerId = parsed.providerId;
        const expectedProvider = providerId === 'xai-api-key' || (typeof providerId === 'string' && PROFILE_ID.test(providerId));
        if (parsed.schemaVersion !== 1 || !expectedProvider
            || parsed.secretRef !== `provider:${providerId}`
            || typeof parsed.startedAt !== 'string' || Number.isNaN(Date.parse(parsed.startedAt))) {
            throw new Error('Invalid Provider update transaction marker.');
        }
        return parsed as ProviderUpdateMarker;
    }

    protected writeProviderUpdateMarker(marker: ProviderUpdateMarker): void {
        this.atomicWrite(this.providerUpdatePath, `${JSON.stringify(marker, undefined, 2)}\n`, 0o600);
    }

    protected clearProviderUpdateMarker(): void {
        try {
            fs.unlinkSync(this.providerUpdatePath);
            fsyncDirectory(path.dirname(this.providerUpdatePath));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    clearCredential(id: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            this.recoverInterruptedProviderUpdateUnlocked();
            const file = this.readMetadata();
            const profile = this.profileFromFile(file, id);
            if (!profile) {
                throw new Error('The selected Provider no longer exists.');
            }
            if (profile.kind === 'grok-subscription') {
                throw new Error('Grok subscription credentials are managed by Grok Build. Use subscription logout instead.');
            }
            // The reference is derived from Electron-main-owned metadata. A
            // renderer can select a Provider ID but can never nominate an
            // arbitrary vault entry for deletion.
            const secretRef = profile.secretRef ?? `provider:${profile.id}`;
            this.writeProviderUpdateMarker({
                schemaVersion: 1,
                providerId: profile.id,
                secretRef,
                startedAt: new Date().toISOString()
            });
            // Persist the invalidating epoch before touching the credential.
            // If deletion or marker cleanup fails, runtimeEpoch/environment/
            // credential all continue to fail closed on the durable marker.
            this.clearAuthenticationConsentUnlocked(file, id);
            this.rotateRuntimeEpochUnlocked(file, id);
            this.writeMetadata(file);
            this.vault.delete(secretRef);
            this.clearProviderUpdateMarker();
        });
    }

    delete(id: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => this.deleteUnlocked(id));
    }

    protected deleteUnlocked(id: string): void {
        if (!PROFILE_ID.test(id)) {
            throw new Error('Built-in or external providers cannot be removed here.');
        }
        const file = this.readMetadata();
        const profile = file.providers.find(candidate => candidate.id === id);
        file.providers = file.providers.filter(candidate => candidate.id !== id);
        if (file.selectedProviderId === id) {
            file.selectedProviderId = 'grok-subscription';
        }
        if (file.preferredModels) delete file.preferredModels[id];
        if (file.runtimeEpochs) delete file.runtimeEpochs[id];
        this.clearAuthenticationConsentUnlocked(file, id);
        if (profile?.secretRef) {
            this.vault.delete(profile.secretRef);
        }
        this.writeMetadata(file);
        this.rewriteManagedBlock(file);
    }

    updateSkills(action: 'enable' | 'disable' | 'add' | 'remove', value: string): void {
        const normalized = value.trim();
        if (!normalized || normalized.length > 1024 || /[\r\n\0]/.test(normalized)) {
            throw new Error('Unsafe or empty skill value.');
        }
        const looksLikePath = path.isAbsolute(normalized) || normalized.startsWith('~') || normalized.startsWith('.') || /[\\/]/.test(normalized);
        const key = action === 'add' || (action === 'remove' && looksLikePath)
            ? 'paths'
            : 'disabled';
        this.withLock(() => {
            fs.mkdirSync(path.dirname(this.grokConfigPath), { recursive: true, mode: 0o700 });
            const before = this.readGrokConfig();
            this.assertToml(before);
            const originalHash = crypto.createHash('sha256').update(before).digest('hex');
            const values = this.readTomlStringArray(before, 'skills', key);
            const next = new Set(values);
            if (action === 'disable' || action === 'add') {
                next.add(normalized);
            } else {
                next.delete(normalized);
            }
            const after = this.writeTomlStringArray(before, 'skills', key, [...next].sort());
            this.assertToml(after);
            const current = this.readGrokConfig();
            if (crypto.createHash('sha256').update(current).digest('hex') !== originalHash) {
                throw new Error('Grok configuration changed while it was being updated. Please retry.');
            }
            if (before !== after) {
                this.backupGrokConfig(before);
                this.atomicWrite(this.grokConfigPath, after, 0o600);
            }
        });
    }

    environment(profileId: string): NodeJS.ProcessEnv {
        return this.withProviderEnvironment(profileId, environment => environment);
    }

    /**
     * Keeps the Provider writer lock through a synchronous consumer such as
     * child-process spawn, so another window cannot change Grok TOML between
     * the coherent credential snapshot and launch.
     */
    withProviderEnvironment<T>(
        profileId: string,
        operation: (environment: NodeJS.ProcessEnv, profile: ProviderProfile, runtimeEpoch: string) => T
    ): T {
        return this.withFileLock(
            this.metadataLockPath,
            'Another Xora Code process is updating Providers. Please retry.',
            () => {
                const snapshot = this.providerEnvironmentSnapshotUnlocked(profileId);
                const runtimeEpoch = this.readMetadata().runtimeEpochs?.[profileId] ?? 'legacy-v1';
                return operation(snapshot.environment, snapshot.profile, runtimeEpoch);
            }
        );
    }

    async withProviderEnvironmentAsync<T>(
        profileId: string,
        operation: (environment: NodeJS.ProcessEnv, profile: ProviderProfile, runtimeEpoch: string) => Promise<T>
    ): Promise<T> {
        return this.withFileLockAsync(
            this.metadataLockPath,
            'Another Xora Code process is updating Providers. Please retry.',
            async () => {
                const snapshot = this.providerEnvironmentSnapshotUnlocked(profileId);
                const runtimeEpoch = this.readMetadata().runtimeEpochs?.[profileId] ?? 'legacy-v1';
                return operation(snapshot.environment, snapshot.profile, runtimeEpoch);
            }
        );
    }

    providerCredentialSnapshot(profileId: string): { profile: ProviderProfile; credential: string } {
        return this.withFileLock(
            this.metadataLockPath,
            'Another Xora Code process is updating Providers. Please retry.',
            () => this.providerCredentialSnapshotUnlocked(profileId)
        );
    }

    protected providerEnvironmentSnapshotUnlocked(
        profileId: string
    ): { profile: ProviderProfile; environment: NodeJS.ProcessEnv } {
        const profile = this.get(profileId);
        if (!profile) {
            throw new Error(`Unknown provider profile: ${profileId}`);
        }
        if (profile.kind === 'grok-subscription') {
            return { profile, environment: {} };
        }
        if (this.isProviderUpdateBlocked(profile.id)) {
            throw new Error('此模型服务的配置更新尚未安全完成，已阻止启动。请重启应用后重新保存 API 密钥。');
        }
        const secretRef = profile.secretRef ?? `provider:${profile.id}`;
        const key = this.vault.get(secretRef);
        if (!key) {
            throw new Error(`No credential is available for ${profile.name}.`);
        }
        if (profile.id === 'xai-api-key') {
            // Keep compatibility with the original official xAI key-only
            // flow. An explicitly configured endpoint is isolated behind a
            // model-scoped variable so a relay key is never treated as shared
            // Grok authentication state.
            const environment: NodeJS.ProcessEnv = profile.model
                ? {
                    [XAI_MANAGED_ENVIRONMENT]: key,
                    // Grok 0.2.102 prefers OIDC session JWT over model env_key
                    // when ~/.grok/auth.json is present. Isolate API profiles.
                    GROK_HOME: this.ensureApiProviderGrokHome(profile),
                    XAI_API_KEY: key
                }
                : { XAI_API_KEY: key };
            if (profile.model && profile.backendSearch === true) {
                // Grok resolves the web-search sampler independently from the
                // active ACP model. A process-scoped pin keeps it on this
                // relay profile without changing the user's shared [models]
                // defaults or affecting an external Grok CLI.
                environment.GROK_WEB_SEARCH_MODEL = XAI_MANAGED_MODEL_ID;
            }
            return { profile: { ...profile }, environment };
        }
        const environmentName = this.environmentName(profile.id);
        // A copied pre-Xora TOML block can still reference the legacy
        // environment variable until the next managed configuration write.
        //
        // Critical: Grok Build 0.2.102 with an active OIDC login
        // (auth.json) sends the subscription JWT to custom base_url
        // endpoints and ignores model env_key — which every third-party
        // relay rejects as INVALID_API_KEY. Point the sidecar at an
        // isolated GROK_HOME that has the model table but no auth.json so
        // env_key / XAI_API_KEY are the only credentials available.
        const environment: NodeJS.ProcessEnv = {
            [environmentName]: key,
            [this.legacyEnvironmentName(profile.id)]: key,
            XAI_API_KEY: key,
            GROK_HOME: this.ensureApiProviderGrokHome(profile)
        };
        if (profile.backendSearch === true) {
            environment.GROK_WEB_SEARCH_MODEL = profile.id;
        }
        return { profile: { ...profile }, environment };
    }

    /**
     * Per-API-provider Grok home without OIDC auth.json. Shared ~/.grok is
     * still used for subscription and external CLI; this directory only exists
     * so custom/base-url profiles cannot pick up the browser session JWT.
     */
    protected ensureApiProviderGrokHome(profile: ProviderProfile): string {
        if (profile.kind !== 'custom' && !(profile.kind === 'xai-api-key' && profile.model)) {
            throw new Error('Isolated Grok home is only for API provider profiles.');
        }
        const root = path.join(this.providerGrokHomesRoot(), profile.id);
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        // Never carry OIDC session tokens into the isolated home.
        for (const name of ['auth.json', 'auth.json.lock']) {
            const candidate = path.join(root, name);
            try {
                if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
            } catch { /* best effort */ }
        }
        const config = [
            '# Managed by Xora Code for an isolated API-provider sidecar.',
            '# Do not place auth.json here — OIDC would override env_key.',
            '[ui]',
            'permission_mode = "always-approve"',
            '',
            this.managedToml(profile),
            ''
        ].join('\n');
        this.atomicWrite(path.join(root, 'config.toml'), config, 0o600);

        // Reuse user skills from the real Grok home when present (read-only).
        const sharedSkills = path.join(os.homedir(), '.grok', 'skills');
        const localSkills = path.join(root, 'skills');
        try {
            if (fs.existsSync(sharedSkills) && !fs.existsSync(localSkills)) {
                fs.symlinkSync(sharedSkills, localSkills, 'dir');
            }
        } catch { /* skills are optional for API providers */ }

        if (process.platform !== 'win32') {
            try { fs.chmodSync(root, 0o700); } catch { /* ignore */ }
        }
        return root;
    }

    protected providerGrokHomesRoot(): string {
        try {
            if (typeof app?.getPath === 'function') {
                return path.join(app.getPath('userData'), 'provider-grok-homes');
            }
        } catch {
            /* Electron app may be unavailable in unit tests. */
        }
        return path.join(os.tmpdir(), 'xora-code-provider-grok-homes');
    }

    credential(profileId: string): string | undefined {
        if (profileId === 'grok-subscription') return undefined;
        try {
            return this.providerCredentialSnapshot(profileId).credential;
        } catch {
            return undefined;
        }
    }

    protected providerCredentialSnapshotUnlocked(profileId: string): { profile: ProviderProfile; credential: string } {
        const profile = this.get(profileId);
        if (!profile || profile.kind === 'grok-subscription') {
            throw new Error(`Unknown API provider profile: ${profileId}`);
        }
        if (this.isProviderUpdateBlocked(profile.id)) {
            throw new Error('此模型服务的配置更新尚未安全完成，已阻止读取密钥。');
        }
        const credential = this.vault.get(profile.secretRef ?? `provider:${profile.id}`);
        if (!credential) {
            throw new Error(`No credential is available for ${profile.name}.`);
        }
        return { profile: { ...profile }, credential };
    }

    mcpEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
        const environment: NodeJS.ProcessEnv = {};
        for (const entry of this.readMcpCredentials().credentials) {
            if (entry.workspaceRoot !== workspaceRoot) continue;
            const secret = this.vault.get(entry.secretRef);
            if (secret) environment[entry.environmentName] = secret;
        }
        return environment;
    }

    redactionSecrets(): string[] {
        const references = new Set<string>();
        for (const profile of this.list()) {
            if (profile.secretRef) references.add(profile.secretRef);
        }
        for (const entry of this.readMcpCredentials().credentials) references.add(entry.secretRef);
        return [...references].flatMap(reference => {
            const value = this.vault.get(reference);
            return value ? [value] : [];
        });
    }

    saveMcpCredential(workspaceRoot: string, server: string, environmentName: string, secret: string): string {
        this.assertMcpIdentity(server, environmentName);
        if (!secret || Buffer.byteLength(secret, 'utf8') > 16 * 1024) {
            throw new Error('MCP secret must contain 1-16384 UTF-8 bytes.');
        }
        const secretRef = `mcp:${crypto.createHash('sha256').update(`${workspaceRoot}\0${server}\0${environmentName}`).digest('hex')}`;
        return this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating MCP credentials. Please retry.', () => {
            const file = this.readMcpCredentials();
            file.credentials = file.credentials.filter(entry => !(entry.workspaceRoot === workspaceRoot && entry.server === server));
            file.credentials.push({ workspaceRoot, server, environmentName, secretRef });
            this.vault.set(secretRef, secret);
            this.atomicWrite(this.mcpCredentialPath, `${JSON.stringify(file, undefined, 2)}\n`, 0o600);
            return environmentName;
        });
    }

    deleteMcpCredential(workspaceRoot: string, server: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating MCP credentials. Please retry.', () => {
            const file = this.readMcpCredentials();
            const removed = file.credentials.filter(entry => entry.workspaceRoot === workspaceRoot && entry.server === server);
            if (!removed.length) return;
            file.credentials = file.credentials.filter(entry => !(entry.workspaceRoot === workspaceRoot && entry.server === server));
            for (const entry of removed) this.vault.delete(entry.secretRef);
            this.atomicWrite(this.mcpCredentialPath, `${JSON.stringify(file, undefined, 2)}\n`, 0o600);
        });
    }

    configureMcpBearerReference(workspaceRoot: string, scope: 'user' | 'project', server: string, environmentName: string): void {
        this.assertMcpIdentity(server, environmentName);
        const configPath = scope === 'user' ? this.grokConfigPath : path.join(workspaceRoot, '.grok', 'config.toml');
        // This lock name is intentionally shared with the pre-Xora release.
        const configLock = `${configPath}.whitenight-code.lock`;
        this.withFileLock(configLock, 'Grok MCP configuration is being modified. Please retry.', () => {
            fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
            const before = readTextOrEmpty(configPath);
            this.assertToml(before);
            const after = this.writeTomlString(before, `mcp_servers.${server}`, 'bearer_token_env_var', environmentName);
            this.assertToml(after);
            if (before !== after) {
                if (before) this.backupConfig(configPath);
                this.atomicWrite(configPath, after, 0o600);
            }
        });
    }

    protected profileFromFile(file: ProviderFile, id: string): ProviderProfile | undefined {
        if (id === 'grok-subscription') {
            return { id, name: 'Grok 订阅', kind: 'grok-subscription', managed: true };
        }
        if (id === 'xai-api-key') return this.xaiProfile(file);
        return file.providers.find(profile => profile.id === id);
    }

    protected authenticationFingerprint(profile: ProviderProfile): string {
        return crypto.createHash('sha256').update(JSON.stringify({
            policyVersion: AUTHENTICATION_CONSENT_POLICY_VERSION,
            id: profile.id,
            kind: profile.kind,
            protocol: profile.protocol ?? '',
            baseUrl: profile.baseUrl ?? ''
        })).digest('hex');
    }

    protected clearAuthenticationConsentUnlocked(file: ProviderFile, id: string): boolean {
        if (!file.authenticationConsents?.[id]) return false;
        delete file.authenticationConsents[id];
        if (Object.keys(file.authenticationConsents).length === 0) {
            delete file.authenticationConsents;
        }
        return true;
    }

    protected validate(input: ProviderProfile): ProviderProfile {
        const name = input.name?.trim();
        if (!name || name.length > 80) {
            throw new Error('Provider name must contain 1-80 characters.');
        }
        if (input.managed || input.kind !== 'custom') {
            throw new Error('Custom Provider profiles must use kind "custom".');
        }
        if (!PROFILE_ID.test(input.id)) {
            throw new Error('Custom provider IDs must use the xora- prefix and lowercase letters, numbers or hyphens.');
        }
        if (input.id === XAI_MANAGED_MODEL_ID) {
            throw new Error('This Provider ID is reserved for the built-in xAI API service.');
        }
        const protocols: ProviderProtocol[] = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'];
        if (!protocols.includes(input.protocol)) {
            throw new Error('Unsupported custom provider protocol.');
        }
        if (input.backendSearch === true && input.protocol !== 'openai-responses') {
            throw new Error('服务端联网搜索仅支持 OpenAI Responses 协议。');
        }
        if (!input.baseUrl || !input.model) {
            throw new Error('Base URL and model ID are required.');
        }
        const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
        const contextWindow = input.contextWindow ?? 1_000_000;
        if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) {
            throw new Error('Context window must be a positive integer of at least 1024.');
        }
        return {
            id: input.id,
            name,
            kind: 'custom',
            protocol: input.protocol,
            baseUrl,
            model: this.validateModelId(input.model),
            contextWindow,
            backendSearch: input.backendSearch === true,
            // Secret references are derived exclusively by Electron main. A
            // renderer must never alias another Provider's vault entry.
            secretRef: `provider:${input.id}`,
            managed: false
        };
    }

    protected validateXaiSettings(input: Extract<ProviderProfile, { kind: 'xai-api-key' }>): XaiApiSettings | undefined {
        const protocols: ProviderProtocol[] = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'];
        const protocol = input.protocol ?? 'openai-responses';
        if (!protocols.includes(protocol)) {
            throw new Error('不支持所选 API 协议。');
        }
        if (input.backendSearch === true && protocol !== 'openai-responses') {
            throw new Error('服务端联网搜索仅支持 OpenAI Responses 协议。');
        }
        const baseUrl = normalizeProviderBaseUrl(input.baseUrl?.trim() || XAI_OFFICIAL_BASE_URL);
        const model = input.model?.trim() ?? '';
        // An old key-only profile deliberately keeps Grok Build's upstream
        // official xAI authentication behaviour. Saving any explicit model
        // switches it to the safer per-model configuration below.
        if (!model) {
            if (baseUrl !== XAI_OFFICIAL_BASE_URL || protocol !== 'openai-responses') {
                throw new Error('自定义 Base URL 或协议时必须填写模型 ID。');
            }
            return undefined;
        }
        const contextWindow = input.contextWindow ?? 1_000_000;
        if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) {
            throw new Error('上下文窗口必须是至少 1024 的整数。');
        }
        return {
            protocol,
            baseUrl,
            model: this.validateModelId(model),
            contextWindow,
            backendSearch: input.backendSearch === true
        };
    }

    protected validateModelId(input: string): string {
        const model = input.trim();
        if (!model || model.length > 256 || /[\r\n\0]/.test(model)) {
            throw new Error('模型 ID 必须包含 1-256 个字符，且不能包含换行。');
        }
        return model;
    }

    protected xaiProfile(file: ProviderFile): Extract<ProviderProfile, { kind: 'xai-api-key' }> {
        return {
            id: 'xai-api-key',
            name: 'xAI / Grok API',
            kind: 'xai-api-key',
            protocol: file.xaiApi?.protocol ?? 'openai-responses',
            baseUrl: file.xaiApi?.baseUrl ?? XAI_OFFICIAL_BASE_URL,
            ...(file.xaiApi ? {
                model: file.xaiApi.model,
                contextWindow: file.xaiApi.contextWindow,
                backendSearch: file.xaiApi.backendSearch
            } : {}),
            secretRef: 'provider:xai-api-key',
            managed: true
        };
    }

    protected validateCredential(input: string): string {
        const credential = input.trim();
        if (!credential || Buffer.byteLength(credential, 'utf8') > 16 * 1024 || /[\r\n\0]/.test(credential)) {
            throw new Error('API credentials must contain 1-16384 UTF-8 bytes without line breaks.');
        }
        return credential;
    }

    protected environmentName(id: string): string {
        return `XORA_CODE_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
    }

    protected legacyEnvironmentName(id: string): string {
        return `WHITENIGHT_CODE_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
    }

    protected managedToml(profile: ProviderProfile): string {
        if (profile.kind !== 'custom' && profile.kind !== 'xai-api-key') {
            throw new Error('Only API providers can be written to the managed model block.');
        }
        const backend = profile.protocol === 'openai-responses'
            ? 'responses'
            : profile.protocol === 'anthropic-messages' ? 'messages' : 'chat_completions';
        const catalogId = profile.kind === 'xai-api-key' ? XAI_MANAGED_MODEL_ID : profile.id;
        const env = profile.kind === 'xai-api-key' ? XAI_MANAGED_ENVIRONMENT : this.environmentName(profile.id);
        const lines = [
            `[model.${JSON.stringify(catalogId)}]`,
            `model = ${JSON.stringify(profile.model)}`,
            `base_url = ${JSON.stringify(profile.baseUrl)}`,
            `name = ${JSON.stringify(profile.name)}`,
            `api_backend = ${JSON.stringify(backend)}`,
            `context_window = ${profile.contextWindow ?? 1_000_000}`,
            `supports_backend_search = ${profile.backendSearch === true}`
        ];
        if (profile.protocol === 'anthropic-messages') {
            lines.push(`extra_headers = { "x-api-key" = "\${${env}}", "anthropic-version" = "2023-06-01" }`);
        } else {
            lines.push(`env_key = ${JSON.stringify(env)}`);
        }
        return lines.join('\n');
    }

    protected rewriteManagedBlock(file: ProviderFile): void {
        this.withLock(() => {
            fs.mkdirSync(path.dirname(this.grokConfigPath), { recursive: true, mode: 0o700 });
            const before = this.readGrokConfig();
            this.assertToml(before);
            const originalHash = crypto.createHash('sha256').update(before).digest('hex');
            this.assertManagedMarkersWellFormed(before);
            // Deduplicate by id so a corrupted providers.json cannot emit two
            // identical [model."…"] tables into config.toml.
            const byId = new Map<string, ProviderProfile>();
            for (const profile of file.providers) {
                byId.set(profile.id, profile);
            }
            const profiles = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
            const catalogIds = profiles.map(profile => (
                profile.kind === 'xai-api-key' ? XAI_MANAGED_MODEL_ID : profile.id
            ));
            // Always include the retired managed xAI slot id so a leftover
            // table cannot collide after Grok rewrites quoted keys to bare ones.
            if (!catalogIds.includes(XAI_MANAGED_MODEL_ID)) {
                catalogIds.push(XAI_MANAGED_MODEL_ID);
            }

            // 1) Drop previous managed marker blocks (current + legacy).
            // 2) Drop any orphan [model.id] / [model."id"] tables for those
            //    catalog ids. Grok sometimes rewrites quoted keys to bare keys
            //    and strips our markers; appending without cleanup then fails
            //    assertToml with "redefine an already defined table".
            let working = removeMarkedManagedBlocksFromToml(before);
            working = removeModelTablesFromToml(working, catalogIds);

            const block = [
                BLOCK_START,
                ...profiles.map(profile => this.managedToml(profile)),
                BLOCK_END
            ].join('\n\n');
            const separator = working.length > 0 && !working.endsWith('\n')
                ? '\n\n'
                : working.length > 0 ? '\n' : '';
            const after = `${working}${separator}${block}\n`;

            const current = this.readGrokConfig();
            const currentHash = crypto.createHash('sha256').update(current).digest('hex');
            if (currentHash !== originalHash) {
                throw new Error('Grok configuration changed while it was being updated. Please retry.');
            }
            if (before === after) {
                return;
            }
            this.assertToml(after);
            if (before) {
                this.backupGrokConfig(before);
            }
            this.atomicWrite(this.grokConfigPath, after, 0o600);
        });
    }

    protected assertManagedMarkersWellFormed(source: string): void {
        const currentStart = source.indexOf(BLOCK_START);
        const currentEnd = source.indexOf(BLOCK_END);
        const legacyStart = source.indexOf(LEGACY_BLOCK_START);
        const legacyEnd = source.indexOf(LEGACY_BLOCK_END);
        if ((currentStart >= 0) !== (currentEnd >= 0) || (legacyStart >= 0) !== (legacyEnd >= 0)) {
            throw new Error('Grok config contains an incomplete managed provider block. Xora Code left it unchanged.');
        }
        if (currentStart >= 0 && legacyStart >= 0) {
            throw new Error('Grok config contains both current and legacy managed provider blocks. Xora Code left it unchanged.');
        }
    }

    protected withLock<T>(operation: () => T): T {
        return this.withFileLock(this.lockPath, 'Another Xora Code window is updating ~/.grok. Please retry.', operation);
    }

    protected withFileLock<T>(lockPath: string, busyMessage: string, operation: () => T): T {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        let descriptor: number;
        try {
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 30_000) {
                    fs.unlinkSync(lockPath);
                    descriptor = fs.openSync(lockPath, 'wx', 0o600);
                } else {
                    throw new Error(busyMessage);
                }
            } else {
                throw error;
            }
        }
        try {
            fs.writeFileSync(descriptor, `${process.pid}\n`);
            fs.fsyncSync(descriptor);
            return operation();
        } finally {
            fs.closeSync(descriptor);
            try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
        }
    }

    protected async withFileLockAsync<T>(
        lockPath: string,
        busyMessage: string,
        operation: () => Promise<T>
    ): Promise<T> {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        let descriptor: number;
        try {
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 30_000) {
                    fs.unlinkSync(lockPath);
                    descriptor = fs.openSync(lockPath, 'wx', 0o600);
                } else {
                    throw new Error(busyMessage);
                }
            } else {
                throw error;
            }
        }
        try {
            fs.writeFileSync(descriptor, `${process.pid}\n`);
            fs.fsyncSync(descriptor);
            const heartbeat = setInterval(() => {
                try {
                    const now = new Date();
                    fs.futimesSync(descriptor, now, now);
                } catch { /* lock cleanup remains authoritative */ }
            }, 5_000);
            heartbeat.unref();
            try {
                return await operation();
            } finally {
                clearInterval(heartbeat);
            }
        } finally {
            fs.closeSync(descriptor);
            try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
        }
    }

    protected readGrokConfig(): string {
        try {
            return fs.readFileSync(this.grokConfigPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return '';
            }
            throw error;
        }
    }

    protected backupGrokConfig(contents: string): void {
        if (!contents) return;
        const backup = `${this.grokConfigPath}.xora-code.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        fs.copyFileSync(this.grokConfigPath, backup);
        fs.chmodSync(backup, 0o600);
    }

    protected readTomlStringArray(source: string, table: string, key: string): string[] {
        const section = this.tomlSection(source, table);
        if (!section) return [];
        const body = source.slice(section.bodyStart, section.end);
        const expression = new RegExp(`^\\s*${key}\\s*=\\s*(\\[[^\\n]*\\])\\s*(?:#.*)?$`, 'm');
        const match = expression.exec(body);
        if (!match) {
            const keyStart = new RegExp(`^\\s*${key}\\s*=`, 'm').exec(body);
            if (keyStart) {
                throw new Error(`Xora Code cannot safely edit a multi-line [${table}].${key} array. Keep it on one line or edit it manually.`);
            }
            return [];
        }
        try {
            const parsed = JSON.parse(match[1]) as unknown;
            if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error();
            return parsed;
        } catch {
            throw new Error(`Xora Code cannot safely edit [${table}].${key}; use a one-line array of double-quoted strings.`);
        }
    }

    protected writeTomlStringArray(source: string, table: string, key: string, values: string[]): string {
        const assignment = `${key} = ${JSON.stringify(values)}`;
        const section = this.tomlSection(source, table);
        if (!section) {
            const separator = source && !source.endsWith('\n') ? '\n\n' : source ? '\n' : '';
            return `${source}${separator}[${table}]\n${assignment}\n`;
        }
        const body = source.slice(section.bodyStart, section.end);
        const expression = new RegExp(`^\\s*${key}\\s*=\\s*\\[[^\\n]*\\]\\s*(?:#.*)?$`, 'm');
        if (expression.test(body)) {
            const replaced = body.replace(expression, assignment);
            return `${source.slice(0, section.bodyStart)}${replaced}${source.slice(section.end)}`;
        }
        const insertion = body.endsWith('\n') || body.length === 0 ? `${assignment}\n` : `\n${assignment}\n`;
        return `${source.slice(0, section.end)}${insertion}${source.slice(section.end)}`;
    }

    protected writeTomlString(source: string, table: string, key: string, value: string): string {
        const assignment = `${key} = ${JSON.stringify(value)}`;
        const section = this.tomlSection(source, table);
        if (!section) throw new Error(`Grok did not create the expected [${table}] MCP table.`);
        const body = source.slice(section.bodyStart, section.end);
        const expression = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
        const replaced = expression.test(body)
            ? body.replace(expression, assignment)
            : `${body}${body.endsWith('\n') || !body ? '' : '\n'}${assignment}\n`;
        return `${source.slice(0, section.bodyStart)}${replaced}${source.slice(section.end)}`;
    }

    protected tomlSection(source: string, table: string): { bodyStart: number; end: number } | undefined {
        const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const header = new RegExp(`^\\s*\\[${escapedTable}\\]\\s*(?:#.*)?$`, 'm').exec(source);
        if (!header || header.index === undefined) return undefined;
        const bodyStart = header.index + header[0].length + (source[header.index + header[0].length] === '\n' ? 1 : 0);
        const rest = source.slice(bodyStart);
        const next = /^\s*\[[^\]]+\]\s*(?:#.*)?$/m.exec(rest);
        return { bodyStart, end: next?.index === undefined ? source.length : bodyStart + next.index };
    }

    protected readMetadata(): ProviderFile {
        try {
            const file = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8')) as ProviderFile;
            if (file.schemaVersion === 1 && Array.isArray(file.providers)) {
                let xaiApi: XaiApiSettings | undefined;
                if (file.xaiApi !== undefined) {
                    const candidate = file.xaiApi as XaiApiSettings;
                    if (!candidate || typeof candidate !== 'object'
                        || typeof candidate.baseUrl !== 'string'
                        || typeof candidate.model !== 'string'
                        || typeof candidate.contextWindow !== 'number'
                        || (candidate.backendSearch !== undefined && typeof candidate.backendSearch !== 'boolean')) {
                        throw new Error('Invalid xAI API settings.');
                    }
                    xaiApi = this.validateXaiSettings({
                        id: 'xai-api-key',
                        name: 'xAI / Grok API',
                        kind: 'xai-api-key',
                        protocol: candidate.protocol,
                        baseUrl: candidate.baseUrl,
                        model: candidate.model,
                        contextWindow: candidate.contextWindow,
                        backendSearch: candidate.backendSearch === true,
                        secretRef: 'provider:xai-api-key',
                        managed: true
                    });
                    if (!xaiApi) throw new Error('Invalid xAI API settings.');
                }
                const authenticationConsents: Record<string, AuthenticationConsent> = {};
                if (file.authenticationConsents && typeof file.authenticationConsents === 'object') {
                    for (const [id, value] of Object.entries(file.authenticationConsents)) {
                        if (value && typeof value === 'object'
                            && value.policyVersion === AUTHENTICATION_CONSENT_POLICY_VERSION
                            && typeof value.fingerprint === 'string'
                            && /^[a-f0-9]{64}$/.test(value.fingerprint)
                            && typeof value.confirmedAt === 'string') {
                            authenticationConsents[id] = { ...value };
                        }
                    }
                }
                const preferredModels: Record<string, string> = {};
                if (file.preferredModels && typeof file.preferredModels === 'object') {
                    for (const [id, value] of Object.entries(file.preferredModels).slice(0, 128)) {
                        if (typeof value === 'string' && value.length <= 256 && !/[\r\n\0]/.test(value)) {
                            preferredModels[id] = this.validateModelId(value);
                        }
                    }
                }
                const runtimeEpochs: Record<string, string> = {};
                if (file.runtimeEpochs && typeof file.runtimeEpochs === 'object') {
                    for (const [id, value] of Object.entries(file.runtimeEpochs).slice(0, 128)) {
                        if ((id === 'grok-subscription' || id === 'xai-api-key' || PROFILE_ID.test(id))
                            && typeof value === 'string'
                            && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
                            runtimeEpochs[id] = value;
                        }
                    }
                }
                let subscriptionAuthState: SubscriptionAuthState | undefined;
                const authState = file.subscriptionAuthState;
                if (authState && (authState.status === 'authenticated' || authState.status === 'unauthenticated')
                    && typeof authState.observedAt === 'string' && !Number.isNaN(Date.parse(authState.observedAt))) {
                    subscriptionAuthState = { ...authState };
                }
                return {
                    schemaVersion: 1,
                    providers: file.providers.map(profile => this.validate(profile)),
                    ...(typeof file.selectedProviderId === 'string' ? { selectedProviderId: file.selectedProviderId } : {}),
                    ...(xaiApi ? { xaiApi } : {}),
                    ...(Object.keys(authenticationConsents).length ? { authenticationConsents } : {}),
                    ...(Object.keys(preferredModels).length ? { preferredModels } : {}),
                    ...(Object.keys(runtimeEpochs).length ? { runtimeEpochs } : {}),
                    ...(subscriptionAuthState ? { subscriptionAuthState } : {}),
                    ...(file.subscriptionAuthMigrationComplete === true ? { subscriptionAuthMigrationComplete: true } : {})
                };
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error('Unable to read provider metadata.');
            }
        }
        return { schemaVersion: 1, providers: [] };
    }

    protected rotateRuntimeEpochUnlocked(file: ProviderFile, providerId: string): string {
        const epoch = crypto.randomUUID();
        file.runtimeEpochs = file.runtimeEpochs ?? {};
        file.runtimeEpochs[providerId] = epoch;
        return epoch;
    }

    protected readMcpCredentials(): McpCredentialFile {
        try {
            const file = JSON.parse(fs.readFileSync(this.mcpCredentialPath, 'utf8')) as McpCredentialFile;
            if (file.schemaVersion !== 1 || !Array.isArray(file.credentials)) throw new Error();
            const credentials = file.credentials.filter(entry =>
                entry && typeof entry.workspaceRoot === 'string' && typeof entry.server === 'string' &&
                typeof entry.environmentName === 'string' && typeof entry.secretRef === 'string');
            return { schemaVersion: 1, credentials };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, credentials: [] };
            throw new Error('Unable to read MCP credential metadata.');
        }
    }

    protected assertMcpIdentity(server: string, environmentName: string): void {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(server)) throw new Error('Unsafe MCP server name.');
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(environmentName)) throw new Error('MCP environment names must use uppercase letters, numbers and underscores.');
    }

    protected writeMetadata(file: ProviderFile): void {
        this.atomicWrite(this.metadataPath, `${JSON.stringify(file, undefined, 2)}\n`, 0o600);
    }

    protected atomicWrite(target: string, contents: string, mode: number): void {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        const descriptor = fs.openSync(temporary, 'wx', mode);
        try {
            fs.writeFileSync(descriptor, contents, 'utf8');
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        try {
            fs.renameSync(temporary, target);
            fs.chmodSync(target, mode);
            fsyncDirectory(path.dirname(target));
        } catch (error) {
            try { fs.unlinkSync(temporary); } catch { /* already moved */ }
            throw error;
        }
    }

    protected assertToml(source: string): void {
        if (!source.trim()) return;
        try {
            parseToml(source);
        } catch (error) {
            throw new Error(`Grok config.toml is invalid; Xora Code left it unchanged: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected backupConfig(configPath: string): void {
        const backup = `${configPath}.xora-code.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        fs.copyFileSync(configPath, backup);
        fs.chmodSync(backup, 0o600);
    }
}

function sameXaiSettings(left: XaiApiSettings | undefined, right: XaiApiSettings | undefined): boolean {
    return left?.protocol === right?.protocol
        && left?.baseUrl === right?.baseUrl
        && left?.model === right?.model
        && left?.contextWindow === right?.contextWindow
        && left?.backendSearch === right?.backendSearch;
}

function sameProviderConfiguration(left: ProviderProfile | undefined, right: ProviderProfile): boolean {
    return !!left
        && left.kind === right.kind
        && left.protocol === right.protocol
        && left.baseUrl === right.baseUrl
        && left.model === right.model
        && left.contextWindow === right.contextWindow
        && left.backendSearch === right.backendSearch;
}

function fsyncDirectory(directory: string): void {
    try {
        const descriptor = fs.openSync(directory, 'r');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    } catch { /* unsupported by some Windows filesystems */ }
}

function readTextOrEmpty(target: string): string {
    try { return fs.readFileSync(target, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
    }
}
