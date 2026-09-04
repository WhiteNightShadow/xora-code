const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');
const { WorkspaceSecurityStore } = require('../lib/electron-main/workspace-security');
const { AgentHostManager } = require('../lib/electron-main/agent-host-manager');

function record(root, id = 'app-session') {
    return {
        appSessionId: id,
        acpSessionId: `acp-${id}`,
        title: id,
        workspaceRoot: root,
        providerId: 'grok-subscription',
        providerRuntimeEpoch: 'provider-epoch',
        sidecarVersion: '0.2.102',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
        status: 'idle'
    };
}

function hostHarness(root) {
    const host = Object.create(GrokAgentHostService.prototype);
    const session = record(root);
    const emitted = [];
    host.sessions = {
        get: id => id === session.appSessionId ? session : undefined,
        list: () => [session],
        appendEvent: () => undefined
    };
    host.activeSessionId = session.appSessionId;
    host.workspaceRoot = root;
    host.providerId = session.providerId;
    host.runtimeProviderEpoch = session.providerRuntimeEpoch;
    host.sidecarVersion = session.sidecarVersion;
    host.phase = 'ready';
    host.activePrompts = new Map([[session.appSessionId, {}]]);
    host.loadedSessionIds = new Set([session.appSessionId]);
    host.restoringSessionCounts = new Map();
    host.acpSessionLookup = new Map([[session.acpSessionId, session.appSessionId]]);
    host.pendingPermissions = new Map();
    host.currentSecrets = [];
    host.models = [];
    host.providers = {
        selectedProviderId: () => session.providerId,
        runtimeEpoch: () => session.providerRuntimeEpoch
    };
    let permissionMode = 'request-approval';
    host.security = {
        agentPermissionMode: () => permissionMode,
        setAgentPermissionMode: mode => { permissionMode = mode; },
        hasPersistentPermission: () => false
    };
    host.onPermissionModeChanged = () => undefined;
    host.isWorkspaceTrusted = () => true;
    host.emit = event => emitted.push(event);
    host.emitSnapshot = () => undefined;
    host.snapshot = () => ({
        phase: 'ready',
        workspaceRoot: root,
        workspaceTrusted: true,
        providerId: session.providerId,
        models: [],
        sessions: [session],
        activeSessionId: host.activeSessionId,
        permissionMode: host.security.agentPermissionMode()
    });
    return { host, session, emitted, permissionMode: () => permissionMode };
}

function permissionParams(session, rawInput = { command: 'npm test' }, options = [
    { optionId: 'allow-this-time', kind: 'allow_once' },
    { optionId: 'allow-forever', kind: 'allow_always' },
    { optionId: 'reject', kind: 'reject_once' }
]) {
    return {
        sessionId: session.acpSessionId,
        toolCall: {
            toolCallId: 'tool-1',
            title: 'Run tests',
            kind: 'terminal/execute',
            rawInput
        },
        options
    };
}

