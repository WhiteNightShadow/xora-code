import * as React from '@theia/core/shared/react';
import { open, OpenerService, ReactWidget } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common';
import { Message } from '@theia/core/shared/@lumino/messaging';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { URI as VSCodeURI } from '@theia/core/shared/vscode-uri';
import { AgentHostService, ComponentUpdateStatus, ManagementRequest, ManagementResult, ProviderProfile, ProviderProtocol, RuntimeSnapshot } from '../common/agent-protocol';
import { friendlyAgentErrorMessage } from './agent-error-labels';
import {
    AgentManagementTab,
    componentChannelLabel,
    credentialStatusLabel,
    GrokSubscriptionAuthStatus,
    grokSubscriptionAuthStatus,
    grokSubscriptionAuthStatusLabel,
    managementTabLabel,
    optionalCredential
} from './agent-management-labels';

type ManagementTab = AgentManagementTab;

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
    if (typeof value === 'boolean') return value ? '是' : '否';
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

function managementWarnings(data: unknown): string[] {
    if (!isJsonObject(data) || !Array.isArray(data.warnings)) return [];
    return data.warnings.flatMap(value => {
        const warning = stringValue(value);
        return warning ? [warning] : [];
    }).slice(0, 8);
}

function isMcpOverview(data: unknown): boolean {
    return isJsonObject(data) && data.schemaVersion === 1 && Array.isArray(data.mcpServers) && isJsonObject(data.sources);
}

function mcpStatusLabel(value: unknown, enabled: boolean | undefined): string | undefined {
    const normalized = stringValue(value)?.toLowerCase();
    switch (normalized) {
        case 'healthy': case 'connected': case 'ready': return '连接正常';
        case 'unhealthy': case 'disconnected': case 'failed': case 'error': return '连接异常';
        case 'enabled': case 'active': return '已启用';
        case 'disabled': case 'inactive': return '已禁用';
        case 'unknown': return enabled === undefined ? '尚未诊断' : enabled ? '已启用，尚未诊断' : '已禁用';
        default: return displayValue(value) ?? (enabled === undefined ? undefined : enabled ? '已启用' : '已禁用');
    }
}

@injectable()
export class AgentManagementWidget extends ReactWidget {
    static readonly ID = 'xora-code-agent-management';
    static readonly LABEL = 'Agent 设置';

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
    protected runtimeSnapshot: RuntimeSnapshot | undefined;
    /** Safe, renderer-local result of an explicit login/logout in this widget. */
    protected lastKnownGrokSubscriptionAuth: Exclude<GrokSubscriptionAuthStatus, 'unknown'> | undefined;
    protected refreshGeneration = 0;
    protected refreshInFlight: { tab: ManagementTab; promise: Promise<void> } | undefined;

    @postConstruct()
    protected init(): void {
        this.id = AgentManagementWidget.ID;
        this.title.label = AgentManagementWidget.LABEL;
        this.title.caption = '管理模型服务、技能、MCP 与插件';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-settings-gear';
        this.addClass('xora-agent-management');
        this.node.tabIndex = 0;
    }

