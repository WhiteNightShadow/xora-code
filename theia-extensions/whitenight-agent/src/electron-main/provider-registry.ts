import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { ProviderProfile, ProviderProtocol } from '../common/agent-protocol';
import { normalizeProviderBaseUrl } from './provider-network';
import { SecretVault } from './secret-vault';

const BLOCK_START = '# >>> WhiteNight Code managed providers >>>';
const BLOCK_END = '# <<< WhiteNight Code managed providers <<<';
const PROFILE_ID = /^wnc-[a-z0-9][a-z0-9-]{0,48}$/;

interface ProviderFile {
    schemaVersion: 1;
    providers: ProviderProfile[];
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
    protected readonly lockPath = path.join(os.homedir(), '.grok', '.whitenight-code.lock');

    constructor(protected readonly vault: SecretVault) {
    }

    list(): ProviderProfile[] {
        return [
            { id: 'grok-subscription', name: 'Grok subscription', kind: 'grok-subscription', managed: true },
            { id: 'xai-api-key', name: 'xAI API Key', kind: 'xai-api-key', secretRef: 'provider:xai-api-key', managed: true },
            ...this.readMetadata().providers.map(profile => ({ ...profile }))
        ];
    }

    get(id: string): ProviderProfile | undefined {
        return this.list().find(profile => profile.id === id);
    }

    save(input: ProviderProfile, apiKey?: string): ProviderProfile {
        return this.withFileLock(this.metadataLockPath, 'Another WhiteNight Code process is updating Providers. Please retry.', () => this.saveUnlocked(input, apiKey));
    }

    protected saveUnlocked(input: ProviderProfile, apiKey?: string): ProviderProfile {
        const builtIn = input.id === 'grok-subscription' || input.id === 'xai-api-key'
            ? this.list().find(profile => profile.id === input.id)
            : undefined;
        if (builtIn) {
            if (builtIn.id !== 'xai-api-key') {
                throw new Error('Built-in providers cannot be changed.');
            }
            if (apiKey) {
                this.vault.set('provider:xai-api-key', apiKey);
            }
            return { ...builtIn };
        }
        if (input.managed || input.kind !== 'custom') {
            throw new Error('Renderer input cannot create or replace a built-in Provider.');
        }
        const profile = this.validate(input);
        const file = this.readMetadata();
        const existing = file.providers.findIndex(candidate => candidate.id === profile.id);
        const previous = existing >= 0 ? file.providers[existing] : undefined;
        if (previous?.baseUrl !== profile.baseUrl && !apiKey) {
            throw new Error('Changing a Provider endpoint requires entering its API key again.');
        }
        if (existing >= 0) {
            file.providers.splice(existing, 1, profile);
        } else {
            file.providers.push(profile);
        }
        if (apiKey) {
            this.vault.set(profile.secretRef!, apiKey);
        } else if (!this.vault.get(profile.secretRef!)) {
            throw new Error('This provider needs an API key.');
        }
        this.writeMetadata(file);
        this.rewriteManagedBlock(file.providers);
        return { ...profile };
    }

    delete(id: string): void {
        this.withFileLock(this.metadataLockPath, 'Another WhiteNight Code process is updating Providers. Please retry.', () => this.deleteUnlocked(id));
    }

    protected deleteUnlocked(id: string): void {
        if (!PROFILE_ID.test(id)) {
            throw new Error('Built-in or external providers cannot be removed here.');
        }
        const file = this.readMetadata();
        const profile = file.providers.find(candidate => candidate.id === id);
        file.providers = file.providers.filter(candidate => candidate.id !== id);
        if (profile?.secretRef) {
            this.vault.delete(profile.secretRef);
        }
        this.writeMetadata(file);
        this.rewriteManagedBlock(file.providers);
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
        // Grok Build's built-in xAI authentication flow reads this exact
        // variable. Custom providers instead reference a profile-scoped name
        // from the WhiteNight-managed TOML block.
        const environmentName = profile.id === 'xai-api-key'
            ? 'XAI_API_KEY'
            : this.environmentName(profile.id);
        return { [environmentName]: key };
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
        return this.withFileLock(this.metadataLockPath, 'Another WhiteNight Code process is updating MCP credentials. Please retry.', () => {
            const file = this.readMcpCredentials();
            file.credentials = file.credentials.filter(entry => !(entry.workspaceRoot === workspaceRoot && entry.server === server));
            file.credentials.push({ workspaceRoot, server, environmentName, secretRef });
            this.vault.set(secretRef, secret);
            this.atomicWrite(this.mcpCredentialPath, `${JSON.stringify(file, undefined, 2)}\n`, 0o600);
            return environmentName;
        });
    }

