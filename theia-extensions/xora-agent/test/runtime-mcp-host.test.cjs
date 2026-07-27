const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AcpRemoteError } = require('@xora-code/acp-client');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { RuntimeMcpRegistry } = require('../lib/electron-main/runtime-mcp-registry');

const MCP_SERVERS = Object.freeze([Object.freeze({
    name: 'camoufox-reverse',
    command: '/opt/xora/python',
    args: Object.freeze(['-m', 'camoufox_reverse_mcp']),
    env: Object.freeze([Object.freeze({ name: 'CAMOUFOX_TOKEN', value: 'main-process-only-secret' })])
})]);

const MCP_SNAPSHOT = Object.freeze({
    mcpServers: MCP_SERVERS,
    fingerprint: 'fixture-mcp-fingerprint',
    configuredNames: Object.freeze(['camoufox-reverse']),
    enabledNames: Object.freeze(['camoufox-reverse']),
    redactionValues: Object.freeze(['main-process-only-secret'])
});

const UPDATED_MCP_SERVERS = Object.freeze([Object.freeze({
    name: 'updated-browser',
    command: '/opt/xora/updated-browser',
    args: Object.freeze([]),
    env: Object.freeze([])
})]);

const UPDATED_MCP_SNAPSHOT = Object.freeze({
    mcpServers: UPDATED_MCP_SERVERS,
    fingerprint: 'updated-mcp-fingerprint',
    configuredNames: Object.freeze(['updated-browser']),
    enabledNames: Object.freeze(['updated-browser']),
    redactionValues: Object.freeze([])
});

function tick() {
    return new Promise(resolve => setImmediate(resolve));
}

function session(appSessionId, overrides = {}) {
    return {
        appSessionId,
        acpSessionId: `acp-${appSessionId}`,
        title: `Session ${appSessionId}`,
        workspaceRoot: '/fixture',
        providerId: 'provider-a',
        providerRuntimeEpoch: 'epoch-a',
        model: undefined,
        sidecarVersion: '0.2.102',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
        status: 'idle',
        ...overrides
    };
}

function createSessionRepository(host, initial = []) {
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
            if (!current) throw new Error(`Missing fixture session ${id}.`);
            const updated = { ...current, ...patch };
            records.set(id, updated);
            return updated;
        },
        flushEvents: () => undefined
    };
    return records;
}

function createHost(initial = []) {
    const host = Object.create(GrokAgentHostService.prototype);
    const providerState = { id: 'provider-a', epoch: 'epoch-a' };
    const requests = [];

    host.workspaceRoot = '/fixture';
    host.providerId = providerState.id;
    host.selectedModel = undefined;
    host.phase = 'ready';
    host.runtimeProviderEpoch = providerState.epoch;
    host.runtimeGeneration = 1;
    host.sessionLoadGeneration = 0;
    host.providerDefaultsGeneration = 0;
    host.sidecarVersion = '0.2.102';
    host.models = [];
    host.knownSessionIds = new Set();
    host.acpSessionLookup = new Map();
    host.loadedSessionIds = new Set();
    host.restoringSessionCounts = new Map();
    host.pendingSessionLoads = new Map();
    host.activePrompts = new Map();
    host.currentSecrets = [];
    host.supportsAdditionalDirectories = false;
    host.attachedWorkspaceRoots = new Set(['/fixture']);
    host.sessionContexts = new Map();
    host.contextEventHighwaters = new Map();
    host.sessionMcpStates = new Map();
    host.runtimeMcpFingerprint = undefined;
    host.runtimeMcpConfiguredNames = [];
    host.mcpConfigurationRefreshPending = false;
    host.skillsRefreshPending = false;
    host.disposed = false;
    host.lifecycleTail = Promise.resolve();
    host.integrationMutationTail = Promise.resolve();
    host.security = { canonicalRoot: value => value, agentPermissionMode: () => 'request-approval' };
    host.providers = {
        selectedProviderId: () => providerState.id,
        runtimeEpoch: id => id === providerState.id ? providerState.epoch : `stale-${id}`,
        preferredModelId: () => undefined,
        get: id => ({ id, name: id, kind: 'grok-subscription' }),
        list: () => [],
        selectPreferredModel: () => undefined,
        refreshCustomProviderSkillViews: () => undefined
    };
    host.resolveRuntimeMcpSnapshot = root => {
        assert.equal(root, '/fixture');
        return MCP_SNAPSHOT;
    };
    host.acp = {
        request: async (method, params, options) => {
            requests.push({ method, params, options });
            if (method === 'session/new') {
                return { sessionId: `acp-new-${requests.filter(request => request.method === method).length}` };
            }
            return {};
        }
    };
    host.flushAssistantTextDeltas = () => undefined;
    host.assistantStreamState = () => new Set();
    host.acceptModelState = () => undefined;
    host.acceptPromptContextFallback = () => undefined;
    host.scheduleMcpStatusRefresh = () => undefined;
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    host.emitError = (_code, error) => { throw error; };
    host.notifyProviderDefaultsChanged = () => undefined;
    host.publishContextState = () => undefined;
    const records = createSessionRepository(host, initial);

    return {
        host,
        records,
        requests,
        switchProvider(id, epoch) {
            providerState.id = id;
            providerState.epoch = epoch;
            host.providerId = id;
            host.runtimeProviderEpoch = epoch;
        }
    };
}

