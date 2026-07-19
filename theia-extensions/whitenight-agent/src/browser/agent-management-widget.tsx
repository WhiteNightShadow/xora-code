import * as React from '@theia/core/shared/react';
import { open, OpenerService, ReactWidget } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { URI as VSCodeURI } from '@theia/core/shared/vscode-uri';
import { AgentHostService, ComponentUpdateStatus, ManagementRequest, ManagementResult, ProviderProfile, ProviderProtocol } from '../common/agent-protocol';

type ManagementTab = 'providers' | 'skills' | 'mcp' | 'plugins';

type JsonObject = Record<string, unknown>;

interface ManagementEntry {
    readonly value: unknown;
    readonly nameHint?: string;
}

interface FieldMatch {
    readonly key: string;
    readonly value: unknown;
}

const CONTAINER_KEYS: Record<Exclude<ManagementTab, 'providers'>, ReadonlySet<string>> = {
    skills: new Set(['skill', 'skills', 'effectiveskills', 'discoveredskills', 'availableskills']),
    mcp: new Set(['mcp', 'servers', 'mcpservers', 'configuredservers', 'connections']),
    plugins: new Set(['plugin', 'plugins', 'installed', 'installedplugins', 'extensions'])
};

const GENERIC_CONTAINER_KEYS = new Set(['data', 'entries', 'items', 'list', 'result', 'results', 'values']);
const NESTED_METADATA_KEYS = new Set(['config', 'configuration', 'details', 'health', 'metadata', 'origin', 'spec']);
const CONTAINER_METADATA_KEYS = new Set(['count', 'cursor', 'errors', 'message', 'next', 'page', 'schema', 'schemaversion', 'success', 'total', 'warnings']);

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedKey(key: string): string {
    return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findField(value: unknown, aliases: readonly string[], depth = 0): FieldMatch | undefined {
    if (!isJsonObject(value)) return undefined;
    const aliasSet = new Set(aliases.map(normalizedKey));
    for (const [key, fieldValue] of Object.entries(value)) {
        if (aliasSet.has(normalizedKey(key)) && fieldValue !== undefined && fieldValue !== null) {
            return { key, value: fieldValue };
        }
    }
    if (depth >= 2) return undefined;
    for (const [key, fieldValue] of Object.entries(value)) {
        if (NESTED_METADATA_KEYS.has(normalizedKey(key))) {
            const nested = findField(fieldValue, aliases, depth + 1);
            if (nested) return nested;
        }
    }
    return undefined;
}

function fieldValue(value: unknown, aliases: readonly string[]): unknown {
    return findField(value, aliases)?.value;
}

function stringValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    return undefined;
}