test('Electron main persists one fail-closed permission mode across app restarts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-global-permission-'));
    const preferencePath = path.join(directory, 'agent-permission-mode.json');
    try {
        const first = Object.create(WorkspaceSecurityStore.prototype);
        first.agentPermissionPath = preferencePath;
        assert.equal(first.agentPermissionMode(), 'request-approval');
        assert.equal(first.setAgentPermissionMode('full-access'), 'full-access');

        const restarted = Object.create(WorkspaceSecurityStore.prototype);
        restarted.agentPermissionPath = preferencePath;
        assert.equal(restarted.agentPermissionMode(), 'full-access');
        assert.throws(() => restarted.setAgentPermissionMode('renderer-invented-mode'), /Unsupported/);

        fs.writeFileSync(preferencePath, '{"permissionMode":"full-access"}', 'utf8');
        assert.equal(restarted.agentPermissionMode(), 'request-approval');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('permission mode changes are broadcast to every other Agent window', () => {
    const manager = Object.create(AgentHostManager.prototype);
    let notifications = 0;
    const source = {};
    const peer = { notifyPermissionModeChanged: () => { notifications += 1; } };
    manager.services = new Set([source, peer]);
    manager.broadcastPermissionMode(source);
    assert.equal(notifications, 1);
});

test('committed session deletion is broadcast explicitly to peer windows', () => {
    const manager = Object.create(AgentHostManager.prototype);
    const received = [];
    const source = { notifySessionDeleted: () => received.push('source') };
    const peer = { notifySessionDeleted: sessionId => received.push(sessionId) };
    manager.services = new Set([source, peer]);

    manager.broadcastSessionDeleted(source, 'session-deleted-by-peer');

    assert.deepEqual(received, ['session-deleted-by-peer']);
});

test('Provider runtime invalidations preserve exact identity and exclude the source window', () => {
    const manager = Object.create(AgentHostManager.prototype);
    const received = [];
    const source = { notifyProviderRuntimeInvalidated: () => received.push('source') };
    const peer = { notifyProviderRuntimeInvalidated: change => received.push(change) };
    manager.services = new Set([source, peer]);
    const change = {
        providerId: 'xora-relay',
        reason: 'credential-cleared',
        invalidateSession: true
    };

    manager.broadcastProviderRuntimeInvalidation(source, change);

    assert.deepEqual(received, [change]);
});

test('subscription authentication is application-wide, pre-isolates peers, and rejects overlap', async () => {
    const manager = Object.create(AgentHostManager.prototype);
    const timeline = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const source = {};
    const peer = {
        prepareSubscriptionAuthenticationMutation: async () => timeline.push('peer-isolated')
    };
    manager.services = new Set([source, peer]);
    manager.providers = {
        rotateRuntimeEpoch: providerId => timeline.push(`epoch:${providerId}`)
    };
    manager.subscriptionAuthenticationMutationActive = false;

    const first = manager.coordinateSubscriptionAuthentication(source, async () => {
        timeline.push('first-operation');
        await firstGate;
        return 'done';
    });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
        manager.coordinateSubscriptionAuthentication(peer, async () => timeline.push('unexpected-operation')),
        /另一个窗口正在更新/
    );
    releaseFirst();

    assert.equal(await first, 'done');
    assert.deepEqual(timeline, [
        'epoch:grok-subscription',
        'peer-isolated',
        'first-operation'
    ]);
    assert.equal(manager.subscriptionAuthenticationMutationActive, false);
});

