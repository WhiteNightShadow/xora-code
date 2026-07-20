const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { ProviderRegistry } = require('../lib/electron-main/provider-registry');

function registryHarness(initial) {
    const registry = Object.create(ProviderRegistry.prototype);
    let file = structuredClone(initial);
    let writes = 0;
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.readMetadata = () => structuredClone(file);
    registry.writeMetadata = next => { writes += 1; file = structuredClone(next); };
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.profileFromFile = (source, id) => id === 'grok-subscription'
        ? { id, name: 'Grok 订阅', kind: 'grok-subscription', managed: true }
        : source.providers.find(provider => provider.id === id);
    registry.validateModelId = value => value;
    return { registry, current: () => structuredClone(file), writes: () => writes };
}

test('new-session model choice remains the user default after changing project roots', async () => {
    const service = new FakeAgentHostService();
    await service.selectDefaultModel('grok-subscription', 'fixture-model');
    await service.setWorkspaceRoot('/fixture/project-a');
    await service.setWorkspaceRoot('/fixture/project-b');

    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.selectedModel, 'fixture-model');
    assert.equal(snapshot.workspaceRoot, '/fixture/project-b');
    assert.equal(snapshot.workspaceTrusted, false, 'a model preference must never grant project trust');
});

test('legacy subscription confirmation is imported once and external change invalidates the hint', () => {
    const { registry, current } = registryHarness({
        schemaVersion: 1,
        providers: [],
        authenticationConsents: {
            'grok-subscription': {
                fingerprint: 'a'.repeat(64),
                policyVersion: 1,
                confirmedAt: '2026-07-20T00:00:00.000Z'
            }
        }
    });

    assert.equal(registry.subscriptionAuthStatus(), 'authenticated');
    assert.equal(current().subscriptionAuthMigrationComplete, true);
    assert.equal(current().subscriptionAuthState.status, 'authenticated');

    registry.invalidateSubscriptionAuthStatus();
    assert.equal(registry.subscriptionAuthStatus(), 'unknown');
    assert.equal(current().subscriptionAuthMigrationComplete, true);
    assert.equal(current().subscriptionAuthState, undefined);
});

test('repeated ACP authentication status does not rewrite Provider metadata', () => {
    const observedAt = '2026-07-20T00:00:00.000Z';
    const { registry, current, writes } = registryHarness({
        schemaVersion: 1,
        providers: [],
        subscriptionAuthMigrationComplete: true,
        subscriptionAuthState: { status: 'authenticated', observedAt }
    });

    registry.rememberSubscriptionAuthStatus('authenticated');
    assert.equal(writes(), 0);
    assert.equal(current().subscriptionAuthState.observedAt, observedAt);

    registry.rememberSubscriptionAuthStatus('unauthenticated');
    assert.equal(writes(), 1);
    assert.equal(current().subscriptionAuthState.status, 'unauthenticated');
});

test('an advertised model catalogue replaces a stale cross-project default', () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let saved;
    host.providerId = 'grok-subscription';
    host.models = [];
    host.providers = {
        preferredModelId: () => 'retired-model',
        selectPreferredModel: (_providerId, modelId) => { saved = modelId; }
    };
    host.onProviderDefaultsChanged = () => undefined;
    host.emitSnapshot = () => undefined;

    host.acceptModelState({
        currentModelId: 'current-model',
        availableModels: [
            { modelId: 'current-model', name: 'Current model' },
            { modelId: 'other-model', name: 'Other model' }
        ]
    });

    assert.equal(host.selectedModel, 'current-model');
    assert.equal(saved, 'current-model');
});

test('production wiring keeps Provider/model/auth hints global but trust and MCP credentials project-scoped', () => {
    const root = path.join(__dirname, '..', 'src');
    const provider = fs.readFileSync(path.join(root, 'electron-main/provider-registry.ts'), 'utf8');
    const host = fs.readFileSync(path.join(root, 'electron-main/grok-agent-host-service.ts'), 'utf8');
    const manager = fs.readFileSync(path.join(root, 'electron-main/agent-host-manager.ts'), 'utf8');
    const protocol = fs.readFileSync(path.join(root, 'common/agent-protocol.ts'), 'utf8');

    assert.match(provider, /preferredModels\?: Record<string, string>/);
    assert.match(provider, /subscriptionAuthState\?: SubscriptionAuthState/);
    assert.match(host, /this\.providerId = this\.providers\.selectedProviderId\(\)/);
    assert.match(host, /this\.selectedModel = this\.defaultModelId\(this\.providerId\)/);
    assert.match(host, /sessions\.list\(\)\.find\(session => session\.providerId === providerId/);
    assert.match(host, /this\.models\.some\(model => model\.id === request\.model\)/,
        'a stale preference must not be sent to session/new');
    assert.match(host, /this\.models\.some\(model => model\.id === this\.selectedModel\)/,
        'a stale runtime default must not be sent to session/new');
    assert.match(host, /preferredIsStale/);
    assert.match(host, /selectDefaultModel\(providerId: string, modelId: string\)/);
    assert.match(protocol, /selectDefaultModel\(providerId: string, modelId: string\): Promise<RuntimeSnapshot>/);
    assert.match(manager, /providers\.invalidateSubscriptionAuthStatus\(\)/);

    assert.match(host, /providers\.mcpEnvironment\(root\)/, 'MCP secrets remain rooted to the selected project');
    assert.match(host, /theiaTrustedRoots = new Set<string>\(\)/, 'trust remains per-window and project-scoped');
    assert.doesNotMatch(provider, /readFileSync\([^\n]*(?:auth|oauth|cookie)/i,
        'Provider defaults must not read Grok credential files');
});
