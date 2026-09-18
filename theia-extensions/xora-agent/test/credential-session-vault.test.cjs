'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const app = Object.assign(new EventEmitter(), { isPackaged: true, getPath: () => os.tmpdir() });
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
    if (name === 'electron') return { app, safeStorage: new Proxy({}, {
        get() { throw new Error('Vault must not enter native Keychain in the main process'); }
    }) };
    return originalLoad.call(this, name, parent, isMain);
};
const { SecretVault } = require('../lib/electron-main/secret-vault');
const { CredentialAccessError } = require('../lib/electron-main/credential-helper-client');
Module._load = originalLoad;

const encrypted = Buffer.from('fixture-encrypted').toString('base64');
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-credential-session-vault-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const vault = new SecretVault();
    vault.filePath = path.join(directory, 'secrets.json');
    vault.lockPath = path.join(directory, '.secrets.lock');
    vault.recoveryPath = path.join(directory, '.credential-recovery.json');
    fs.writeFileSync(vault.filePath, JSON.stringify({ schemaVersion: 1, values: {
        'provider:a': encrypted, 'provider:b': encrypted
    } }));
    return vault;
}

test('one failed authorization rejects old queued saves instead of presenting successive OS prompts', async t => {
    const vault = fixture(t);
    const before = fs.readFileSync(vault.filePath, 'utf8');
    let calls = 0;
    let rejectAuthorization;
    vault.runHelper = () => {
        calls++;
        return new Promise((_, reject) => { rejectAuthorization = reject; });
    };
    const first = assert.rejects(vault.prepare(['provider:a'], { retry: true }), { code: 'CREDENTIAL_ACCESS_TIMEOUT' });
    const queuedProvider = assert.rejects(vault.prepare(['provider:b'], { retry: true }), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    const queuedSave = assert.rejects(vault.prepareSet('queued-new-key'), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(vault.lockPath), false);
    rejectAuthorization(new CredentialAccessError('CREDENTIAL_ACCESS_TIMEOUT'));
    await Promise.all([first, queuedProvider, queuedSave]);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(vault.filePath, 'utf8'), before);
    assert.equal(vault.preparedEncryptions.size, 0);

    vault.runHelper = async () => { calls++; return { decrypted: ['fixture-key'], encrypted: [] }; };
    await vault.prepare(['provider:a'], { retry: true });
    assert.equal(vault.get('provider:a'), 'fixture-key');
    assert.equal(calls, 2, 'a new explicit retry after the failed queue can authorize again');
    assert.equal(fs.existsSync(vault.recoveryPath), false);
});

test('Mac explicit authorization has a longer budget while automatic startup stays bounded', async t => {
    const vault = fixture(t);
    const budgets = [];
    vault.runHelper = async (request, options) => {
        budgets.push(options.timeoutMs);
        return {
            decrypted: request.decrypt.map(() => 'fixture-key'),
            encrypted: request.encrypt.map(() => encrypted)
        };
    };
    await vault.prepare(['provider:a']);
    await vault.prepare(['provider:b'], { retry: true });
    await vault.prepareSet('new-fixture-key');
    assert.deepEqual(budgets, [15000, process.platform === 'darwin' ? 90000 : 15000, process.platform === 'darwin' ? 90000 : 15000]);
    await vault.prepare(['provider:a', 'provider:b']);
    await vault.prepareSet('new-fixture-key');
    assert.equal(budgets.length, 3, 'already prepared credentials require no new authorization');
});

test('an existing recovery marker does not cancel a queued explicit unlock', async t => {
    const vault = fixture(t);
    fs.writeFileSync(vault.recoveryPath, '{}');
    let calls = 0;
    vault.runHelper = async () => { calls++; return { decrypted: ['fixture-key'], encrypted: [] }; };
    const automatic = assert.rejects(vault.prepare(['provider:a']), { code: 'CREDENTIAL_UNLOCK_REQUIRED' });
    const explicit = vault.prepare(['provider:a'], { retry: true });
    await Promise.all([automatic, explicit]);
    assert.equal(calls, 1);
    assert.equal(vault.get('provider:a'), 'fixture-key');
});

test('Mac unavailable-storage fallback does not replay already queued password prompts', async t => {
    const vault = fixture(t);
    const before = fs.readFileSync(vault.filePath, 'utf8');
    let calls = 0;
    vault.runHelper = async () => { calls++; throw new CredentialAccessError('CREDENTIAL_STORAGE_UNAVAILABLE'); };
    const results = await Promise.allSettled([vault.prepareSet('first-fixture-key'), vault.prepareSet('queued-fixture-key')]);
    assert.equal(results[0].status, 'fulfilled', 'current operation preserves the established memory-only fallback');
    if (process.platform === 'darwin') {
        assert.equal(results[1].status, 'rejected');
        assert.equal(results[1].reason.code, 'CREDENTIAL_UNLOCK_REQUIRED');
        assert.equal(calls, 1);
    } else {
        assert.equal(results[1].status, 'fulfilled');
        assert.equal(calls, 2, 'other platforms retain their existing unavailable-storage behavior');
    }
    assert.equal(fs.readFileSync(vault.filePath, 'utf8'), before);
    vault.runHelper = async () => { calls++; return { decrypted: [], encrypted: [encrypted] }; };
    await vault.prepareSet('explicit-later-fixture-key');
    assert.equal(vault.isPersistentStorageAvailable(), true);
});
