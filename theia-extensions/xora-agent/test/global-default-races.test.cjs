const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function session(appSessionId, overrides = {}) {
    return {
        appSessionId,
        acpSessionId: `acp-${appSessionId}`,
        title: `Session ${appSessionId}`,
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        providerRuntimeEpoch: 'subscription-epoch',
        model: 'model-1',
        sidecarVersion: '0.2.102',
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        status: 'idle',
        ...overrides
    };
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

function baseHost() {
    const host = Object.create(GrokAgentHostService.prototype);
    host.workspaceRoot = '/fixture';
    host.providerId = 'grok-subscription';
    host.selectedModel = 'model-1';
    host.phase = 'ready';
    host.runtimeProviderEpoch = 'subscription-epoch';
    host.runtimeGeneration = 1;
    host.sessionLoadGeneration = 0;
    host.sidecarVersion = '0.2.102';
    host.models = [
        { id: 'model-1', name: 'Model 1' },
        { id: 'model-2', name: 'Model 2' }
    ];
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
    host.acceptModelState = () => undefined;
    host.acceptPromptContextFallback = () => undefined;
    host.emit = () => undefined;
    host.emitError = (_code, error) => { throw error; };
    host.notifyProviderDefaultsChanged = () => undefined;
    host.snapshotRevision = 0;
    host.emitSnapshot = () => ++host.snapshotRevision;
    return host;
}

test('an explicit snapshot read reconciles a deleted Provider before the renderer freezes a prompt', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    host.providerId = 'xora-deleted-provider';
    host.activePrompts = new Map();
    host.disposed = false;
    host.lifecycleTail = Promise.resolve();
    host.providers = { selectedProviderId: () => 'xora-current-provider' };
    let reconciliations = 0;
    host.applyProviderDefaultsLocked = async () => {
        reconciliations += 1;
        host.providerId = 'xora-current-provider';
    };
    host.snapshot = () => ({ providerId: host.providerId });

    const snapshot = await host.getSnapshot();

    assert.equal(reconciliations, 1);
    assert.equal(snapshot.providerId, 'xora-current-provider');
});

test('session/new finishing after M1 -> M2 reconciles to M2 and never activates or persists M1', async () => {
    const host = baseHost();
    const records = attachSessionRepository(host);
    const newGate = deferred();
    const requests = [];
    let globalModel = 'model-1';
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => globalModel,
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' }),
        selectPreferredModel: () => undefined
    };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'session/new') return newGate.promise;
            if (method === 'session/set_model') {
                assert.equal(host.activeSessionId, undefined,
                    'the M1 session must not activate before set_model M2 completes');
                assert.equal(records.size, 0,
                    'the M1 session must not be persisted before set_model M2 completes');
                return {};
            }
            throw new Error(`unexpected ACP method ${method}`);
        }
    };

    const creating = host.createSession({
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        model: 'model-1'
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests[0], {
        method: 'session/new',
        params: { cwd: '/fixture', mcpServers: [], _meta: { modelId: 'model-1' } }
    });

    // The durable preference changes before a peer-window notification is
    // delivered. Completion must independently re-read ProviderRegistry.
    globalModel = 'model-2';
    newGate.resolve({
        sessionId: 'acp-created-race',
        _meta: {
            modelState: {
                currentModelId: 'model-1',
                availableModels: [
                    { modelId: 'model-1', name: 'Model 1' },
                    { modelId: 'model-2', name: 'Model 2' }
                ]
            }
        }
    });
    const created = await creating;

    assert.deepEqual(requests[1], {
        method: 'session/set_model',
        params: { sessionId: 'acp-created-race', modelId: 'model-2' }
    });
    assert.equal(created.model, 'model-2');
    assert.equal(created.status, 'idle');
    assert.equal(created.authorityRevision, 1,
        'session/create returns the exact snapshot fence which already contains the record');
    assert.equal(host.selectedModel, 'model-2');
    assert.equal(host.activeSessionId, created.appSessionId);
    assert.equal(records.get(created.appSessionId).model, 'model-2');
    assert.notEqual(records.get(created.appSessionId).model, 'model-1');
});

