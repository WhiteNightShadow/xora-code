const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: () => os.tmpdir()
});
const originalLoad = Module._load;
let cachedWindowsAvailability;
let cachedWindowsAvailabilityReads = 0;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app, safeStorage: new Proxy({}, {
        get(_target, property) {
            if (property === 'isEncryptionAvailable' && cachedWindowsAvailability !== undefined) {
                return () => { cachedWindowsAvailabilityReads++; return cachedWindowsAvailability; };
            }
            throw new Error('safeStorage encryption/decryption must never run in the application main process');
        }
    }) };
    return originalLoad.call(this, request, parent, isMain);
};
const { SecretVault } = require('../lib/electron-main/secret-vault');
const { CredentialAccessError, runCredentialHelper, waitForWindowsStorageKey } = require('../lib/electron-main/credential-helper-client');
const { ProviderRegistry } = require('../lib/electron-main/provider-registry');
Module._load = originalLoad;

const encrypted = Buffer.from('encrypted-value').toString('base64');
function fixture(t, contents = { 'provider:xora-fixture': encrypted }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-credential-recovery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const vault = new SecretVault();
    vault.filePath = path.join(directory, 'secrets.json');
    vault.lockPath = path.join(directory, '.secrets.lock');
    vault.recoveryPath = path.join(directory, '.credential-recovery.json');
    fs.writeFileSync(vault.filePath, JSON.stringify({ schemaVersion: 1, values: contents }));
    return vault;
}

