const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { ProviderRegistry } = require('../lib/electron-main/provider-registry');
const { AgentHostManager } = require('../lib/electron-main/agent-host-manager');

test('credential RPC exposes only configured state and can clear a Provider secret', async () => {
    const service = new FakeAgentHostService();
    const xai = (await service.listProviders()).find(provider => provider.id === 'xai-api-key');
    assert.equal(xai.credentialConfigured, false);

    const saved = await service.saveProvider(xai, 'xai-fixture-secret-that-must-not-cross-rpc');
    assert.equal(saved.credentialConfigured, true);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-secret/);
    assert.equal((await service.listProviders()).find(provider => provider.id === 'xai-api-key').credentialConfigured, true);

    await service.clearProviderCredential('xai-api-key');
    assert.equal((await service.listProviders()).find(provider => provider.id === 'xai-api-key').credentialConfigured, false);
    await assert.rejects(service.clearProviderCredential('grok-subscription'), /subscription logout/);
});

test('authentication confirmation is requested once per Provider and reused afterwards', async () => {
    const service = new FakeAgentHostService();

    assert.deepEqual(await service.authenticate('grok.com'), { status: 'confirmation-required' });
    assert.deepEqual(await service.authenticate('grok.com', true), { status: 'authenticated' });
    assert.deepEqual(await service.authenticate('grok.com'), { status: 'authenticated' });
});

test('an initialize-selected authentication method reaches ready without consuming confirmation consent', async () => {
    const service = new FakeAgentHostService();
    const root = '/fixture/initialize-auth-workspace';
    await service.setWorkspaceRoot(root);
    await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: true });

    const started = await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' });
    assert.equal(started.phase, 'ready');
    assert.deepEqual(await service.authenticate('grok.com'), { status: 'confirmation-required' });

    const source = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    const initializeStart = source.indexOf('const initializedMethod = this.capabilities?.defaultAuthMethodId;');
    const fallbackStart = source.indexOf('const desiredMethod =', initializeStart);
    const initializeShortcut = source.slice(initializeStart, fallbackStart);
    assert.ok(initializeStart >= 0 && fallbackStart > initializeStart);
    assert.match(initializeShortcut, /authMethods\.some\(item => item\.id === initializedMethod\)/);
    assert.match(initializeShortcut, /this\.phase = 'ready'/);
    assert.match(initializeShortcut, /this\.emitSnapshot\(\)/);
    assert.match(initializeShortcut, /return this\.snapshot\(\)/);
    assert.doesNotMatch(initializeShortcut, /\.request\('authenticate'/);
});

test('editing a Provider credential invalidates its previous authentication confirmation', async () => {
    const service = new FakeAgentHostService();
    const xai = (await service.listProviders()).find(provider => provider.id === 'xai-api-key');
    await service.selectProvider('xai-api-key');

    assert.deepEqual(await service.authenticate('xai.api_key', true), { status: 'authenticated' });
    assert.deepEqual(await service.authenticate('xai.api_key'), { status: 'authenticated' });

    await service.saveProvider(xai, 'replacement-xai-secret');
    assert.deepEqual(await service.authenticate('xai.api_key'), { status: 'confirmation-required' });
});

test('built-in xAI Provider retains relay URL, protocol, model and context without returning its key', async () => {
    const service = new FakeAgentHostService();
    const xai = (await service.listProviders()).find(provider => provider.id === 'xai-api-key');
    const saved = await service.saveProvider({
        ...xai,
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-relay-model',
        contextWindow: 1_000_000,
        backendSearch: true
    }, 'relay-secret-that-must-not-cross-rpc');

    assert.equal(saved.protocol, 'openai-responses');
    assert.equal(saved.baseUrl, 'https://relay.example.invalid/v1');
    assert.equal(saved.model, 'grok-relay-model');
    assert.equal(saved.contextWindow, 1_000_000);
    assert.equal(saved.backendSearch, true);
    assert.equal(saved.credentialConfigured, true);
    assert.doesNotMatch(JSON.stringify(saved), /relay-secret/);

    const listed = (await service.listProviders()).find(provider => provider.id === 'xai-api-key');
    assert.deepEqual(
        {
            protocol: listed.protocol,
            baseUrl: listed.baseUrl,
            model: listed.model,
            contextWindow: listed.contextWindow,
            backendSearch: listed.backendSearch,
            credentialConfigured: listed.credentialConfigured
        },
        {
            protocol: 'openai-responses',
            baseUrl: 'https://relay.example.invalid/v1',
            model: 'grok-relay-model',
            contextWindow: 1_000_000,
            backendSearch: true,
            credentialConfigured: true
        }
    );
    assert.doesNotMatch(JSON.stringify(await service.listProviders()), /relay-secret/);
});