function displayValue(value: unknown): string | undefined {
    const scalar = stringValue(value);
    if (scalar) return scalar;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) {
        const values = value.map(stringValue).filter((item): item is string => Boolean(item));
        return values.length ? values.join(', ') : undefined;
    }
    if (isJsonObject(value)) {
        const preferred = fieldValue(value, ['name', 'label', 'type', 'url', 'path', 'id']);
        const preferredText = stringValue(preferred);
        if (preferredText) return preferredText;
        try {
            const compact = JSON.stringify(value);
            return compact.length > 240 ? `${compact.slice(0, 237)}…` : compact;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return undefined;
    switch (value.trim().toLowerCase()) {
        case 'true': case 'yes': case 'on': case 'enabled': case 'active': case 'ready': case 'healthy': case 'connected':
            return true;
        case 'false': case 'no': case 'off': case 'disabled': case 'inactive': case 'unhealthy': case 'disconnected':
            return false;
        default:
            return undefined;
    }
}

function enabledValue(value: unknown): boolean | undefined {
    const enabled = findField(value, ['enabled', 'active', 'isEnabled']);
    if (enabled) return booleanValue(enabled.value);
    const disabled = findField(value, ['disabled', 'isDisabled']);
    const disabledValue = disabled ? booleanValue(disabled.value) : undefined;
    if (disabledValue !== undefined) return !disabledValue;
    return booleanValue(fieldValue(value, ['status', 'state']));
}

function looksLikeEntry(tab: Exclude<ManagementTab, 'providers'>, value: unknown): boolean {
    if (!isJsonObject(value)) return false;
    const specificName = tab === 'mcp' ? 'serverName' : `${tab.slice(0, -1)}Name`;
    const commonName = findField(value, ['name', 'id', 'label', specificName, 'mcpName']);
    if (commonName) return true;
    switch (tab) {
        case 'skills':
            return Boolean(findField(value, ['path', 'skillPath', 'directory', 'source', 'scope', 'enabled', 'disabled']));
        case 'mcp':
            return Boolean(findField(value, ['transport', 'protocol', 'command', 'url', 'status', 'health']));
        case 'plugins':
            return Boolean(findField(value, ['version', 'source', 'repository', 'enabled', 'disabled']));
    }
}

function extractEntries(data: unknown, tab: Exclude<ManagementTab, 'providers'>): ManagementEntry[] {
    const entries: ManagementEntry[] = [];
    const seenObjects = new Set<object>();
    const visited = new Set<object>();

    const add = (value: unknown, nameHint?: string): void => {
        if (value === undefined || value === null) return;
        if (typeof value === 'object') {
            if (seenObjects.has(value)) return;
            seenObjects.add(value);
        }
        entries.push({ value, ...(nameHint ? { nameHint } : {}) });
    };

    const addContainer = (container: unknown): void => {
        if (Array.isArray(container)) {
            container.forEach(value => add(value));
            return;
        }
        if (!isJsonObject(container)) {
            add(container);
            return;
        }
        if (looksLikeEntry(tab, container)) {
            add(container);
            return;
        }
        for (const [nameHint, value] of Object.entries(container)) {
            const key = normalizedKey(nameHint);
            if (GENERIC_CONTAINER_KEYS.has(key)) {
                addContainer(value);
            } else if (!CONTAINER_METADATA_KEYS.has(key) && value !== undefined && value !== null) {
                add(value, nameHint);
            }
        }
    };

    const visit = (value: unknown, depth: number, includeGeneric: boolean): void => {
        if (depth > 5 || value === null || typeof value !== 'object') return;
        if (visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, depth + 1, includeGeneric));
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            const normalized = normalizedKey(key);
            const isContainer = CONTAINER_KEYS[tab].has(normalized) || (includeGeneric && depth <= 1 && GENERIC_CONTAINER_KEYS.has(normalized));
            if (isContainer && child !== null && typeof child === 'object') {
                addContainer(child);
            }
            visit(child, depth + 1, includeGeneric);
        }
    };

    if (Array.isArray(data)) {
        addContainer(data);
    } else {
        visit(data, 0, false);
        if (entries.length === 0 && looksLikeEntry(tab, data)) add(data);
        if (entries.length === 0) {
            visited.clear();
            visit(data, 0, true);
        }
        if (entries.length === 0 && isJsonObject(data)) addContainer(data);
    }
    return entries;
}

function rawJson(value: unknown): string {
    try {
        const result = JSON.stringify(value, undefined, 2);
        return result === undefined ? String(value) : result;
    } catch {
        return String(value);
    }
}

@injectable()
export class AgentManagementWidget extends ReactWidget {
    static readonly ID = 'whitenight-code-agent-management';
    static readonly LABEL = 'Agent Management';

    @inject(AgentHostService)
    protected readonly service!: AgentHostService;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    @inject(OpenerService)
    protected readonly openerService!: OpenerService;

    protected tab: ManagementTab = 'providers';
    protected providers: ProviderProfile[] = [];
    protected result: ManagementResult | undefined;
    protected loading = false;
    protected discoveredModels = new Map<string, string[]>();
    protected componentUpdate: ComponentUpdateStatus | undefined;

    @postConstruct()
    protected init(): void {
        this.id = AgentManagementWidget.ID;
        this.title.label = AgentManagementWidget.LABEL;
        this.title.caption = 'Providers, Skills, MCP servers and Plugins';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-settings-gear';
        this.addClass('whitenight-agent-management');
        void this.refresh();
    }

