const assert = require('node:assert/strict');
const test = require('node:test');
const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { AgentHostManager } = require('../lib/electron-main/agent-host-manager');

function idleHost() {
    const host = Object.create(GrokAgentHostService.prototype);
    host.phase = 'ready'; host.activePrompts = new Map(); host.promptClaimTokens = new Map();
    host.sessionLoadGeneration = 0; host.runtimeGeneration = 1;
    host.supervisor = { running: true }; host.acp = {};
    host.withLifecycle = operation => operation(); host.emitSnapshot = () => undefined;
    host.stopRuntimeLocked = async () => { host.stops = (host.stops || 0) + 1; host.supervisor.running = false; host.acp = undefined; };
    return host;
}

test('prewarmed idle runtimes can be switched without user-visible stop controls', async () => {
    const host = idleHost(); assert.equal(host.runtimeActive, true); assert.equal(host.componentUpdateBlocked, false);
    await host.prepareSidecarActivation(); assert.equal(host.stops, 1); assert.equal(host.phase, 'updating');
    host.sidecarActivationSettled(); assert.equal(host.phase, 'stopped');
});

test('a task in any window rejects activation before stopping any idle runtime', async () => {
    const idle = idleHost(); const busy = idleHost(); busy.activePrompts.set('task', {});
    const manager = Object.create(AgentHostManager.prototype); manager.services = new Set([idle, busy]);
    await assert.rejects(manager.prepareSidecarActivation(), /任务/);
    assert.equal(idle.stops, undefined); assert.equal(busy.stops, undefined);
});

test('permission, command and unresolved prompt claims fence updates', () => {
    for (const [field, value] of [['pendingPermissions', new Map([['ask', {}]])],
        ['managementChild', { exitCode: null }], ['promptClaimTokens', new Map([['claim', 'owned']])], ['orphanedGoalSessions', new Set(['goal'])]]) {
        const host = idleHost(); host[field] = value; assert.equal(host.componentUpdateBlocked, true, field);
    }
});

test('idle initialization is cancelled promptly before component activation', async () => {
    const host = idleHost(); host.phase = 'initializing';
    let closed = false; host.acp = { close: () => { closed = true; } };
    host.pendingRuntimeStarts = new Map([['prewarm', {}]]);
    assert.equal(host.componentUpdateBlocked, false);
    await host.prepareSidecarActivation();
    assert.equal(closed, true); assert.equal(host.stops, 1); assert.equal(host.phase, 'updating');
});

test('update fence prevents prompt submission and runtime startup before provider/credential access', async () => {
    const host = idleHost(); host.updates = { busy: true };
    await assert.rejects(host.sendPrompt({ sessionId: 'task' }), /正在更新/);
    await assert.rejects(host.startRuntimeLocked({ workspaceRoot: '/fixture' }), /正在更新/);
});

test('settling a failed download does not change a running idle runtime', () => {
    const host = idleHost(); host.sidecarActivationSettled();
    assert.equal(host.phase, 'ready'); assert.equal(host.supervisor.running, true); assert.equal(host.stops, undefined);
});

test('update waits for a just-finished task query instead of requiring a second click', async () => {
    const host = idleHost(); host.updates = { busy: false };
    let checks = 0; host.canApplyUpdate = () => ++checks > 1;
    await host.waitForComponentUpdateIdle();
    assert.equal(checks, 2); assert.equal(host.stops, undefined);
});