test('configured xAI relays use a secret-free managed Grok model and profile-scoped environment key', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/electron-main/provider-registry.ts'), 'utf8');
    const host = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    const managedStart = source.indexOf('protected managedToml(');
    const managedEnd = source.indexOf('protected rewriteManagedBlock(', managedStart);
    const managedToml = source.slice(managedStart, managedEnd);
    const rewriteEnd = source.indexOf('protected readGrokConfig(', managedEnd);
    const rewriteManagedBlock = source.slice(managedEnd, rewriteEnd);

    const protocol = fs.readFileSync(path.join(__dirname, '../src/common/agent-protocol.ts'), 'utf8');
    assert.match(protocol, /export const XAI_MANAGED_MODEL_ID = 'xora-xai-api'/);
    assert.match(source, /XAI_MANAGED_MODEL_ID.*from '\.\.\/common\/agent-protocol'/s);
    assert.match(source, /const XAI_MANAGED_ENVIRONMENT = 'XORA_CODE_XAI_API_KEY'/);
    assert.match(source, /xaiApi\?: XaiApiSettings/);
    assert.match(source, /profile\.model\s*\?\s*\{ \[XAI_MANAGED_ENVIRONMENT\]: key \}\s*:\s*\{ XAI_API_KEY: key \}/);
    assert.match(managedToml, /profile\.kind === 'xai-api-key' \? XAI_MANAGED_MODEL_ID : profile\.id/);
    assert.match(managedToml, /profile\.kind === 'xai-api-key' \? XAI_MANAGED_ENVIRONMENT : this\.environmentName\(profile\.id\)/);
    assert.match(managedToml, /env_key =/);
    assert.match(managedToml, /supports_backend_search =/);
    assert.match(managedToml, /extra_headers = \{ "x-api-key" =/);
    assert.doesNotMatch(managedToml, /vault\.get|credential\(|secretRef/);
    assert.doesNotMatch(rewriteManagedBlock, /xaiProfile\(file\)|file\.xaiApi/);
    assert.match(rewriteManagedBlock, /const profiles: ProviderProfile\[\] = \[\.\.\.file\.providers\]/);
    assert.match(host, /provider\?\.kind === 'xai-api-key' && provider\.model\s*\? XAI_MANAGED_MODEL_ID/);
    assert.match(host, /if \(providerId === 'grok-subscription'\)/);
    assert.match(host, /if \(!provider\.baseUrl\)/);
    assert.match(host, /provider\.protocol === 'anthropic-messages'[\s\S]*headers\['x-api-key'\] = credential/);
    assert.match(host, /headers\.authorization = `Bearer \$\{credential\}`/);
    assert.match(host, /providerCredentialSnapshot\(providerId\)/);
    assert.match(host, /withProviderEnvironment\(provider\.id, \(providerEnvironment, currentProvider, runtimeEpoch\)[\s\S]*this\.runtimeProviderEpoch = runtimeEpoch[\s\S]*supervisor\.launch\(root, environment\)/);
});

test('managed Grok relay TOML preserves a one-million-token Responses profile exactly', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    const toml = registry.managedToml({
        id: 'xai-api-key',
        name: 'xAI / Grok API',
        kind: 'xai-api-key',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        contextWindow: 1_000_000,
        backendSearch: true,
        secretRef: 'provider:xai-api-key',
        managed: true
    });

    assert.match(toml, /^\[model\."xora-xai-api"\]/m);
    assert.match(toml, /^model = "grok-4\.5"$/m);
    assert.match(toml, /^base_url = "https:\/\/relay\.example\.invalid\/v1"$/m);
    assert.match(toml, /^api_backend = "responses"$/m);
    assert.match(toml, /^context_window = 1000000$/m);
    assert.match(toml, /^supports_backend_search = true$/m);
    assert.match(toml, /^env_key = "XORA_CODE_XAI_API_KEY"$/m);
    assert.doesNotMatch(toml, /relay-secret|api_key\s*=/i);
});

test('the live managed Grok catalog removes the retired xAI alias while preserving its metadata', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-retired-catalog-'));
    const configPath = path.join(directory, 'config.toml');
    fs.writeFileSync(configPath, [
        '# >>> Xora Code managed providers >>>',
        '',
        '[model."xora-xai-api"]',
        'model = "grok-legacy"',
        'name = "xAI / Grok API"',
        '',
        '# <<< Xora Code managed providers <<<',
        ''
    ].join('\n'));
    const registry = Object.create(ProviderRegistry.prototype);
    registry.grokConfigPath = configPath;
    registry.withLock = operation => operation();
    registry.backupGrokConfig = () => undefined;
    registry.atomicWrite = (target, contents) => fs.writeFileSync(target, contents, { mode: 0o600 });
    const metadata = {
        schemaVersion: 1,
        providers: [{
            id: 'xora-relay',
            name: 'Relay',
            kind: 'custom',
            protocol: 'openai-responses',
            baseUrl: 'https://relay.example.invalid/v1',
            model: 'grok-4.5',
            contextWindow: 1_000_000,
            backendSearch: true,
            secretRef: 'provider:xora-relay'
        }],
        xaiApi: {
            protocol: 'openai-responses',
            baseUrl: 'https://legacy.example.invalid/v1',
            model: 'grok-legacy',
            contextWindow: 200_000,
            backendSearch: false
        }
    };
    try {
        registry.rewriteManagedBlock(metadata);
        const rewritten = fs.readFileSync(configPath, 'utf8');
        assert.match(rewritten, /\[model\."xora-relay"\]/);
        assert.doesNotMatch(rewritten, /xora-xai-api|xAI \/ Grok API/);
        assert.equal(metadata.xaiApi.model, 'grok-legacy', 'compatibility metadata is not deleted');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('backend search fails closed for non-Responses API profiles', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    assert.throws(() => registry.validateXaiSettings({
        id: 'xai-api-key',
        name: 'xAI / Grok API',
        kind: 'xai-api-key',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        contextWindow: 1_000_000,
        backendSearch: true,
        secretRef: 'provider:xai-api-key',
        managed: true
    }), /仅支持 OpenAI Responses/);
});

test('backend-search relays pin Grok web search to the current process-scoped model', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.readMetadata = () => ({
        schemaVersion: 1,
        providers: [],
        runtimeEpochs: { 'xai-api-key': 'fixture-epoch' }
    });
    registry.isProviderUpdateBlocked = () => false;
    registry.vault = { get: () => 'fixture-secret' };
    registry.get = id => id === 'xai-api-key' ? {
        id,
        name: 'xAI / Grok API',
        kind: 'xai-api-key',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        contextWindow: 1_000_000,
        backendSearch: true,
        secretRef: 'provider:xai-api-key',
        managed: true
    } : undefined;

    assert.deepEqual(registry.environment('xai-api-key'), {
        XORA_CODE_XAI_API_KEY: 'fixture-secret',
        GROK_WEB_SEARCH_MODEL: 'xora-xai-api'
    });

    registry.get = id => id === 'xai-api-key' ? {
        id,
        name: 'xAI / Grok API',
        kind: 'xai-api-key',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        contextWindow: 1_000_000,
        backendSearch: false,
        secretRef: 'provider:xai-api-key',
        managed: true
    } : undefined;
    assert.deepEqual(registry.environment('xai-api-key'), {
        XORA_CODE_XAI_API_KEY: 'fixture-secret'
    });
});

test('Provider runtime epochs are non-secret, persistent, and rotate atomically', () => {
    let metadata = { schemaVersion: 1, providers: [] };
    const registry = Object.create(ProviderRegistry.prototype);
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.readMetadata = () => structuredClone(metadata);
    registry.writeMetadata = next => { metadata = structuredClone(next); };

    assert.equal(registry.runtimeEpoch('grok-subscription'), 'legacy-v1');
    const first = registry.rotateRuntimeEpoch('grok-subscription');
    const second = registry.rotateRuntimeEpoch('grok-subscription');

    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.match(second, /^[0-9a-f-]{36}$/);
    assert.notEqual(first, second);
    assert.equal(registry.runtimeEpoch('grok-subscription'), second);
    assert.doesNotMatch(JSON.stringify(metadata), /secret|token|credential/i);
});

test('a hidden legacy xAI selection fails closed to Grok subscription without deleting old metadata', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    registry.readMetadata = () => ({
        schemaVersion: 1,
        selectedProviderId: 'xai-api-key',
        xaiApi: {
            protocol: 'openai-responses',
            baseUrl: 'https://relay.example.invalid/v1',
            model: 'grok-legacy',
            contextWindow: 200000,
            backendSearch: false
        },
        providers: []
    });

    assert.equal(registry.selectedProviderId(), 'grok-subscription');
    assert.equal(registry.xaiProfile(registry.readMetadata()).model, 'grok-legacy',
        'legacy metadata remains readable for old sessions and explicit migration');

    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.writeMetadata = () => assert.fail('a retired Provider must never be selected');
    assert.throws(
        () => registry.selectProvider('xai-api-key'),
        /已停用/,
        'the registry itself rejects the hidden legacy service'
    );
});