    protected render(): React.ReactNode {
        return <div className='wn-management-root'>
            <nav className='wn-management-tabs'>
                {(['providers', 'skills', 'mcp', 'plugins'] as ManagementTab[]).map(tab =>
                    <button
                        key={tab}
                        className={`theia-button ${this.tab === tab ? 'main' : 'secondary'}`}
                        onClick={() => { this.tab = tab; void this.refresh(); }}>
                        {tab[0].toUpperCase() + tab.slice(1)}
                    </button>)}
            </nav>
            <section className='wn-management-content'>
                <header>
                    <div>
                        <h2>{this.tab[0].toUpperCase() + this.tab.slice(1)}</h2>
                        <p>{this.description()}</p>
                    </div>
                    <button className='theia-button secondary' disabled={this.loading} onClick={() => this.refresh()}>Refresh</button>
                </header>
                {this.tab === 'providers' ? this.renderProviders() : <>
                    {this.renderResult()}
                    {this.renderManagementForm()}
                </>}
            </section>
        </div>;
    }

    protected description(): string {
        switch (this.tab) {
            case 'providers': return 'Subscription and API profiles. Secrets never enter Theia preferences.';
            case 'skills': return 'Effective skills discovered from Grok configuration and the current project.';
            case 'mcp': return 'Configured MCP servers and health diagnostics.';
            case 'plugins': return 'Installed plugins and marketplaces. Executable sources require explicit trust.';
        }
    }

    protected renderProviders(): React.ReactNode {
        return <div className='wn-provider-list'>
            {this.componentUpdate ? <article className='wn-card'>
                <div><strong>Grok Build component</strong><code>{this.componentUpdate.channel}</code></div>
                <p>{this.componentUpdate.message}</p>
                <button className='theia-button secondary' disabled={!this.componentUpdate.enabled || !this.componentUpdate.configured || this.loading} onClick={() => this.applySidecarUpdate()}>
                    Check signed update
                </button>
                <button className='theia-button secondary' disabled={!this.componentUpdate.configured || this.loading} onClick={() => this.rollbackSidecarUpdate()}>
                    Roll back to previous
                </button>
            </article> : undefined}
            {this.providers.map(provider => <article key={provider.id} className='wn-card'>
                <div><strong>{provider.name}</strong><code>{provider.kind === 'custom' ? provider.protocol : provider.kind}</code></div>
                {provider.baseUrl ? <p>{provider.baseUrl}</p> : undefined}
                {provider.model ? <p>Model: {provider.model}</p> : undefined}
                {provider.kind === 'grok-subscription' ? <p>Sign-in is delegated to Grok Build through ACP. It shares ~/.grok with the CLI.</p> : undefined}
                {provider.kind === 'xai-api-key' ? <form onSubmit={event => this.saveBuiltInKey(event, provider)}>
                    <label>API Key<input required name='apiKey' type='password' autoComplete='off' /></label>
                    <button className='theia-button secondary' type='submit'>Save xAI key</button>
                </form> : undefined}
                {provider.kind === 'custom' ? <button className='theia-button secondary' onClick={() => this.discoverModels(provider.id)}>Get models</button> : undefined}
                {this.discoveredModels.get(provider.id)?.length
                    ? <p>Available: {this.discoveredModels.get(provider.id)!.join(', ')}</p>
                    : undefined}
                {!provider.managed ? <button className='theia-button secondary' onClick={() => this.removeProvider(provider.id)}>Remove</button> : undefined}
            </article>)}
            <details className='wn-card wn-provider-form'>
                <summary>Add API provider</summary>
                <form onSubmit={event => this.addProvider(event)}>
                    <label>Name<input required name='name' /></label>
                    <label>Protocol<select name='protocol' defaultValue='openai-responses'>
                        <option value='openai-responses'>OpenAI Responses</option>
                        <option value='openai-chat-completions'>OpenAI Chat Completions</option>
                        <option value='anthropic-messages'>Anthropic Messages</option>
                    </select></label>
                    <label>Base URL<input required name='baseUrl' type='url' placeholder='https://api.example.com/v1' /></label>
                    <label>Model ID<input required name='model' /></label>
                    <label>Context window<input required name='contextWindow' type='number' min='1024' defaultValue='200000' /></label>
                    <label>API Key<input required name='apiKey' type='password' autoComplete='off' /></label>
                    <button className='theia-button main' type='submit'>Save provider</button>
                </form>
            </details>
        </div>;
    }