    protected override onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        this.node.focus();
        // The runtime can finish ACP authentication while this view is hidden.
        // Refresh on every reveal so a ready Grok runtime is reflected as
        // "已登录" without inspecting the shared credential files.
        void this.refresh();
    }

    protected render(): React.ReactNode {
        const tabs: ManagementTab[] = ['providers', 'skills', 'mcp', 'plugins'];
        return <div className='xora-management-root'>
            <section className='xora-management-content' aria-labelledby='xora-agent-settings-title'>
                <header className='xora-management-page-header'>
                    <div>
                        <h1 id='xora-agent-settings-title'>Agent 设置</h1>
                        <p>管理账号、模型，以及 Agent 可以使用的技能、MCP 和插件。</p>
                    </div>
                    <button
                        type='button'
                        className='theia-button secondary'
                        aria-label={`刷新${managementTabLabel(this.tab)}`}
                        disabled={this.loading}
                        onClick={() => this.refresh()}>
                        刷新
                    </button>
                </header>
                <nav className='xora-management-tabs' role='tablist' aria-label='Agent 设置分类'>
                    {tabs.map(tab =>
                    <button
                        key={tab}
                        id={`xora-management-tab-${tab}`}
                        type='button'
                        role='tab'
                        aria-selected={this.tab === tab}
                        aria-controls={`xora-management-panel-${tab}`}
                        tabIndex={this.tab === tab ? 0 : -1}
                        className={`theia-button ${this.tab === tab ? 'main' : 'secondary'}`}
                        onClick={() => this.selectTab(tab)}
                        onKeyDown={event => this.handleTabKeyDown(event, tab, tabs)}>
                        {managementTabLabel(tab)}
                    </button>)}
                </nav>
                <div
                    id={`xora-management-panel-${this.tab}`}
                    role='tabpanel'
                    aria-labelledby={`xora-management-tab-${this.tab}`}
                    aria-busy={this.loading}>
                    <header className='xora-management-section-heading'>
                    <div>
                        <h2>{managementTabLabel(this.tab)}</h2>
                        <p>{this.description()}</p>
                    </div>
                    </header>
                    {this.tab === 'providers' ? this.renderProviders() : <>
                        {this.renderResult()}
                        {this.renderManagementForm()}
                    </>}
                </div>
            </section>
        </div>;
    }

    protected selectTab(tab: ManagementTab): void {
        if (this.tab === tab) return;
        this.tab = tab;
        void this.refresh();
    }

    protected handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, tab: ManagementTab, tabs: readonly ManagementTab[]): void {
        let nextIndex: number | undefined;
        const currentIndex = tabs.indexOf(tab);
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        const nextTab = tabs[nextIndex];
        this.selectTab(nextTab);
        requestAnimationFrame(() => this.node.querySelector<HTMLElement>(`#xora-management-tab-${nextTab}`)?.focus());
    }

    protected description(): string {
        switch (this.tab) {
            case 'providers': return '选择 Agent 当前使用的服务，登录 Grok 订阅，或配置 API 地址、密钥和模型。密钥不会写入 Theia 设置。';
            case 'skills': return '查看并管理 Grok 配置和当前项目最终生效的技能。';
            case 'mcp': return '管理 MCP 服务及其连接健康状态。';
            case 'plugins': return '管理已安装的插件和插件市场；可执行来源需要明确授权。';
        }
    }

    protected renderProviders(): React.ReactNode {
        // The original built-in xAI credential slot remains readable in the
        // Electron backend solely for upgrades and old sessions. New product
        // UI exposes one clear API path: ordinary custom model services.
        const visibleProviders = this.providers.filter(provider => provider.kind !== 'xai-api-key');
        return <div className='xora-provider-list'>
            <article className='xora-card xora-current-provider-card'>
                <div className='xora-current-provider-copy'>
                    <strong>当前模型服务</strong>
                    <span>Agent 新会话将使用这里选择的订阅或 API 配置。</span>
                </div>
                <label>
                    <span className='codicon codicon-server-environment' aria-hidden='true' />
                    <select
                        aria-label='当前模型服务'
                        disabled={this.loading || !this.runtimeSnapshot}
                        value={this.runtimeSnapshot?.providerId ?? 'grok-subscription'}
                        onChange={event => void this.selectProvider(event.currentTarget.value)}>
                        {visibleProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                    </select>
                </label>
            </article>
            {visibleProviders.map(provider => this.renderProvider(provider))}
            <details className='xora-card xora-provider-form'>
                <summary>添加自定义 API 服务</summary>
                <form onSubmit={event => this.addProvider(event)}>
                    <label>显示名称<input required name='name' /></label>
                    <label>协议<select name='protocol' defaultValue='openai-responses'>
                        <option value='openai-responses'>OpenAI Responses</option>
                        <option value='openai-chat-completions'>OpenAI Chat Completions</option>
                        <option value='anthropic-messages'>Anthropic Messages</option>
                    </select></label>
                    <label>Base URL<input required name='baseUrl' type='url' placeholder='https://api.example.com/v1' /></label>
                    <label>模型 ID<input required name='model' /></label>
                    <label>上下文窗口<input required name='contextWindow' type='number' min='1024' step='1' defaultValue='200000' /></label>
                    <label className='xora-provider-checkbox'>
                        <input name='backendSearch' type='checkbox' />
                        <span>启用服务端联网搜索（仅 Responses）</span>
                    </label>
                    <label>API 密钥<input required name='apiKey' type='password' autoComplete='off' /></label>
                    <button className='theia-button main' type='submit'>保存并使用</button>
                </form>
            </details>
            {this.componentUpdate ? <details className='xora-card xora-provider-form'>
                <summary>
                    运行时与更新 · Grok Build <code>{componentChannelLabel(this.componentUpdate.channel)}</code>
                </summary>
                <p>{this.componentUpdate.message}</p>
                <div className='xora-provider-card-actions'>
                    <button
                        type='button'
                        className='theia-button secondary'
                        disabled={!this.componentUpdate.enabled || !this.componentUpdate.configured || this.loading}
                        onClick={() => this.applySidecarUpdate()}>
                        检查签名更新
                    </button>
                    <button
                        type='button'
                        className='theia-button secondary'
                        disabled={!this.componentUpdate.configured || this.loading}
                        onClick={() => this.rollbackSidecarUpdate()}>
                        回滚到上一版本
                    </button>
                </div>
            </details> : undefined}
        </div>;
    }

    protected renderProvider(provider: ProviderProfile): React.ReactNode {
        if (provider.kind === 'grok-subscription') {
            const authStatus = grokSubscriptionAuthStatus(this.runtimeSnapshot, this.lastKnownGrokSubscriptionAuth);
            const authenticated = authStatus === 'authenticated';
            const authDescription = authenticated
                ? 'Grok 订阅已在当前窗口完成认证。切换账号或退出会同时影响外部 Grok CLI 和其他窗口。'
                : authStatus === 'unauthenticated'
                    ? '已退出共享的 Grok 订阅登录。登录流程完全交给 Grok Build。'
                    : '本窗口尚未确认 Grok 订阅状态。启动 Agent 或完成登录后会自动更新；Xora Code 不会读取 ~/.grok 中的凭据。';
            return <article key={provider.id} className='xora-card xora-provider-card'>
                <div>
                    <strong>{provider.name}</strong>
                    <span className={`xora-status-badge ${authenticated ? 'enabled' : authStatus === 'unauthenticated' ? 'disabled' : ''}`}>
                        {grokSubscriptionAuthStatusLabel(authStatus)}
                    </span>
                </div>
                <p>{authDescription}</p>
                <div className='xora-provider-card-actions'>
                    <button className='theia-button main' disabled={this.loading} onClick={() => this.loginGrokSubscription()}>
                        {authenticated ? '切换账号' : '登录 Grok'}
                    </button>
                    {authenticated ? <button className='theia-button secondary' disabled={this.loading} onClick={() => this.logoutGrokSubscription()}>
                        退出登录
                    </button> : undefined}
                </div>
            </article>;
        }
        if (provider.kind === 'xai-api-key') return undefined;
        return this.renderCustomProvider(provider);
    }

    protected renderCustomProvider(provider: Extract<ProviderProfile, { kind: 'custom' }>): React.ReactNode {
        const models = this.discoveredModels.get(provider.id);
        return <details key={provider.id} className='xora-card xora-provider-card'>
            <summary>
                <strong>{provider.name}</strong>
                {' · '}<code>{provider.protocol}</code>
                {' · '}<span>{provider.model}</span>
                {' '}
                <span className={`xora-status-badge ${provider.credentialConfigured ? 'enabled' : 'disabled'}`}>
                    {credentialStatusLabel(provider.credentialConfigured)}
                </span>
            </summary>
            <p title={provider.baseUrl}>{provider.baseUrl}</p>
            <form className='xora-provider-edit-form' onSubmit={event => this.saveCustomProvider(event, provider)}>
                <label>显示名称<input required name='name' defaultValue={provider.name} /></label>
                <label>协议<select required name='protocol' defaultValue={provider.protocol}>
                    <option value='openai-responses'>OpenAI Responses</option>
                    <option value='openai-chat-completions'>OpenAI Chat Completions</option>
                    <option value='anthropic-messages'>Anthropic Messages</option>
                </select></label>
                <label>Base URL<input required name='baseUrl' type='url' defaultValue={provider.baseUrl} /></label>
                <label>模型 ID<input required name='model' defaultValue={provider.model} /></label>
                <label>上下文窗口<input required name='contextWindow' type='number' min='1024' step='1' defaultValue={provider.contextWindow ?? 200000} /></label>
                <label className='xora-provider-checkbox'>
                    <input name='backendSearch' type='checkbox' defaultChecked={provider.backendSearch === true} />
                    <span>启用服务端联网搜索（仅 Responses）</span>
                </label>
                <label>替换 API 密钥（可选）
                    <input name='apiKey' type='password' autoComplete='off' placeholder='留空则保持当前密钥' />
                </label>
                <p className='xora-provider-edit-hint'>修改 Base URL 时必须重新输入 API 密钥；密钥只会发送给 Electron 凭据保险库且不会回显。</p>
                {models?.length ? <p className='xora-provider-models'>可用模型：{models.join(', ')}</p> : undefined}
                <div className='xora-provider-card-actions xora-provider-edit-actions'>
                    <button className='theia-button main' disabled={this.loading} type='submit'>保存并使用</button>
                    <button className='theia-button secondary' disabled={this.loading} type='button' onClick={() => this.discoverModels(provider.id)}>获取模型</button>
                    <button
                        className='theia-button secondary'
                        disabled={this.loading || !provider.credentialConfigured}
                        type='button'
                        onClick={() => this.clearProviderCredential(provider)}>
                        清除密钥
                    </button>
                    <button className='theia-button secondary' disabled={this.loading} type='button' onClick={() => this.removeProvider(provider)}>删除服务</button>
                </div>
            </form>
        </details>;
    }

    protected renderResult(): React.ReactNode {
        if (this.loading) {
            return <div className='theia-spinner' />;
        }
        if (!this.result) {
            return <p>暂无数据。</p>;
        }
        if (!this.result.ok) {
            return <div className='xora-card xora-message-error'>{this.result.error}</div>;
        }
        if (this.tab === 'providers') return undefined;
        const entries = extractEntries(this.result.data, this.tab);
        const warnings = managementWarnings(this.result.data);
        if (entries.length === 0) {
            return <>
                {warnings.map((warning, index) => <div key={`warning-${index}`} className='xora-card xora-message-warning'>{warning}</div>)}
                <div className='xora-card xora-management-empty'>
                    <p>当前没有发现 {managementTabLabel(this.tab)} 项目。</p>
                    {this.result.data !== undefined && !isMcpOverview(this.result.data)
                        ? this.renderRawDetails(this.result.data, '原始响应')
                        : undefined}
                </div>
            </>;
        }
        return <>
            {warnings.map((warning, index) => <div key={`warning-${index}`} className='xora-card xora-message-warning'>{warning}</div>)}
            <div className='xora-integration-list'>
                {entries.map((entry, index) => this.renderIntegrationEntry(entry, index))}
                {this.shouldShowResponseFallback(this.result.data, entries) && !isMcpOverview(this.result.data)
                    ? this.renderRawDetails(this.result.data, '完整响应', 'xora-response-fallback')
                    : undefined}
            </div>
        </>;
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
        return <article key={`skill-${index}-${name}`} className='xora-card xora-integration-card'>
            {this.renderEntryHeader(name, enabled)}
            {this.renderFields([
                ['来源', source],
                ['路径', path],
                ['作用域', scope]
            ])}
            {document ? <div className='xora-integration-actions'>
                <button className='theia-button secondary' onClick={() => this.openSkillDocument(document, name)}>
                    打开 SKILL.md
                </button>
            </div> : undefined}
            {this.renderRawDetails(entry.value)}
        </article>;
    }

    protected renderMcpEntry(entry: ManagementEntry, index: number): React.ReactNode {
        const name = this.entryName(entry, 'MCP 服务', index);
        const transport = displayValue(fieldValue(entry.value, ['transport', 'transportType', 'protocol', 'type']));
        const rawSource = fieldValue(entry.value, ['configSource', 'source', 'origin']);
        const scope = displayValue(fieldValue(entry.value, ['scope', 'level']))
            ?? displayValue(fieldValue(rawSource, ['scope', 'type']))
            ?? displayValue(rawSource);
        const statusValue = fieldValue(entry.value, ['status', 'state', 'connectionStatus', 'connected', 'healthy']);
        const normalizedStatus = stringValue(statusValue)?.toLowerCase();
        const enabled = normalizedStatus === 'healthy' || normalizedStatus === 'unhealthy'
            ? booleanValue(fieldValue(entry.value, ['enabled', 'active', 'isEnabled']))
            : enabledValue(entry.value);
        const status = mcpStatusLabel(statusValue, enabled);
        const vendor = displayValue(fieldValue(entry.value, ['vendor', 'provider', 'originVendor']));
        const source = displayValue(fieldValue(entry.value, ['url', 'command', 'target', 'endpoint']))
            ?? (entry.nameHint ? stringValue(entry.value) : undefined);
        return <article key={`mcp-${index}-${name}`} className='xora-card xora-integration-card'>
            {this.renderEntryHeader(name, enabled)}
            {this.renderFields([
                ['传输方式', transport],
                ['配置来源', vendor],
                ['作用域', scope],
                ['状态', status],
                ['命令 / URL', source]
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
        return <article key={`plugin-${index}-${name}`} className='xora-card xora-integration-card'>
            {this.renderEntryHeader(name, enabled)}
            {this.renderFields([
                ['版本', version],
                ['来源', source]
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
        return <header className='xora-integration-header'>
            <strong>{name}</strong>
            {enabled !== undefined
                ? <span className={`xora-status-badge ${enabled ? 'enabled' : 'disabled'}`}>{enabled ? '已启用' : '已禁用'}</span>
                : undefined}
        </header>;
    }

    protected renderFields(fields: Array<readonly [string, string | undefined]>): React.ReactNode {
        const available = fields.filter((field): field is readonly [string, string] => Boolean(field[1]));
        if (available.length === 0) return <p className='xora-integration-muted'>没有可识别的详细信息。</p>;
        return <dl className='xora-integration-fields'>
            {available.map(([label, value]) => <React.Fragment key={label}>
                <dt>{label}</dt><dd title={value}>{value}</dd>
            </React.Fragment>)}
        </dl>;
    }

    protected renderRawDetails(value: unknown, label = '原始详情', className = ''): React.ReactNode {
        return <details className={`xora-raw-details ${className}`.trim()}>
            <summary>{label}</summary>
            <pre className='xora-management-json'>{rawJson(value)}</pre>
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
            this.messages.error(`无法打开 ${name} 的 SKILL.md：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected renderManagementForm(): React.ReactNode {
        if (this.tab === 'skills') {
            return <details className='xora-card xora-provider-form'>
                <summary>添加或管理技能</summary>
                <form onSubmit={event => this.submitManagement(event)}>
                    <label>操作<select name='action' defaultValue='add'>
                        <option value='add'>添加扫描路径</option>
                        <option value='disable'>禁用 Skill</option>
                        <option value='enable'>启用 Skill</option>
                        <option value='remove'>移除路径或禁用项</option>
                    </select></label>
                    <label>Skill 名称或绝对路径<input required name='value' /></label>
                    <button className='theia-button main' type='submit'>应用</button>
                </form>
            </details>;
        }
        if (this.tab === 'mcp') {
            return <details className='xora-card xora-provider-form'>
                <summary>添加或管理 MCP 服务</summary>
                <form onSubmit={event => this.submitManagement(event)}>
                    <label>操作<select name='action' defaultValue='add'>
                        <option value='add'>添加</option><option value='remove'>移除</option><option value='doctor'>运行诊断</option>
                    </select></label>
                    <label>名称<input name='name' /></label>
                    <label>传输方式<select name='transport' defaultValue='stdio'>
                        <option value='stdio'>stdio</option><option value='http'>HTTP</option><option value='sse'>SSE</option>
                    </select></label>
                    <label>命令或 URL<input name='source' /></label>
                    <label>参数（每行一个）<textarea name='args' /></label>
                    <label>密钥环境变量名（stdio 可选）<input name='environmentName' placeholder='GITHUB_TOKEN' /></label>
                    <label>密钥值（可选，由 Electron 加密）<input name='secretValue' type='password' autoComplete='off' /></label>
                    <p>使用 HTTP/SSE 时，Xora Code 只在配置中保存 bearer token 引用，并仅将密钥注入当前工作区的 Agent 进程。</p>
                    <label>作用域<select name='scope' defaultValue='project'><option value='project'>项目</option><option value='user'>用户</option></select></label>
                    <button className='theia-button main' type='submit'>应用</button>
                </form>
            </details>;
        }
        return <details className='xora-card xora-provider-form'>
            <summary>添加或管理插件</summary>
            <form onSubmit={event => this.submitManagement(event)}>
                <label>类型<select name='area' defaultValue='plugins'><option value='plugins'>插件</option><option value='marketplaces'>插件市场</option></select></label>
                <label>操作<select name='action' defaultValue='install'>
                    <option value='install'>安装</option><option value='update'>更新</option><option value='uninstall'>卸载</option>
                    <option value='enable'>启用</option><option value='disable'>禁用</option><option value='add'>添加插件市场</option>
                </select></label>
                <label>名称<input name='name' /></label>
                <label>固定到 40 位 commit SHA 的来源<input name='source' placeholder='owner/repo@0123…' /></label>
                <label><input name='confirmedTrust' type='checkbox' /> 我已检查并信任这个可执行来源</label>
                <button className='theia-button main' type='submit'>应用</button>
            </form>
        </details>;
    }

    protected refresh(): Promise<void> {
        const requestedTab = this.tab;
        if (this.refreshInFlight?.tab === requestedTab) {
            return this.refreshInFlight.promise;
        }
        const promise = this.refreshTab(requestedTab).finally(() => {
            if (this.refreshInFlight?.promise === promise) {
                this.refreshInFlight = undefined;
            }
        });
        this.refreshInFlight = { tab: requestedTab, promise };
        return promise;
    }

    protected async refreshTab(requestedTab: ManagementTab): Promise<void> {
        const generation = ++this.refreshGeneration;
        this.loading = true;
        this.update();
        try {
            if (requestedTab === 'providers') {
                const [providers, componentUpdate, runtimeSnapshot] = await Promise.all([
                    this.service.listProviders(),
                    this.service.getSidecarUpdateStatus(),
                    this.service.getSnapshot()
                ]);
                if (generation !== this.refreshGeneration || this.tab !== requestedTab) return;
                this.providers = providers;
                this.componentUpdate = componentUpdate;
                this.runtimeSnapshot = runtimeSnapshot;
            } else if (requestedTab === 'skills') {
                const result = await this.service.inspect();
                if (generation !== this.refreshGeneration || this.tab !== requestedTab) return;
                this.result = result;
            } else if (requestedTab === 'mcp') {
                const result = await this.service.runManagementCommand('mcp-list');
                if (generation !== this.refreshGeneration || this.tab !== requestedTab) return;
                this.result = result;
            } else {
                const result = await this.service.runManagementCommand('plugin-list');
                if (generation !== this.refreshGeneration || this.tab !== requestedTab) return;
                this.result = result;
            }
        } catch (error) {
            if (generation !== this.refreshGeneration || this.tab !== requestedTab) return;
            this.result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            if (generation === this.refreshGeneration && this.tab === requestedTab) {
                this.loading = false;
                this.update();
            }
        }
    }

    protected async addProvider(event: React.FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const id = `xora-${Date.now().toString(36)}`;
        const provider: ProviderProfile = {
            id,
            name: String(form.get('name')),
            kind: 'custom',
            protocol: String(form.get('protocol')) as ProviderProtocol,
            baseUrl: String(form.get('baseUrl')),
            model: String(form.get('model')),
            contextWindow: Number(form.get('contextWindow')),
            backendSearch: form.get('backendSearch') === 'on',
            secretRef: `provider:${id}`
        };
        try {
            await this.service.saveProvider(provider, String(form.get('apiKey')));
            formElement.reset();
            try {
                await this.service.selectProvider(provider.id);
            } catch (error) {
                await this.refresh();
                this.messages.warn(`模型服务“${provider.name}”已保存，但当前无法切换：${friendlyAgentErrorMessage(error)}`);
                return;
            }
            await this.refresh();
            this.messages.info(`已保存并启用模型服务“${provider.name}”。`);
        } catch (error) {
            this.messages.error(`无法保存模型服务：${friendlyAgentErrorMessage(error)}`);
        }
    }

    protected async selectProvider(providerId: string): Promise<void> {
        if (this.loading || providerId === this.runtimeSnapshot?.providerId) return;
        const providerName = this.providers.find(provider => provider.id === providerId)?.name ?? providerId;
        this.loading = true;
        this.update();
        try {
            await this.service.selectProvider(providerId);
            this.messages.info(`已将“${providerName}”设为当前模型服务。`);
        } catch (error) {
            this.messages.error(`无法切换模型服务：${friendlyAgentErrorMessage(error)}`);
        } finally {
            this.loading = false;
            await this.refresh();
        }
    }

    protected async saveCustomProvider(event: React.FormEvent<HTMLFormElement>, existing: Extract<ProviderProfile, { kind: 'custom' }>): Promise<void> {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const provider: ProviderProfile = {
            id: existing.id,
            name: String(form.get('name') ?? ''),
            kind: 'custom',
            protocol: String(form.get('protocol')) as ProviderProtocol,
            baseUrl: String(form.get('baseUrl') ?? ''),
            model: String(form.get('model') ?? ''),
            contextWindow: Number(form.get('contextWindow')),
            backendSearch: form.get('backendSearch') === 'on',
            secretRef: existing.secretRef,
            managed: false
        };
        try {
            await this.service.saveProvider(provider, optionalCredential(form.get('apiKey')));
            const password = formElement.elements.namedItem('apiKey');
            if (password instanceof HTMLInputElement) password.value = '';
            try {
                await this.service.selectProvider(provider.id);
            } catch (error) {
                await this.refresh();
                this.messages.warn(`模型服务“${provider.name}”已更新，但当前无法切换：${friendlyAgentErrorMessage(error)}`);
                return;
            }
            await this.refresh();
            this.messages.info(`已更新并启用模型服务“${provider.name}”。`);
        } catch (error) {
            this.messages.error(`无法更新模型服务：${friendlyAgentErrorMessage(error)}`);
        }
    }

    protected async removeProvider(provider: ProviderProfile): Promise<void> {
        const confirmLabel = '删除服务';
        const choice = await this.messages.warn(`删除“${provider.name}”及其已保存的密钥？此操作无法撤销。`, confirmLabel);
        if (choice !== confirmLabel) return;
        try {
            await this.service.deleteProvider(provider.id);
            this.discoveredModels.delete(provider.id);
            await this.refresh();
            this.messages.info(`已删除模型服务“${provider.name}”。`);
        } catch (error) {
            this.messages.error(`无法删除模型服务：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async clearProviderCredential(provider: ProviderProfile): Promise<void> {
        const confirmLabel = '清除密钥';
        const choice = await this.messages.warn(`清除“${provider.name}”的 API 密钥？清除后需要重新输入密钥才能使用该服务。`, confirmLabel);
        if (choice !== confirmLabel) return;
        try {
            await this.service.clearProviderCredential(provider.id);
            this.discoveredModels.delete(provider.id);
            await this.refresh();
            this.messages.info(`已清除“${provider.name}”的 API 密钥。`);
        } catch (error) {
            this.messages.error(`无法清除 API 密钥：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async loginGrokSubscription(): Promise<void> {
        this.loading = true;
        this.update();
        try {
            const result = await this.service.loginGrokSubscription();
            if (result.ok) {
                this.lastKnownGrokSubscriptionAuth = 'authenticated';
                this.update();
                this.messages.info('Grok 订阅登录完成。');
            } else {
                this.messages.warn(result.error ?? 'Grok 订阅登录未完成。');
            }
        } catch (error) {
            this.messages.error(`Grok 订阅登录失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.loading = false;
            await this.refresh();
        }
    }

    protected async logoutGrokSubscription(): Promise<void> {
        this.loading = true;
        this.update();
        try {
            const result = await this.service.logoutGrokSubscription();
            if (result.ok) {
                this.lastKnownGrokSubscriptionAuth = 'unauthenticated';
                this.update();
                this.messages.info('已退出共享的 Grok 订阅登录。');
            } else {
                this.messages.warn(result.error ?? '未能退出 Grok 订阅登录。');
            }
        } catch (error) {
            this.messages.error(`退出 Grok 订阅失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.loading = false;
            await this.refresh();
        }
    }

    protected async discoverModels(providerId: string): Promise<void> {
        try {
            const models = await this.service.fetchProviderModels(providerId);
            this.discoveredModels.set(providerId, models.map(model => model.id));
            this.update();
            this.messages.info(models.length ? `已获取 ${models.length} 个可用模型。` : '服务没有返回可用模型，请手动输入模型 ID。');
        } catch (error) {
            this.messages.error(`无法获取模型：${friendlyAgentErrorMessage(error)}`);
        }
    }

    protected async applySidecarUpdate(): Promise<void> {
        this.loading = true;
        this.update();
        try {
            const result = await this.service.applySidecarUpdate();
            this.messages.info(result.status === 'installed'
                ? `已安装 Grok Build ${result.version}，新启动的 Agent 将使用该版本。`
                : `Grok Build ${result.version} 已是最新版本。`);
        } catch (error) {
            this.messages.error(`无法更新 Grok Build：${error instanceof Error ? error.message : String(error)}`);
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
            this.messages.info(`已回滚到 Grok Build ${result.version}，新启动的 Agent 将使用该版本。`);
        } catch (error) {
            this.messages.error(`无法回滚 Grok Build：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.loading = false;
            await this.refresh();
        }
    }

    protected async submitManagement(event: React.FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
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
            if (this.result.ok) {
                formElement.reset();
                if (request.area === 'mcp' && request.action === 'doctor') {
                    this.messages.info('MCP 连接诊断完成。');
                } else {
                    await this.refresh();
                    this.messages.info('Agent 集成设置已更新。');
                }
            } else {
                this.messages.error(`更新 Agent 集成设置失败：${this.result.error ?? '未知错误'}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.result = { ok: false, error: message };
            this.messages.error(`更新 Agent 集成设置失败：${message}`);
        } finally {
            this.loading = false;
            this.update();
        }
    }
}
