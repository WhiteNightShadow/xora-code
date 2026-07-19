const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeAgentHostService } = require('../lib/node/fake-agent-host-service');

test('a persisted root remains restricted until the current Theia window synchronizes trust', async () => {
    const service = new FakeAgentHostService();
    const first = '/fixture/workspace-a';
    const second = '/fixture/workspace-b';

    let snapshot = await service.setWorkspaceRoot(first);
    assert.equal(snapshot.workspaceTrusted, false);

    snapshot = await service.synchronizeWorkspaceTrust({ workspaceRoots: [first, second], trusted: true });
    assert.equal(snapshot.workspaceTrusted, true);
    assert.equal((await service.startRuntime({ workspaceRoot: first, providerId: 'grok-subscription' })).phase, 'ready');

    snapshot = await service.setWorkspaceRoot(second);
    assert.equal(snapshot.phase, 'stopped');
    assert.equal(snapshot.workspaceTrusted, false);
    await assert.rejects(
        service.startRuntime({ workspaceRoot: second, providerId: 'grok-subscription' }),
        /not trusted/
    );

    snapshot = await service.synchronizeWorkspaceTrust({ workspaceRoots: [first, second], trusted: true });
    assert.equal(snapshot.workspaceTrusted, true);
});

test('Theia revocation removes backend trust and stops the active runtime', async () => {
    const service = new FakeAgentHostService();
    const root = '/fixture/workspace';
    const events = [];
    service.setClient({ onAgentEvent: event => events.push(event) });

    await service.setWorkspaceRoot(root);
    await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: true });
    await service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' });

    const revoked = await service.synchronizeWorkspaceTrust({ workspaceRoots: [root], trusted: false });
    assert.equal(revoked.workspaceTrusted, false);
    assert.equal(revoked.phase, 'stopped');
    assert.ok(events.some(event => event.kind === 'snapshot' && event.snapshot.workspaceTrusted === false));
    await assert.rejects(
        service.startRuntime({ workspaceRoot: root, providerId: 'grok-subscription' }),
        /not trusted/
    );
});

test('backend rejects a trust assertion that omits the selected Agent root', async () => {
    const service = new FakeAgentHostService();
    await service.setWorkspaceRoot('/fixture/selected');
    await assert.rejects(
        service.synchronizeWorkspaceTrust({ workspaceRoots: ['/fixture/other'], trusted: true }),
        /must belong/
    );
    assert.equal((await service.getSnapshot()).workspaceTrusted, false);
});
