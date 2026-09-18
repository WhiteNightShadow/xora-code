const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getName: () => 'Fixture App',
    getAppPath: () => '/fixture/application',
    getPath: name => name === 'sessionData' ? '/fixture/session' : '/fixture/user-data'
});
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app, safeStorage: new Proxy({}, {
        get() { throw new Error('Application main must not enter Keychain'); }
    }) };
    return originalLoad.call(this, request, parent, isMain);
};
const { MacCredentialSession, runCredentialHelper, disposeMacCredentialSession } = require('../lib/electron-main/credential-helper-client');
Module._load = originalLoad;

const ciphertext = Buffer.from('owned-encrypted-value').toString('base64');
const flush = () => new Promise(resolve => setImmediate(resolve));

function childFixture() {
    const child = Object.assign(new EventEmitter(), {
        connected: true, exitCode: null, signalCode: null,
        requests: [], callbacks: [], kills: [], disconnects: 0
    });
    const lease = Object.assign(new EventEmitter(), { destroyed: false });
    lease.destroy = () => { lease.destroyed = true; };
    child.stdio = [null, null, null, null, lease];
    child.send = (request, callback) => { child.requests.push(request); child.callbacks.push(callback); return true; };
    child.kill = signal => { child.kills.push(signal); return true; };
    child.disconnect = () => { child.disconnects++; child.connected = false; child.emit('disconnect'); };
    child.close = (code = 0, signal = null) => {
        child.connected = false; child.exitCode = code; child.signalCode = signal;
        child.emit('close', code, signal);
    };
    child.reply = (response, index = child.requests.length - 1) => {
        child.emit('message', { requestId: child.requests[index].requestId, ...response });
    };
    return child;
}

function fixture(t, configure = () => undefined) {
    const children = [];
    const session = new MacCredentialSession(() => {
        const child = childFixture(); configure(child); children.push(child); return child;
    });
    t.after(() => {
        session.dispose();
        for (const child of children) child.close();
        assert.equal(app.listenerCount('will-quit'), 0);
        assert.equal(app.listenerCount('quit'), 0);
    });
    return { session, children };
}

test('one macOS session serves later decryption and encryption without ending the helper', async t => {
    const { session, children } = fixture(t);
    const first = session.run({ decrypt: [ciphertext], encrypt: [] });
    await flush();
    children[0].reply({ decrypted: ['fixture-key-a'], encrypted: [] });
    assert.deepEqual(await first, { decrypted: ['fixture-key-a'], encrypted: [] });
    const second = session.run({ decrypt: [], encrypt: ['fixture-key-b'] });
    await flush();
    assert.equal(children.length, 1);
    children[0].reply({ decrypted: [], encrypted: [ciphertext] });
    assert.deepEqual(await second, { decrypted: [], encrypted: [ciphertext] });
    assert.deepEqual(children[0].requests.map(value => value.requestId), [1, 2]);
    assert.deepEqual(children[0].kills, []);
    assert.equal(children[0].disconnects, 0);
    assert.equal(children[0].stdio[4].destroyed, false);
});

test('concurrent session operations serialize and do not accept old or future response IDs', async t => {
    const { session, children } = fixture(t);
    const first = session.run({ decrypt: [ciphertext], encrypt: [] });
    let secondResolved = false;
    const second = session.run({ decrypt: [], encrypt: ['fixture-next'] }).then(value => { secondResolved = true; return value; });
    await flush();
    const child = children[0];
    assert.equal(child.requests.length, 1);
    child.emit('message', { requestId: 2, decrypted: ['out-of-order'], encrypted: [] });
    assert.equal(child.requests.length, 1);
    child.reply({ decrypted: ['fixture-first'], encrypted: [] }, 0);
    await first;
    await flush();
    assert.equal(child.requests.length, 2);
    child.reply({ decrypted: [], encrypted: [ciphertext] }, 0);
    await flush();
    assert.equal(secondResolved, false);
    child.reply({ decrypted: [], encrypted: [ciphertext] }, 1);
    await second;
    assert.equal(children.length, 1);
});

