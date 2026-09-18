'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('credential helper mirrors sessionData and uses graceful Electron shutdown after IPC completion', async () => {
    const script = fs.readFileSync(path.join(__dirname, '../scripts/credential-helper.js'), 'utf8');
    const calls = [];
    const child = Object.assign(new EventEmitter(), {
        platform: 'win32',
        connected: true,
        env: { XORA_CREDENTIAL_SESSION_DATA: '/fixture/session-profile' },
        send: (response, completed) => {
            calls.push('response');
            assert.equal(response.encrypted.length, 1);
            assert.equal(response.decrypted.length, 0);
            assert.equal(calls.includes('quit'), false);
            completed();
        }
    });
    vm.runInNewContext(script, {
        Buffer,
        process: child,
        require: name => {
            assert.equal(name, 'electron');
            return {
                app: {
                    setPath: (name, value) => {
                        assert.equal(name, 'sessionData');
                        assert.equal(value, '/fixture/session-profile');
                        calls.push('session-path');
                    },
                    disableHardwareAcceleration: () => undefined,
                    whenReady: async () => { calls.push('ready'); },
                    quit: () => { calls.push('quit'); },
                    exit: () => assert.fail('immediate app.exit can skip pending preference writes')
                },
                safeStorage: {
                    isEncryptionAvailable: () => true,
                    encryptString: value => Buffer.from(`fixture:${value}`)
                }
            };
        }
    });
    child.emit('message', { decrypt: [], encrypt: ['generated-fixture-key'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['session-path', 'ready', 'response', 'quit']);
});

function sessionFixture(options = {}) {
    const calls = [];
    const responses = [];
    const app = Object.assign(new EventEmitter(), {
        setPath: () => undefined,
        disableHardwareAcceleration: () => undefined,
        whenReady: async () => undefined,
        quit: () => { calls.push('quit'); app.emit('will-quit'); }
    });
    const child = Object.assign(new EventEmitter(), {
        platform: options.platform ?? 'darwin',
        argv: ['xora-code', '--xora-credential-helper', '--xora-credential-session'],
        connected: true,
        env: {},
        send: (response, complete) => {
            responses.push(JSON.parse(JSON.stringify(response)));
            complete();
        }
    });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/credential-helper.js'), 'utf8'), {
        Buffer,
        process: child,
        require: name => {
            if (name === './credential-parent-watchdog') return {
                startCredentialParentWatchdog: () => ({
                    ready: options.watchdogReady ?? Promise.resolve(),
                    stop: () => calls.push('watchdog-stop')
                })
            };
            assert.equal(name, 'electron');
            return { app, safeStorage: {
                isEncryptionAvailable: () => options.available !== false,
                getSelectedStorageBackend: () => 'gnome_libsecret',
                encryptString: value => { calls.push('encrypt'); return Buffer.from('encrypted:' + value); },
                decryptString: value => { calls.push('decrypt'); return value.toString().slice('encrypted:'.length); }
            } };
        }
    });
    return { app, child, calls, responses };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('macOS session serves correlated encrypt/decrypt requests without restarting the helper', async () => {
    const f = sessionFixture();
    f.child.emit('message', { requestId: 1, decrypt: [], encrypt: ['first'] });
    await turn();
    f.child.emit('message', { requestId: 2, decrypt: [f.responses[0].encrypted[0]], encrypt: ['second'] });
    await turn();
    assert.deepEqual(f.responses, [
        { decrypted: [], encrypted: [Buffer.from('encrypted:first').toString('base64')], requestId: 1 },
        { decrypted: ['first'], encrypted: [Buffer.from('encrypted:second').toString('base64')], requestId: 2 }
    ]);
    assert.deepEqual(f.calls, ['encrypt', 'decrypt', 'encrypt']);
    f.child.connected = false;
    f.child.emit('disconnect');
    assert.deepEqual(f.calls.slice(-2), ['quit', 'watchdog-stop']);
});

test('session errors retain their request identity and retire the native key cache', async () => {
    const f = sessionFixture({ available: false });
    f.child.emit('message', { requestId: 9, decrypt: [], encrypt: ['fixture'] });
    await turn();
    assert.deepEqual(f.responses, [{ error: 'unavailable', requestId: 9 }]);
    assert.deepEqual(f.calls, ['quit', 'watchdog-stop']);
});

test('Mac shutdown control quits without a credential operation or response', async () => {
    const f = sessionFixture();
    f.child.emit('message', { type: 'shutdown' });
    await turn();
    assert.deepEqual(f.calls, ['quit', 'watchdog-stop']);
    assert.deepEqual(f.responses, []);
});

test('a repeated session request ID cannot reuse the helper or enter the OS again', async () => {
    const f = sessionFixture();
    f.child.emit('message', { requestId: 1, decrypt: [], encrypt: ['first'] });
    await turn();
    f.child.emit('message', { requestId: 1, decrypt: [], encrypt: ['second'] });
    await turn();
    assert.deepEqual(f.responses[1], { error: 'denied', requestId: 1 });
    assert.equal(f.calls.filter(call => call === 'encrypt').length, 1);
    assert.deepEqual(f.calls.slice(-2), ['quit', 'watchdog-stop']);
});

test('a second request during setup retires the session before either OS operation', async () => {
    let ready;
    const f = sessionFixture({ watchdogReady: new Promise(resolve => { ready = resolve; }) });
    f.child.emit('message', { requestId: 1, decrypt: [], encrypt: ['first'] });
    f.child.emit('message', { requestId: 2, decrypt: [], encrypt: ['second'] });
    ready();
    await turn();
    assert.deepEqual(f.responses, [{ error: 'denied', requestId: 2 }]);
    assert.equal(f.calls.includes('encrypt'), false);
});

test('a failed parent monitor cannot authorize a session operation', async () => {
    const f = sessionFixture({ watchdogReady: Promise.reject(new Error('private native monitor detail')) });
    f.child.emit('message', { requestId: 1, decrypt: [], encrypt: ['fixture'] });
    await turn();
    assert.deepEqual(f.responses, [{ error: 'denied', requestId: 1 }]);
    assert.equal(f.calls.includes('encrypt'), false);
});

test('Windows and Linux ignore the Mac session flag and retain one-shot graceful close', async () => {
    for (const platform of ['win32', 'linux']) {
        const f = sessionFixture({ platform });
        f.child.emit('message', { decrypt: [], encrypt: ['fixture'] });
        await turn();
        assert.equal(f.responses.length, 1);
        assert.equal(f.responses[0].requestId, undefined);
        assert.deepEqual(f.calls, ['encrypt', 'quit']);
        f.child.emit('message', { decrypt: [], encrypt: ['ignored'] });
        await turn();
        assert.equal(f.responses.length, 1);
    }
});
