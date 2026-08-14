const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { ProviderRegistry } = require('../lib/electron-main/provider-registry');

function session(appSessionId, overrides = {}) {
    return {
        appSessionId,
        acpSessionId: `acp-${appSessionId}`,
        title: `Session ${appSessionId}`,
        workspaceRoot: '/fixture/project-a',
        providerId: 'grok-subscription',
        providerRuntimeEpoch: 'subscription-epoch',
        model: 'grok-4.6',
        sidecarVersion: '0.2.102',
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
        status: 'idle',
        ...overrides
    };
}

function registryStore(initial = {}) {
    let durable = {
        schemaVersion: 1,
        providers: [],
        ...structuredClone(initial)
    };
    const make = () => {
        const registry = Object.create(ProviderRegistry.prototype);
        registry.metadataLockPath = '/fixture/providers.lock';
        registry.readMetadata = () => structuredClone(durable);
        registry.writeMetadata = next => { durable = structuredClone(next); };
        registry.withFileLock = (_lock, _message, operation) => operation();
        registry.profileFromFile = (source, id) => id === 'grok-subscription'
            ? { id, name: 'Grok 订阅', kind: 'grok-subscription', managed: true }
            : source.providers.find(provider => provider.id === id);
        registry.validateModelId = value => value;
        return registry;
    };
    return { make, current: () => structuredClone(durable) };
}

function attachSessionRepository(host, initial = []) {
    const records = new Map(initial.map(record => [record.appSessionId, record]));
    let sequence = 0;
    host.sessions = {
        create: input => {
            const record = session(`created-${++sequence}`, input);
            records.set(record.appSessionId, record);
            return record;
        },
        get: id => records.get(id),
        list: () => [...records.values()],
        update: (id, patch) => {
            const current = records.get(id);
            if (!current) throw new Error(`missing fixture session ${id}`);
            const updated = { ...current, ...patch };
            records.set(id, updated);
            return updated;
        },
        flushEvents: () => undefined
    };
    return records;
}

function baseHost(workspaceRoot = '/fixture/project-a') {
    const host = Object.create(GrokAgentHostService.prototype);
    host.workspaceRoot = workspaceRoot;
    host.providerId = 'grok-subscription';
    host.selectedModel = 'grok-4.6';
    host.phase = 'ready';
    host.runtimeProviderEpoch = 'subscription-epoch';
    host.runtimeGeneration = 1;
    host.sessionLoadGeneration = 0;
    host.providerDefaultsGeneration = 0;
    host.sidecarVersion = '0.2.102';
    host.models = [{
        id: 'grok-4.6',
        name: 'Grok 4.6',
        reasoningOptions: [
            { id: 'low', value: 'low', name: 'Low' },
            { id: 'high', value: 'high', name: 'High', default: true },
            { id: 'deep', value: 'xhigh', name: 'Deep' }
        ]
    }];
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map();
    host.loadedSessionIds = new Set();
    host.restoringSessionCounts = new Map();
    host.activePrompts = new Map();
    host.currentSecrets = [];
    host.supportsAdditionalDirectories = false;
    host.security = { canonicalRoot: value => value };
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.completeActiveThought = () => undefined;
    host.acceptModelState = () => undefined;
    host.acceptPromptContextFallback = () => undefined;
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    host.emitError = (_code, error) => { throw error; };
    host.notifyProviderDefaultsChanged = () => undefined;
    host.onProviderDefaultsChanged = () => undefined;
    host.lifecycleTail = Promise.resolve();
    return host;
}

test('reasoning preference is durable across projects and a fresh ProviderRegistry instance', () => {
    const store = registryStore();
    const firstWindow = store.make();

    firstWindow.selectPreferredReasoningEffort('grok-subscription', 'grok-4.6', 'xhigh');

    // A new Electron service/window reads the same user-level file. Workspace
    // roots are deliberately absent from the key so project B inherits the
    // explicit choice without inheriting any trust or session state.
    const restartedWindow = store.make();
    assert.equal(restartedWindow.preferredReasoningEffort('grok-subscription', 'grok-4.6'), 'xhigh');
    assert.equal(restartedWindow.preferredReasoningEffort('grok-subscription', 'grok-4.5'), undefined,
        'reasoning choices remain model-scoped');
    assert.equal(restartedWindow.preferredReasoningEffort('another-provider', 'grok-4.6'), undefined,
        'reasoning choices remain Provider-scoped');

    restartedWindow.selectPreferredReasoningEffort('grok-subscription', 'grok-4.6', undefined);
    assert.equal(store.make().preferredReasoningEffort('grok-subscription', 'grok-4.6'), undefined,
        'clearing an incompatible preference is durable too');
});