test('a failed authorization rejects the already queued batch even when child close is immediate', async t => {
    const { session, children } = fixture(t, child => {
        child.kill = signal => { child.kills.push(signal); child.close(null, signal); return true; };
    });
    const first = session.run({ decrypt: [ciphertext], encrypt: [] }, 20);
    const queued = session.run({ decrypt: [], encrypt: ['queued-key'] }, 500);
    const results = await Promise.allSettled([first, queued]);
    assert.deepEqual(results.map(value => value.status), ['rejected', 'rejected']);
    assert.deepEqual(results.map(value => value.reason.code), ['CREDENTIAL_ACCESS_TIMEOUT', 'CREDENTIAL_ACCESS_TIMEOUT']);
    assert.equal(children.length, 1);
    assert.equal(children[0].requests.length, 1);
    const explicitLater = session.run({ decrypt: [ciphertext], encrypt: [] });
    await flush();
    assert.equal(children.length, 2);
    assert.equal(children[1].requests[0].requestId, 2);
    children[1].reply({ decrypted: ['explicit-retry-value'], encrypted: [] });
    await explicitLater;
});

test('timeout and exit cannot release the old child fence before close confirmation', async t => {
    const { session, children } = fixture(t);
    await assert.rejects(session.run({ decrypt: [ciphertext], encrypt: [] }, 20), { code: 'CREDENTIAL_ACCESS_TIMEOUT' });
    const old = children[0];
    assert.deepEqual(old.kills, ['SIGKILL']);
    assert.equal(old.stdio[4].destroyed, false);
    old.emit('exit', null, 'SIGKILL');
    await assert.rejects(session.run({ decrypt: [ciphertext], encrypt: [] }), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    assert.equal(children.length, 1);
    old.close(null, 'SIGKILL');
    assert.equal(old.stdio[4].destroyed, true);
    const next = session.run({ decrypt: [ciphertext], encrypt: [] });
    await flush();
    const current = children[1];
    old.emit('message', { requestId: current.requests[0].requestId, decrypted: ['stale-old-process'], encrypted: [] });
    old.callbacks[0](new Error('late previous-process send error'));
    current.reply({ decrypted: ['current-process-value'], encrypted: [] });
    assert.deepEqual(await next, { decrypted: ['current-process-value'], encrypted: [] });
    assert.deepEqual(current.kills, []);
});

test('malformed or denied session replies expose only fixed errors and retire the helper', async t => {
    const { session, children } = fixture(t);
    const waiting = session.run({ decrypt: [ciphertext], encrypt: [] });
    const rejected = assert.rejects(waiting, error => error.code === 'CREDENTIAL_ACCESS_DENIED'
        && !error.message.includes('native-sensitive-value'));
    await flush();
    children[0].reply({ error: 'native-sensitive-value' });
    await rejected;
    assert.deepEqual(children[0].kills, ['SIGKILL']);
    children[0].close(null, 'SIGKILL');
    const malformed = session.run({ decrypt: [ciphertext], encrypt: [] });
    const malformedRejected = assert.rejects(malformed, { code: 'CREDENTIAL_ACCESS_DENIED' });
    await flush();
    children[1].emit('message', { requestId: 0, decrypted: ['invalid-id-value'], encrypted: [] });
    await malformedRejected;
    assert.deepEqual(children[1].kills, ['SIGKILL']);
});

test('quitting aborts active and queued operations without releasing the lease early', async t => {
    const { session, children } = fixture(t);
    const waiting = session.run({ decrypt: [ciphertext], encrypt: [] });
    const queued = session.run({ decrypt: [], encrypt: ['queued-secret'] });
    const completion = Promise.allSettled([waiting, queued]);
    await flush();
    session.dispose();
    const result = await completion;
    assert.deepEqual(result.map(value => value.reason.code), ['CREDENTIAL_UNLOCK_REQUIRED', 'CREDENTIAL_UNLOCK_REQUIRED']);
    assert.equal(children.length, 1);
    assert.equal(children[0].disconnects, 1);
    assert.deepEqual(children[0].kills, []);
    assert.equal(children[0].stdio[4].destroyed, false);
    children[0].reply({ decrypted: ['late-after-quit'], encrypted: [] });
    await assert.rejects(session.run({ decrypt: [], encrypt: ['new-after-quit'] }), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    children[0].close();
    assert.equal(children[0].stdio[4].destroyed, true);
});

test('quitting also gracefully disconnects an idle successful session', async t => {
    const { session, children } = fixture(t);
    const waiting = session.run({ decrypt: [ciphertext], encrypt: [] });
    await flush();
    children[0].reply({ decrypted: ['idle-cache-value'], encrypted: [] });
    await waiting;
    session.dispose();
    assert.equal(children[0].disconnects, 1);
    assert.equal(children[0].stdio[4].destroyed, false);
    children[0].close();
    assert.equal(children[0].stdio[4].destroyed, true);
});

test('a vetoed will-quit keeps the live macOS session usable', async t => {
    const { session, children } = fixture(t);
    const first = session.run({ decrypt: [ciphertext], encrypt: [] });
    await flush();
    children[0].reply({ decrypted: ['before-veto'], encrypted: [] });
    await first;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.once('will-quit', value => value.preventDefault());
    app.emit('will-quit', event);
    assert.equal(event.defaultPrevented, true);
    const afterVeto = session.run({ decrypt: [], encrypt: ['after-veto'] });
    await flush();
    assert.equal(children.length, 1);
    assert.equal(children[0].disconnects, 0);
    assert.deepEqual(children[0].kills, []);
    children[0].reply({ decrypted: [], encrypted: [ciphertext] });
    await afterVeto;
});

test('actual quit force-cleans a helper which has not closed after graceful disposal', async t => {
    const { session, children } = fixture(t);
    const waiting = session.run({ decrypt: [ciphertext], encrypt: [] });
    const rejected = assert.rejects(waiting, { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    await flush();
    session.dispose();
    await rejected;
    assert.equal(children[0].disconnects, 1);
    assert.deepEqual(children[0].kills, []);
    app.emit('quit');
    assert.deepEqual(children[0].kills, ['SIGKILL']);
    assert.equal(children[0].stdio[4].destroyed, false);
    children[0].close(null, 'SIGKILL');
    assert.equal(children[0].stdio[4].destroyed, true);
});

test('graceful disposal escalates a stuck helper but retains its lease until close', async t => {
    const { session, children } = fixture(t);
    const waiting = session.run({ decrypt: [ciphertext], encrypt: [] });
    await flush();
    children[0].reply({ decrypted: ['ready-before-dispose'], encrypted: [] });
    await waiting;
    session.dispose();
    assert.deepEqual(children[0].kills, []);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(children[0].kills, ['SIGKILL']);
    assert.equal(children[0].stdio[4].destroyed, false);
    children[0].close(null, 'SIGKILL');
});

test('a stale completed request deadline cannot cancel the next request on the same helper', async t => {
    const { session, children } = fixture(t);
    const originalTimeout = global.setTimeout;
    const deadlines = [];
    global.setTimeout = (callback, milliseconds, ...args) => {
        if (milliseconds === 4321) {
            deadlines.push(callback);
            return originalTimeout(() => undefined, 60_000);
        }
        return originalTimeout(callback, milliseconds, ...args);
    };
    try {
        const first = session.run({ decrypt: [ciphertext], encrypt: [] }, 4321);
        await flush();
        children[0].reply({ decrypted: ['first-result'], encrypted: [] });
        await first;
        const second = session.run({ decrypt: [ciphertext], encrypt: [] }, 4321);
        await flush();
        deadlines[0]();
        assert.deepEqual(children[0].kills, []);
        children[0].reply({ decrypted: ['second-result'], encrypted: [] });
        assert.deepEqual(await second, { decrypted: ['second-result'], encrypted: [] });
    } finally {
        global.setTimeout = originalTimeout;
    }
});

test('the default macOS client shares its helper and adds only a non-secret ownership pipe', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const childProcess = require('node:child_process');
    const originalSpawn = childProcess.spawn;
    const children = [];
    let launched;
    childProcess.spawn = (executable, args, options) => {
        const child = childFixture();
        child.send = request => {
            child.requests.push(request);
            setImmediate(() => child.reply({ decrypted: [], encrypted: [ciphertext] }));
            return true;
        };
        children.push(child); launched = { executable, args, options }; return child;
    };
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
        await runCredentialHelper({ decrypt: [], encrypt: ['first-default-key'] });
        await runCredentialHelper({ decrypt: [], encrypt: ['second-default-key'] });
        assert.equal(children.length, 1);
        assert.deepEqual(launched.args, ['--xora-credential-helper', '--xora-credential-session']);
        assert.deepEqual(launched.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc', 'pipe']);
        assert.equal(launched.options.cwd, path.dirname(process.execPath));
        assert.equal(launched.options.env.XORA_CREDENTIAL_USER_DATA, '/fixture/user-data');
        assert.equal(launched.options.env.XORA_CREDENTIAL_SESSION_DATA, '/fixture/session');
        assert.ok(!JSON.stringify(launched).includes('first-default-key'));
        assert.ok(!JSON.stringify(launched).includes('second-default-key'));
        disposeMacCredentialSession();
        assert.equal(children[0].disconnects, 1);
        children[0].close();
    } finally {
        disposeMacCredentialSession();
        for (const child of children) child.close();
        Object.defineProperty(process, 'platform', platform);
        childProcess.spawn = originalSpawn;
    }
});