test('clearing a Provider credential persists its epoch before deleting the vault entry and unblocking', () => {
    const provider = {
        id: 'xora-clear-fixture',
        name: 'Clear fixture',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://clear.example.invalid/v1',
        model: 'grok-fixture',
        secretRef: 'provider:xora-clear-fixture'
    };
    let metadata = {
        schemaVersion: 1,
        providers: [provider],
        runtimeEpochs: { [provider.id]: '11111111-1111-4111-8111-111111111111' },
        authenticationConsents: {
            [provider.id]: {
                fingerprint: 'a'.repeat(64),
                policyVersion: 1,
                confirmedAt: '2026-07-21T00:00:00.000Z'
            }
        }
    };
    let marker;
    let credential = 'fixture-secret';
    const events = [];
    const registry = Object.create(ProviderRegistry.prototype);
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.recoverInterruptedProviderUpdateUnlocked = () => undefined;
    registry.readMetadata = () => structuredClone(metadata);
    registry.writeMetadata = next => {
        events.push('metadata');
        metadata = structuredClone(next);
    };
    registry.readProviderUpdateMarker = () => marker;
    registry.writeProviderUpdateMarker = next => {
        events.push('marker');
        marker = structuredClone(next);
    };
    registry.clearProviderUpdateMarker = () => {
        events.push('unblock');
        marker = undefined;
    };
    registry.vault = {
        delete: secretRef => {
            events.push('vault-delete');
            assert.equal(secretRef, provider.secretRef);
            assert.ok(metadata.runtimeEpochs[provider.id] !== '11111111-1111-4111-8111-111111111111');
            assert.ok(marker, 'the durable marker must remain until deletion completes');
            credential = undefined;
        }
    };

    registry.clearCredential(provider.id);

    assert.deepEqual(events, ['marker', 'metadata', 'vault-delete', 'unblock']);
    assert.equal(credential, undefined);
    assert.equal(marker, undefined);
    assert.equal(metadata.authenticationConsents, undefined);
    assert.match(metadata.runtimeEpochs[provider.id], /^[0-9a-f-]{36}$/);
});