test('a draft runtime snapshot exposes the preferred reasoning level without an active session', () => {
    const host = baseHost('/fixture/project-b');
    host.activeSessionId = undefined;
    host.attachedWorkspaceRoots = new Set(['/fixture/project-b']);
    host.sessions = { list: () => [] };
    host.contextStates = () => new Map();
    host.security = {
        agentPermissionMode: () => 'request-approval'
    };
    host.providers = {
        providerProfilesRevision: () => 3,
        preferredReasoningEffort: (providerId, modelId) =>
            providerId === 'grok-subscription' && modelId === 'grok-4.6' ? 'xhigh' : undefined
    };

    const snapshot = host.snapshot();

    assert.equal(snapshot.activeSessionId, undefined);
    assert.equal(snapshot.selectedModel, 'grok-4.6');
    assert.equal(snapshot.preferredReasoningEffort, 'xhigh');
    assert.equal(snapshot.selectedReasoningEffort, undefined,
        'session state and the durable draft preference remain distinct');
});

test('a cold project snapshot preserves the durable reasoning token before ACP advertises its catalogue', () => {
    const host = baseHost('/fixture/project-b');
    host.models = [];
    host.activeSessionId = undefined;
    host.attachedWorkspaceRoots = new Set(['/fixture/project-b']);
    host.sessions = { list: () => [] };
    host.contextStates = () => new Map();
    host.security = { agentPermissionMode: () => 'request-approval' };
    host.providers = {
        providerProfilesRevision: () => 4,
        preferredReasoningEffort: (providerId, modelId) =>
            providerId === 'grok-subscription' && modelId === 'grok-4.6' ? 'xhigh' : undefined
    };

    const snapshot = host.snapshot();

    assert.equal(snapshot.models.length, 0, 'a newly opened window starts before ACP model discovery');
    assert.equal(snapshot.preferredReasoningEffort, 'xhigh',
        'catalogue discovery may validate the value later, but must not erase the application preference meanwhile');
    assert.equal(snapshot.selectedReasoningEffort, undefined,
        'a cold draft still has no session-scoped reasoning state');
});

test('the new-session UI restores and writes the durable reasoning preference', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src/browser/agent-widget.tsx'), 'utf8');
    const resetStart = source.indexOf('protected resetToNewSession(');
    const resetEnd = source.indexOf('\n    protected async refreshAll()', resetStart);
    assert.ok(resetStart >= 0 && resetEnd > resetStart, 'new-session reset implementation must remain discoverable');
    const reset = source.slice(resetStart, resetEnd);

    assert.match(reset, /preferredReasoningEffort/,
        'clicking New session must seed its selector from the durable preference');
    assert.doesNotMatch(reset, /newSessionReasoningEffort\s*=\s*this\.defaultReasoningEffortForModel/,
        'clicking New session must not overwrite an explicit xhigh choice with the advertised high default');
    assert.match(source,
        /selectDefaultModel\(this\.model\.snapshot\.providerId,\s*modelId,\s*this\.newSessionReasoningEffort\)/,
        'changing reasoning in a draft must cross the RPC boundary even when the model id is unchanged');

    const preferenceStart = source.indexOf('protected preferredReasoningEffortForModel(');
    const preferenceEnd = source.indexOf('\n    protected async selectReasoningEffort(', preferenceStart);
    assert.ok(preferenceStart >= 0 && preferenceEnd > preferenceStart,
        'draft preference resolver must remain discoverable');
    const preferenceResolver = source.slice(preferenceStart, preferenceEnd);
    assert.match(preferenceResolver, /options\.length\s*===\s*0|!options\.length/,
        'a fresh window must distinguish an undiscovered catalogue from a model that rejected the saved level');
    assert.match(preferenceResolver, /return\s+preferred|\?\s*preferred\s*:/,
        'before discovery, the renderer must carry the durable token into the new-session draft');
});

