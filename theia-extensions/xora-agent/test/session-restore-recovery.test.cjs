const assert = require('node:assert/strict');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { AcpRemoteError } = require('@xora-code/acp-client');
const { SessionNotFoundError, SessionPromptConflictError } = require('../lib/electron-main/session-repository');

function fixture() {
    const host = Object.create(GrokAgentHostService.prototype);
    let record = {
        appSessionId: '10000000-0000-4000-8000-000000000001',
        acpSessionId: 'acp-expired',
        title: 'Recovery fixture',
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription',
        providerRuntimeEpoch: 'fixture-epoch',
        model: 'old-model',
        status: 'completed',
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T00:00:00.000Z'
    };
    const requests = [];
    let ownership = 'none';
    host.sessions = {
        get: id => id === record.appSessionId ? record : undefined,
        update: (_id, patch) => (record = { ...record, ...patch }),
        list: () => [record],
        promptClaimOwnership: () => ownership
    };
    host.providers = {
        selectedProviderId: () => record.providerId,
        runtimeEpoch: () => 'fixture-epoch',
        preferredModelId: () => 'new-model',
        get: id => ({ id, name: 'Fixture', kind: 'grok-subscription' })
    };
    host.security = { canonicalRoot: value => value };
    host.activeSessionId = record.appSessionId;
    host.workspaceRoot = record.workspaceRoot;
    host.providerId = record.providerId;
    host.phase = 'ready';
    host.runtimeGeneration = 7;
    host.runtimeProviderEpoch = 'fixture-epoch';
    host.sidecarVersion = '1.0.50';
    host.models = [{ id: 'old-model' }, { id: 'new-model' }];
    host.knownSessionIds = new Set([record.appSessionId]);
    host.loadedSessionIds = new Set([record.appSessionId]);
    host.acpSessionLookup = new Map([[record.acpSessionId, record.appSessionId]]);
    host.restoringSessionCounts = new Map();
    host.activePrompts = new Map();
    host.currentSecrets = [];
    host.emit = () => undefined;
    host.emitSnapshot = () => undefined;
    host.scheduleMcpStatusRefresh = () => undefined;
    host.acp = {
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'session/set_model' && params.sessionId === 'acp-expired') {
                throw new AcpRemoteError(1, method, { code: -32602, message: 'Unknown session: acp-expired' });
            }
            if (method === 'session/new') return { sessionId: 'acp-recovered' };
            if (method === 'session/set_model') return {};
            assert.fail(`Recovery must not issue ${method}`);
        }
    };
    return {
        host, requests,
        record: () => record,
        changeRecord: patch => (record = { ...record, ...patch }),
        claim: () => { record = { ...record, status: 'running' }; ownership = 'foreign'; },
        load: () => host.loadSessionUncoalesced(record.appSessionId, () => undefined, {
            mcpServers: [], configuredNames: [], enabledNames: [], fingerprint: 'fixture-mcp'
        })
    };
}

test('an expired visible loaded session reconnects without replaying its history or prompt', async () => {
    const f = fixture();
    const originalId = f.record().appSessionId;
    const loaded = await f.load();

    assert.equal(loaded.appSessionId, originalId);
    assert.equal(loaded.acpSessionId, 'acp-recovered');
    assert.equal(loaded.status, 'idle');
    assert.deepEqual(f.requests.map(request => request.method), [
        'session/set_model', 'session/new', 'session/set_model'
    ]);
    assert.equal(f.host.acpSessionLookup.has('acp-expired'), false);
    assert.equal(f.host.acpSessionLookup.get('acp-recovered'), originalId);
    assert.deepEqual(f.requests[1].params, {
        cwd: '/fixture', mcpServers: [], _meta: { modelId: 'new-model' }
    });
});

test('successful synchronization of a visible loaded session avoids redundant restore requests', async () => {
    const f = fixture();
    f.host.acp.request = async (method, params) => {
        f.requests.push({ method, params });
        return {};
    };
    const loaded = await f.load();

    assert.equal(loaded.acpSessionId, 'acp-expired');
    assert.equal(loaded.model, 'new-model');
    assert.deepEqual(f.requests.map(request => request.method), ['session/set_model']);
});

test('a runtime replacement during loaded-session synchronization never creates a replacement session', async () => {
    const f = fixture();
    f.host.acp.request = async (method, params) => {
        f.requests.push({ method, params });
        f.host.runtimeGeneration += 1;
        throw new AcpRemoteError(1, method, { code: -32602, message: 'Unknown session: acp-expired' });
    };
    await assert.rejects(f.load(), /Unknown session/);
    assert.deepEqual(f.requests.map(request => request.method), ['session/set_model']);
    assert.equal(f.record().acpSessionId, 'acp-expired');
});

test('a foreign prompt claim acquired while synchronization is pending prevents rebinding', async () => {
    const f = fixture();
    f.host.acp.request = async (method, params) => {
        f.requests.push({ method, params });
        f.claim();
        throw new AcpRemoteError(1, method, { code: -32602, message: 'Unknown session: acp-expired' });
    };
    await assert.rejects(f.load(), SessionPromptConflictError);
    assert.deepEqual(f.requests.map(request => request.method), ['session/set_model']);
    assert.equal(f.record().status, 'running');
    assert.equal(f.record().acpSessionId, 'acp-expired');
});

test('an already-running session cannot enter loaded-session recovery', async () => {
    const f = fixture();
    f.changeRecord({ status: 'running' });
    await assert.rejects(f.load(), SessionPromptConflictError);
    assert.deepEqual(f.requests, []);
});

test('a conversation removed while synchronization is pending is not recreated', async () => {
    const f = fixture();
    f.host.acp.request = async (method, params) => {
        f.requests.push({ method, params });
        f.host.sessions.get = () => undefined;
        throw new AcpRemoteError(1, method, { code: -32602, message: 'Unknown session: acp-expired' });
    };
    await assert.rejects(f.load(), SessionNotFoundError);
    assert.deepEqual(f.requests.map(request => request.method), ['session/set_model']);
});

test('a Provider epoch change cannot recover on the previous credential-bound runtime', async () => {
    const f = fixture();
    const runtimeStarts = [];
    f.host.startRuntime = async request => {
        runtimeStarts.push(request);
        throw new Error('AUTHENTICATION_REQUIRED');
    };
    f.host.acp.request = async (method, params) => {
        f.requests.push({ method, params });
        f.host.providers.runtimeEpoch = () => 'new-credential-epoch';
        throw new AcpRemoteError(1, method, { code: -32602, message: 'Unknown session: acp-expired' });
    };
    await assert.rejects(f.load(), /AUTHENTICATION_REQUIRED/);
    assert.deepEqual(f.requests.map(request => request.method), ['session/set_model']);
    assert.deepEqual(runtimeStarts, [{ workspaceRoot: '/fixture', providerId: 'grok-subscription' }]);
    assert.equal(f.record().providerRuntimeEpoch, 'fixture-epoch');
    assert.equal(f.record().acpSessionId, 'acp-expired');
});