test('session/new without modelState explicitly selects a custom relay alias before activation', async () => {
    const host = baseHost();
    const records = attachSessionRepository(host);
    const requests = [];
    const provider = {
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        secretRef: 'provider:xora-relay'
    };
    host.providerId = provider.id;
    host.selectedModel = provider.id;
    host.runtimeProviderEpoch = 'relay-epoch';
    host.models = [{ id: provider.id, name: provider.name }];
    host.providers = {
        selectedProviderId: () => provider.id,
        runtimeEpoch: () => 'relay-epoch',
        preferredModelId: () => provider.model,
        get: id => id === provider.id ? provider : undefined,
        selectPreferredModel: () => undefined
    };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'session/new') return { sessionId: 'acp-relay' };
            if (method === 'session/set_model') return {};
            throw new Error(`unexpected ACP method ${method}`);
        }
    };

    const created = await host.createSession({
        workspaceRoot: '/fixture',
        providerId: provider.id,
        model: provider.id
    });

    assert.deepEqual(requests, [
        {
            method: 'session/new',
            params: { cwd: '/fixture', mcpServers: [], _meta: { modelId: provider.id } }
        },
        {
            method: 'session/set_model',
            params: { sessionId: 'acp-relay', modelId: provider.id }
        }
    ]);
    assert.equal(created.status, 'idle');
    assert.equal(created.model, provider.id);
    assert.equal(host.activeSessionId, created.appSessionId);
    assert.equal(records.get(created.appSessionId).model, provider.id);
});

test('session/new applies a requested reasoning effort before the conversation becomes active', async () => {
    const host = baseHost();
    const records = attachSessionRepository(host);
    const requests = [];
    host.models = [{
        id: 'model-1',
        name: 'Model 1',
        reasoningOptions: [
            { id: 'quick', value: 'low', name: 'Quick', default: true },
            { id: 'deep', value: 'xhigh', name: 'Deep' }
        ]
    }];
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => 'model-1',
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' }),
        selectPreferredModel: () => undefined
    };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params, activeSessionId: host.activeSessionId });
            if (method === 'session/new') {
                return {
                    sessionId: 'acp-reasoning',
                    _meta: {
                        modelState: {
                            currentModelId: 'model-1',
                            availableModels: [{
                                id: 'model-1',
                                _meta: {
                                    supportsReasoningEffort: true,
                                    reasoningEffort: 'low',
                                    reasoningEfforts: [
                                        { id: 'quick', value: 'low' },
                                        { id: 'deep', value: 'xhigh' }
                                    ]
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
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        model: 'model-1',
        reasoningEffort: 'deep'
    });

    assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [{
        method: 'session/new',
        params: { cwd: '/fixture', mcpServers: [], _meta: { modelId: 'model-1' } }
    }, {
        method: 'session/set_model',
        params: {
            sessionId: 'acp-reasoning',
            modelId: 'model-1',
            _meta: { reasoningEffort: 'xhigh' }
        }
    }]);
    assert.equal(requests[1].activeSessionId, undefined,
        'the first prompt cannot race ahead of the effort switch');
    assert.equal(created.reasoningEffort, 'xhigh');
    assert.equal(records.get(created.appSessionId).reasoningEffort, 'xhigh');
});

test('session/new cannot activate an ABA-stale result after defaults generation changes while pending', async () => {
    const host = baseHost();
    let record;
    const newGate = deferred();
    let globalModel = 'model-1';
    let globalProvider = 'grok-subscription';
    host.providerDefaultsGeneration = 10;
    host.sessions = {
        create: input => (record = session('defaults-aba', input)),
        get: id => id === record?.appSessionId ? record : undefined,
        list: () => record ? [record] : [],
        update: (_id, patch) => (record = { ...record, ...patch }),
        flushEvents: () => undefined
    };
    host.providers = {
        selectedProviderId: () => globalProvider,
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => globalModel,
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' }),
        selectPreferredModel: () => undefined
    };
    host.acp = {
        request: async method => {
            if (method === 'session/new') return newGate.promise;
            throw new Error(`an ABA-stale session must not call ${method}`);
        }
    };

    const creating = host.createSession({
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        model: 'model-1'
    });
    await new Promise(resolve => setImmediate(resolve));

    // Simulate a synchronously observed peer-default notification whose
    // durable values changed M1 -> M2 -> M1 before the old ACP response. The
    // final-value comparison alone cannot distinguish this ABA transition.
    globalProvider = 'other-provider';
    globalModel = 'model-2';
    host.providerDefaultsGeneration += 1;
    globalProvider = 'grok-subscription';
    globalModel = 'model-1';
    newGate.resolve({
        sessionId: 'acp-defaults-aba',
        _meta: {
            modelState: {
                currentModelId: 'model-1',
                availableModels: [
                    { modelId: 'model-1', name: 'Model 1' },
                    { modelId: 'model-2', name: 'Model 2' }
                ]
            }
        }
    });
    const created = await creating;

    assert.equal(created.status, 'read-only');
    assert.equal(record.status, 'read-only');
    assert.equal(host.activeSessionId, undefined);
    assert.equal(host.loadedSessionIds.has(created.appSessionId), false);
});

test('session/load finishing after M1 -> M2 cannot overwrite the global M2 selection', async () => {
    const host = baseHost();
    const historical = session('load-race');
    const records = attachSessionRepository(host, [historical]);
    const loadGate = deferred();
    const requests = [];
    let globalModel = 'model-1';
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => globalModel,
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' }),
        selectPreferredModel: () => undefined
    };
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'session/load') return loadGate.promise;
            if (method === 'session/set_model') return {};
            throw new Error(`unexpected ACP method ${method}`);
        }
    };

    const loading = host.loadSession(historical.appSessionId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests[0].method, 'session/load');
    assert.equal(requests[0].params._meta.modelId, 'model-1');

    globalModel = 'model-2';
    loadGate.resolve({
        _meta: {
            modelState: {
                currentModelId: 'model-1',
                availableModels: [
                    { modelId: 'model-1', name: 'Model 1' },
                    { modelId: 'model-2', name: 'Model 2' }
                ]
            }
        }
    });
    const loaded = await loading;

    assert.deepEqual(requests[1], {
        method: 'session/set_model',
        params: { sessionId: historical.acpSessionId, modelId: 'model-2' }
    });
    assert.equal(loaded.status, 'idle');
    assert.equal(loaded.model, 'model-2');
    assert.equal(records.get(historical.appSessionId).model, 'model-2');
    assert.equal(host.selectedModel, 'model-2');
    assert.equal(host.activeSessionId, historical.appSessionId);
});