    deleteMcpCredential(workspaceRoot: string, server: string): void {
        this.withFileLock(this.metadataLockPath, 'Another WhiteNight Code process is updating MCP credentials. Please retry.', () => {
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

    protected validate(input: ProviderProfile): ProviderProfile {
        const name = input.name?.trim();
        if (!name || name.length > 80) {
            throw new Error('Provider name must contain 1-80 characters.');
        }
        if (input.managed || input.kind !== 'custom') {
            throw new Error('Custom Provider profiles must use kind "custom".');
        }
        if (!PROFILE_ID.test(input.id)) {
            throw new Error('Custom provider IDs must use the wnc- prefix and lowercase letters, numbers or hyphens.');
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
            model: input.model.trim(),
            contextWindow,
            // Secret references are derived exclusively by Electron main. A
            // renderer must never alias another Provider's vault entry.
            secretRef: `provider:${input.id}`,
            managed: false
        };
    }

    protected environmentName(id: string): string {
        return `WHITENIGHT_CODE_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
    }

    protected managedToml(profile: ProviderProfile): string {
        if (profile.kind !== 'custom') {
            throw new Error('Only custom providers can be written to the managed model block.');
        }
        const backend = profile.protocol === 'openai-responses'
            ? 'responses'
            : profile.protocol === 'anthropic-messages' ? 'messages' : 'chat_completions';
        const env = this.environmentName(profile.id);
        const lines = [
            `[model.${JSON.stringify(profile.id)}]`,
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

    protected rewriteManagedBlock(profiles: ProviderProfile[]): void {
        this.withLock(() => {
            fs.mkdirSync(path.dirname(this.grokConfigPath), { recursive: true, mode: 0o700 });
            const before = this.readGrokConfig();
            this.assertToml(before);
            const originalHash = crypto.createHash('sha256').update(before).digest('hex');
            const block = [BLOCK_START, ...profiles.sort((a, b) => a.id.localeCompare(b.id)).map(profile => this.managedToml(profile)), BLOCK_END].join('\n\n');
            const start = before.indexOf(BLOCK_START);
            const end = before.indexOf(BLOCK_END);
            let after: string;
            if (start >= 0 && end >= start) {
                after = `${before.slice(0, start)}${block}${before.slice(end + BLOCK_END.length)}`;
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
        return this.withFileLock(this.lockPath, 'Another WhiteNight Code window is updating ~/.grok. Please retry.', operation);
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
        const backup = `${this.grokConfigPath}.whitenight-code.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
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
                throw new Error(`WhiteNight Code cannot safely edit a multi-line [${table}].${key} array. Keep it on one line or edit it manually.`);
            }
            return [];
        }
        try {
            const parsed = JSON.parse(match[1]) as unknown;
            if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error();
            return parsed;
        } catch {
            throw new Error(`WhiteNight Code cannot safely edit [${table}].${key}; use a one-line array of double-quoted strings.`);
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
                return { schemaVersion: 1, providers: file.providers.map(profile => this.validate(profile)) };
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
            throw new Error(`Grok config.toml is invalid; WhiteNight Code left it unchanged: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected backupConfig(configPath: string): void {
        const backup = `${configPath}.whitenight-code.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        fs.copyFileSync(configPath, backup);
        fs.chmodSync(backup, 0o600);
    }
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