test('changing a live session reasoning level also updates the durable new-session preference', async () => {
    const host = baseHost();
    let record = session('active', { reasoningEffort: 'high' });
    const requests = [];
    const saved = [];
    host.activeSessionId = record.appSessionId;
    host.loadedSessionIds.add(record.appSessionId);
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (_id, patch) => (record = { ...record, ...patch })
    };
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => 'grok-4.6',
        preferredReasoningEffort: () => 'high',
        selectPreferredReasoningEffort: (providerId, modelId, effort) => saved.push({ providerId, modelId, effort }),
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' })
    };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            return {};
        }
    };

    await host.selectReasoningEffort(record.appSessionId, 'deep');

    assert.deepEqual(requests, [{
        method: 'session/set_model',
        params: {
            sessionId: record.acpSessionId,
            modelId: 'grok-4.6',
            _meta: { reasoningEffort: 'xhigh' }
        }
    }]);
    assert.deepEqual(saved, [{
        providerId: 'grok-subscription',
        modelId: 'grok-4.6',
        effort: 'xhigh'
    }]);
    assert.equal(record.reasoningEffort, 'xhigh');
});

test('the combined model menu and draft selector persist their reasoning choice', async () => {
    const activeHost = baseHost();
    let record = session('combined', { reasoningEffort: 'high' });
    let preferredModel = 'grok-4.6';
    let preferredReasoning = 'high';
    activeHost.activeSessionId = record.appSessionId;
    activeHost.loadedSessionIds.add(record.appSessionId);
    activeHost.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        list: () => [record],
        update: (_id, patch) => (record = { ...record, ...patch })
    };
    activeHost.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => preferredModel,
        preferredReasoningEffort: () => preferredReasoning,
        selectPreferredModel: (_providerId, modelId, effort) => {
            preferredModel = modelId;
            if (effort !== undefined) preferredReasoning = effort;
        },
        selectPreferredReasoningEffort: (_providerId, _modelId, effort) => { preferredReasoning = effort; },
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' })
    };
    activeHost.acp = { request: async () => ({}) };

    // This is the route used by the single combined model/reasoning selector.
    await activeHost.selectModel(record.appSessionId, 'grok-4.6', 'deep');
    assert.equal(preferredReasoning, 'xhigh');
    assert.equal(record.reasoningEffort, 'xhigh');

    preferredReasoning = 'high';
    const draftHost = baseHost('/fixture/project-b');
    draftHost.activeSessionId = undefined;
    draftHost.loadedSessionIds = new Set();
    draftHost.sessions = { get: () => undefined, list: () => [] };
    draftHost.providers = activeHost.providers;
    draftHost.snapshot = () => ({
        providerId: 'grok-subscription',
        selectedModel: preferredModel,
        preferredReasoningEffort: preferredReasoning
    });

    await draftHost.selectDefaultModel('grok-subscription', 'grok-4.6', 'xhigh');
    assert.equal(preferredReasoning, 'xhigh');
    assert.equal(draftHost.snapshot().preferredReasoningEffort, 'xhigh');
});

async function createFromDurablePreference({
    preferredEffort,
    advertisedOptions,
    providerId = 'grok-subscription',
    modelId = 'grok-4.6',
    providerKind = 'grok-subscription'
}) {
    const host = baseHost('/fixture/project-b');
    host.providerId = providerId;
    host.selectedModel = modelId;
    const records = attachSessionRepository(host);
    const requests = [];
    host.models = [{
        id: modelId,
        name: modelId,
        reasoningOptions: advertisedOptions
    }];
    let preferenceReads = 0;
    host.providers = {
        selectedProviderId: () => providerId,
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => modelId,
        preferredReasoningEffort: () => {
            preferenceReads += 1;
            return typeof preferredEffort === 'function' ? preferredEffort() : preferredEffort;
        },
        selectPreferredModel: () => undefined,
        selectPreferredReasoningEffort: () => undefined,
        get: id => ({ id, name: id, kind: providerKind, ...(providerKind === 'custom' ? { model: 'grok-4.6' } : {}) })
    };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'session/new') {
                return {
                    sessionId: 'acp-preferred-reasoning',
                    _meta: {
                        modelState: {
                            currentModelId: modelId,
                            availableModels: [{
                                id: modelId,
                                _meta: {
                                    supportsReasoningEffort: true,
                                    reasoningEffort: advertisedOptions.find(option => option.default)?.value,
                                    reasoningEfforts: advertisedOptions
                                }
                            }]
                        }
                    }
                };
            }
            if (method === 'session/set_model') return {};
            throw new Error(`unexpected ACP method ${method}`);
        }
    };

    const created = await host.createSession({
        workspaceRoot: '/fixture/project-b',
        providerId,
        model: modelId
    });
    return { created, records, requests, preferenceReads };
}