test('historical model-state notification during session/load cannot replace the global model', async () => {
    const host = baseHost();
    const historical = session('load-model-notification-race', { model: 'model-1' });
    const records = attachSessionRepository(host, [historical]);
    const loadGate = deferred();
    const notificationHandlers = new Map();
    let globalModel = 'model-2';
    host.selectedModel = globalModel;
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => globalModel,
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' }),
        selectPreferredModel: (_providerId, modelId) => { globalModel = modelId; }
    };
    host.onProviderDefaultsChanged = () => undefined;
    host.acceptModelState = (...args) =>
        GrokAgentHostService.prototype.acceptModelState.call(host, ...args);
    host.acp = {
        onNotification: (method, handler) => notificationHandlers.set(method, handler),
        onRequest: () => undefined,
        onError: () => undefined,
        request: async method => {
            if (method === 'session/load') return loadGate.promise;
            if (method === 'session/set_model') return {};
            throw new Error(`unexpected ACP method ${method}`);
        }
    };
    host.bindAcp(host.acp);

    const loading = host.loadSession(historical.appSessionId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.isSessionRestoring(historical.appSessionId), true);

    // Grok can publish this unscoped extension while replaying an M1 history.
    // It is descriptive session/runtime state, not authority to persist M1 as
    // the application-wide default that the user already set to M2.
    notificationHandlers.get('_x.ai/model_state_updated')({
        modelState: {
            currentModelId: 'model-1',
            availableModels: [{ modelId: 'model-1', name: 'Model 1' }]
        }
    });
    loadGate.resolve({
        _meta: {
            modelState: {
                currentModelId: 'model-1',
                availableModels: [{ modelId: 'model-1', name: 'Model 1' }]
            }
        }
    });

    let loadError;
    try {
        await loading;
    } catch (error) {
        loadError = error;
    }
    const finalRecord = records.get(historical.appSessionId);

    assert.equal(globalModel, 'model-2', 'history must never persist M1 over the global M2 choice');
    if (finalRecord.status === 'read-only') {
        assert.ok(loadError, 'an unavailable global M2 should leave this history read-only');
        assert.equal(host.activeSessionId, undefined);
    } else {
        assert.equal(loadError, undefined);
        assert.equal(finalRecord.model, 'model-2');
        assert.equal(host.selectedModel, 'model-2');
    }
});