test('full access is application-wide while ACP approval remains backend-owned and allow-once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-'));
    try {
        const { host, session, emitted, permissionMode } = hostHarness(root);
        host.security.hasPersistentPermission = () => {
            throw new Error('full access must not consult or create a cross-session rule');
        };

        await host.setPermissionMode('full-access');
        const result = await host.handlePermissionRequest(permissionParams(session));

        assert.deepEqual(result, { outcome: { outcome: 'selected', optionId: 'allow-this-time' } });
        assert.equal(permissionMode(), 'full-access');
        assert.equal(Object.hasOwn(session, 'permissionMode'), false);
        assert.deepEqual(emitted, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('full access fails closed without an ACP allow-once option', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-'));
    try {
        const { host, session } = hostHarness(root);
        await host.setPermissionMode('full-access');
        const result = await host.handlePermissionRequest(permissionParams(session, {}, [
            { optionId: 'allow-forever', kind: 'allow_always' },
            { optionId: 'reject', kind: 'reject_once' }
        ]));
        assert.deepEqual(result, { outcome: { outcome: 'cancelled' } });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('request approval rejects paths outside the workspace, including a missing file below a symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-outside-'));
    try {
        fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        const { host, session, emitted } = hostHarness(root);

        const result = await host.handlePermissionRequest(permissionParams(session, {
            path: 'escape/not-created-yet.txt'
        }));

        assert.deepEqual(result, { outcome: { outcome: 'cancelled' } });
        assert.equal(emitted.some(event => event.kind === 'error' && event.code === 'PERMISSION_BOUNDARY_REJECTED'), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('full access allows absolute paths and symlink targets anywhere on the current account disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-full-disk-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-full-disk-other-project-'));
    try {
        const link = path.join(root, 'other-project');
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        const { host, session, emitted } = hostHarness(root);
        await host.setPermissionMode('full-access');
        const target = path.join(outside, 'not-created-yet.txt');
        const canonicalOutside = fs.realpathSync.native(outside);

        assert.deepEqual(
            await host.handlePermissionRequest(permissionParams(session, { path: target })),
            { outcome: { outcome: 'selected', optionId: 'allow-this-time' } }
        );
        assert.equal(host.safeWorkspaceFile(target), path.resolve(canonicalOutside, 'not-created-yet.txt'));
        assert.equal(host.safeWorkspaceFile(path.join(link, 'through-link.txt')), path.resolve(canonicalOutside, 'through-link.txt'));
        assert.equal(emitted.some(event => event.kind === 'error' && event.code === 'PERMISSION_BOUNDARY_REJECTED'), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('request approval accepts every trusted workspace root and a legal ..hidden child', () => {
    const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-multi-root-primary-'));
    const additional = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-multi-root-additional-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-multi-root-outside-'));
    try {
        const canonicalPrimary = fs.realpathSync.native(primary);
        const canonicalAdditional = fs.realpathSync.native(additional);
        const host = Object.create(GrokAgentHostService.prototype);
        host.workspaceRoot = canonicalPrimary;
        host.theiaTrustedRoots = new Set([canonicalPrimary, canonicalAdditional]);
        host.security = {
            agentPermissionMode: () => 'request-approval',
            canonicalRoot: root => fs.existsSync(root) ? fs.realpathSync.native(root) : path.normalize(root),
            isTrusted: root => root === canonicalPrimary || root === canonicalAdditional
        };

        const hidden = path.join(canonicalPrimary, '..hidden');
        const secondaryFile = path.join(canonicalAdditional, 'nested', 'fixture.ts');
        assert.equal(host.safeWorkspaceFile(hidden), hidden);
        assert.equal(host.safeWorkspaceFile(secondaryFile), secondaryFile);
        assert.equal(host.isPathInsideWorkspace(canonicalAdditional), true,
            'an additional directory itself is a valid tool cwd');
        assert.equal(host.isPathInsideWorkspace(secondaryFile), true);
        assert.throws(
            () => host.safeWorkspaceFile(path.join(outside, 'escape.ts')),
            /inside the trusted workspace/
        );
    } finally {
        fs.rmSync(primary, { recursive: true, force: true });
        fs.rmSync(additional, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('global full access follows the outstanding turn across tabs and never bypasses workspace trust', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-'));
    try {
        const { host, session } = hostHarness(root);
        await host.setPermissionMode('full-access');
        host.activeSessionId = 'another-session';
        assert.deepEqual(
            await host.handlePermissionRequest(permissionParams(session)),
            { outcome: { outcome: 'selected', optionId: 'allow-this-time' } },
            'opening another conversation must not cancel a background turn permission'
        );

        host.activePrompts.delete(session.appSessionId);
        assert.deepEqual(
            await host.handlePermissionRequest(permissionParams(session)),
            { outcome: { outcome: 'cancelled' } },
            'a session without an outstanding turn cannot gain a new permission continuation'
        );

        host.activePrompts.set(session.appSessionId, {});
        host.isWorkspaceTrusted = () => false;
        assert.deepEqual(
            await host.handlePermissionRequest(permissionParams(session)),
            { outcome: { outcome: 'cancelled' } }
        );
        assert.equal((await host.setPermissionMode('full-access')).permissionMode, 'full-access');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('permission approval is cancelled when Provider identity no longer matches the session runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-permission-provider-epoch-'));
    try {
        for (const mismatch of [
            { name: 'runtime epoch', runtimeEpoch: 'other-runtime', registryEpoch: 'session-epoch', globalProvider: 'grok-subscription' },
            { name: 'registry epoch', runtimeEpoch: 'session-epoch', registryEpoch: 'rotated-epoch', globalProvider: 'grok-subscription' },
            { name: 'global Provider', runtimeEpoch: 'session-epoch', registryEpoch: 'session-epoch', globalProvider: 'xai-api-key' }
        ]) {
            const { host, session } = hostHarness(root);
            session.providerRuntimeEpoch = 'session-epoch';
            host.runtimeProviderEpoch = mismatch.runtimeEpoch;
            host.providers = {
                selectedProviderId: () => mismatch.globalProvider,
                runtimeEpoch: () => mismatch.registryEpoch
            };
            await host.setPermissionMode('full-access');

            assert.deepEqual(
                await host.handlePermissionRequest(permissionParams(session)),
                { outcome: { outcome: 'cancelled' } },
                `${mismatch.name} must not auto-allow a tool`
            );
        }

        const { host, session, emitted } = hostHarness(root);
        session.providerRuntimeEpoch = 'session-epoch';
        host.runtimeProviderEpoch = 'session-epoch';
        let registryEpoch = 'session-epoch';
        host.providers = {
            selectedProviderId: () => 'grok-subscription',
            runtimeEpoch: () => registryEpoch
        };
        const response = host.handlePermissionRequest(permissionParams(session));
        const event = emitted.find(candidate => candidate.kind === 'permission-request');
        assert.ok(event);

        registryEpoch = 'rotated-epoch';
        await host.respondPermission({ requestId: event.requestId, outcome: 'allow-once' });
        assert.deepEqual(
            await response,
            { outcome: { outcome: 'cancelled' } },
            'a delayed manual approval must not allow a tool after credential rotation'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('request approval remains the default and still emits a renderer decision request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-'));
    try {
        const { host, session, emitted } = hostHarness(root);
        const response = host.handlePermissionRequest(permissionParams(session));
        assert.equal(host.pendingPermissions.size, 1);
        assert.equal(emitted.some(event => event.kind === 'permission-request'), true);
        const pending = [...host.pendingPermissions.values()][0];
        pending.resolve({ outcome: { outcome: 'selected', optionId: 'allow-this-time' } });
        assert.deepEqual(await response, { outcome: { outcome: 'selected', optionId: 'allow-this-time' } });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('permission labels redact exact secrets before truncation and renderer delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-permission-redaction-'));
    try {
        const { host, session, emitted } = hostHarness(root);
        const secret = `relay-secret-${'z'.repeat(180)}`;
        host.currentSecrets = [secret];
        const response = host.handlePermissionRequest(permissionParams(session, {
            command: `run-tool --credential ${secret}`,
            description: secret
        }));
        const permission = emitted.find(event => event.kind === 'permission-request');
        assert.ok(permission);
        const serialized = JSON.stringify(permission);
        assert.doesNotMatch(serialized, /relay-secret-/);
        assert.match(serialized, /REDACTED/);
        const pending = [...host.pendingPermissions.values()][0];
        pending.resolve({ outcome: { outcome: 'selected', optionId: 'allow-this-time' } });
        await response;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('fake service keeps full access across sessions and project switches', async () => {
    const service = new FakeAgentHostService();
    const events = [];
    service.setClient({ onAgentEvent: event => events.push(event) });
    await service.setWorkspaceRoot('/fixture');
    await service.synchronizeWorkspaceTrust({ workspaceRoots: ['/fixture'], trusted: true });
    await service.startRuntime({ workspaceRoot: '/fixture', providerId: 'grok-subscription' });
    await service.setPermissionMode('full-access');
    const session = await service.createSession({
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription'
    });

    assert.equal((await service.getSnapshot()).permissionMode, 'full-access');
    await service.sendPrompt({ sessionId: session.appSessionId, text: 'fixture task' });
    assert.equal(events.some(event => event.kind === 'permission-request'), false);

    const second = await service.createSession({
        workspaceRoot: '/fixture',
        providerId: 'grok-subscription'
    });
    assert.equal((await service.getSnapshot()).permissionMode, 'full-access');
    await service.setWorkspaceRoot('/fixture/other-project');
    assert.equal((await service.getSnapshot()).permissionMode, 'full-access');
});