test('a new project session restores the last compatible reasoning preference', async () => {
    const result = await createFromDurablePreference({
        preferredEffort: 'xhigh',
        advertisedOptions: [
            { id: 'low', value: 'low', name: 'Low' },
            { id: 'high', value: 'high', name: 'High', default: true },
            { id: 'deep', value: 'xhigh', name: 'Deep' }
        ]
    });

    assert.equal(result.created.reasoningEffort, 'xhigh');
    assert.ok(result.preferenceReads > 0, 'session/new must consult the durable reasoning preference');
    assert.equal(result.records.get(result.created.appSessionId).reasoningEffort, 'xhigh');
    assert.deepEqual(result.requests.at(-1), {
        method: 'session/set_model',
        params: {
            sessionId: 'acp-preferred-reasoning',
            modelId: 'grok-4.6',
            _meta: { reasoningEffort: 'xhigh' }
        }
    });
});

test('directory A reasoning selection survives a fresh backend service for directory B', async () => {
    const store = registryStore({ selectedProviderId: 'grok-subscription' });
    const directoryA = store.make();
    directoryA.selectPreferredModel('grok-subscription', 'grok-4.6', 'xhigh');

    // Opening a folder in a new Electron window constructs another host
    // service. It must consult the shared Provider registry rather than any
    // workspace/session record from A.
    const directoryB = store.make();
    const result = await createFromDurablePreference({
        preferredEffort: () => directoryB.preferredReasoningEffort('grok-subscription', 'grok-4.6'),
        advertisedOptions: [
            { id: 'low', value: 'low', name: 'Low' },
            { id: 'high', value: 'high', name: 'High', default: true },
            { id: 'deep', value: 'xhigh', name: 'Deep' }
        ]
    });

    assert.equal(result.created.workspaceRoot, '/fixture/project-b');
    assert.equal(result.created.reasoningEffort, 'xhigh');
    assert.deepEqual(result.requests.at(-1)?.params?._meta, { reasoningEffort: 'xhigh' });
});

test('custom Provider reasoning preference also survives another project and service instance', async () => {
    const relay = {
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.invalid/v1',
        model: 'grok-4.6',
        contextWindow: 500_000,
        secretRef: 'provider:xora-relay'
    };
    const store = registryStore({
        providers: [relay],
        selectedProviderId: relay.id
    });
    store.make().selectPreferredModel(relay.id, relay.id, 'xhigh');
    const directoryB = store.make();

    assert.equal(directoryB.preferredModelId(relay.id), relay.id,
        'custom Providers expose their stable catalogue alias, not the upstream relay model id');
    assert.equal(directoryB.preferredReasoningEffort(relay.id, relay.id), 'xhigh');

    const result = await createFromDurablePreference({
        providerId: relay.id,
        modelId: relay.id,
        providerKind: 'custom',
        preferredEffort: () => directoryB.preferredReasoningEffort(relay.id, relay.id),
        advertisedOptions: [
            { id: 'low', value: 'low', name: 'Low' },
            { id: 'high', value: 'high', name: 'High', default: true },
            { id: 'deep', value: 'xhigh', name: 'Deep' }
        ]
    });

    assert.equal(result.created.providerId, relay.id);
    assert.equal(result.created.model, relay.id);
    assert.equal(result.created.reasoningEffort, 'xhigh');
    assert.deepEqual(result.requests.at(-1)?.params?._meta, { reasoningEffort: 'xhigh' });
});

test('a stale reasoning preference falls back to the advertised model default', async () => {
    const result = await createFromDurablePreference({
        preferredEffort: 'xhigh',
        advertisedOptions: [
            { id: 'low', value: 'low', name: 'Low' },
            { id: 'high', value: 'high', name: 'High', default: true }
        ]
    });

    assert.equal(result.created.reasoningEffort, 'high');
    assert.ok(result.preferenceReads > 0, 'fallback must be based on a deliberately calibrated durable preference');
    assert.equal(result.records.get(result.created.appSessionId).reasoningEffort, 'high');
    assert.equal(result.requests.some(request => request.params?._meta?.reasoningEffort === 'xhigh'), false,
        'an unsupported persisted value must never cross ACP');
});