    protected renderResult(): React.ReactNode {
        if (this.loading) {
            return <div className='theia-spinner' />;
        }
        if (!this.result) {
            return <p>No data.</p>;
        }
        if (!this.result.ok) {
            return <div className='wn-card wn-message-error'>{this.result.error}</div>;
        }
        if (this.tab === 'providers') return undefined;
        const entries = extractEntries(this.result.data, this.tab);
        if (entries.length === 0) {
            return <div className='wn-card wn-management-empty'>
                <p>No {this.tab} were reported.</p>
                {this.result.data !== undefined ? this.renderRawDetails(this.result.data, 'Raw response') : undefined}
            </div>;
        }
        return <div className='wn-integration-list'>
            {entries.map((entry, index) => this.renderIntegrationEntry(entry, index))}
            {this.shouldShowResponseFallback(this.result.data, entries)
                ? this.renderRawDetails(this.result.data, 'Complete response', 'wn-response-fallback')
                : undefined}
        </div>;
    }

    protected renderIntegrationEntry(entry: ManagementEntry, index: number): React.ReactNode {
        switch (this.tab) {
            case 'skills': return this.renderSkillEntry(entry, index);
            case 'mcp': return this.renderMcpEntry(entry, index);
            case 'plugins': return this.renderPluginEntry(entry, index);
            default: return undefined;
        }
    }

    protected renderSkillEntry(entry: ManagementEntry, index: number): React.ReactNode {
        const name = this.entryName(entry, 'Skill', index);
        const rawSource = fieldValue(entry.value, ['source', 'origin', 'provider', 'repository', 'from']);
        const source = displayValue(rawSource);
        const path = stringValue(fieldValue(entry.value, ['path', 'skillPath', 'directory', 'dir', 'location', 'manifestPath', 'skillMd', 'skillFile', 'file']))
            ?? stringValue(fieldValue(rawSource, ['path', 'skillPath', 'file']))
            ?? (entry.nameHint ? stringValue(entry.value) : undefined);
        const scope = displayValue(fieldValue(entry.value, ['scope', 'level', 'visibility']))
            ?? displayValue(fieldValue(rawSource, ['scope', 'type']));
        const explicitEnabled = enabledValue(entry.value);
        const enabled = explicitEnabled ?? (isJsonObject(entry.value) && rawSource !== undefined ? true : undefined);
        const document = this.skillDocumentUri(path);
        return <article key={`skill-${index}-${name}`} className='wn-card wn-integration-card'>
            {this.renderEntryHeader(name, enabled)}
            {this.renderFields([
                ['Source', source],
                ['Path', path],
                ['Scope', scope]
            ])}
            {document ? <div className='wn-integration-actions'>
                <button className='theia-button secondary' onClick={() => this.openSkillDocument(document, name)}>
                    Open SKILL.md
                </button>
            </div> : undefined}
            {this.renderRawDetails(entry.value)}
        </article>;
    }