test('active reasoning drift notification resynchronizes the global preference only when explicit', () => {
    const host = baseHost();
    const active = session('reasoning-notification-drift', {
        model: 'model-1',
        reasoningEffort: 'xhigh'
    });
    const records = attachSessionRepository(host, [active]);
    const notificationHandlers = new Map();
    let synchronizations = 0;
    host.activeSessionId = active.appSessionId;
    host.loadedSessionIds.add(active.appSessionId);
    host.acpSessionLookup.set(active.acpSessionId, active.appSessionId);
    host.models = [{
        id: 'model-1',
        name: 'Model 1',
        reasoningOptions: [
            { id: 'high', value: 'high', name: 'High', default: true },
            { id: 'deep', value: 'xhigh', name: 'Deep' }
        ]
    }];
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        preferredModelId: () => 'model-1',
        preferredReasoningEffort: () => 'xhigh',
        get: id => ({ id, name: 'Grok subscription', kind: 'grok-subscription' })
    };
    host.notifyProviderDefaultsChanged = () => { synchronizations += 1; };
    host.acp = {
        onNotification: (method, handler) => notificationHandlers.set(method, handler),
        onRequest: () => undefined,
        onError: () => undefined
    };
    host.bindAcp(host.acp);

    const notifyModelState = meta => notificationHandlers.get('_x.ai/model_state_updated')({
        sessionId: active.acpSessionId,
        modelState: {
            currentModelId: 'model-1',
            availableModels: [{
                modelId: 'model-1',
                name: 'Model 1',
                _meta: {
                    supportsReasoningEffort: true,
                    reasoningEfforts: [
                        { id: 'high', value: 'high', label: 'High' },
                        { id: 'deep', value: 'xhigh', label: 'Deep' }
                    ],
                    ...meta
                }
            }]
        }
    });

    notifyModelState({});
    assert.equal(synchronizations, 0,
        'an omitted reasoningEffort is compatible metadata, not evidence of drift');

    notifyModelState({ reasoningEffort: 'high' });
    assert.equal(synchronizations, 1,
        'an explicit high report must re-apply the durable xhigh preference');
    assert.equal(records.get(active.appSessionId).reasoningEffort, 'high',
        'the notification remains descriptive until the serialized global synchronization runs');
});

