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
    host.sidecarVersion = session.sidecarVersion;
    host.phase = 'ready';
    host.loadedSessionIds = new Set([session.appSessionId]);
    host.restoringSessionCounts = new Map();
    host.acpSessionLookup = new Map([[session.acpSessionId, session.appSessionId]]);
    host.pendingPermissions = new Map();
    host.currentSecrets = [];
    host.models = [];
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

test('full access rejects paths outside the workspace, including a missing file below a symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-outside-'));
    try {
        fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        const { host, session, emitted } = hostHarness(root);
        await host.setPermissionMode('full-access');

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

test('global full access never bypasses active-session or workspace-trust checks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-permission-'));
    try {
        const { host, session } = hostHarness(root);
        await host.setPermissionMode('full-access');
        host.activeSessionId = 'another-session';
        assert.deepEqual(
            await host.handlePermissionRequest(permissionParams(session)),
            { outcome: { outcome: 'cancelled' } }
        );

        host.activeSessionId = session.appSessionId;
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