test('session/new and Provider rebind inject the same canonical non-empty MCP snapshot', async () => {
    const fixture = createHost();
    const created = await fixture.host.createSession({
        workspaceRoot: '/fixture',
        providerId: 'provider-a',
        title: 'Canonical MCP'
    });

    assert.deepEqual(fixture.requests[0], {
        method: 'session/new',
        params: { cwd: '/fixture', mcpServers: MCP_SERVERS },
        options: { timeoutMs: 30_000 }
    });
    assert.ok(fixture.requests[0].params.mcpServers.length > 0);

    fixture.switchProvider('provider-b', 'epoch-b');
    fixture.requests.length = 0;
    const rebound = await fixture.host.loadSession(created.appSessionId);

    assert.equal(rebound.providerId, 'provider-b');
    assert.equal(rebound.providerRuntimeEpoch, 'epoch-b');
    assert.deepEqual(fixture.requests, [{
        method: 'session/new',
        params: { cwd: '/fixture', mcpServers: MCP_SERVERS },
        options: { timeoutMs: 30_000 }
    }]);
    assert.strictEqual(fixture.requests[0].params.mcpServers, MCP_SNAPSHOT.mcpServers,
        'a Provider change must not select a Provider-local MCP source');
});

test('session/load injects the canonical non-empty MCP snapshot', async () => {
    const existing = session('history');
    const fixture = createHost([existing]);

    const loaded = await fixture.host.loadSession(existing.appSessionId);

    assert.equal(loaded.appSessionId, existing.appSessionId);
    assert.deepEqual(fixture.requests, [{
        method: 'session/load',
        params: {
            sessionId: existing.acpSessionId,
            cwd: '/fixture',
            mcpServers: MCP_SERVERS
        },
        options: { timeoutMs: 60_000 }
    }]);
    assert.deepEqual(fixture.host.runtimeMcpConfiguredNames, ['camoufox-reverse']);
});