test('cross-Provider history rebind preserves the initialize catalogue and can select Grok 4.6', async () => {
    const host = baseHost();
    const historical = session('relay-history', {
        providerId: 'xora-relay',
        providerRuntimeEpoch: 'relay-epoch',
        model: 'xora-relay'
    });
    const records = attachSessionRepository(host, [historical]);
    let preferredModel = 'grok-build';
    const subscription = { id: 'grok-subscription', name: 'Grok subscription', kind: 'grok-subscription' };
    const relay = {
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example.invalid/v1',
        model: 'grok-4.5',
        secretRef: 'provider:xora-relay'
    };
    host.providers = {
        selectedProviderId: () => subscription.id,
        runtimeEpoch: providerId => providerId === relay.id ? 'relay-epoch' : 'subscription-epoch',
        preferredModelId: providerId => providerId === subscription.id ? preferredModel : relay.id,
        selectPreferredModel: (providerId, modelId) => {
            assert.equal(providerId, subscription.id);
            preferredModel = modelId;
        },
        get: id => id === subscription.id ? subscription : id === relay.id ? relay : undefined,
        list: () => [subscription, relay]
    };
    host.providerId = subscription.id;
    host.runtimeProviderEpoch = 'subscription-epoch';
    host.selectedModel = preferredModel;
    host.acceptModelState = (...args) =>
        GrokAgentHostService.prototype.acceptModelState.call(host, ...args);
    host.acceptSessionModeCapability = () => undefined;
    host.scheduleMcpStatusRefresh = () => undefined;
    host.publishContextState = () => undefined;
    host.contextStates = () => new Map();
    host.contextEventHighwaters = new Map();
    host.sessionGoalStateMap = () => new Map();
    host.sessionPlanState = () => new Map();
    host.pendingApprovedPlanState = () => new Map();
    host.sessionTaskContractState = () => new Map();
    host.replayedGoalStateMap = () => new Map();
    host.pendingPlanApprovalState = () => new Map();
    host.acpGoalCapabilityState = () => new Map();
    host.updateTaskContractLifecycle = () => undefined;
    host.lifecycleTail = Promise.resolve();
    host.onProviderDefaultsChanged = () => undefined;

    // Only initialize owns replacement semantics: an obsolete process model
    // disappears when the subscription runtime advertises its full catalogue.
    host.models = [{ id: 'obsolete-runtime-model', name: 'Obsolete runtime model' }];
    host.acceptInitialize({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        _meta: {
            modelState: {
                currentModelId: 'grok-build',
                availableModels: [
                    { modelId: 'grok-build', name: 'Grok Build' },
                    {
                        modelId: 'grok-4.6',
                        name: 'Grok 4.6',
                        _meta: {
                            supportsReasoningEffort: true,
                            reasoningEffort: 'high',
                            reasoningEfforts: [
                                { id: 'high', value: 'high', label: 'High' },
                                { id: 'deep', value: 'xhigh', label: 'Deep' }
                            ]
                        }
                    },
                    { modelId: 'grok-4.5', name: 'Grok 4.5' }
                ]
            }
        }
    }, false);
    assert.deepEqual(host.models.map(model => model.id), ['grok-build', 'grok-4.6', 'grok-4.5']);

    const requests = [];
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'session/new') {
                // Grok Build can return a session-scoped subset here. It is
                // not authority to erase grok-4.6 from the runtime catalogue.
                return {
                    sessionId: 'acp-subscription-history',
                    _meta: {
                        modelState: {
                            currentModelId: 'grok-build',
                            availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }]
                        }
                    }
                };
            }
            if (method === 'session/set_model') return {};
            throw new Error(`unexpected ACP method ${method}`);
        }
    };

    const rebound = await host.loadSession(historical.appSessionId);

    assert.equal(rebound.appSessionId, historical.appSessionId,
        'Provider rebinding must preserve the local conversation identity');
    assert.equal(rebound.acpSessionId, 'acp-subscription-history');
    assert.equal(rebound.providerId, subscription.id);
    assert.equal(records.size, 1, 'rebinding must not create a second local conversation');
    assert.deepEqual(host.models.map(model => model.id), ['grok-build', 'grok-4.6', 'grok-4.5'],
        'a session-scoped modelState must not shrink the initialize catalogue');
    assert.deepEqual(requests.map(request => request.method), ['session/new'],
        'old prompts and the old Provider ACP session must never be replayed');
    assert.equal(JSON.stringify(requests[0].params).includes(historical.acpSessionId), false);

    await host.selectModel(historical.appSessionId, 'grok-4.6', 'xhigh');

    assert.equal(preferredModel, 'grok-4.6');
    assert.equal(records.get(historical.appSessionId).model, 'grok-4.6');
    assert.equal(records.get(historical.appSessionId).reasoningEffort, 'xhigh');
    assert.equal(records.get(historical.appSessionId).appSessionId, historical.appSessionId);
    assert.deepEqual(requests[1], {
        method: 'session/set_model',
        params: {
            sessionId: 'acp-subscription-history',
            modelId: 'grok-4.6',
            _meta: { reasoningEffort: 'xhigh' }
        }
    });
});

test('runtime start rejects a stale Provider before launch even if peer defaults notification is delayed', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    let launches = 0;
    host.disposed = false;
    host.workspaceRoot = '/fixture';
    host.attachedWorkspaceRoots = new Set(['/fixture']);
    host.security = { canonicalRoot: value => value };
    host.providers = {
        get: id => ({ id, name: id, kind: 'grok-subscription' }),
        selectedProviderId: () => 'new-provider'
    };
    host.supervisor = {
        running: false,
        launch: () => { launches += 1; throw new Error('must not launch'); }
    };

    await assert.rejects(
        host.startRuntimeLocked({ workspaceRoot: '/fixture', providerId: 'old-provider' }),
        /application-wide model service changed/i
    );
    assert.equal(launches, 0);
});