test('a failed credential clear keeps its marker and runtime epoch fail-closed across processes', () => {
    const provider = {
        id: 'xora-clear-failure',
        name: 'Clear failure',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://clear-failure.example.invalid/v1',
        model: 'grok-fixture',
        secretRef: 'provider:xora-clear-failure'
    };
    let metadata = {
        schemaVersion: 1,
        providers: [provider],
        runtimeEpochs: { [provider.id]: '22222222-2222-4222-8222-222222222222' }
    };
    let marker;
    let deleteAttempts = 0;
    const registry = Object.create(ProviderRegistry.prototype);
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.recoverInterruptedProviderUpdateUnlocked = () => undefined;
    registry.readMetadata = () => structuredClone(metadata);
    registry.writeMetadata = next => { metadata = structuredClone(next); };
    registry.readProviderUpdateMarker = () => marker;
    registry.writeProviderUpdateMarker = next => { marker = structuredClone(next); };
    registry.clearProviderUpdateMarker = () => { marker = undefined; };
    registry.vault = {
        delete: () => {
            deleteAttempts += 1;
            throw new Error('fixture vault delete failure');
        }
    };

    assert.throws(() => registry.clearCredential(provider.id), /fixture vault delete failure/);
    assert.equal(deleteAttempts, 1);
    assert.ok(marker, 'an uncertain credential deletion must remain durably blocked');
    assert.notEqual(metadata.runtimeEpochs[provider.id], '22222222-2222-4222-8222-222222222222');
    assert.equal(registry.runtimeEpoch(provider.id), 'provider-update-blocked');
});

test('a metadata failure during credential clear never reaches the vault and still blocks runtime', () => {
    const provider = {
        id: 'xora-clear-metadata-failure',
        name: 'Clear metadata failure',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://clear-metadata.example.invalid/v1',
        model: 'grok-fixture',
        secretRef: 'provider:xora-clear-metadata-failure'
    };
    const metadata = { schemaVersion: 1, providers: [provider] };
    let marker;
    let deleteAttempts = 0;
    const registry = Object.create(ProviderRegistry.prototype);
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.recoverInterruptedProviderUpdateUnlocked = () => undefined;
    registry.readMetadata = () => structuredClone(metadata);
    registry.writeMetadata = () => { throw new Error('fixture metadata failure'); };
    registry.readProviderUpdateMarker = () => marker;
    registry.writeProviderUpdateMarker = next => { marker = structuredClone(next); };
    registry.clearProviderUpdateMarker = () => { marker = undefined; };
    registry.vault = { delete: () => { deleteAttempts += 1; } };

    assert.throws(() => registry.clearCredential(provider.id), /fixture metadata failure/);
    assert.equal(deleteAttempts, 0);
    assert.ok(marker);
    assert.equal(registry.runtimeEpoch(provider.id), 'provider-update-blocked');
});