test('session creation owns the integration gate until its snapshot is committed', async () => {
    const fixture = createHost();
    let resolveSession;
    fixture.host.acp.request = (method, params, options) => {
        fixture.requests.push({ method, params, options });
        if (method === 'session/new') {
            return new Promise(resolve => { resolveSession = resolve; });
        }
        return Promise.resolve({ ok: true });
    };

    const creating = fixture.host.createSession({
        workspaceRoot: '/fixture',
        providerId: 'provider-a',
        title: 'Serialized creation'
    });
    await tick();
    const refreshing = fixture.host.withIntegrationMutation(() =>
        fixture.host.withLifecycle(() => fixture.host.refreshIntegrationsLocked(UPDATED_MCP_SNAPSHOT))
    );
    await tick();

    assert.deepEqual(fixture.requests.map(request => request.method), ['session/new'],
        'MCP refresh must wait until session/new has committed its snapshot');
    resolveSession({ sessionId: 'acp-created-serialized' });
    const created = await creating;
    await refreshing;

    assert.deepEqual(fixture.requests.map(request => request.method), [
        'session/new',
        '_x.ai/session/update_mcp_servers'
    ]);
    assert.equal(fixture.requests[1].params.sessionId, 'acp-created-serialized');
    assert.strictEqual(fixture.requests[1].params.mcpServers, UPDATED_MCP_SNAPSHOT.mcpServers);
    assert.equal(fixture.host.loadedSessionIds.has(created.appSessionId), true);
    assert.equal(fixture.host.runtimeMcpFingerprint, UPDATED_MCP_SNAPSHOT.fingerprint,
        'a late session/new completion must not overwrite the newer integration snapshot');
});

test('method-not-found fallback safely rebinds an expired active session before committing MCP state', async () => {
    const existing = session('active');
    const fixture = createHost([existing]);
    fixture.host.activeSessionId = existing.appSessionId;
    fixture.host.loadedSessionIds.add(existing.appSessionId);
    fixture.host.runtimeMcpFingerprint = 'previous-fingerprint';
    fixture.host.acp.request = async (method, params, options) => {
        fixture.requests.push({ method, params, options });
        throw new AcpRemoteError(1, method, { code: -32601, message: 'Method not found' });
    };
    fixture.host.stopRuntimeLocked = async () => {
        fixture.host.loadedSessionIds.clear();
        fixture.host.runtimeMcpFingerprint = undefined;
        fixture.host.runtimeMcpConfiguredNames = [];
        fixture.host.mcpConfigurationRefreshPending = false;
        fixture.host.phase = 'stopped';
        fixture.host.acp = undefined;
    };
    fixture.host.startRuntimeLocked = async () => {
        fixture.host.phase = 'ready';
        fixture.host.runtimeGeneration += 1;
        fixture.host.acp = {
            request: async (method, params, options) => {
                fixture.requests.push({ method, params, options });
                if (method === 'session/load') throw new Error('Unknown remote session');
                if (method === 'session/new') return { sessionId: 'acp-active-rebound' };
                return {};
            }
        };
        return fixture.host.snapshot();
    };

    await fixture.host.refreshIntegrationsLocked(MCP_SNAPSHOT);

    assert.deepEqual(fixture.requests.map(request => request.method), [
        '_x.ai/session/update_mcp_servers',
        'session/load',
        'session/new'
    ]);
    assert.equal(fixture.records.get(existing.appSessionId).acpSessionId, 'acp-active-rebound');
    assert.equal(fixture.host.loadedSessionIds.has(existing.appSessionId), true);
    assert.equal(fixture.host.activeSessionId, existing.appSessionId);
    assert.equal(fixture.host.runtimeMcpFingerprint, MCP_SNAPSHOT.fingerprint);
    assert.equal(fixture.host.mcpConfigurationRefreshPending, false);
});