test('runtime start finishing after M1 -> M2 exposes the latest global model without needing peer notification', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    let globalModel = 'model-1';
    const profile = { id: 'grok-subscription', name: 'Grok subscription', kind: 'grok-subscription' };
    const initializeWritten = deferred();
    let initializeRequest;
    let input = '';
    stdin.on('data', chunk => {
        input += chunk.toString('utf8');
        const newline = input.indexOf('\n');
        if (newline < 0 || initializeRequest) return;
        initializeRequest = JSON.parse(input.slice(0, newline));
        initializeWritten.resolve();
    });

    host.disposed = false;
    host.workspaceRoot = '/fixture';
    host.attachedWorkspaceRoots = new Set(['/fixture']);
    host.security = { canonicalRoot: value => value };
    host.providers = {
        get: id => id === profile.id ? profile : undefined,
        selectedProviderId: () => profile.id,
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => globalModel,
        selectPreferredModel: () => undefined,
        withProviderEnvironment: (_id, operation) => operation({}, profile, 'subscription-epoch'),
        mcpEnvironment: () => ({}),
        redactionSecrets: () => []
    };
    host.supervisor = {
        running: false,
        launch: () => ({ process: child, version: '0.2.102' }),
        stop: async () => undefined
    };
    host.acp = undefined;
    host.runtimeGeneration = 0;
    host.sessionLoadGeneration = 0;
    host.loadedSessionIds = new Set();
    host.currentSecrets = [];
    host.models = [];
    host.selectedModel = undefined;
    host.phase = 'stopped';
    host.intentionalStop = false;
    host.isWorkspaceTrusted = () => false;
    host.bindAcp = () => undefined;
    host.onProviderDefaultsChanged = () => undefined;
    host.publishSubscriptionAuthStatus = () => undefined;
    host.emitSnapshot = () => undefined;
    host.emitError = (_code, error) => { throw error; };
    host.snapshot = () => ({
        phase: host.phase,
        providerId: host.providerId,
        selectedModel: host.selectedModel
    });

    const starting = host.startRuntimeLocked({
        workspaceRoot: '/fixture',
        providerId: profile.id
    });
    await initializeWritten.promise;
    assert.equal(initializeRequest.method, 'initialize');

    globalModel = 'model-2';
    stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: initializeRequest.id,
        result: {
            _meta: {
                modelState: {
                    currentModelId: 'model-1',
                    availableModels: [
                        { modelId: 'model-1', name: 'Model 1' },
                        { modelId: 'model-2', name: 'Model 2' }
                    ]
                }
            }
        }
    })}\n`);
    const snapshot = await starting;

    assert.equal(snapshot.phase, 'ready');
    assert.equal(snapshot.providerId, profile.id);
    assert.equal(snapshot.selectedModel, 'model-2');
    stdout.end();
    stdin.end();
});

test('custom Provider routing ids survive renderer redaction while credentials remain hidden', async () => {
    const host = Object.create(GrokAgentHostService.prototype);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    const profile = {
        id: 'xora-relay',
        name: 'Relay',
        kind: 'custom',
        model: 'grok-4.5',
        protocol: 'openai-responses',
        backendSearch: true
    };
    const credential = 'fixture-secret-that-must-be-redacted';
    const initializeWritten = deferred();
    let initializeRequest;
    let input = '';
    stdin.on('data', chunk => {
        input += chunk.toString('utf8');
        const newline = input.indexOf('\n');
        if (newline < 0 || initializeRequest) return;
        initializeRequest = JSON.parse(input.slice(0, newline));
        initializeWritten.resolve();
    });

    const events = [];
    host.disposed = false;
    host.workspaceRoot = '/fixture';
    host.attachedWorkspaceRoots = new Set(['/fixture']);
    host.theiaTrustedRoots = new Set();
    host.security = {
        canonicalRoot: value => value,
        agentPermissionMode: () => 'request-approval',
        isTrusted: () => false
    };
    host.providers = {
        get: id => id === profile.id ? profile : undefined,
        selectedProviderId: () => profile.id,
        runtimeEpoch: () => 'relay-epoch',
        preferredModelId: () => profile.id,
        selectPreferredModel: () => undefined,
        withProviderEnvironment: (_id, operation) => operation({
            XORA_CODE_PROVIDER_XORA_RELAY: credential,
            GROK_WEB_SEARCH_MODEL: profile.id
        }, profile, 'relay-epoch'),
        mcpEnvironment: () => ({}),
        redactionSecrets: () => [credential]
    };
    host.supervisor = {
        running: false,
        launch: () => ({ process: child, version: '0.2.102' }),
        stop: async () => undefined
    };
    host.sessions = { list: () => [], appendEvent: () => undefined };
    host.client = { onAgentEvent: event => events.push(event) };
    host.acp = undefined;
    host.runtimeGeneration = 0;
    host.sessionLoadGeneration = 0;
    host.snapshotRevision = 0;
    host.loadedSessionIds = new Set();
    host.knownSessionIds = new Set();
    host.currentSecrets = [];
    host.sessionContexts = new Map();
    host.models = [];
    host.selectedModel = undefined;
    host.phase = 'stopped';
    host.intentionalStop = false;
    host.grokSubscriptionAuthStatus = 'unknown';
    host.isWorkspaceTrusted = () => false;
    host.bindAcp = () => undefined;
    host.onProviderDefaultsChanged = () => undefined;
    host.publishSubscriptionAuthStatus = () => undefined;

    const starting = host.startRuntimeLocked({
        workspaceRoot: '/fixture',
        providerId: profile.id
    });
    await initializeWritten.promise;
    stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: initializeRequest.id,
        result: {
            protocolVersion: 1,
            agentCapabilities: {},
            authMethods: [],
            _meta: {
                modelState: {
                    currentModelId: profile.id,
                    availableModels: [{ modelId: profile.id, name: profile.name }]
                }
            }
        }
    })}\n`);

    const snapshot = await starting;
    assert.equal(snapshot.phase, 'ready');
    assert.equal(snapshot.providerId, profile.id);
    assert.equal(snapshot.selectedModel, profile.id);
    assert.deepEqual(snapshot.models.map(model => model.id), [profile.id]);

    host.emit({
        kind: 'error',
        code: 'REDACTION_FIXTURE',
        message: `${credential}|${profile.id}`,
        recoverable: true
    }, false);
    const lastEvent = events.at(-1);
    assert.equal(lastEvent.message, `[REDACTED]|${profile.id}`);
    assert.ok(events.some(event => event.kind === 'snapshot'
        && event.snapshot.providerId === profile.id
        && event.snapshot.selectedModel === profile.id));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(credential));

    stdout.end();
    stdin.end();
});