    protected renderMcpEntry(entry: ManagementEntry, index: number): React.ReactNode {
        const name = this.entryName(entry, 'MCP server', index);
        const transport = displayValue(fieldValue(entry.value, ['transport', 'transportType', 'protocol', 'type']));
        const rawSource = fieldValue(entry.value, ['configSource', 'source', 'origin']);
        const scope = displayValue(fieldValue(entry.value, ['scope', 'level']))
            ?? displayValue(fieldValue(rawSource, ['scope', 'type']))
            ?? displayValue(rawSource);
        const statusValue = fieldValue(entry.value, ['status', 'state', 'connectionStatus', 'connected', 'healthy']);
        const enabled = enabledValue(entry.value);
        const status = displayValue(statusValue) ?? (enabled === undefined ? undefined : enabled ? 'Enabled' : 'Disabled');
        const source = displayValue(fieldValue(entry.value, ['url', 'command', 'target', 'endpoint']))
            ?? (entry.nameHint ? stringValue(entry.value) : undefined);
        return <article key={`mcp-${index}-${name}`} className='wn-card wn-integration-card'>
            {this.renderEntryHeader(name, enabled)}
            {this.renderFields([
                ['Transport', transport],
                ['Scope', scope],
                ['Status', status],
                ['Command / URL', source]
            ])}
            {this.renderRawDetails(entry.value)}
        </article>;
    }

    protected renderPluginEntry(entry: ManagementEntry, index: number): React.ReactNode {
        const name = this.entryName(entry, 'Plugin', index);
        const version = displayValue(fieldValue(entry.value, ['version', 'pluginVersion', 'revision', 'commit', 'sha']))
            ?? (entry.nameHint ? stringValue(entry.value) : undefined);
        const source = displayValue(fieldValue(entry.value, ['marketplaceSource', 'source', 'origin', 'repository', 'repo', 'url', 'root', 'path']));
        const enabled = enabledValue(entry.value);
        return <article key={`plugin-${index}-${name}`} className='wn-card wn-integration-card'>
            {this.renderEntryHeader(name, enabled)}
            {this.renderFields([
                ['Version', version],
                ['Source', source]
            ])}
            {this.renderRawDetails(entry.value)}
        </article>;
    }

    protected entryName(entry: ManagementEntry, fallback: string, index: number): string {
        return displayValue(fieldValue(entry.value, ['name', 'skillName', 'serverName', 'pluginName', 'id', 'label']))
            ?? entry.nameHint
            ?? stringValue(entry.value)
            ?? `${fallback} ${index + 1}`;
    }