test('fallback recovery failure stays pending and reports the active session instead of silently detaching it', async () => {
    const existing = session('active');
    const fixture = createHost([existing]);
    const emittedErrors = [];
    fixture.host.emitError = (code, error, recoverable, sessionId) => {
        emittedErrors.push({ code, error, recoverable, sessionId });
    };
    fixture.host.activeSessionId = existing.appSessionId;
    fixture.host.loadedSessionIds.add(existing.appSessionId);
    fixture.host.runtimeMcpFingerprint = 'previous-fingerprint';
    fixture.host.acp.request = async (method, params, options) => {
        fixture.requests.push({ method, params, options });
        throw new AcpRemoteError(1, method, { code: -32601, message: 'Method not found' });
    };
    fixture.host.stopRuntimeLocked = async () => {
        fixture.host.loadedSessionIds.clear();
        fixture.host.runtimeMcpFingerprint = undefined;
        fixture.host.runtimeMcpConfiguredNames = [];
        fixture.host.mcpConfigurationRefreshPending = false;
        fixture.host.phase = 'stopped';
        fixture.host.acp = undefined;
    };
    fixture.host.startRuntimeLocked = async () => {
        fixture.host.phase = 'ready';
        fixture.host.runtimeGeneration += 1;
        fixture.host.acp = {
            request: async (method, params, options) => {
                fixture.requests.push({ method, params, options });
                throw new Error(method === 'session/load' ? 'Unknown remote session' : 'Cannot create replacement session');
            }
        };
        return fixture.host.snapshot();
    };

    await assert.rejects(
        fixture.host.refreshIntegrationsLocked(MCP_SNAPSHOT),
        /Cannot create replacement session/
    );

    assert.equal(fixture.host.runtimeMcpFingerprint, undefined,
        'failed recovery must not commit a globally coherent fingerprint');
    assert.equal(fixture.host.mcpConfigurationRefreshPending, true);
    assert.equal(fixture.host.loadedSessionIds.has(existing.appSessionId), false);
    assert.deepEqual(emittedErrors.map(event => ({
        code: event.code,
        recoverable: event.recoverable,
        sessionId: event.sessionId
    })), [{
        code: 'SESSION_RESTORE_FAILED',
        recoverable: true,
        sessionId: existing.appSessionId
    }]);
});

test('dynamic MCP updates wait for idle and use the exact Grok extension method', async () => {
    const existing = session('loaded');
    const fixture = createHost([existing]);
    fixture.host.loadedSessionIds.add(existing.appSessionId);
    fixture.host.runtimeMcpFingerprint = 'previous-fingerprint';
    fixture.host.runtimeMcpConfiguredNames = ['previous-server'];
    fixture.host.mcpConfigurationRefreshPending = true;
    fixture.host.activePrompts.set(existing.appSessionId, { promise: Promise.resolve({}) });

    await fixture.host.refreshIntegrationsLocked(MCP_SNAPSHOT);
    assert.deepEqual(fixture.requests, [], 'an active Agent turn must not be interrupted by MCP reconfiguration');
    assert.equal(fixture.host.runtimeMcpFingerprint, 'previous-fingerprint');

    fixture.host.activePrompts.clear();
    await fixture.host.refreshIntegrationsLocked(MCP_SNAPSHOT);

    assert.deepEqual(fixture.requests, [{
        method: '_x.ai/session/update_mcp_servers',
        params: {
            sessionId: existing.acpSessionId,
            mcpServers: MCP_SERVERS
        },
        options: { timeoutMs: 45_000 }
    }]);
    assert.equal(fixture.host.runtimeMcpFingerprint, MCP_SNAPSHOT.fingerprint);
    assert.equal(fixture.host.mcpConfigurationRefreshPending, false);
});

test('one stale background session does not block MCP refresh for healthy sessions', async () => {
    const healthy = session('healthy');
    const stale = session('stale');
    const fixture = createHost([healthy, stale]);
    fixture.host.loadedSessionIds.add(healthy.appSessionId);
    fixture.host.loadedSessionIds.add(stale.appSessionId);
    fixture.host.runtimeMcpFingerprint = 'previous-fingerprint';
    fixture.host.acp.request = async (method, params, options) => {
        fixture.requests.push({ method, params, options });
        if (params.sessionId === stale.acpSessionId) throw new Error('unknown session');
        return { ok: true };
    };

    await fixture.host.refreshIntegrationsLocked(MCP_SNAPSHOT);

    assert.equal(fixture.host.runtimeMcpFingerprint, MCP_SNAPSHOT.fingerprint);
    assert.equal(fixture.host.loadedSessionIds.has(healthy.appSessionId), true);
    assert.equal(fixture.host.loadedSessionIds.has(stale.appSessionId), false);
    assert.equal(fixture.host.mcpConfigurationRefreshPending, false);
});

