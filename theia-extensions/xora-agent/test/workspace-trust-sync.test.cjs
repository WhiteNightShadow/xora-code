const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');

test('renderer trust synchronization stays fail-closed without blocking the first frame', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/browser/workspace-trust-guard.ts'), 'utf8');
    const onStart = source.slice(source.indexOf('onStart('), source.indexOf('onStop()'));

    assert.match(onStart, /onStart\(_app: FrontendApplication\): void/);
    assert.match(onStart, /void this\.enqueue/);
    assert.doesNotMatch(onStart, /await this\.enqueue/);
    assert.match(source, /lastSynchronizationSignature/);
    assert.match(source, /if \(signature === this\.lastSynchronizationSignature\) return/);
    assert.doesNotMatch(source, /await this\.model\.refresh\(\)/);
});

test('an untrusted root becomes attached and its runtime can wait for input', async () => {
    const service = new FakeAgentHostService();
    const root = path.resolve('/fixture/workspace-a');

    let snapshot = await service.setWorkspaceRoot(root);
    assert.equal(snapshot.workspaceAttached, false);
    assert.equal(snapshot.workspaceTrusted, false);

    snapshot = await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: false });
    assert.equal(snapshot.workspaceAttached, true);
    assert.equal(snapshot.workspaceTrusted, false);
    snapshot = await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' });
    assert.equal(snapshot.phase, 'ready');
    assert.equal(snapshot.workspaceAttached, true);
    assert.equal(snapshot.workspaceTrusted, false);
});

test('Theia revocation clears privileged state without stopping the ready runtime', async () => {
    const service = new FakeAgentHostService();
    const root = path.resolve('/fixture/workspace');
    const events = [];
    let permissionResolved = false;
    service.setClient({ onAgentEvent: event => events.push(event) });

    await service.setWorkspaceRoot(root);
    await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: true });
    await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' });
    service.pendingPermissions.set('pending', { sessionId: 'fixture', resolve: () => { permissionResolved = true; } });

    const revoked = await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: false });
    assert.equal(revoked.workspaceAttached, true);
    assert.equal(revoked.workspaceTrusted, false);
    assert.equal(revoked.phase, 'ready');
    assert.equal(permissionResolved, true);
    assert.equal(service.pendingPermissions.size, 0);
    assert.ok(events.some(event => event.kind === 'snapshot' && event.snapshot.workspaceTrusted === false));
    assert.equal((await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' })).phase, 'ready');
});

test('production trust revocation keeps ACP standby alive and cancels pending grants', async () => {
    const root = path.resolve('/fixture/workspace');
    const host = Object.create(GrokAgentHostService.prototype);
    let stopped = 0;
    let resolved;
    const persisted = [];
    host.workspaceRoot = root;
    host.phase = 'ready';
    host.attachedWorkspaceRoots = new Set([root]);
    host.theiaTrustedRoots = new Set([root]);
    host.pendingPermissions = new Map([['pending', { resolve: value => { resolved = value; } }]]);
    host.security = {
        canonicalRoot: value => path.normalize(value),
        synchronizeTrust: (roots, trusted) => persisted.push({ roots, trusted }),
        agentPermissionMode: () => 'full-access'
    };
    host.emitSnapshot = () => undefined;
    host.snapshot = () => ({
        phase: host.phase,
        workspaceAttached: host.attachedWorkspaceRoots.has(root),
        workspaceTrusted: host.theiaTrustedRoots.has(root),
        permissionMode: host.security.agentPermissionMode()
    });
    host.stopRuntime = async () => { stopped += 1; };

    const snapshot = await host.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: false });

    assert.equal(snapshot.phase, 'ready');
    assert.equal(snapshot.workspaceAttached, true);
    assert.equal(snapshot.workspaceTrusted, false);
    assert.equal(snapshot.permissionMode, 'full-access');
    assert.deepEqual(resolved, { outcome: { outcome: 'cancelled' } });
    assert.equal(host.pendingPermissions.size, 0);
    assert.equal(stopped, 0);
    assert.deepEqual(persisted, [{ roots: [root], trusted: false }]);
});

test('backend rejects any workspace synchronization that omits the selected Agent root', async () => {
    const service = new FakeAgentHostService();
    await service.setWorkspaceRoot('/fixture/selected');
    for (const trusted of [false, true]) {
        await assert.rejects(
            service.synchronizeWorkspaceTrust({ workspaceRoots: ['/fixture/other'], trusted }),
            /must belong/
        );
    }
    assert.equal((await service.getSnapshot()).workspaceAttached, false);
    assert.equal((await service.getSnapshot()).workspaceTrusted, false);
});

test('fake and production runtimes reject a selected root until the current window attaches it', async () => {
    const service = new FakeAgentHostService();
    const root = path.resolve('/fixture/unattached');
    await service.setWorkspaceRoot(root);

    await assert.rejects(
        service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' }),
        /not attached|Select this Agent root/
    );

    const host = Object.create(GrokAgentHostService.prototype);
    host.disposed = false;
    host.workspaceRoot = root;
    host.attachedWorkspaceRoots = new Set();
    host.security = { canonicalRoot: value => path.normalize(value) };
    await assert.rejects(
        host.startRuntimeLocked({ workspaceRoot: root, providerId: 'grok-subscription' }),
        /not attached|Select this Agent root/
    );
});

test('untrusted projects retain the global preference without receiving an execution grant', async () => {
    const service = new FakeAgentHostService();
    const root = '/fixture/untrusted';
    await service.setWorkspaceRoot(root);
    await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: false });
    await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' });

    const snapshot = await service.setPermissionMode('full-access');
    assert.equal(snapshot.permissionMode, 'full-access');
    assert.equal(snapshot.workspaceTrusted, false);
});

test('production runtime gates project MCP injection on native workspace trust', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/electron-main/grok-agent-host-service.ts'), 'utf8');

    assert.match(source, /if \(!this\.isWorkspaceTrusted\(workspaceRoot\)\) \{/);
    assert.match(source, /const credentials = this\.providers\.mcpCredentialBindings\(workspaceRoot\)/);
    assert.doesNotMatch(source, /projectMcpEnvironment/,
        'stored MCP secrets must not be injected into the global sidecar process environment');
    assert.match(source, /if \(!this\.attachedWorkspaceRoots\.has\(root\)\)/);
    assert.doesNotMatch(source, /Trust this project before starting the Agent runtime/);
});
