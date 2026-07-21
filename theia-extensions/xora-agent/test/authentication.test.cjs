const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');
const { ProviderRegistry } = require('../lib/electron-main/provider-registry');

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

    assert.match(source, /export const XAI_MANAGED_MODEL_ID = 'xora-xai-api'/);
    assert.match(source, /const XAI_MANAGED_ENVIRONMENT = 'XORA_CODE_XAI_API_KEY'/);
    assert.match(source, /xaiApi\?: XaiApiSettings/);
    assert.match(source, /profile\.model\s*\?\s*\{ \[XAI_MANAGED_ENVIRONMENT\]: key \}\s*:\s*\{ XAI_API_KEY: key \}/);
    assert.match(managedToml, /profile\.kind === 'xai-api-key' \? XAI_MANAGED_MODEL_ID : profile\.id/);
    assert.match(managedToml, /profile\.kind === 'xai-api-key' \? XAI_MANAGED_ENVIRONMENT : this\.environmentName\(profile\.id\)/);
    assert.match(managedToml, /env_key =/);
    assert.match(managedToml, /supports_backend_search =/);
    assert.match(managedToml, /extra_headers = \{ "x-api-key" =/);
    assert.doesNotMatch(managedToml, /vault\.get|credential\(|secretRef/);
    assert.match(source, /\.\.\.\(file\.xaiApi \? \[this\.xaiProfile\(file\)\] : \[\]\)/);
    assert.match(host, /provider\?\.kind === 'xai-api-key' && provider\.model\s*\? XAI_MANAGED_MODEL_ID/);
    assert.match(host, /if \(providerId === 'grok-subscription'\)/);
    assert.match(host, /if \(!provider\.baseUrl\)/);
    assert.match(host, /provider\.protocol === 'anthropic-messages'[\s\S]*headers\['x-api-key'\] = credential/);
    assert.match(host, /headers\.authorization = `Bearer \$\{credential\}`/);
    assert.match(host, /providerCredentialSnapshot\(providerId\)/);
    assert.match(host, /withProviderEnvironmentAsync\(provider\.id,[\s\S]*supervisor\.launch\(root, environment\)/);
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
    const registry = Object.create(ProviderRegistry.prototype);
    registry.readProviderUpdateMarker = () => marker;
    registry.clearProviderUpdateMarker = () => { marker = undefined; };
    registry.readMetadata = () => structuredClone(file);
    registry.rewriteManagedBlock = next => { managed = structuredClone(next); };
    registry.vault = {
        delete: () => { credential = undefined; }
    };

    registry.recoverInterruptedProviderUpdateUnlocked();
    assert.equal(credential, undefined);
    assert.deepEqual(managed, file);
    assert.equal(marker, undefined);
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