test('MCP runtime list is reduced to name, status and toolCount before renderer projection', async () => {
    const existing = session('loaded');
    const fixture = createHost([existing]);
    fixture.host.loadedSessionIds.add(existing.appSessionId);
    fixture.host.activeSessionId = existing.appSessionId;
    fixture.host.runtimeGeneration = 7;
    fixture.host.runtimeMcpConfiguredNames = ['camoufox-reverse'];
    fixture.host.acp.request = async (method, params, options) => {
        fixture.requests.push({ method, params, options });
        return {
            servers: [{
                name: 'camoufox-reverse',
                displayName: 'secret display name',
                source: '/secret/config.toml',
                headers: { Authorization: 'Bearer should-never-render' },
                session: {
                    enabled: true,
                    status: 'ready',
                    tools: [
                        { name: 'launch_browser', inputSchema: { secret: 'schema-detail' } },
                        { name: 'navigate', error: 'private provider detail' }
                    ],
                    error: 'private runtime failure'
                }
            }, {
                name: 'bad.name',
                session: { status: 'ready', tools: [{ name: 'must-be-ignored' }] }
            }, {
                name: 'unknown-status',
                session: { status: 'connected', tools: [] }
            }]
        };
    };

    await fixture.host.refreshMcpRuntimeStatus();
    const projection = fixture.host.currentMcpRuntimeProjection();

    assert.deepEqual(fixture.requests, [{
        method: '_x.ai/mcp/list',
        params: { sessionId: existing.acpSessionId, cache: true },
        options: { timeoutMs: 12_000 }
    }]);
    assert.deepEqual(projection.servers, [{
        name: 'camoufox-reverse',
        status: 'ready',
        enabled: true,
        toolCount: 2
    }]);
    assert.deepEqual(Object.keys(projection.servers[0]).sort(), ['enabled', 'name', 'status', 'toolCount']);
    assert.doesNotMatch(JSON.stringify(projection), /secret|Bearer|schema-detail|private|launch_browser|navigate/);
});

test('duplicate MCP lifecycle notifications are semantic no-ops instead of list polling loops', () => {
    const existing = session('loaded');
    const fixture = createHost([existing]);
    fixture.host.loadedSessionIds.add(existing.appSessionId);
    fixture.host.acpSessionLookup.set(existing.acpSessionId, existing.appSessionId);
    const scheduled = [];
    fixture.host.scheduleMcpStatusRefresh = appSessionId => scheduled.push(appSessionId);

    const ready = {
        sessionId: existing.acpSessionId,
        name: 'camoufox-reverse',
        status: 'ready',
        reason: 'provider detail must not affect the safe signal',
        tools: [{ name: 'launch_browser' }, { name: 'navigate' }]
    };
    fixture.host.acceptMcpLifecycleNotification('_x.ai/mcp/server_status', ready);
    fixture.host.acceptMcpLifecycleNotification('_x.ai/mcp/server_status', {
        ...ready,
        reason: 'a repeated diagnostic string is not a new renderer state'
    });
    fixture.host.acceptMcpLifecycleNotification('_x.ai/mcp/server_status', {
        ...ready,
        status: 'unavailable'
    });

    assert.deepEqual(scheduled, [existing.appSessionId, existing.appSessionId]);
    assert.equal(fixture.host.mcpLifecycleSignalState().size, 1);
});

test('MCP status refresh is single-flight and bounds a lifecycle burst to one trailing refresh', async () => {
    const existing = session('loaded');
    const fixture = createHost([existing]);
    fixture.host.loadedSessionIds.add(existing.appSessionId);
    fixture.host.activeSessionId = existing.appSessionId;
    let resolveList;
    fixture.host.acp.request = (method, params, options) => {
        fixture.requests.push({ method, params, options });
        return new Promise(resolve => { resolveList = resolve; });
    };
    let trailingRefreshes = 0;
    fixture.host.scheduleMcpStatusRefresh = () => { trailingRefreshes += 1; };

    const first = fixture.host.refreshMcpRuntimeStatus();
    const concurrent = fixture.host.refreshMcpRuntimeStatus();
    await tick();
    assert.equal(fixture.requests.length, 1, 'concurrent callers must share one mcp/list sweep');
    resolveList({ servers: [] });
    await Promise.all([first, concurrent]);

    assert.equal(trailingRefreshes, 1,
        'changes observed during the sweep are represented by at most one trailing refresh');
});

