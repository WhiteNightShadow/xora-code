// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function fixture({ platform = 'linux', args = [] } = {}) {
    const events = [];
    const forks = [];
    const owners = [];
    const runtime = { platform, argv: ['electron', ...args], versions: { electron: '39.8.7' }, env: {} };
    const app = new EventEmitter();
    app.canCloseWindows = true;
    app.completedQuits = 0;
    app.quit = () => {
        events.push('app.quit');
        const before = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        app.emit('before-quit', before);
        if (before.defaultPrevented || !app.canCloseWindows) return;
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        app.emit('will-quit', event);
        if (!event.defaultPrevented) { app.completedQuits++; app.emit('quit'); }
    };
    app.exit = () => assert.fail('never bypass normal quit handlers');
    class ElectronMainApplication {
        async startBackend() { events.push('super.startBackend'); return 1234; }
        async getForkOptions() { return { detached: platform !== 'win32', env: { TOKEN: 'owned-fixture', VERSION: runtime.env.THEIA_ELECTRON_VERSION } }; }
        onWillQuit() { events.push('stopContributions'); }
        hookApplicationEvents() { app.on('will-quit', this.onWillQuit.bind(this)); }
    }
    class OwnedBackendProcess {
        constructor(child, detached) { this.child = child; this.detached = detached; owners.push(this); }
        stop() { events.push('backend.TERM/wait'); return new Promise(resolve => { this.finish = resolve; }); }
        forceKill() { events.push('backend.quit-fallback'); }
    }
    const filename = path.resolve(__dirname, '../lib/electron-main/xora-electron-main-application.js');
    const actualRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, process: runtime, console,
        require(id) {
            if (id === '@theia/core/lib/electron-main/electron-main-application') return { ElectronMainApplication };
            if (id === '@theia/core/electron-shared/electron') return { app };
            if (id === './owned-backend-process') return { OwnedBackendProcess };
            if (id === 'child_process') return { fork: (...argv) => { const child = new EventEmitter(); forks.push({ argv, child }); return child; } };
            return actualRequire(id);
        }
    }, { filename });
    const application = new module.exports.XoraElectronMainApplication();
    application.globals = { THEIA_BACKEND_MAIN_PATH: '/fixture/backend-main.js' };
    application.processArgv = { getProcessArgvWithoutBin: () => ['--port', '0', '--fixture'] };
    application.contributions = { getContributions: () => [{ onStop: () => events.push('stopContributions') }] };
    application.hookApplicationEvents();
    return { application, app, events, forks, owners, runtime };
}

async function start(f) {
    const pending = f.application.startBackend();
    await new Promise(resolve => setImmediate(resolve));
    f.forks[0].child.emit('message', { port: 45007, family: 'IPv4', address: '127.0.0.1' });
    assert.equal(await pending, 45007);
}

test('owned Unix fork preserves arguments, token options and IPC port handshake', async () => {
    const f = fixture();
    await start(f);
    assert.equal(f.runtime.env.THEIA_ELECTRON_VERSION, '39.8.7');
    assert.deepEqual(f.forks[0].argv, ['/fixture/backend-main.js', ['--port', '0', '--fixture'], { detached: true, env: { TOKEN: 'owned-fixture', VERSION: '39.8.7' } }]);
    assert.strictEqual(f.owners[0].child, f.forks[0].child);
    assert.equal(f.owners[0].detached, true);
});

test('Windows and explicit no-cluster launches delegate their existing lifecycle', async () => {
    for (const options of [{ platform: 'win32' }, { args: ['--no-cluster'] }]) {
        const f = fixture(options);
        assert.equal(await f.application.startBackend(), 1234);
        f.app.quit();
        assert.deepEqual(f.events, ['super.startBackend', 'app.quit', 'stopContributions']);
        assert.equal(f.forks.length, 0);
        assert.equal(f.app.completedQuits, 1);
    }
});

test('dirty-window and before-quit vetoes do not start backend teardown', async () => {
    const f = fixture();
    await start(f);
    f.app.canCloseWindows = false;
    f.app.quit();
    assert.equal(f.application.backendShutdown, undefined);
    f.app.canCloseWindows = true;
    f.app.once('before-quit', event => event.preventDefault());
    f.app.quit();
    assert.equal(f.application.backendShutdown, undefined);
    assert.equal(f.events.includes('stopContributions'), false);
});

test('an existing will-quit veto is respected without stopping contributions or backend', async () => {
    const f = fixture();
    await start(f);
    f.app.prependListener('will-quit', event => event.preventDefault());
    f.app.quit();
    assert.equal(f.application.backendShutdown, undefined);
    assert.equal(f.events.includes('stopContributions'), false);
    assert.equal(f.app.completedQuits, 0);
});

test('will-quit holds Electron alive and repeated requests share one contribution/backend stop', async () => {
    const f = fixture();
    await start(f);
    f.app.quit();
    const stopping = f.application.backendShutdown;
    f.app.quit();
    assert.strictEqual(f.application.backendShutdown, stopping);
    assert.equal(f.app.completedQuits, 0);
    assert.equal(f.events.filter(value => value === 'stopContributions').length, 1);
    await Promise.resolve();
    assert.equal(f.events.filter(value => value === 'backend.TERM/wait').length, 1);
    f.owners[0].finish({ forced: false, exited: true });
    await stopping;
    assert.equal(f.app.completedQuits, 1);
    assert.equal(f.events.filter(value => value === 'stopContributions').length, 1);
});

test('resumed shutdown still uses app.quit and respects another before-quit veto', async () => {
    const f = fixture();
    await start(f);
    f.app.quit();
    f.app.once('before-quit', event => event.preventDefault());
    await Promise.resolve();
    f.owners[0].finish({ forced: true, exited: true });
    await f.application.backendShutdown;
    assert.equal(f.app.completedQuits, 0);
    assert.equal(f.events.at(-1), 'app.quit');
});

test('a reentrant throwing contribution cannot skip later cleanup or abandon bounded shutdown', async () => {
    const f = fixture();
    await start(f);
    f.application.contributions = { getContributions: () => [
        { onStop: () => {
            f.events.push('firstContribution');
            f.app.quit();
            throw new Error('fixture contribution cleanup failed');
        } },
        { onStop: () => f.events.push('laterContribution') }
    ] };
    f.app.quit();
    const stopping = f.application.backendShutdown;
    assert.ok(stopping);
    await Promise.resolve();
    assert.equal(f.events.filter(value => value === 'firstContribution').length, 1);
    assert.equal(f.events.filter(value => value === 'laterContribution').length, 1);
    assert.equal(f.events.filter(value => value === 'backend.TERM/wait').length, 1);
    f.owners[0].finish({ forced: false, exited: true });
    await stopping;
    assert.equal(f.app.completedQuits, 1);
});

test('startup spawn failure rejects the original handshake instead of fabricating readiness', async () => {
    const f = fixture();
    const starting = f.application.startBackend();
    const rejected = assert.rejects(starting, /spawn failed/);
    await new Promise(resolve => setImmediate(resolve));
    f.forks[0].child.emit('error', new Error('spawn failed'));
    await rejected;
});
