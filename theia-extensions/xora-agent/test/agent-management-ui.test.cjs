const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    componentChannelLabel,
    credentialStatusLabel,
    grokSubscriptionAuthStatus,
    grokSubscriptionAuthStatusLabel,
    managementTabLabel,
    optionalCredential
} = require('../lib/browser/agent-management-labels');

test('Agent management labels and secret-field semantics are Chinese and do not invent credentials', () => {
    assert.equal(managementTabLabel('providers'), '模型服务');
    assert.equal(managementTabLabel('skills'), '技能');
    assert.equal(managementTabLabel('plugins'), '插件');
    assert.equal(componentChannelLabel('stable'), '稳定版');
    assert.equal(credentialStatusLabel(true), '密钥已配置');
    assert.equal(credentialStatusLabel(false), '未配置密钥');
    assert.equal(optionalCredential(''), undefined);
    assert.equal(optionalCredential(null), undefined);
    assert.equal(optionalCredential('new-secret'), 'new-secret');
});

test('Grok subscription status is derived without inspecting shared credential files', () => {
    assert.equal(grokSubscriptionAuthStatus(undefined), 'unknown');
    assert.equal(grokSubscriptionAuthStatus({ providerId: 'grok-subscription', phase: 'stopped' }), 'unknown');
    assert.equal(grokSubscriptionAuthStatus({ providerId: 'grok-subscription', phase: 'auth-required' }), 'unknown');
    assert.equal(grokSubscriptionAuthStatus({ providerId: 'grok-subscription', phase: 'ready' }), 'authenticated');
    assert.equal(grokSubscriptionAuthStatus({
        providerId: 'grok-subscription',
        phase: 'stopped',
        grokSubscriptionAuthStatus: 'authenticated'
    }), 'authenticated');
    assert.equal(grokSubscriptionAuthStatus({
        providerId: 'grok-subscription',
        phase: 'ready',
        grokSubscriptionAuthStatus: 'unauthenticated'
    }), 'unauthenticated');
    assert.equal(grokSubscriptionAuthStatus({ providerId: 'xai-api-key', phase: 'ready' }), 'unknown');
    assert.equal(grokSubscriptionAuthStatus(undefined, 'authenticated'), 'authenticated');
    assert.equal(grokSubscriptionAuthStatus(undefined, 'unauthenticated'), 'unauthenticated');
    assert.equal(grokSubscriptionAuthStatusLabel('authenticated'), '已登录');
    assert.equal(grokSubscriptionAuthStatusLabel('unauthenticated'), '未登录');
    assert.equal(grokSubscriptionAuthStatusLabel('unknown'), '登录状态待确认');
});

test('subscription login state crosses the shared runtime snapshot boundary', () => {
    const protocol = fs.readFileSync(path.join(__dirname, '../src/common/agent-protocol.ts'), 'utf8');
    const host = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    const agent = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    assert.match(protocol, /grokSubscriptionAuthStatus: 'authenticated' \| 'unauthenticated' \| 'unknown'/);
    assert.match(host, /publishSubscriptionAuthStatus\('authenticated'\)/);
    assert.match(host, /publishSubscriptionAuthStatus\('unauthenticated'\)/);
    assert.match(host, /providers\.rememberSubscriptionAuthStatus\(status\)/);
    assert.match(host, /grokSubscriptionAuthStatus: this\.grokSubscriptionAuthStatus/);
    assert.match(agent, /Grok 订阅已登录/);
    assert.doesNotMatch(agent, /'登录或配置模型'/);
});

test('management UI wires subscription login/logout and credential clearing through backend RPC', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-management-widget.tsx'), 'utf8');
    assert.match(source, /service\.loginGrokSubscription\(\)/);
    assert.match(source, /service\.logoutGrokSubscription\(\)/);
    assert.match(source, /service\.getSnapshot\(\)/);
    assert.match(source, /onActivateRequest[\s\S]*void this\.refresh\(\)/);
    assert.match(source, /lastKnownGrokSubscriptionAuth = 'authenticated'/);
    assert.match(source, /lastKnownGrokSubscriptionAuth = 'unauthenticated'/);
    assert.match(source, /authenticated \? '切换账号' : '登录 Grok'/);
    assert.doesNotMatch(source, />订阅登录</);
    assert.match(source, /service\.clearProviderCredential\(provider\.id\)/);
    assert.match(source, /saveCustomProvider\(event, provider\)/);
    assert.match(source, /placeholder='留空则保持当前密钥'/);
    assert.doesNotMatch(source, /value=\{provider\.(?:apiKey|secret)/);
});