test('session creation rejects a stale Provider before ACP session/new without waiting for peer notification', async () => {
    const host = baseHost();
    let acpRequests = 0;
    attachSessionRepository(host);
    host.providers = {
        selectedProviderId: () => 'relay-selected-elsewhere',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => 'model-1',
        get: id => ({ id, name: id, kind: 'grok-subscription' }),
        selectPreferredModel: () => undefined
    };
    host.acp = { request: async () => { acpRequests += 1; return {}; } };

    await assert.rejects(
        host.createSession({
            workspaceRoot: '/fixture',
            providerId: 'grok-subscription',
            model: 'model-1'
        }),
        /application-wide model service changed/i
    );
    assert.equal(acpRequests, 0);
});

test('prompt send revalidates ProviderRegistry before ACP, while an already-started prompt may finish', async () => {
    const host = baseHost();
    let record = session('prompt-race');
    const records = attachSessionRepository(host, [record]);
    host.activeSessionId = record.appSessionId;
    host.loadedSessionIds.add(record.appSessionId);
    let globalProvider = 'other-provider';
    let globalModel = 'model-1';
    const promptGate = deferred();
    let promptStarts = 0;
    host.providers = {
        selectedProviderId: () => globalProvider,
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => globalModel,
        get: id => ({ id, name: id, kind: 'grok-subscription' }),
        selectPreferredModel: () => undefined
    };
    host.acp = {
        startRequest: () => {
            promptStarts += 1;
            return { promise: promptGate.promise, cancel: async () => undefined };
        }
    };

    await assert.rejects(
        host.sendPrompt({ sessionId: record.appSessionId, text: 'must not cross ACP' }),
        /application-wide model service changed/i
    );
    assert.equal(promptStarts, 0);

    globalProvider = 'grok-subscription';
    globalModel = 'model-2';
    await assert.rejects(
        host.sendPrompt({ sessionId: record.appSessionId, text: 'stale model must not cross ACP' }),
        /application-wide model changed/i
    );
    assert.equal(promptStarts, 0);

    // A prompt which passed the boundary while the registry was coherent is
    // allowed to complete. The later preference is applied by the defaults
    // refresh path after the turn, not by cancelling the in-flight request.
    globalModel = 'model-1';
    const sending = host.sendPrompt({ sessionId: record.appSessionId, text: 'already started' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(promptStarts, 1);
    globalModel = 'model-2';
    promptGate.resolve({ stopReason: 'end_turn' });
    await sending;

    record = records.get(record.appSessionId);
    assert.equal(record.status, 'completed');
    assert.equal(promptStarts, 1);
});

test('two loaded sessions run concurrently without stealing the visible session', async () => {
    const host = baseHost();
    const sessionA = session('parallel-a');
    const sessionB = session('parallel-b');
    const records = attachSessionRepository(host, [sessionA, sessionB]);
    const gates = new Map([
        [sessionA.acpSessionId, deferred()],
        [sessionB.acpSessionId, deferred()]
    ]);
    const starts = [];
    host.activeSessionId = sessionB.appSessionId;
    host.loadedSessionIds = new Set([sessionA.appSessionId, sessionB.appSessionId]);
    host.capabilities = { prompt: { image: false } };
    host.providers = {
        selectedProviderId: () => 'grok-subscription',
        runtimeEpoch: () => 'subscription-epoch',
        preferredModelId: () => 'model-1',
        get: id => ({ id, name: id, kind: 'grok-subscription' }),
        selectPreferredModel: () => undefined
    };
    host.acp = {
        startRequest: (_method, params) => {
            starts.push(params.sessionId);
            const gate = gates.get(params.sessionId);
            return { promise: gate.promise, cancel: async () => undefined };
        }
    };

    const sendingA = host.sendPrompt({ sessionId: sessionA.appSessionId, text: '任务 A' });
    const sendingB = host.sendPrompt({ sessionId: sessionB.appSessionId, text: '任务 B' });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(new Set(starts), new Set([sessionA.acpSessionId, sessionB.acpSessionId]));
    assert.equal(host.activePrompts.size, 2);
    assert.equal(host.activeSessionId, sessionB.appSessionId,
        'a background prompt must not replace the conversation selected by the user');
    assert.equal(records.get(sessionA.appSessionId).status, 'running');
    assert.equal(records.get(sessionB.appSessionId).status, 'running');

    gates.get(sessionB.acpSessionId).resolve({ stopReason: 'end_turn' });
    await sendingB;
    assert.equal(records.get(sessionB.appSessionId).status, 'completed');
    assert.equal(records.get(sessionA.appSessionId).status, 'running');

    gates.get(sessionA.acpSessionId).resolve({ stopReason: 'end_turn' });
    await sendingA;
    assert.equal(records.get(sessionA.appSessionId).status, 'completed');
    assert.equal(host.activePrompts.size, 0);
    assert.equal(host.activeSessionId, sessionB.appSessionId);
});

for (const mismatch of [
    {
        name: 'runtime epoch differs from the session record',
        runtimeEpoch: 'different-runtime-epoch',
        registryEpoch: 'subscription-epoch'
    },
    {
        name: 'registry epoch differs from the session record',
        runtimeEpoch: 'subscription-epoch',
        registryEpoch: 'rotated-provider-epoch'
    }
]) {
    test(`prompt send is fail-closed with zero ACP prompt when ${mismatch.name}`, async () => {
        const host = baseHost();
        const record = session(`epoch-${mismatch.runtimeEpoch}`);
        const records = attachSessionRepository(host, [record]);
        host.activeSessionId = record.appSessionId;
        host.loadedSessionIds.add(record.appSessionId);
        host.runtimeProviderEpoch = mismatch.runtimeEpoch;
        let promptStarts = 0;
        host.providers = {
            selectedProviderId: () => 'grok-subscription',
            runtimeEpoch: () => mismatch.registryEpoch,
            preferredModelId: () => 'model-1',
            get: id => ({ id, name: id, kind: 'grok-subscription' }),
            selectPreferredModel: () => undefined
        };
        host.acp = {
            startRequest: () => {
                promptStarts += 1;
                throw new Error('must not send prompt');
            }
        };

        await assert.rejects(
            host.sendPrompt({ sessionId: record.appSessionId, text: 'blocked by epoch' }),
            /Provider changed after this session was created/i
        );
        assert.equal(promptStarts, 0);
        assert.equal(records.get(record.appSessionId).status, 'read-only');
    });
}
