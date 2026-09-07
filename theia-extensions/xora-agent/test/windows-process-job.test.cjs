const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { WindowsProcessJob, windowsProcessJobScriptPath } = require('../lib/electron-main/windows-process-job');
const { GrokSidecarSupervisor } = require('../lib/electron-main/sidecar-supervisor');

function fixture() {
    const job = Object.create(WindowsProcessJob.prototype);
    const socket = new EventEmitter();
    const sent = [];
    const errors = [];
    socket.setEncoding = () => undefined;
    socket.write = (line, callback) => { sent.push(JSON.parse(line)); callback?.(); };
    socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit('close'); } };
    job.launch = { binary: 'fixture.exe', args: ['a b'], cwd: 'fixture-root' };
    job.token = 'independent-authentication-token';
    job.server = { close: () => undefined };
    job.process = new EventEmitter();
    job.process.on('error', error => errors.push(error));
    job.authenticated = false;
    job.launchSent = false;
    job.stopRequested = false;
    job.terminationConfirmed = false;
    job.errorReported = false;
    job.acceptConnection(socket);
    const receive = message => socket.emit('data', `${JSON.stringify(message)}\n`);
    const hello = () => receive({ type: 'hello', token: job.token });
    return { job, socket, sent, errors, receive, hello };
}

test('packaged guardians resolve outside app.asar and development uses the actual wrapper', () => {
    const resourcesPath = path.resolve('fixture', 'resources');
    const packaged = windowsProcessJobScriptPath({ packaged: true, resourcesPath, entry: path.resolve('irrelevant-entry.js') });
    assert.equal(packaged, path.join(resourcesPath, 'app.asar.unpacked', 'scripts', 'windows-process-job.ps1'));
    const entry = path.resolve('fixture', 'applications', 'electron', 'scripts', 'theia-electron-main.js');
    assert.equal(windowsProcessJobScriptPath({ packaged: false, resourcesPath, entry }), path.join(path.dirname(entry), 'windows-process-job.ps1'));
});

test('untrusted control packets cannot launch a process or confirm its exit', () => {
    const f = fixture();
    f.receive({ type: 'hello', token: 'wrong' });
    assert.equal(f.socket.destroyed, true);
    assert.deepEqual(f.sent, []);
    assert.equal(f.job.running, true);
});

test('only an authenticated terminal acknowledgement releases Job authority', () => {
    const f = fixture();
    f.hello();
    assert.deepEqual(f.sent, [{ type: 'launch', binary: 'fixture.exe', args: ['a b'], cwd: 'fixture-root' }]);
    f.receive({ type: 'started', pid: 123 });
    f.job.guardianExited();
    assert.equal(f.job.running, true, 'guardian exit alone does not prove Job exit');
    f.receive({ type: 'terminated', exitCode: 0, reason: 'exit' });
    assert.equal(f.job.running, false);
    assert.equal(f.socket.destroyed, true);
});

test('malformed terminal packets retain fences and expose only fixed errors', () => {
    const f = fixture();
    f.hello();
    f.receive({ type: 'terminated', exitCode: 'not-an-integer', reason: 'exit', diagnostic: 'secret-fixture' });
    assert.equal(f.job.running, true);
    assert.deepEqual(f.sent.at(-1), { type: 'stop' });
    assert.equal(f.errors.length, 1);
    assert.doesNotMatch(f.errors[0].message, /secret-fixture|independent-authentication-token/);
    f.job.disconnect();
});

test('prelaunch cancellation never admits a new workspace process', () => {
    const f = fixture();
    f.job.stop();
    f.hello();
    assert.deepEqual(f.sent, [{ type: 'stop' }]);
    f.job.guardianExited();
    assert.equal(f.job.running, false, 'no launch was ever admitted');
});

test('control loss after launch remains unconfirmed while the guardian kills its Job', () => {
    const f = fixture();
    f.hello();
    f.socket.destroy();
    f.job.guardianExited();
    assert.equal(f.job.running, true);
    assert.equal(f.errors.length, 1);
});

test('supervisor retains a launched Windows Job after guardian exit until confirmation', () => {
    const child = { pid: 123, exitCode: 1, signalCode: null };
    const state = { running: true, stops: 0, stop() { this.stops++; } };
    const supervisor = Object.create(GrokSidecarSupervisor.prototype);
    supervisor.child = child;
    supervisor.windowsJobs = new WeakMap([[child, state]]);
    assert.equal(supervisor.running, true);
    supervisor.terminateProcessTree(child, true);
    assert.equal(state.stops, 1);
    state.running = false;
    assert.equal(supervisor.running, false);
});

test('synchronous shutdown never kills an exited guardian by its reusable numeric PID', () => {
    const f = fixture();
    f.hello();
    f.job.process.pid = 123;
    f.job.process.exitCode = 1;
    f.job.process.signalCode = null;
    f.job.process.kill = () => assert.fail('an exited guardian must never be signalled');
    f.job.guardianExited();
    const supervisor = Object.create(GrokSidecarSupervisor.prototype);
    supervisor.child = f.job.process;
    supervisor.windowsJobs = new WeakMap([[f.job.process, f.job]]);
    supervisor.flushStderr = () => undefined;
    supervisor.stopSync();
    assert.equal(f.job.running, true, 'shutdown cannot fabricate a missing Job confirmation');
});