    protected renderEntryHeader(name: string, enabled?: boolean): React.ReactNode {
        return <header className='wn-integration-header'>
            <strong>{name}</strong>
            {enabled !== undefined
                ? <span className={`wn-status-badge ${enabled ? 'enabled' : 'disabled'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
                : undefined}
        </header>;
    }

    protected renderFields(fields: Array<readonly [string, string | undefined]>): React.ReactNode {
        const available = fields.filter((field): field is readonly [string, string] => Boolean(field[1]));
        if (available.length === 0) return <p className='wn-integration-muted'>No recognized metadata was reported.</p>;
        return <dl className='wn-integration-fields'>
            {available.map(([label, value]) => <React.Fragment key={label}>
                <dt>{label}</dt><dd title={value}>{value}</dd>
            </React.Fragment>)}
        </dl>;
    }

    protected renderRawDetails(value: unknown, label = 'Raw details', className = ''): React.ReactNode {
        return <details className={`wn-raw-details ${className}`.trim()}>
            <summary>{label}</summary>
            <pre className='wn-management-json'>{rawJson(value)}</pre>
        </details>;
    }

    protected shouldShowResponseFallback(data: unknown, entries: readonly ManagementEntry[]): boolean {
        if (!isJsonObject(data)) return false;
        if (entries.length === 1 && entries[0].value === data) return false;
        return Object.keys(data).some(key => !CONTAINER_KEYS[this.tab as Exclude<ManagementTab, 'providers'>].has(normalizedKey(key)));
    }

    protected skillDocumentUri(path: string | undefined): URI | undefined {
        if (!path || /[\0\r\n]/.test(path)) return undefined;
        let localPath: string;
        try {
            if (/^file:/i.test(path)) {
                const parsed = VSCodeURI.parse(path);
                if (parsed.scheme !== 'file') return undefined;
                localPath = parsed.fsPath;
            } else {
                if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(path)) return undefined;
                localPath = path;
            }
        } catch {
            return undefined;
        }
        let normalized = localPath.replace(/\\/g, '/').replace(/\/+$/, '');
        const filename = normalized.slice(normalized.lastIndexOf('/') + 1);
        if (/\.md$/i.test(filename) && !/^skill\.md$/i.test(filename)) return undefined;
        if (!/^skill\.md$/i.test(filename)) normalized = `${normalized}/SKILL.md`;
        return new URI(VSCodeURI.file(normalized));
    }

    protected async openSkillDocument(uri: URI, name: string): Promise<void> {
        try {
            await open(this.openerService, uri);
        } catch (error) {
            this.messages.error(`Unable to open ${name} SKILL.md: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected renderManagementForm(): React.ReactNode {
        if (this.tab === 'skills') {
            return <form className='wn-card wn-provider-form' onSubmit={event => this.submitManagement(event)}>
                <h3>Change skills</h3>
                <label>Action<select name='action' defaultValue='add'>
                    <option value='add'>Add scan path</option>
                    <option value='disable'>Disable skill</option>
                    <option value='enable'>Enable skill</option>
                    <option value='remove'>Remove path or disabled entry</option>
                </select></label>
                <label>Skill name or absolute path<input required name='value' /></label>
                <button className='theia-button main' type='submit'>Apply</button>
            </form>;
        }
        if (this.tab === 'mcp') {
            return <form className='wn-card wn-provider-form' onSubmit={event => this.submitManagement(event)}>
                <h3>Manage MCP server</h3>
                <label>Action<select name='action' defaultValue='add'>
                    <option value='add'>Add</option><option value='remove'>Remove</option><option value='doctor'>Doctor</option>
                </select></label>
                <label>Name<input name='name' /></label>
                <label>Transport<select name='transport' defaultValue='stdio'>
                    <option value='stdio'>stdio</option><option value='http'>HTTP</option><option value='sse'>SSE</option>
                </select></label>
                <label>Command or URL<input name='source' /></label>
                <label>Arguments (one per line)<textarea name='args' /></label>
                <label>Secret environment name (optional for stdio)<input name='environmentName' placeholder='GITHUB_TOKEN' /></label>
                <label>Secret value (optional; encrypted by Electron)<input name='secretValue' type='password' autoComplete='off' /></label>
                <p>For HTTP/SSE, WhiteNight Code stores a bearer token reference in config and injects the token only into the active workspace sidecar.</p>
                <label>Scope<select name='scope' defaultValue='project'><option value='project'>Project</option><option value='user'>User</option></select></label>
                <button className='theia-button main' type='submit'>Apply</button>
            </form>;
        }
        return <form className='wn-card wn-provider-form' onSubmit={event => this.submitManagement(event)}>
            <h3>Manage plugin</h3>
            <label>Area<select name='area' defaultValue='plugins'><option value='plugins'>Plugin</option><option value='marketplaces'>Marketplace</option></select></label>
            <label>Action<select name='action' defaultValue='install'>
                <option value='install'>Install</option><option value='update'>Update</option><option value='uninstall'>Uninstall</option>
                <option value='enable'>Enable</option><option value='disable'>Disable</option><option value='add'>Add marketplace</option>
            </select></label>
            <label>Name<input name='name' /></label>
            <label>Source pinned to a 40-character commit SHA<input name='source' placeholder='owner/repo@0123…' /></label>
            <label><input name='confirmedTrust' type='checkbox' /> I reviewed and trust this executable source</label>
            <button className='theia-button main' type='submit'>Apply</button>
        </form>;
    }

    protected async refresh(): Promise<void> {
        this.loading = true;
        this.update();
        try {
            if (this.tab === 'providers') {
                [this.providers, this.componentUpdate] = await Promise.all([
                    this.service.listProviders(),
                    this.service.getSidecarUpdateStatus()
                ]);
            } else if (this.tab === 'skills') {
                this.result = await this.service.inspect();
            } else if (this.tab === 'mcp') {
                this.result = await this.service.runManagementCommand('mcp-list');
            } else {
                this.result = await this.service.runManagementCommand('plugin-list');
            }
        } catch (error) {
            this.result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            this.loading = false;
            this.update();
        }
    }

    protected async addProvider(event: React.FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const id = `wnc-${Date.now().toString(36)}`;
        const provider: ProviderProfile = {
            id,
            name: String(form.get('name')),
            kind: 'custom',
            protocol: String(form.get('protocol')) as ProviderProtocol,
            baseUrl: String(form.get('baseUrl')),
            model: String(form.get('model')),
            contextWindow: Number(form.get('contextWindow')),
            secretRef: `provider:${id}`
        };
        try {
            await this.service.saveProvider(provider, String(form.get('apiKey')));
            event.currentTarget.reset();
            await this.refresh();
            this.messages.info(`Saved provider ${provider.name}.`);
        } catch (error) {
            this.messages.error(`Unable to save provider: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async removeProvider(id: string): Promise<void> {
        await this.service.deleteProvider(id);
        await this.refresh();
    }

    protected async saveBuiltInKey(event: React.FormEvent<HTMLFormElement>, provider: ProviderProfile): Promise<void> {
        event.preventDefault();
        const apiKey = String(new FormData(event.currentTarget).get('apiKey') ?? '');
        try {
            await this.service.saveProvider(provider, apiKey);
            event.currentTarget.reset();
            this.messages.info('The xAI API key was stored by the Electron credential vault.');
        } catch (error) {
            this.messages.error(`Unable to save API key: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async discoverModels(providerId: string): Promise<void> {
        try {
            const models = await this.service.fetchProviderModels(providerId);
            this.discoveredModels.set(providerId, models.map(model => model.id));
            this.update();
        } catch (error) {
            this.messages.error(`Unable to get models: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async applySidecarUpdate(): Promise<void> {
        this.loading = true;
        this.update();
        try {
            const result = await this.service.applySidecarUpdate();
            this.messages.info(result.status === 'installed'
                ? `Installed Grok Build ${result.version}; new runtimes will use it.`
                : `Grok Build ${result.version} is already current.`);
        } catch (error) {
            this.messages.error(`Unable to update Grok Build: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.loading = false;
            await this.refresh();
        }
    }

    protected async rollbackSidecarUpdate(): Promise<void> {
        this.loading = true;
        this.update();
        try {
            const result = await this.service.rollbackSidecarUpdate();
            this.messages.info(`Rolled back to Grok Build ${result.version}; new runtimes will use it.`);
        } catch (error) {
            this.messages.error(`Unable to roll back Grok Build: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.loading = false;
            await this.refresh();
        }
    }

    protected async submitManagement(event: React.FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const action = String(form.get('action')) as ManagementRequest['action'];
        let request: ManagementRequest;
        if (this.tab === 'skills') {
            const value = String(form.get('value') ?? '');
            request = {
                area: 'skills', action,
                ...(action === 'add' ? { source: value } : { name: value })
            };
        } else if (this.tab === 'mcp') {
            request = {
                area: 'mcp', action,
                name: String(form.get('name') ?? ''),
                source: String(form.get('source') ?? ''),
                transport: String(form.get('transport')) as ManagementRequest['transport'],
                scope: String(form.get('scope')) as ManagementRequest['scope'],
                args: String(form.get('args') ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean),
                environmentName: String(form.get('environmentName') ?? ''),
                secretValue: String(form.get('secretValue') ?? '')
            };
        } else {
            request = {
                area: String(form.get('area')) as 'plugins' | 'marketplaces', action,
                name: String(form.get('name') ?? ''),
                source: String(form.get('source') ?? ''),
                confirmedTrust: form.get('confirmedTrust') === 'on'
            };
        }
        this.loading = true;
        this.update();
        try {
            this.result = await this.service.manage(request);
            if (this.result.ok) this.messages.info('Agent integration settings updated.');
        } catch (error) {
            this.result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            this.loading = false;
            this.update();
        }
    }
}
