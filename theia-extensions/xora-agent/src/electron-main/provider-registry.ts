import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { ProviderProfile, ProviderProtocol } from '../common/agent-protocol';
import { normalizeProviderBaseUrl } from './provider-network';
import { SecretVault } from './secret-vault';

const BLOCK_START = '# >>> Xora Code managed providers >>>';
const BLOCK_END = '# <<< Xora Code managed providers <<<';
// Read the pre-Xora identifiers during the rename transition. New profiles and
// generated TOML always use the Xora names, but existing profiles must keep
// their IDs because those IDs are also part of their encrypted secretRef.
const LEGACY_BLOCK_START = '# >>> WhiteNight Code managed providers >>>';
const LEGACY_BLOCK_END = '# <<< WhiteNight Code managed providers <<<';
const PROFILE_ID = /^(?:xora|wnc)-[a-z0-9][a-z0-9-]{0,48}$/;
const XAI_OFFICIAL_BASE_URL = 'https://api.x.ai/v1';
export const XAI_MANAGED_MODEL_ID = 'xora-xai-api';
const XAI_MANAGED_ENVIRONMENT = 'XORA_CODE_XAI_API_KEY';
const AUTHENTICATION_CONSENT_POLICY_VERSION = 1;

interface XaiApiSettings {
    protocol: ProviderProtocol;
    baseUrl: string;
    model: string;
    contextWindow: number;
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
    /** Last known Grok result. Runtime initialization remains authoritative. */
    subscriptionAuthState?: SubscriptionAuthState;
    /** Prevents a legacy confirmation record from being reused after invalidation. */
    subscriptionAuthMigrationComplete?: boolean;
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
    protected readonly grokConfigPath = path.join(os.homedir(), '.grok', 'config.toml');
    // Keep using the legacy shared lock for one compatibility epoch so Xora
    // Code and an older desktop build cannot edit ~/.grok concurrently.
    protected readonly lockPath = path.join(os.homedir(), '.grok', '.whitenight-code.lock');

