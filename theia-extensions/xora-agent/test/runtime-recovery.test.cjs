const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const { GrokAgentHostService } = require('../lib/electron-main/grok-agent-host-service');
const { AgentHostManager } = require('../lib/electron-main/agent-host-manager');
const { GrokSidecarSupervisor, SidecarTerminationUnconfirmedError } = require('../lib/electron-main/sidecar-supervisor');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function lifecycleHost() {
    const host = Object.create(GrokAgentHostService.prototype);
    host.lifecycleTail = Promise.resolve();
    host.runtimeStartRequestGeneration = 0;
    host.sessionLoadGeneration = 0;
    host.runtimeGeneration = 0;
    host.phase = 'stopped';
    return host;
}

const request = { workspaceRoot: '/fixture', providerId: 'provider-a' };

test('concurrent startup callers share a failed attempt and a later explicit retry is fresh', async () => {
    const host = lifecycleHost();
    const initialization = deferred();
    let launches = 0;
    host.startRuntimeLocked = async () => { launches++; return initialization.promise; };
    const attempts = [host.startRuntime(request), host.startRuntime(request), host.startRuntime(request)];
    const settled = Promise.allSettled(attempts);
    initialization.reject(new Error('transient connection closed'));
    assert.deepEqual((await settled).map(result => result.status), ['rejected', 'rejected', 'rejected']);
    assert.equal(launches, 1);
    host.startRuntimeLocked = async () => { launches++; return { phase: 'ready' }; };
    assert.equal((await host.startRuntime(request)).phase, 'ready');
    assert.equal(launches, 2);
});

test('stop invalidates starts still queued behind another lifecycle operation', async () => {
    const host = lifecycleHost();
    const previous = deferred();
    host.lifecycleTail = previous.promise;
    let launches = 0;
    host.startRuntimeLocked = async () => { launches++; return { phase: 'ready' }; };
    host.stopRuntimeLocked = async () => { host.phase = 'stopped'; };
    const starting = assert.rejects(host.startRuntime(request), /cancelled/);
    const stopping = host.stopRuntime();
    previous.resolve();
    await Promise.all([starting, stopping]);
    assert.equal(launches, 0);
});

function startingHost() {
    const host = lifecycleHost();
    const initialized = deferred();
    const stdout = new PassThrough();
    const stdin = new Writable({ write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString());
        if (message.method === 'initialize') initialized.resolve(message);
        callback();
    } });
    const child = new EventEmitter();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), exitCode: null });
    const provider = { id: request.providerId, kind: 'custom', name: 'Fixture' };
    Object.assign(host, {
        workspaceRoot: request.workspaceRoot,
        attachedWorkspaceRoots: new Set([request.workspaceRoot]),
        loadedSessionIds: new Set(),
        currentSecrets: [],
        models: [],
        security: { canonicalRoot: value => value },
        providers: {
            selectedProviderId: () => provider.id,
            get: () => provider,
            runtimeEpoch: () => 'epoch-a',
            preferredModelId: () => undefined,
            redactionSecrets: () => [],
            withProviderEnvironment: (_id, operation) => operation({}, provider, 'epoch-a')
        },
        supervisor: {
            running: false,
            launch: () => ({ process: child, version: 'fixture' }),
            stop: async () => { stdout.destroy(); stdin.destroy(); child.stderr.destroy(); }
        },
        bindAcp: () => undefined,
        emitSnapshot: () => undefined,
        emitError: () => undefined,
        snapshot: () => ({ phase: host.phase }),
        stopRuntimeLocked: async () => {
            await host.supervisor.stop();
            host.acp = undefined;
            host.phase = 'stopped';
        }
    });
    return { host, initialized };
}

test('stop interrupts an actual in-flight ACP initialize instead of waiting for its timeout', { timeout: 2_000 }, async () => {
    const { host, initialized } = startingHost();
    const starting = assert.rejects(host.startRuntime(request), /cancelled/);
    await initialized.promise;
    const before = Date.now();
    await host.stopRuntime();
    await starting;
    assert.equal(host.phase, 'stopped');
    assert.ok(Date.now() - before < 1_000);
});

test('stop during credential preparation cannot launch a sidecar after the preparation resolves', async () => {
    const { host } = startingHost();
    const preparation = deferred();
    const entered = deferred();
    host.providers.prepareRuntimeCredentials = () => { entered.resolve(); return preparation.promise; };
    let launches = 0;
    host.supervisor.launch = () => { launches++; throw new Error('must not launch'); };
    const starting = assert.rejects(host.startRuntime(request), /cancelled/);
    await entered.promise;
    const stopping = host.stopRuntime();
    preparation.resolve();
    await Promise.all([starting, stopping]);
    assert.equal(launches, 0);
});