test('management data loads on first reveal and coalesces duplicate refreshes', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-management-widget.tsx'), 'utf8');
    const init = source.slice(source.indexOf('@postConstruct()'), source.indexOf('protected override onActivateRequest'));

    assert.doesNotMatch(init, /refresh\(/);
    assert.match(source, /refreshInFlight/);
    assert.match(source, /this\.refreshInFlight\?\.tab === requestedTab/);
    assert.match(source, /onActivateRequest[\s\S]*void this\.refresh\(\)/);
});

test('built-in xAI settings are absent while custom API configuration remains complete', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-management-widget.tsx'), 'utf8');
    assert.match(source, /visibleProviders = this\.providers\.filter\(provider => provider\.kind !== 'xai-api-key'\)/);
    assert.match(source, /if \(provider\.kind === 'xai-api-key'\) return undefined/);
    assert.doesNotMatch(source, /saveXaiProvider/);
    assert.doesNotMatch(source, /xora-xai-provider-form/);
    assert.match(source, /添加自定义 API 服务/);
    assert.match(source, /name='baseUrl'[^>]*type='url'/);
    assert.match(source, /name='apiKey'[^>]*type='password'/);
    assert.match(source, /service\.saveProvider\(provider, optionalCredential\(form\.get\('apiKey'\)\)\)/);
    assert.match(source, /await this\.service\.selectProvider\(provider\.id\)/);
});

test('model service selection lives in settings and uses the shared backend switch', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-management-widget.tsx'), 'utf8');
    const agentSource = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    assert.match(source, /aria-label='当前模型服务'/);
    assert.match(source, /value=\{this\.runtimeSnapshot\?\.providerId \?\? 'grok-subscription'\}/);
    assert.match(source, /await this\.service\.selectProvider\(providerId\)/);
    assert.match(source, /已将“\$\{providerName\}”设为当前模型服务/);
    assert.doesNotMatch(agentSource, /aria-label='Agent 服务'/);
});

test('custom API profiles use save-and-use semantics without adding a second Agent service control', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-management-widget.tsx'), 'utf8');
    const agentSource = fs.readFileSync(path.join(__dirname, '../src/browser/agent-widget.tsx'), 'utf8');
    const add = source.slice(source.indexOf('protected async addProvider('), source.indexOf('protected async selectProvider(', source.indexOf('protected async addProvider(')));
    const save = source.slice(source.indexOf('protected async saveCustomProvider('), source.indexOf('protected async removeProvider(', source.indexOf('protected async saveCustomProvider(')));

    assert.match(source, /<button className='theia-button main' type='submit'>保存并使用<\/button>/);
    assert.match(add, /await this\.service\.saveProvider\(provider,/);
    assert.match(add, /await this\.service\.selectProvider\(provider\.id\)/);
    assert.ok(add.indexOf('saveProvider(provider') < add.indexOf('selectProvider(provider.id)'));
    assert.match(save, /await this\.service\.saveProvider\(provider,/);
    assert.match(save, /await this\.service\.selectProvider\(provider\.id\)/);
    assert.ok(save.indexOf('saveProvider(provider') < save.indexOf('selectProvider(provider.id)'));
    assert.match(source, /已保存并启用模型服务/);
    assert.match(source, /已更新并启用模型服务/);
    assert.doesNotMatch(agentSource, /aria-label='Agent 服务'/);
});

test('the selected Provider is persisted as the safe default for new windows', () => {
    const registry = fs.readFileSync(path.join(__dirname, '../src/electron-main/provider-registry.ts'), 'utf8');
    const host = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    assert.match(registry, /selectedProviderId\?: string/);
    assert.match(registry, /selectedProviderId\(\): string/);
    assert.match(registry, /file\.selectedProviderId = id/);
    assert.match(registry, /file\.selectedProviderId = 'grok-subscription'/);
    assert.match(host, /this\.providerId = this\.providers\.selectedProviderId\(\)/);
    assert.match(host, /this\.providers\.selectProvider\(providerId\)/);
});

test('opening Agent settings preserves the permanently visible Xora Code panel', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/agent-management-contribution.ts'), 'utf8');
    assert.doesNotMatch(source, /collapsePanel\('right'\)/);
    assert.match(source, /openView\(\{ activate: true, reveal: true \}\)/);
});