test('a background MCP lifecycle change refreshes only that session, not every hydrated tab', async () => {
    const active = session('active');
    const background = session('background');
    const fixture = createHost([active, background]);
    fixture.host.loadedSessionIds.add(active.appSessionId);
    fixture.host.loadedSessionIds.add(background.appSessionId);
    fixture.host.activeSessionId = active.appSessionId;
    fixture.host.mcpStatusRefreshSessionIdState().add(background.appSessionId);
    fixture.host.acp.request = async (method, params, options) => {
        fixture.requests.push({ method, params, options });
        return { servers: [] };
    };

    await fixture.host.refreshMcpRuntimeStatus();

    assert.deepEqual(fixture.requests.map(request => request.params.sessionId), [background.acpSessionId]);
});

test('shared Grok state changes refresh silently because no user action is required', () => {
    const fixture = createHost();
    const messages = [];
    let refreshes = 0;
    fixture.host.grokSubscriptionAuthStatus = 'authenticated';
    fixture.host.emitSnapshot = message => messages.push(message);
    fixture.host.scheduleIntegrationRefresh = () => { refreshes += 1; };

    fixture.host.notifySharedGrokStateChanged(true, true);

    assert.equal(fixture.host.grokSubscriptionAuthStatus, 'unknown');
    assert.equal(fixture.host.mcpConfigurationRefreshPending, true);
    assert.equal(fixture.host.skillsRefreshPending, true);
    assert.equal(refreshes, 1);
    assert.deepEqual(messages, [undefined]);
});

test('host resolves one config-bound stdio credential into ACP without adding it to the sidecar environment', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-host-mcp-credential-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const workspace = path.join(directory, 'workspace');
    const grokHome = path.join(directory, 'grok-home');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(grokHome, { recursive: true });
    fs.writeFileSync(path.join(grokHome, 'config.toml'), [
        '[mcp_servers.alpha]',
        'command = "node"',
        'args = ["alpha.js"]',
        '',
        '[mcp_servers.alpha.env]',
        'ALPHA_TOKEN = "${ALPHA_TOKEN}"',
        ''
    ].join('\n'));

    const registry = new RuntimeMcpRegistry({ grokHome });
    const identity = registry.credentialConfigurationIdentity(workspace, 'alpha', 'ALPHA_TOKEN');
    const canonicalWorkspace = fs.realpathSync(workspace);
    const host = Object.create(GrokAgentHostService.prototype);
    host.runtimeMcpRegistry = registry;
    host.currentSecrets = [];
    host.theiaTrustedRoots = new Set([workspace]);
    host.isWorkspaceTrusted = root => root === workspace;
    let commandEnvironmentInput = 'not-called';
    let registered;
    host.security = {};
    host.supervisor = {
        commandEnvironment: input => {
            commandEnvironmentInput = input;
            return { PATH: '/fixture/bin' };
        },
        registerRedactionSecrets: values => { registered = [...values]; }
    };
    host.providers = {
        mcpCredentialBindings: root => {
            assert.equal(root, workspace);
            return [{
                workspaceRoot: canonicalWorkspace,
                server: 'alpha',
                environmentName: 'ALPHA_TOKEN',
                configIdentity: identity,
                value: 'host-only-secret'
            }];
        }
    };

    const snapshot = host.resolveRuntimeMcpSnapshot(workspace);
    assert.equal(commandEnvironmentInput, undefined,
        'stored MCP credentials must not enter the sidecar process environment');
    assert.deepEqual(snapshot.mcpServers[0].env, [{ name: 'ALPHA_TOKEN', value: 'host-only-secret' }]);
    assert.deepEqual(registered, ['host-only-secret']);
});