test('failed startup publishes a terminal state even when process exit cannot be confirmed', async () => {
    const { host } = startingHost();
    host.providers.prepareRuntimeCredentials = async () => { throw new Error('fixture startup failed'); };
    host.supervisor.stop = async () => { throw new SidecarTerminationUnconfirmedError(); };
    const errors = [];
    host.emitError = (code, error) => errors.push([code, error.code]);
    await assert.rejects(host.startRuntime(request), SidecarTerminationUnconfirmedError);
    assert.equal(host.phase, 'crashed');
    assert.deepEqual(errors, [['RUNTIME_START_FAILED', 'SIDECAR_TERMINATION_UNCONFIRMED']]);
});

test('a cross-window provider rotation during credential preparation prevents stale process spawn', async () => {
    const { host } = startingHost();
    const preparation = deferred();
    const entered = deferred();
    host.providers.prepareRuntimeCredentials = () => { entered.resolve(); return preparation.promise; };
    let launches = 0;
    host.supervisor.launch = () => { launches++; throw new Error('must not launch'); };
    const starting = assert.rejects(host.startRuntime(request), /STALE_PROVIDER_SELECTION/);
    await entered.promise;
    host.providers.runtimeEpoch = () => 'rotated-epoch';
    preparation.resolve();
    await starting;
    assert.equal(launches, 0);
});

test('MCP refresh waiting for credentials cannot apply a snapshot after workspace detachment', async () => {
    const { host } = startingHost();
    const preparation = deferred();
    host.activePrompts = new Map();
    host.providers.prepareMcpCredentials = () => preparation.promise;
    let resolutions = 0;
    host.resolveRuntimeMcpSnapshot = () => { resolutions++; throw new Error('must not resolve a detached workspace'); };
    const refresh = host.refreshIntegrationsLocked();
    host.workspaceRoot = undefined;
    preparation.resolve();
    await refresh;
    assert.equal(resolutions, 0);
});

function supervisorFor(child) {
    const supervisor = Object.create(GrokSidecarSupervisor.prototype);
    supervisor.child = child;
    supervisor.flushStderr = () => undefined;
    supervisor.exactSecrets = [];
    return supervisor;
}

test('concurrent process stops share one signal sequence and clean exit listeners after timeout', async () => {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, stdin: { end: () => undefined } });
    const supervisor = supervisorFor(child);
    const signals = [];
    supervisor.signalTree = (_child, signal) => signals.push(signal);
    supervisor.forcedExitConfirmationTimeoutMs = () => 5;
    const first = supervisor.stop(0);
    const second = supervisor.stop(0);
    assert.equal(first, second);
    const results = await Promise.allSettled([first, second]);
    assert.ok(results.every(result => result.reason instanceof SidecarTerminationUnconfirmedError));
    assert.equal(supervisor.child, child);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
});

test('signal-terminated leaders close retained streams without waiting for an impossible second exit', async () => {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: 'SIGKILL', stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const supervisor = supervisorFor(child);
    assert.equal(supervisor.running, false);
    await supervisor.stop(0);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(supervisor.child, undefined);
});

test('spawn failure releases a phantom process without an exit event', { timeout: process.platform === 'win32' ? 20_000 : 2_000 }, async () => {
    const supervisor = supervisorFor(undefined);
    supervisor.resolveBinary = () => '/xora-runtime-fixture/does-not-exist';
    supervisor.resolvedVersion = () => 'fixture';
    supervisor.sanitizedEnvironment = () => process.env;
    const { process: child } = supervisor.launch(process.cwd(), {});
    const error = once(child, 'error');
    // Windows launches a Job guardian first. Let it report the target spawn
    // error before stopping, otherwise prelaunch cancellation is successful.
    const stopping = process.platform === 'win32' ? undefined : supervisor.stop(500);
    await error;
    await (stopping ?? supervisor.stop(500));
    assert.equal(supervisor.running, false);
    assert.equal(supervisor.child, undefined);
    assert.equal(child.stdout.destroyed, true);
});

test('POSIX teardown kills descendants even after their detached leader has exited', { skip: process.platform === 'win32', timeout: 5_000 }, async t => {
    const source = `const {spawn}=require('node:child_process');
        const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
        console.log(descendant.pid);
        setTimeout(()=>process.exit(0),30);`;
    const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    });
    const supervisor = supervisorFor(child);
    await once(child, 'exit');
    assert.equal(supervisor.running, true, 'the inherited process group outlives its leader');
    await supervisor.stop(0);
    assert.equal(supervisor.running, false);
    assert.equal(child.stdout.destroyed, true);
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
});

test('manager retains failed disconnects for final shutdown and isolates peer shutdown failures', async () => {
    const manager = Object.create(AgentHostManager.prototype);
    const stopped = [];
    const failed = {
        dispose: async () => { throw new SidecarTerminationUnconfirmedError(); },
        disposeSync: () => { stopped.push('failed'); throw new Error('storage unavailable'); }
    };
    const peer = { disposeSync: () => stopped.push('peer') };
    manager.services = new Set([failed, peer]);
    await assert.rejects(manager.disconnect(failed), SidecarTerminationUnconfirmedError);
    assert.equal(manager.services.has(failed), true);
    manager.onStop();
    assert.deepEqual(stopped, ['failed', 'peer']);
    assert.equal(manager.services.size, 0);
});