test('production subscription auth paths use the manager mutex and external auth changes invalidate sessions', () => {
    const host = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');
    const manager = fs.readFileSync(path.join(__dirname, '../src/electron-main/agent-host-manager.ts'), 'utf8');

    assert.match(host, /withSubscriptionAuthMutation\(authenticate\)/);
    assert.match(host, /withSubscriptionAuthMutation\(async \(\) => \{[\s\S]*runCli\(\['login', '--oauth'\]/);
    assert.match(host, /withSubscriptionAuthMutation\(async \(\) => \{[\s\S]*runCli\(\['logout'\]/);
    assert.match(manager, /subscriptionAuthenticationMutationActive/);
    assert.match(manager, /rotateRuntimeEpoch\('grok-subscription'\)/);
    assert.match(manager, /notifyProviderRuntimeInvalidated\(\{[\s\S]*providerId: 'grok-subscription'[\s\S]*invalidateSession: true/);
    assert.doesNotMatch(manager, /lastManagedSubscriptionAuthChangeAt/);
});

test('managed subscription auth events fold into one final epoch before the RPC returns', async () => {
    const manager = Object.create(AgentHostManager.prototype);
    const timeline = [];
    let rotations = 0;
    let invalidations = 0;
    const source = {
        notifyProviderRuntimeInvalidated: () => { invalidations += 1; },
        notifySharedGrokStateChanged: changed => timeline.push(`source-shared:${changed}`)
    };
    const peer = {
        prepareSubscriptionAuthenticationMutation: async () => timeline.push('peer-isolated'),
        notifyProviderRuntimeInvalidated: () => { invalidations += 1; },
        notifySharedGrokStateChanged: changed => timeline.push(`peer-shared:${changed}`)
    };
    manager.services = new Set([source, peer]);
    manager.providers = {
        rotateRuntimeEpoch: providerId => {
            rotations += 1;
            timeline.push(`epoch:${providerId}`);
        },
        invalidateSubscriptionAuthStatus: () => timeline.push('auth-cache-invalidated')
    };
    // A sentinel is sufficient: the test invokes the filename-only observer
    // directly and never opens or reads an authentication file.
    manager.grokHomeWatcher = {};
    manager.grokHomeNotification = undefined;
    manager.grokAuthenticationNotificationPending = false;
    manager.grokManagedAuthenticationNotificationPending = false;
    manager.subscriptionAuthenticationMutationActive = false;
    manager.grokHomeNotificationDelayMs = 4;
    manager.subscriptionAuthenticationDrainQuietMs = 12;

    const result = await manager.coordinateSubscriptionAuthentication(source, async () => {
        timeline.push('operation');
        manager.observeGrokHomeChange('oauth-state.json');
        // Coalesced writes from one managed login/logout transaction must not
        // be mistaken for separate external authentication changes.
        manager.observeGrokHomeChange('credentials.json');
        return 'done';
    });
    timeline.push('rpc-returned');

    assert.equal(result, 'done');
    assert.equal(rotations, 2);
    assert.equal(invalidations, 0);
    assert.equal(manager.grokHomeNotification, undefined);
    assert.equal(manager.grokManagedAuthenticationNotificationPending, false);
    assert.equal(manager.subscriptionAuthenticationMutationActive, false);
    assert.ok(timeline.indexOf('source-shared:false') < timeline.indexOf('rpc-returned'));
    assert.ok(timeline.indexOf('peer-shared:false') < timeline.indexOf('rpc-returned'));

    // There must be no delayed self-event left that can retire a session made
    // immediately after the authentication RPC resolves.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(rotations, 2);
    assert.equal(invalidations, 0);
});

test('a real subscription auth event outside a managed transaction still rotates and broadcasts', async () => {
    const manager = Object.create(AgentHostManager.prototype);
    let rotations = 0;
    let authCacheInvalidations = 0;
    const received = [];
    manager.services = new Set([{
        notifyProviderRuntimeInvalidated: change => received.push(change),
        notifySharedGrokStateChanged: changed => received.push({ shared: changed })
    }]);
    manager.providers = {
        rotateRuntimeEpoch: providerId => {
            rotations += 1;
            assert.equal(providerId, 'grok-subscription');
        },
        invalidateSubscriptionAuthStatus: () => { authCacheInvalidations += 1; }
    };
    manager.grokHomeNotification = undefined;
    manager.grokAuthenticationNotificationPending = false;
    manager.grokManagedAuthenticationNotificationPending = false;
    manager.subscriptionAuthenticationMutationActive = false;
    manager.grokHomeNotificationDelayMs = 4;

    manager.observeGrokHomeChange('external-auth.json');
    await new Promise(resolve => setTimeout(resolve, 12));

    assert.equal(rotations, 1);
    assert.equal(authCacheInvalidations, 1);
    assert.deepEqual(received, [
        {
            providerId: 'grok-subscription',
            reason: 'subscription-auth',
            invalidateSession: true
        },
        { shared: true }
    ]);
});

test('a Grok TOML write failure cannot replace relay metadata or its credential', () => {
    const previousFile = {
        schemaVersion: 1,
        providers: [],
        xaiApi: {
            protocol: 'openai-responses',
            baseUrl: 'https://old-relay.example.invalid/v1',
            model: 'old-model',
            contextWindow: 200_000,
            backendSearch: false
        }
    };
    let metadata = structuredClone(previousFile);
    let credential = 'old-fixture-secret';
    let metadataWrites = 0;
    let credentialWrites = 0;
    const registry = Object.create(ProviderRegistry.prototype);
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.recoverInterruptedProviderUpdateUnlocked = () => undefined;
    registry.writeProviderUpdateMarker = () => undefined;
    registry.clearProviderUpdateMarker = () => undefined;
    registry.readMetadata = () => structuredClone(metadata);
    registry.writeMetadata = file => {
        metadataWrites += 1;
        metadata = structuredClone(file);
    };
    let tomlWrites = 0;
    registry.rewriteManagedBlock = () => {
        tomlWrites += 1;
        if (tomlWrites === 1) throw new Error('fixture Grok TOML write failure');
    };
    registry.vault = {
        get: () => credential,
        set: (_secretRef, value) => {
            credentialWrites += 1;
            credential = value;
        },
        delete: () => { credential = undefined; }
    };

    assert.throws(() => registry.save({
        id: 'xai-api-key',
        name: 'xAI / Grok API',
        kind: 'xai-api-key',
        protocol: 'openai-responses',
        baseUrl: 'https://new-relay.example.invalid/v1',
        model: 'grok-4.5',
        contextWindow: 1_000_000,
        backendSearch: true,
        secretRef: 'provider:xai-api-key',
        managed: true
    }, 'new-fixture-secret'), /fixture Grok TOML write failure/);

    assert.deepEqual(metadata, previousFile);
    assert.equal(credential, 'old-fixture-secret');
    assert.equal(metadataWrites, 0);
    assert.equal(credentialWrites, 0);
});

test('a partial credential-store failure rolls Provider metadata and Grok TOML back', () => {
    const previousFile = {
        schemaVersion: 1,
        providers: [],
        xaiApi: {
            protocol: 'openai-responses',
            baseUrl: 'https://old-relay.example.invalid/v1',
            model: 'old-model',
            contextWindow: 200_000,
            backendSearch: false
        }
    };
    const nextFile = structuredClone(previousFile);
    nextFile.xaiApi = {
        protocol: 'openai-responses',
        baseUrl: 'https://new-relay.example.invalid/v1',
        model: 'grok-4.5',
        contextWindow: 1_000_000,
        backendSearch: true
    };
    let metadata = structuredClone(previousFile);
    let managed = structuredClone(previousFile);
    let credential = 'old-fixture-secret';
    const events = [];
    const registry = Object.create(ProviderRegistry.prototype);
    registry.writeProviderUpdateMarker = () => undefined;
    registry.clearProviderUpdateMarker = () => undefined;
    registry.rewriteManagedBlock = file => {
        events.push(`toml:${file.xaiApi.baseUrl}`);
        managed = structuredClone(file);
    };
    registry.writeMetadata = file => {
        events.push(`metadata:${file.xaiApi.baseUrl}`);
        metadata = structuredClone(file);
    };
    registry.vault = {
        get: () => credential,
        set: (_secretRef, value) => {
            events.push(`credential:${value.startsWith('new-') ? 'new' : 'old'}`);
            credential = value;
            if (value.startsWith('new-')) throw new Error('fixture credential write failure');
        },
        delete: () => { credential = undefined; }
    };

    assert.throws(() => registry.commitProviderUpdate(
        previousFile,
        nextFile,
        'xai-api-key',
        'provider:xai-api-key',
        'new-fixture-secret'
    ), /fixture credential write failure/);

    assert.deepEqual(metadata, previousFile);
    assert.deepEqual(managed, previousFile);
    assert.equal(credential, 'old-fixture-secret');
    assert.deepEqual(events, [
        'toml:https://new-relay.example.invalid/v1',
        'metadata:https://new-relay.example.invalid/v1',
        'credential:new',
        'credential:old',
        'metadata:https://old-relay.example.invalid/v1',
        'toml:https://old-relay.example.invalid/v1'
    ]);
});

test('a post-replace Grok TOML error restores the old block before unblocking the Provider', () => {
    const previousFile = {
        schemaVersion: 1,
        providers: [],
        xaiApi: {
            protocol: 'openai-responses',
            baseUrl: 'https://old-relay.example.invalid/v1',
            model: 'old-model',
            contextWindow: 200_000,
            backendSearch: false
        }
    };
    const nextFile = structuredClone(previousFile);
    nextFile.xaiApi = {
        ...nextFile.xaiApi,
        baseUrl: 'https://new-relay.example.invalid/v1',
        model: 'grok-4.5'
    };
    let managed = structuredClone(previousFile);
    let marker = false;
    let rewrites = 0;
    const registry = Object.create(ProviderRegistry.prototype);
    registry.writeProviderUpdateMarker = () => { marker = true; };
    registry.clearProviderUpdateMarker = () => { marker = false; };
    registry.rewriteManagedBlock = file => {
        rewrites += 1;
        managed = structuredClone(file);
        if (rewrites === 1) throw new Error('fixture error after atomic replace');
    };
    registry.writeMetadata = () => assert.fail('metadata must not be written after the TOML failure');
    registry.vault = {
        get: () => 'old-fixture-secret',
        set: () => assert.fail('credential must not be written after the TOML failure'),
        delete: () => assert.fail('credential must not be deleted after a successful rollback')
    };

    assert.throws(() => registry.commitProviderUpdate(
        previousFile,
        nextFile,
        'xai-api-key',
        'provider:xai-api-key',
        'new-fixture-secret'
    ), /fixture error after atomic replace/);
    assert.deepEqual(managed, previousFile);
    assert.equal(marker, false);
    assert.equal(rewrites, 2);
});

test('an uncertain credential rollback keeps the new endpoint blocked instead of restoring the old URL', () => {
    const previousFile = {
        schemaVersion: 1,
        providers: [],
        xaiApi: {
            protocol: 'openai-responses',
            baseUrl: 'https://old-relay.example.invalid/v1',
            model: 'old-model',
            contextWindow: 200_000,
            backendSearch: false
        }
    };
    const nextFile = structuredClone(previousFile);
    nextFile.xaiApi = {
        ...nextFile.xaiApi,
        baseUrl: 'https://new-relay.example.invalid/v1',
        model: 'grok-4.5'
    };
    let metadata = structuredClone(previousFile);
    let managed = structuredClone(previousFile);
    let credential = 'old-fixture-secret';
    let marker = false;
    const registry = Object.create(ProviderRegistry.prototype);
    registry.writeProviderUpdateMarker = () => { marker = true; };
    registry.clearProviderUpdateMarker = () => { marker = false; };
    registry.rewriteManagedBlock = file => { managed = structuredClone(file); };
    registry.writeMetadata = file => { metadata = structuredClone(file); };
    registry.vault = {
        get: () => credential,
        set: (_secretRef, value) => {
            if (value.startsWith('old-')) throw new Error('fixture old credential restore failure');
            credential = value;
            throw new Error('fixture new credential post-write failure');
        },
        delete: () => { throw new Error('fixture credential delete failure'); }
    };

    assert.throws(() => registry.commitProviderUpdate(
        previousFile,
        nextFile,
        'xai-api-key',
        'provider:xai-api-key',
        'new-fixture-secret'
    ), /已阻止该服务启动/);
    assert.deepEqual(metadata, nextFile);
    assert.deepEqual(managed, nextFile);
    assert.equal(credential, 'new-fixture-secret');
    assert.equal(marker, true);

    registry.get = () => ({
        id: 'xai-api-key',
        name: 'xAI / Grok API',
        kind: 'xai-api-key',
        protocol: 'openai-responses',
        baseUrl: nextFile.xaiApi.baseUrl,
        model: nextFile.xaiApi.model,
        secretRef: 'provider:xai-api-key',
        managed: true
    });
    registry.metadataLockPath = '/fixture/providers.lock';
    registry.withFileLock = (_lock, _message, operation) => operation();
    registry.isProviderUpdateBlocked = () => marker;
    assert.throws(() => registry.environment('xai-api-key'), /已阻止启动/);
    assert.equal(registry.credential('xai-api-key'), undefined);
});

test('startup recovery deletes an uncertain key and reconciles Grok TOML from Provider metadata', () => {
    const file = {
        schemaVersion: 1,
        providers: [],
        runtimeEpochs: { 'xai-api-key': '33333333-3333-4333-8333-333333333333' },
        xaiApi: {
            protocol: 'openai-responses',
            baseUrl: 'https://recovered-relay.example.invalid/v1',
            model: 'grok-4.5',
            contextWindow: 1_000_000,
            backendSearch: true
        }
    };
    let marker = {
        schemaVersion: 1,
        providerId: 'xai-api-key',
        secretRef: 'provider:xai-api-key',
        startedAt: '2026-07-21T00:00:00.000Z'
    };
    let credential = 'uncertain-fixture-secret';
    let managed;
    let recoveredMetadata;
    const recoveryEvents = [];
    const registry = Object.create(ProviderRegistry.prototype);
    registry.readProviderUpdateMarker = () => marker;
    registry.clearProviderUpdateMarker = () => {
        recoveryEvents.push('unblock');
        marker = undefined;
    };
    registry.readMetadata = () => structuredClone(file);
    registry.writeMetadata = next => {
        recoveryEvents.push('metadata');
        recoveredMetadata = structuredClone(next);
    };
    registry.rewriteManagedBlock = next => {
        recoveryEvents.push('toml');
        managed = structuredClone(next);
    };
    registry.vault = {
        delete: () => {
            recoveryEvents.push('vault-delete');
            credential = undefined;
        }
    };

    registry.recoverInterruptedProviderUpdateUnlocked();
    assert.equal(credential, undefined);
    assert.notEqual(recoveredMetadata.runtimeEpochs['xai-api-key'], '33333333-3333-4333-8333-333333333333');
    assert.deepEqual(managed, recoveredMetadata);
    assert.equal(marker, undefined);
    assert.deepEqual(recoveryEvents, ['vault-delete', 'metadata', 'toml', 'unblock']);
});

test('failed interrupted-clear recovery retains the marker and never unblocks the old epoch', () => {
    const provider = {
        id: 'xora-recovery-failure',
        name: 'Recovery failure',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://recovery.example.invalid/v1',
        model: 'grok-fixture',
        secretRef: 'provider:xora-recovery-failure'
    };
    const file = {
        schemaVersion: 1,
        providers: [provider],
        runtimeEpochs: { [provider.id]: '44444444-4444-4444-8444-444444444444' }
    };
    let marker = {
        schemaVersion: 1,
        providerId: provider.id,
        secretRef: provider.secretRef,
        startedAt: '2026-07-21T00:00:00.000Z'
    };
    let clearAttempts = 0;
    const registry = Object.create(ProviderRegistry.prototype);
    registry.readProviderUpdateMarker = () => marker;
    registry.readMetadata = () => structuredClone(file);
    registry.writeMetadata = () => { throw new Error('fixture recovery metadata failure'); };
    registry.rewriteManagedBlock = () => assert.fail('TOML must not be reconciled before recovery metadata is durable');
    registry.clearProviderUpdateMarker = () => {
        clearAttempts += 1;
        marker = undefined;
    };
    registry.vault = { delete: () => undefined };

    assert.throws(
        () => registry.recoverInterruptedProviderUpdateUnlocked(),
        /fixture recovery metadata failure/
    );
    assert.equal(clearAttempts, 0);
    assert.ok(marker);
    assert.equal(registry.runtimeEpoch(provider.id), 'provider-update-blocked');
});

test('persistent authentication consent is Provider-scoped, versioned and never fingerprints a secret', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/electron-main/provider-registry.ts'), 'utf8');
    const fingerprintStart = source.indexOf('protected authenticationFingerprint(');
    const fingerprintEnd = source.indexOf('protected clearAuthenticationConsentUnlocked(', fingerprintStart);
    const fingerprint = source.slice(fingerprintStart, fingerprintEnd);

    assert.match(source, /const AUTHENTICATION_CONSENT_POLICY_VERSION = 1/);
    assert.match(source, /authenticationConfirmationRequired\(providerId: string\): boolean/);
    assert.match(source, /rememberAuthenticationConfirmation\(providerId: string\): void/);
    assert.match(source, /clearAuthenticationConfirmation\(providerId: string\): void/);
    assert.match(fingerprint, /id: profile\.id/);
    assert.match(fingerprint, /kind: profile\.kind/);
    assert.match(fingerprint, /protocol: profile\.protocol/);
    assert.match(fingerprint, /baseUrl: profile\.baseUrl/);
    assert.doesNotMatch(fingerprint, /vault|credential|secretRef|apiKey|key:/i);
});

test('custom Provider secret references are derived by the backend fixture', async () => {
    const service = new FakeAgentHostService();
    const saved = await service.saveProvider({
        id: 'xora-fixture',
        name: 'Fixture',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://example.invalid/v1',
        model: 'fixture',
        secretRef: 'provider:xai-api-key'
    }, 'custom-fixture-secret');

    assert.equal(saved.secretRef, 'provider:xora-fixture');
    assert.equal(saved.credentialConfigured, true);
    assert.doesNotMatch(JSON.stringify(await service.listProviders()), /custom-fixture-secret/);
    await service.clearProviderCredential('xora-fixture');
    assert.equal((await service.listProviders()).find(provider => provider.id === 'xora-fixture').credentialConfigured, false);
});

test('pre-Xora custom Provider IDs retain their existing secret reference', async () => {
    const service = new FakeAgentHostService();
    const saved = await service.saveProvider({
        id: 'wnc-legacy-fixture',
        name: 'Legacy fixture',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://example.invalid/v1',
        model: 'fixture'
    }, 'legacy-fixture-secret');

    assert.equal(saved.secretRef, 'provider:wnc-legacy-fixture');
});

test('subscription login and logout stop an active runtime before changing shared authentication', async () => {
    const service = new FakeAgentHostService();
    const root = '/fixture/auth-workspace';
    await service.setWorkspaceRoot(root);
    await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: true });
    await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' });

    assert.equal((await service.loginGrokSubscription()).ok, true);
    assert.equal((await service.getSnapshot()).phase, 'stopped');

    await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' });
    assert.equal((await service.logoutGrokSubscription()).ok, true);
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.phase, 'stopped');
    assert.match(snapshot.message, /退出/);
});

test('ACP subscription authentication adopts the coordinator final epoch and a failed mutation cannot create a session', async () => {
    const createHost = requestAuthentication => {
        const host = Object.create(require('../lib/electron-main/grok-agent-host-service').GrokAgentHostService.prototype);
        let epoch = 'launch-epoch';
        let sessionRequests = 0;
        host.phase = 'auth-required';
        host.providerId = 'grok-subscription';
        host.runtimeProviderEpoch = 'launch-epoch';
        host.capabilities = {
            authMethods: [{ id: 'grok.com', name: 'Grok' }],
            defaultAuthMethodId: 'grok.com'
        };
        host.providers = {
            get: id => id === 'grok-subscription'
                ? { id, name: 'Grok 订阅', kind: 'grok-subscription' }
                : undefined,
            authenticationConfirmationRequired: () => false,
            selectedProviderId: () => 'grok-subscription',
            runtimeEpoch: () => epoch
        };
        host.acp = {
            request: async method => {
                if (method === 'authenticate') return requestAuthentication();
                if (method === 'session/new') sessionRequests += 1;
                return { sessionId: 'must-not-be-created' };
            }
        };
        host.withSubscriptionAuthMutation = async operation => {
            // The manager pre-rotates before ACP authenticate, then completes
            // its watcher drain before returning to the source host.
            epoch = 'coordinator-pre-rotation';
            const result = await operation();
            epoch = 'coordinator-final-epoch';
            return result;
        };
        host.isolateProviderSessions = () => undefined;
        host.publishSubscriptionAuthStatus = () => undefined;
        host.emitSnapshot = () => undefined;
        host.flushAssistantTextDeltas = () => undefined;
        host.assistantStreamState = () => new Set();
        return {
            host,
            epoch: () => epoch,
            sessionRequests: () => sessionRequests
        };
    };

    const success = createHost(async () => ({}));
    assert.deepEqual(await success.host.authenticateLocked('grok.com', true), { status: 'authenticated' });
    assert.equal(success.epoch(), 'coordinator-final-epoch');
    assert.equal(success.host.runtimeProviderEpoch, 'coordinator-final-epoch');
    assert.equal(success.host.phase, 'ready');

    const failure = createHost(async () => { throw new Error('fixture authentication failed'); });
    await assert.rejects(
        failure.host.authenticateLocked('grok.com', true),
        /fixture authentication failed/
    );
    assert.equal(failure.epoch(), 'coordinator-pre-rotation');
    assert.equal(failure.host.runtimeProviderEpoch, 'launch-epoch');
    assert.equal(failure.host.phase, 'auth-required');
    await assert.rejects(
        failure.host.createSession({
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription'
        }),
        /not ready/i
    );
    assert.equal(failure.sessionRequests(), 0);
});

test('API authentication sends zero ACP when the global Provider or runtime epoch changed', async () => {
    for (const mismatch of [
        { name: 'registry epoch', selectedProviderId: 'xai-api-key', runtimeEpoch: 'rotated-epoch' },
        { name: 'global Provider', selectedProviderId: 'grok-subscription', runtimeEpoch: 'launch-epoch' }
    ]) {
        const host = Object.create(GrokAgentHostService.prototype);
        let authenticateRequests = 0;
        host.phase = 'auth-required';
        host.providerId = 'xai-api-key';
        host.runtimeProviderEpoch = 'launch-epoch';
        host.capabilities = {
            authMethods: [{ id: 'xai.api_key', name: 'xAI API key' }],
            defaultAuthMethodId: 'xai.api_key'
        };
        host.providers = {
            get: id => id === 'xai-api-key'
                ? { id, name: 'xAI API', kind: 'xai-api-key' }
                : undefined,
            selectedProviderId: () => mismatch.selectedProviderId,
            runtimeEpoch: () => mismatch.runtimeEpoch,
            authenticationConfirmationRequired: () => false
        };
        host.acp = {
            request: async method => {
                if (method === 'authenticate') authenticateRequests += 1;
                return {};
            }
        };
        host.emitSnapshot = () => undefined;

        await assert.rejects(
            host.authenticateLocked('xai.api_key', true),
            /Provider|credential|runtime|changed/i,
            mismatch.name
        );
        assert.equal(authenticateRequests, 0, `${mismatch.name} must block ACP authenticate`);
        assert.equal(host.phase, 'auth-required');
    }
});