    constructor(protected readonly vault: SecretVault) {
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
            credentialConfigured: !!this.vault.get(profile.secretRef ?? `provider:${profile.id}`)
        });
    }

    get(id: string): ProviderProfile | undefined {
        return this.list().find(profile => profile.id === id);
    }

    selectedProviderId(): string {
        const file = this.readMetadata();
        const selected = file.selectedProviderId;
        if (typeof selected === 'string' && (selected === 'grok-subscription' || selected === 'xai-api-key'
            || file.providers.some(profile => profile.id === selected))) {
            return selected;
        }
        return 'grok-subscription';
    }

    selectProvider(id: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            const exists = id === 'grok-subscription' || id === 'xai-api-key'
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
        return file.preferredModels?.[providerId] ?? profile.model;
    }

    selectPreferredModel(providerId: string, modelId: string): void {
        const model = this.validateModelId(modelId);
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const file = this.readMetadata();
            if (!this.profileFromFile(file, providerId)) {
                throw new Error('所选模型服务已不存在。');
            }
            file.preferredModels = file.preferredModels ?? {};
            if (file.preferredModels[providerId] === model) return;
            file.preferredModels[providerId] = model;
            this.writeMetadata(file);
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
        return this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => this.saveUnlocked(input, apiKey));
    }

    protected saveUnlocked(input: ProviderProfile, apiKey?: string): ProviderProfile {
        const credential = apiKey === undefined ? undefined : this.validateCredential(apiKey);
        if (input.id === 'grok-subscription' || input.id === 'xai-api-key') {
            if (input.id !== 'xai-api-key' || input.kind !== 'xai-api-key') {
                throw new Error('Built-in providers cannot be changed.');
            }
            const file = this.readMetadata();
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
            if (credential) {
                this.vault.set('provider:xai-api-key', credential);
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
            }
            this.writeMetadata(file);
            this.rewriteManagedBlock(file);
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
        file.preferredModels = file.preferredModels ?? {};
        file.preferredModels[profile.id] = profile.model!;
        if (credential) {
            this.vault.set(profile.secretRef!, credential);
        } else if (!this.vault.get(profile.secretRef!)) {
            throw new Error('This provider needs an API key.');
        }
        if (credential || !sameProviderConfiguration(previous, profile)) {
            this.clearAuthenticationConsentUnlocked(file, profile.id);
        }
        this.writeMetadata(file);
        this.rewriteManagedBlock(file);
        return { ...profile, credentialConfigured: !!this.vault.get(profile.secretRef!) };
    }

    clearCredential(id: string): void {
        this.withFileLock(this.metadataLockPath, 'Another Xora Code process is updating Providers. Please retry.', () => {
            const profile = this.get(id);
            if (!profile) {
                throw new Error('The selected Provider no longer exists.');
            }
            if (profile.kind === 'grok-subscription') {
                throw new Error('Grok subscription credentials are managed by Grok Build. Use subscription logout instead.');
            }
            // The reference is derived from Electron-main-owned metadata. A
            // renderer can select a Provider ID but can never nominate an
            // arbitrary vault entry for deletion.
            this.vault.delete(profile.secretRef ?? `provider:${profile.id}`);
            const file = this.readMetadata();
            if (this.clearAuthenticationConsentUnlocked(file, id)) {
                this.writeMetadata(file);
            }
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
        const profile = this.get(profileId);
        if (!profile) {
            throw new Error(`Unknown provider profile: ${profileId}`);
        }
        if (profile.kind === 'grok-subscription') {
            return {};
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
            return profile.model
                ? { [XAI_MANAGED_ENVIRONMENT]: key }
                : { XAI_API_KEY: key };
        }
        const environmentName = this.environmentName(profile.id);
        // A copied pre-Xora TOML block can still reference the legacy
        // environment variable until the next managed configuration write.
        return {
            [environmentName]: key,
            [this.legacyEnvironmentName(profile.id)]: key
        };
    }

    credential(profileId: string): string | undefined {
        const profile = this.get(profileId);
        if (!profile || profile.kind === 'grok-subscription') {
            return undefined;
        }
        return this.vault.get(profile.secretRef ?? `provider:${profile.id}`);
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
        if (!input.baseUrl || !input.model) {
            throw new Error('Base URL and model ID are required.');
        }
        const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
        const contextWindow = input.contextWindow ?? 200_000;
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
        const contextWindow = input.contextWindow ?? 200_000;
        if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) {
            throw new Error('上下文窗口必须是至少 1024 的整数。');
        }
        return {
            protocol,
            baseUrl,
            model: this.validateModelId(model),
            contextWindow
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
                contextWindow: file.xaiApi.contextWindow
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
            `context_window = ${profile.contextWindow ?? 200_000}`
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
            const profiles: ProviderProfile[] = [
                ...file.providers,
                ...(file.xaiApi ? [this.xaiProfile(file)] : [])
            ];
            const block = [
                BLOCK_START,
                ...profiles.sort((a, b) => a.id.localeCompare(b.id)).map(profile => this.managedToml(profile)),
                BLOCK_END
            ].join('\n\n');
            const currentStart = before.indexOf(BLOCK_START);
            const currentEnd = before.indexOf(BLOCK_END);
            const legacyStart = before.indexOf(LEGACY_BLOCK_START);
            const legacyEnd = before.indexOf(LEGACY_BLOCK_END);
            if ((currentStart >= 0) !== (currentEnd >= 0) || (legacyStart >= 0) !== (legacyEnd >= 0)) {
                throw new Error('Grok config contains an incomplete managed provider block. Xora Code left it unchanged.');
            }
            if (currentStart >= 0 && legacyStart >= 0) {
                throw new Error('Grok config contains both current and legacy managed provider blocks. Xora Code left it unchanged.');
            }
            const start = currentStart >= 0 ? currentStart : legacyStart;
            const end = currentStart >= 0 ? currentEnd : legacyEnd;
            const endMarker = currentStart >= 0 ? BLOCK_END : LEGACY_BLOCK_END;
            let after: string;
            if (start >= 0 && end >= start) {
                after = `${before.slice(0, start)}${block}${before.slice(end + endMarker.length)}`;
            } else {
                const separator = before.length > 0 && !before.endsWith('\n') ? '\n\n' : before.length > 0 ? '\n' : '';
                after = `${before}${separator}${block}\n`;
            }
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
                        || typeof candidate.contextWindow !== 'number') {
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
        && left?.contextWindow === right?.contextWindow;
}

function sameProviderConfiguration(left: ProviderProfile | undefined, right: ProviderProfile): boolean {
    return !!left
        && left.kind === right.kind
        && left.protocol === right.protocol
        && left.baseUrl === right.baseUrl
        && left.model === right.model
        && left.contextWindow === right.contextWindow;
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
