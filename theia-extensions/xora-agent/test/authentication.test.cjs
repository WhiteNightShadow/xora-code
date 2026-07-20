const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');

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
        protocol: 'openai-chat-completions',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-relay-model',
        contextWindow: 262_144
    }, 'relay-secret-that-must-not-cross-rpc');

    assert.equal(saved.protocol, 'openai-chat-completions');
    assert.equal(saved.baseUrl, 'https://relay.example.invalid/v1');
    assert.equal(saved.model, 'grok-relay-model');
    assert.equal(saved.contextWindow, 262_144);
    assert.equal(saved.credentialConfigured, true);
    assert.doesNotMatch(JSON.stringify(saved), /relay-secret/);

    const listed = (await service.listProviders()).find(provider => provider.id === 'xai-api-key');
    assert.deepEqual(
        {
            protocol: listed.protocol,
            baseUrl: listed.baseUrl,
            model: listed.model,
            contextWindow: listed.contextWindow,
            credentialConfigured: listed.credentialConfigured
        },
        {
            protocol: 'openai-chat-completions',
            baseUrl: 'https://relay.example.invalid/v1',
            model: 'grok-relay-model',
            contextWindow: 262_144,
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
    assert.match(managedToml, /extra_headers = \{ "x-api-key" =/);
    assert.doesNotMatch(managedToml, /vault\.get|credential\(|secretRef/);
    assert.match(source, /\.\.\.\(file\.xaiApi \? \[this\.xaiProfile\(file\)\] : \[\]\)/);
    assert.match(host, /provider\?\.kind === 'xai-api-key' && provider\.model\s*\? XAI_MANAGED_MODEL_ID/);
    assert.match(host, /provider\.kind === 'grok-subscription' \|\| !provider\.baseUrl/);
    assert.match(host, /provider\.protocol === 'anthropic-messages'[\s\S]*headers\['x-api-key'\] = credential/);
    assert.match(host, /headers\.authorization = `Bearer \$\{credential\}`/);
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
