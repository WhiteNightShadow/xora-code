// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const test = require('node:test');
const { OwnedBackendProcess } = require('../lib/electron-main/owned-backend-process');

class Child extends EventEmitter {
    pid = 2147000000;
    exitCode = null;
    signalCode = null;
    signals = [];
    kill(signal) { this.signals.push(signal); return true; }
    exit(code = 0, signal = null) {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
    }
}
class ObservedBackend extends OwnedBackendProcess {
    groupSignals = [];
    killDetachedGroup() {
        this.groupSignals.push('SIGKILL');
        this.child.exit(null, 'SIGKILL');
    }
}

function fixture(detached = true) {
    const child = new Child();
    const owned = new ObservedBackend(child, detached);
    const original = child.kill.bind(child);
    child.kill = signal => {
        original(signal);
        if (signal === 'SIGKILL') child.exit(null, signal);
        return true;
    };
    return { child, owned };
}

test('backend gets graceful TERM only; normal exit needs no group signal', async () => {
    const { child, owned } = fixture();
    child.kill = signal => {
        child.signals.push(signal);
        setImmediate(() => child.exit());
        return true;
    };
    assert.deepEqual(await owned.stop(50, 50), { forced: false, exited: true });
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.deepEqual(owned.groupSignals, []);
});

test('default grace preserves legitimate asynchronous teardown lasting more than one second', { timeout: 5000 }, async () => {
    const { child, owned } = fixture();
    child.kill = signal => {
        child.signals.push(signal);
        setTimeout(() => child.exit(), 1100);
        return true;
    };
    assert.deepEqual(await owned.stop(), { forced: false, exited: true });
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.deepEqual(owned.groupSignals, []);
});

test('repeated shutdown calls share one bounded TERM then forced termination sequence', async () => {
    const { child, owned } = fixture();
    const first = owned.stop(5, 20);
    assert.strictEqual(owned.stop(5, 20), first);
    assert.deepEqual(await first, { forced: true, exited: true });
    assert.deepEqual(child.signals, process.platform === 'win32' ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM']);
    assert.deepEqual(owned.groupSignals, process.platform === 'win32' ? [] : ['SIGKILL']);
    owned.forceKill();
    assert.equal(child.signals.length + owned.groupSignals.length, 2, 'do not signal an exited child again');
});

test('a non-detached child never receives a process-group signal', async () => {
    const { child, owned } = fixture(false);
    assert.deepEqual(await owned.stop(5, 20), { forced: true, exited: true });
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(owned.groupSignals, []);
});

test('unspawned, unsafe, replaced and exited child identities are never signalled', async () => {
    for (const state of ['unspawned', 'zero', 'negative', 'self', 'replaced', 'exited']) {
        const child = new Child();
        if (state === 'unspawned') child.pid = undefined;
        if (state === 'zero') child.pid = 0;
        if (state === 'negative') child.pid = -1;
        if (state === 'self') child.pid = process.pid;
        const owned = new ObservedBackend(child, true);
        if (state === 'replaced') child.pid++;
        if (state === 'exited') child.exit();
        await owned.stop(1, 1);
        owned.forceKill();
        assert.deepEqual(child.signals, [], state);
        assert.deepEqual(owned.groupSignals, [], state);
    }
});

test('an exit arriving just before escalation cancels the force signal', async () => {
    const { child, owned } = fixture();
    owned.waitForExit = async () => { child.exit(); return false; };
    await owned.stop(1, 1);
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.deepEqual(owned.groupSignals, []);
});

test('force termination has its own finite confirmation wait', async () => {
    const { child, owned } = fixture();
    owned.forceKill = () => true;
    const started = Date.now();
    assert.deepEqual(await owned.stop(5, 10), { forced: true, exited: false });
    assert.ok(Date.now() - started < 1000);
    assert.equal(child.listenerCount('exit'), 0);
});

test('real detached Unix backend blocked opening FIFO and its descendant exit without releasing the FIFO', {
    skip: process.platform === 'win32', timeout: 8000
}, async t => {
    const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xora-backend-shutdown-')));
    const fifo = path.join(directory, 'blocked.code-workspace');
    const script = path.join(directory, 'backend.cjs');
    const descendantScript = path.join(directory, 'descendant.cjs');
    fs.writeFileSync(descendantScript, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n");
    fs.writeFileSync(script, `
const fs=require('node:fs');const {spawn}=require('node:child_process');
process.on('SIGTERM',()=>{if(process.connected)process.disconnect();});
const descendant=spawn(process.execPath,[process.argv[3]],{stdio:'inherit'});
fs.open(process.argv[2],'r',()=>{});
process.send({ready:true,descendant:descendant.pid});
`);
    execFileSync('mkfifo', [fifo]);
    const child = fork(script, [fifo, descendantScript], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const owned = new OwnedBackendProcess(child, true);
    let descendant;
    t.after(async () => {
        owned.forceKill();
        if (descendant) {
            try {
                const command = execFileSync('ps', ['-p', String(descendant), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                if (command.includes(descendantScript)) process.kill(descendant, 'SIGKILL');
            } catch { /* owned descendant already gone */ }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const [message] = await once(child, 'message');
    assert.equal(message.ready, true);
    descendant = message.descendant;
    const closed = once(child, 'close');
    const result = await owned.stop(40, 1000);
    assert.deepEqual(result, { forced: true, exited: true });
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    try {
        const state = execFileSync('ps', ['-p', String(descendant), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        assert.ok(!state || state.startsWith('Z'), 'same-group descendant remained running');
    } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error;
        assert.equal(error.status, 1, 'unexpected process inspection error');
    }
});