test('metadata and synchronous reads cannot enter the OS keychain', t => {
    const vault = fixture(t);
    vault.runHelper = () => { throw new Error('unexpected helper'); };
    assert.equal(vault.has('provider:xora-fixture'), true);
    assert.equal(vault.get('provider:missing'), undefined);
    assert.throws(() => vault.get('provider:xora-fixture'), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    assert.deepEqual(vault.cachedSecrets(), []);
    assert.equal(vault.isPersistentStorageAvailable(), false);
});

test('fresh profiles never launch a credential helper', async t => {
    const vault = fixture(t);
    fs.unlinkSync(vault.filePath);
    vault.runHelper = () => { throw new Error('unexpected helper'); };
    assert.equal(vault.has('provider:missing'), false);
    assert.equal(vault.get('provider:missing'), undefined);
    await vault.prepare(['provider:missing']);
    assert.equal(fs.existsSync(vault.recoveryPath), false);
});

test('failed authorization is not replayed automatically, including after a restart', async t => {
    const vault = fixture(t);
    const before = fs.readFileSync(vault.filePath, 'utf8');
    let calls = 0;
    vault.runHelper = async () => {
        calls++;
        throw new CredentialAccessError('CREDENTIAL_ACCESS_TIMEOUT');
    };
    await assert.rejects(vault.prepare(['provider:xora-fixture']), { code: 'CREDENTIAL_ACCESS_TIMEOUT' });
    await assert.rejects(vault.prepare(['provider:xora-fixture']), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(vault.filePath, 'utf8'), before);
    const restarted = new SecretVault();
    restarted.filePath = vault.filePath;
    restarted.lockPath = vault.lockPath;
    restarted.recoveryPath = vault.recoveryPath;
    restarted.runHelper = async request => {
        calls++;
        assert.deepEqual(request, { decrypt: [encrypted], encrypt: [] });
        return { decrypted: ['fixture-secret'], encrypted: [] };
    };
    await assert.rejects(restarted.prepare(['provider:xora-fixture']), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    assert.equal(calls, 1);
    await restarted.prepare(['provider:xora-fixture'], { retry: true });
    assert.equal(restarted.get('provider:xora-fixture'), 'fixture-secret');
    assert.equal(fs.existsSync(vault.recoveryPath), false);
    assert.equal(fs.readFileSync(vault.filePath, 'utf8'), before);
});

test('concurrent credential preparation shares cached decryption and detects external changes', async t => {
    const vault = fixture(t);
    let calls = 0;
    vault.runHelper = async () => {
        calls++;
        await new Promise(resolve => setImmediate(resolve));
        return { decrypted: ['fixture-secret'], encrypted: [] };
    };
    await Promise.all([vault.prepare(['provider:xora-fixture']), vault.prepare(['provider:xora-fixture'])]);
    assert.equal(calls, 1);
    fs.writeFileSync(vault.filePath, JSON.stringify({ schemaVersion: 1, values: {
        'provider:xora-fixture': Buffer.from('replacement').toString('base64')
    } }));
    assert.throws(() => vault.get('provider:xora-fixture'), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    vault.runHelper = async () => {
        fs.writeFileSync(vault.filePath, JSON.stringify({ schemaVersion: 1, values: {} }));
        return { decrypted: ['obsolete-secret'], encrypted: [] };
    };
    await assert.rejects(vault.prepare(['provider:xora-fixture']), { code: 'CREDENTIAL_STORE_CHANGED' });
    assert.equal(vault.get('provider:xora-fixture'), undefined);
    assert.deepEqual(vault.cachedSecrets(), []);
});

test('encrypted replacement, rollback and deletion need no old credential decryption', async t => {
    const vault = fixture(t);
    const previous = vault.capture('provider:xora-fixture');
    const replacement = Buffer.from('new-encrypted-value').toString('base64');
    vault.runHelper = async request => {
        assert.deepEqual(request, { decrypt: [], encrypt: ['new-secret'] });
        return { decrypted: [], encrypted: [replacement] };
    };
    await vault.prepareSet('new-secret');
    vault.set('provider:xora-fixture', 'new-secret');
    assert.equal(vault.get('provider:xora-fixture'), 'new-secret');
    assert.equal(JSON.parse(fs.readFileSync(vault.filePath, 'utf8')).values['provider:xora-fixture'], replacement);
    vault.restore('provider:xora-fixture', previous);
    assert.equal(JSON.parse(fs.readFileSync(vault.filePath, 'utf8')).values['provider:xora-fixture'], encrypted);
    assert.throws(() => vault.get('provider:xora-fixture'), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    vault.delete('provider:xora-fixture');
    assert.equal(vault.has('provider:xora-fixture'), false);
});

test('unavailable secure storage keeps a newly entered key in memory only', async t => {
    const vault = fixture(t, {});
    const before = fs.readFileSync(vault.filePath, 'utf8');
    vault.runHelper = async () => { throw new CredentialAccessError('CREDENTIAL_STORAGE_UNAVAILABLE'); };
    await vault.prepareSet('session-only-key');
    vault.set('provider:xora-new', 'session-only-key');
    assert.equal(vault.get('provider:xora-new'), 'session-only-key');
    assert.equal(fs.readFileSync(vault.filePath, 'utf8'), before);
});

test('a session-only replacement cannot reactivate the previous saved key after restart', async t => {
    const vault = fixture(t);
    vault.runHelper = async () => { throw new CredentialAccessError('CREDENTIAL_STORAGE_UNAVAILABLE'); };
    await vault.prepareSet('session-only-replacement');
    vault.set('provider:xora-fixture', 'session-only-replacement');
    assert.equal(vault.get('provider:xora-fixture'), 'session-only-replacement');
    assert.deepEqual(JSON.parse(fs.readFileSync(vault.filePath, 'utf8')).values, {});
});

test('redaction enumerates cached credentials without decrypting unrelated providers', () => {
    const registry = Object.create(ProviderRegistry.prototype);
    registry.vault = {
        get: () => { throw new Error('must not decrypt'); },
        cachedSecrets: () => ['already-unlocked-key']
    };
    registry.list = () => { throw new Error('must not enumerate providers'); };
    assert.deepEqual(registry.redactionSecrets(), ['already-unlocked-key']);
});

test('a blocked OS helper is killed on deadline while the application event loop stays responsive', async () => {
    const child = new EventEmitter();
    let killed;
    let responsive = false;
    child.send = () => setImmediate(() => { responsive = true; });
    child.kill = signal => { killed = signal; child.emit('exit', null, signal); };
    await assert.rejects(runCredentialHelper({ decrypt: [encrypted], encrypt: [] }, {
        spawnHelper: () => child, timeoutMs: 25
    }), { code: 'CREDENTIAL_ACCESS_TIMEOUT' });
    assert.equal(responsive, true);
    assert.equal(killed, 'SIGKILL');
    assert.equal(app.listenerCount('will-quit'), 0);
});

test('helper errors expose only fixed classifications and never native diagnostics', async () => {
    const child = new EventEmitter();
    child.send = () => setImmediate(() => child.emit('error', new Error('sensitive-native-payload')));
    child.kill = () => true;
    await assert.rejects(runCredentialHelper({ decrypt: [], encrypt: ['fixture-secret'] }, {
        spawnHelper: () => child
    }), error => error.code === 'CREDENTIAL_ACCESS_DENIED'
        && !error.message.includes('sensitive-native-payload') && !error.message.includes('fixture-secret'));
});

test('successful helper output is accepted only after normal close and never sends SIGKILL', async () => {
    const child = new EventEmitter();
    let kills = 0;
    let accepted = false;
    child.send = () => undefined;
    child.kill = () => { kills++; };
    const operation = runCredentialHelper({ decrypt: [], encrypt: ['fixture-secret'] }, {
        spawnHelper: () => child
    }).then(result => { accepted = true; return result; });
    child.emit('message', { decrypted: [], encrypted: [encrypted] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(accepted, false);
    child.emit('exit', 0, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(accepted, false);
    child.emit('close', 0, null);
    assert.deepEqual(await operation, { decrypted: [], encrypted: [encrypted] });
    assert.equal(kills, 0);
    assert.equal(app.listenerCount('will-quit'), 0);
});

test('an IPC success cannot commit ciphertext when helper shutdown hangs or crashes', async () => {
    for (const abnormal of [false, true]) {
        const child = new EventEmitter();
        let kills = 0;
        child.send = () => setImmediate(() => {
            child.emit('message', { decrypted: [], encrypted: [encrypted] });
            if (abnormal) child.emit('close', 1, null);
        });
        child.kill = () => { kills++; };
        await assert.rejects(runCredentialHelper({ decrypt: [], encrypt: ['fixture-secret'] }, {
            spawnHelper: () => child, timeoutMs: 30
        }), { code: abnormal ? 'CREDENTIAL_ACCESS_DENIED' : 'CREDENTIAL_ACCESS_TIMEOUT' });
        assert.equal(kills, 1);
    }
});

test('Windows helper preparation observes the persisted profile key before proceeding', async t => {
    const vault = fixture(t, {});
    const localState = path.join(path.dirname(vault.filePath), 'Local State');
    let ready = false;
    const waiting = waitForWindowsStorageKey(localState, 1000).then(() => { ready = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false);
    fs.writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIwrapped-fixture-key').toString('base64') } }));
    await waiting;
    assert.equal(ready, true);
});

test('missing or invalid persisted Windows profile keys time out without being replaced', async t => {
    const vault = fixture(t, {});
    const localState = path.join(path.dirname(vault.filePath), 'Local State');
    const original = JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('not-a-DPAPI-key').toString('base64') } });
    fs.writeFileSync(localState, original);
    await assert.rejects(waitForWindowsStorageKey(localState, 25), { code: 'CREDENTIAL_ACCESS_TIMEOUT' });
    assert.equal(fs.readFileSync(localState, 'utf8'), original);
    fs.unlinkSync(localState);
    await assert.rejects(waitForWindowsStorageKey(localState, 25), { code: 'CREDENTIAL_ACCESS_TIMEOUT' });
    assert.equal(fs.existsSync(localState), false);
});

test('cancelled Windows profile preparation cannot be revived by a late file write', async t => {
    const vault = fixture(t, {});
    const localState = path.join(path.dirname(vault.filePath), 'Local State');
    const controller = new AbortController();
    const operation = waitForWindowsStorageKey(localState, 1000, controller.signal);
    controller.abort();
    await assert.rejects(operation, { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    fs.writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIlate-key').toString('base64') } }));
    await new Promise(resolve => setImmediate(resolve));
});

test('quitting before Windows app-ready preparation resolves can never launch a late helper', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const childProcess = require('node:child_process');
    const spawn = childProcess.spawn;
    const whenReady = app.whenReady;
    let ready;
    let spawns = 0;
    app.whenReady = () => new Promise(resolve => { ready = resolve; });
    childProcess.spawn = () => { spawns++; throw new Error('unexpected late spawn'); };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
        const operation = runCredentialHelper({ decrypt: [], encrypt: ['fixture-secret'] });
        app.emit('will-quit');
        await assert.rejects(operation, { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
        ready();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(spawns, 0);
    } finally {
        Object.defineProperty(process, 'platform', platform);
        childProcess.spawn = spawn;
        if (whenReady === undefined) delete app.whenReady;
        else app.whenReady = whenReady;
    }
});

test('the helper inherits the exact session profile and an application-local working directory', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const childProcess = require('node:child_process');
    const spawn = childProcess.spawn;
    const getPath = app.getPath;
    const getName = app.getName;
    const getAppPath = app.getAppPath;
    const child = new EventEmitter();
    let options;
    child.send = () => setImmediate(() => {
        child.emit('message', { decrypted: [], encrypted: [encrypted] });
        child.emit('close', 0, null);
    });
    child.kill = () => assert.fail('successful helper must quit normally');
    childProcess.spawn = (_executable, _arguments, value) => { options = value; return child; };
    app.getPath = name => name === 'sessionData' ? '/fixture/overridden-session-data' : '/fixture/user-data';
    app.getName = () => 'Fixture App';
    app.getAppPath = () => '/fixture/application';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
        await runCredentialHelper({ decrypt: [], encrypt: ['fixture-secret'] });
        assert.equal(options.cwd, path.dirname(process.execPath));
        assert.equal(options.env.XORA_CREDENTIAL_USER_DATA, '/fixture/user-data');
        assert.equal(options.env.XORA_CREDENTIAL_SESSION_DATA, '/fixture/overridden-session-data');
    } finally {
        Object.defineProperty(process, 'platform', platform);
        childProcess.spawn = spawn;
        app.getPath = getPath;
        if (getName === undefined) delete app.getName;
        else app.getName = getName;
        if (getAppPath === undefined) delete app.getAppPath;
        else app.getAppPath = getAppPath;
    }
});

test('cached Windows encryption unavailability is reported without waiting for a profile key or spawning', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const whenReady = app.whenReady;
    const getPath = app.getPath;
    app.whenReady = async () => undefined;
    app.getPath = () => assert.fail('unavailable encryption must not wait on Local State');
    cachedWindowsAvailability = false;
    cachedWindowsAvailabilityReads = 0;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
        await assert.rejects(runCredentialHelper({ decrypt: [], encrypt: ['fixture-secret'] }, { timeoutMs: 1000 }), {
            code: 'CREDENTIAL_STORAGE_UNAVAILABLE'
        });
        assert.equal(cachedWindowsAvailabilityReads, 1);
    } finally {
        Object.defineProperty(process, 'platform', platform);
        cachedWindowsAvailability = undefined;
        app.getPath = getPath;
        if (whenReady === undefined) delete app.whenReady;
        else app.whenReady = whenReady;
    }
});
