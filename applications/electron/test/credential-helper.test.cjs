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
