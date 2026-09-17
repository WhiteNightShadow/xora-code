// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const URI = require('@theia/core/lib/common/uri').default;
const { Deferred } = require('@theia/core/lib/common/promise-util');

function rendererClock() {
    let now = 0;
    let next = 0;
    const timers = new Map();
    const filename = path.resolve(__dirname, '../lib/common/workspace-startup.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, performance: { now: () => now },
        setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, due: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    }, { filename });
    return {
        deadlines: module.exports,
        elapseWithoutCallbacks(milliseconds) { now += milliseconds; },
        async advance(milliseconds, blocked = false) {
            const target = now + milliseconds;
            if (blocked) now = target;
            for (;;) {
                const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0] ?? [];
                if (!timer || timer.due > target) break;
                if (!blocked) now = timer.due;
                timers.delete(id);
                timer.callback();
                await new Promise(resolve => setImmediate(resolve));
            }
            now = target;
            await new Promise(resolve => setImmediate(resolve));
        },
        get pendingTimers() { return timers.size; }
    };
}

// Run the real product subclass with a small browser/base-service boundary.
// Theia's base imports DOM widgets, which are unrelated to restoration IO.
function fixture({ hash = '#/Volumes/offline/project', storage = new Map(), resolve, read, providerReady = true, clock } = {}) {
    const notices = [];
    const writes = [];
    const watches = [];
    const changes = [];
    const registrationListeners = new Set();
    const location = { hash, pathname: '/index.html', search: '' };
    const window = {
        location,
        history: { replaceState() { location.hash = ''; } },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        }
    };
    class BaseWorkspaceService {
        constructor() {
            this._roots = [];
            this.deferredRoots = new Deferred();
            this._ready = new Deferred();
            this.toDisposeOnWorkspace = { dispose() {}, push() {} };
            this.onWorkspaceChangeEmitter = { fire: roots => changes.push(roots) };
            this.onWorkspaceLocationChangedEmitter = { fire() {} };
            this.fileService = {
                hasProvider: scheme => scheme === 'file' && providerReady,
                activateProvider: async () => ({
                    stat: async uri => {
                        const file = await this.fileService.resolve(uri);
                        return { type: file.isDirectory ? 2 : 1, ctime: 0, mtime: 0, size: 0 };
                    }
                }),
                onDidChangeFileSystemProviderRegistrations: listener => {
                    registrationListeners.add(listener);
                    return { dispose: () => registrationListeners.delete(listener) };
                },
                resolve: resolve ?? (() => new Promise(() => {})),
                read: read ?? (() => new Promise(() => {})),
                watch: uri => { watches.push(uri.toString()); return { dispose() {} }; },
                onDidFilesChange() {}
            };
            this.fsPreferences = { onPreferenceChanged() {} };
            this.server = {
                getMostRecentlyUsedWorkspace: async () => undefined,
                setMostRecentlyUsedWorkspace: async uri => { writes.push(uri); }
            };
            this.messageService = { warn: async text => notices.push(text) };
        }
        get roots() { return this.deferredRoots.promise; }
        get ready() { return this._ready.promise; }
        isWorkspaceFile(stat) { return /\.(code-workspace|theia-workspace)$/u.test(stat.resource.path.base); }
        updateTitle() {}
        getWorkspacePath(uri) { return uri.path.toString(); }
        setURLFragment(value) { location.hash = '#' + value; }
        isRemoteSession() { return false; }
        async watchRoots() { for (const root of this._roots) this.fileService.watch(root.resource); }
        async setWorkspace(stat) {
            this._workspace = stat;
            this._roots = stat ? [stat] : [];
            this.deferredRoots.resolve(this._roots);
        }
        async toFileStat(uri) { return this.fileService.resolve(new URI(uri.toString())).catch(() => undefined); }
        async openWorkspace(uri) {
            const stat = await this.toFileStat(uri);
            if (!stat) throw new Error('Invalid workspace');
            await this.roots;
            this.openedManually = uri.toString();
        }
        async doInit() { this.remoteInitialization = true; }
    }
    const filename = path.resolve(__dirname, '../lib/browser/xora-workspace-service.js');
    const actualRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, window, document: { title: 'Grok' }, setTimeout, clearTimeout, AbortController,
        require(id) {
            if (clock && id === '../common/workspace-startup') return clock.deadlines;
            if (id === '@theia/workspace/lib/browser/workspace-service') {
                return {
                    WorkspaceService: BaseWorkspaceService,
                    WorkspaceData: {
                        is: value => value && Array.isArray(value.folders) && value.folders.every(folder => typeof folder.path === 'string'),
                        transformToAbsolute: value => value
                    }
                };
            }
            return actualRequire(id);
        }
    }, { filename });
    const service = new module.exports.XoraWorkspaceService();
    service.workspaceStartupTimeout = 15;
    service.workspaceStartupMaximumWait = 1000;
    return {
        service, notices, writes, watches, changes, storage, location, registrationListeners,
        registerFileProvider() {
            providerReady = true;
            for (const listener of registrationListeners) listener({ added: true, scheme: 'file' });
        }
    };
}

function stat(uri, directory = true) {
    return { resource: new URI(uri), isDirectory: directory, isFile: !directory, name: new URI(uri).path.base };
}

const offlineUri = 'file:///Volumes/offline/project';

test('a reply queued ahead of an overdue timer cannot bypass the frontend hard ceiling', async () => {
    const clock = rendererClock();
    let complete;
    const result = clock.deadlines.workspaceFrontendDeadline(new Promise(resolve => { complete = resolve; }), 15, 120);
    const rejection = assert.rejects(result, /Workspace restoration timed out/);
    clock.elapseWithoutCallbacks(120);
    complete('too late');
    await rejection;
    assert.equal(clock.pendingTimers, 0);
});

test('a hung network folder opens an empty window and releases ready and roots', async () => {
    const f = fixture();
    await f.service.doInit();
    await f.service.ready;
    assert.deepEqual(Array.from(await f.service.roots), []);
    assert.equal(f.service._workspace, undefined);
    assert.equal(f.location.hash, '');
    assert.deepEqual(f.writes, ['']);
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /网络盘.*打开最近/);
    assert.equal(f.storage.get('xora.workspace-recovery:' + offlineUri), 'failed');
});

test('a rejected drive resolve recovers without deleting its saved history', async () => {
    const f = fixture({ resolve: async () => { throw new Error('ENOTCONN'); } });
    await f.service.doInit();
    assert.equal(f.notices.length, 1);
    assert.deepEqual(f.writes, ['']);
    assert.equal(f.storage.size, 1);
});

test('late timed-out IO cannot replace the empty workspace or start watchers', async () => {
    let complete;
    const f = fixture({ resolve: () => new Promise(resolve => { complete = resolve; }) });
    await f.service.doInit();
    complete(stat(offlineUri));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service._workspace, undefined);
    assert.deepEqual(Array.from(f.service._roots), []);
    assert.deepEqual(f.watches, []);
    assert.deepEqual(f.writes, ['']);
});

test('an interrupted or failed restore is skipped on the next launch', async () => {
    for (const state of ['pending', 'failed']) {
        const storage = new Map([['xora.workspace-recovery:' + offlineUri, state]]);
        const f = fixture({ storage, resolve: async () => assert.fail('do not re-probe a quarantined drive') });
        await f.service.doInit();
        assert.equal(f.service._workspace, undefined);
        assert.equal(f.notices.length, 1);
    }
});

test('manual reopening clears recovery state and releases startup readiness', async () => {
    const storage = new Map([['xora.workspace-recovery:' + offlineUri, 'failed']]);
    const f = fixture({ storage, resolve: async uri => stat(uri.toString()) });
    await f.service.doInit();
    await f.service.openWorkspace(new URI(offlineUri));
    assert.equal(f.storage.size, 0);
    assert.equal(f.service.openedManually, offlineUri);
});

test('a healthy folder is restored and removes its pending marker', async () => {
    const f = fixture({ resolve: async uri => stat(uri.toString()) });
    await f.service.doInit();
    assert.equal(f.service._workspace.resource.toString(), offlineUri);
    assert.equal((await f.service.roots).length, 1);
    assert.equal(f.storage.size, 0);
    assert.deepEqual(f.writes, [offlineUri]);
    assert.deepEqual(f.notices, []);
});

test('startup only requests folder metadata and leaves directory enumeration to Explorer', async () => {
    const f = fixture({ resolve: async () => assert.fail('startup must not enumerate directory contents through resolve') });
    f.service.fileService.activateProvider = async () => ({
        stat: async () => ({ type: 2, ctime: 0, mtime: 0, size: 0 }),
        readdir: async () => assert.fail('a slow network directory listing must not block readiness')
    });
    await f.service.doInit();
    assert.equal(f.service._workspace.resource.toString(), offlineUri);
    assert.equal((await f.service.roots).length, 1);
    assert.deepEqual(f.notices, []);
});

test('startup waits for the built-in file provider without activating workspace-dependent extensions', async () => {
    let prematurelyActivated = false;
    const f = fixture({
        providerReady: false,
        resolve: async uri => {
            if (!f.service.fileService.hasProvider('file')) {
                prematurelyActivated = true;
                // Theia's plugin activation waits on workspace.ready, which
                // cannot resolve until this same read completes.
                await f.service.ready;
            }
            return stat(uri.toString());
        }
    });
    f.service.workspaceStartupTimeout = 100;
    const initialization = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.registrationListeners.size, 1);
    f.registerFileProvider();
    await initialization;
    assert.equal(prematurelyActivated, false);
    assert.equal(f.service._workspace.resource.toString(), offlineUri);
    assert.deepEqual(f.notices, []);
    assert.equal(f.registrationListeners.size, 0);
});

test('an unavailable file provider still releases startup and disposes its registration listener', async () => {
    const f = fixture({ providerReady: false, resolve: async () => assert.fail('do not activate an unavailable provider') });
    await f.service.doInit();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(Array.from(await f.service.roots), []);
    assert.equal(f.notices.length, 1);
    assert.equal(f.registrationListeners.size, 0);
    assert.equal(f.storage.size, 0, 'infrastructure failure must not quarantine a healthy folder');
    assert.deepEqual(f.writes, [], 'infrastructure failure must not replace the remembered workspace with empty');
    assert.match(f.notices[0], /项目初始化暂未完成.*最近使用记录已保留/);
});

test('a blocked renderer does not quarantine a folder while the file provider is registering', async () => {
    const clock = rendererClock();
    const f = fixture({ clock, providerReady: false, resolve: async uri => stat(uri.toString()) });
    const initialization = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.storage.size, 0, 'no pending marker before file IO');
    await clock.advance(40, true); // A queued registration cannot run during this turn.
    assert.equal(f.service.startupFinished, false);
    assert.equal(f.storage.size, 0);
    f.registerFileProvider();
    await initialization;
    assert.equal(f.service._workspace.resource.toString(), offlineUri);
    assert.equal(f.storage.size, 0);
    assert.deepEqual(f.notices, []);
    assert.equal(clock.pendingTimers, 0);
});

test('a successful filesystem reply queued behind a blocked renderer still restores the workspace', async () => {
    const clock = rendererClock();
    let complete;
    const f = fixture({ clock, resolve: () => new Promise(resolve => { complete = resolve; }) });
    const initialization = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.storage.get('xora.workspace-recovery:' + offlineUri), 'pending');
    await clock.advance(40, true);
    complete(stat(offlineUri));
    await initialization;
    assert.equal(f.service._workspace.resource.toString(), offlineUri);
    assert.equal(f.storage.size, 0);
    assert.equal(clock.pendingTimers, 0);
});

test('responsive offline IO still expires at its original budget and ignores a late reply', async () => {
    const clock = rendererClock();
    let complete;
    const f = fixture({ clock, resolve: () => new Promise(resolve => { complete = resolve; }) });
    const initialization = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    await clock.advance(15);
    await initialization;
    assert.equal(f.service._workspace, undefined);
    assert.equal(f.storage.get('xora.workspace-recovery:' + offlineUri), 'failed');
    complete(stat(offlineUri));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service._workspace, undefined);
    assert.deepEqual(f.watches, []);
});

test('the hard ceiling bounds repeated renderer starvation without quarantining bootstrap failures', async () => {
    for (const providerReady of [false, true]) {
        const clock = rendererClock();
        const f = fixture({ clock, providerReady });
        f.service.workspaceStartupMaximumWait = 120;
        const initialization = f.service.doInit();
        await new Promise(resolve => setImmediate(resolve));
        await clock.advance(40, true);
        await clock.advance(40, true);
        await clock.advance(40, true);
        await initialization;
        assert.equal(f.service.startupFinished, true);
        assert.equal(f.service._workspace, undefined);
        assert.equal(f.storage.size, 0, 'renderer starvation cannot identify a bad workspace, even after IO began');
        assert.deepEqual(f.writes, [], 'a starved renderer preserves the remembered workspace for retry');
        assert.equal(f.registrationListeners.size, 0);
        assert.equal(clock.pendingTimers, 0);
    }
});

test('late provider activation cannot begin filesystem IO after timeout', async () => {
    const clock = rendererClock();
    const f = fixture({ clock });
    let activate;
    f.service.fileService.activateProvider = () => new Promise(resolve => { activate = resolve; });
    const initialization = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    await clock.advance(15);
    await initialization;
    assert.equal(f.storage.size, 0, 'no filesystem call began, so there is no quarantine');
    activate({ stat: async () => assert.fail('late activation must not start IO') });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service._workspace, undefined);
    assert.equal(f.storage.size, 0);
});

test('late bootstrap history cannot probe or quarantine a workspace after recovery', async () => {
    const clock = rendererClock();
    const f = fixture({ clock, hash: '', resolve: async () => assert.fail('late history must not start IO') });
    let completeHistory;
    f.service.server.getMostRecentlyUsedWorkspace = () => new Promise(resolve => { completeHistory = resolve; });
    const initialization = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    await clock.advance(15);
    await initialization;
    completeHistory(offlineUri);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service._workspace, undefined);
    assert.equal(f.storage.size, 0);
    assert.deepEqual(f.writes, []);
});

test('provider bootstrap failure preserves the remembered workspace for a healthy next launch', async () => {
    const clock = rendererClock();
    let remembered = offlineUri;
    const first = fixture({ clock, hash: '', providerReady: false });
    first.service.server.getMostRecentlyUsedWorkspace = async () => remembered;
    first.service.server.setMostRecentlyUsedWorkspace = async uri => { remembered = uri; };
    const initialization = first.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    await clock.advance(15);
    await initialization;
    assert.equal(remembered, offlineUri);
    assert.equal(first.storage.size, 0);

    const next = fixture({ hash: '', storage: first.storage, resolve: async uri => stat(uri.toString()) });
    next.service.server.getMostRecentlyUsedWorkspace = async () => remembered;
    await next.service.doInit();
    assert.equal(next.service._workspace.resource.toString(), offlineUri);
    assert.deepEqual(next.notices, []);
});

test('overall bootstrap expiry cancels a later provider wait and disposes its listener immediately', async () => {
    const clock = rendererClock();
    const f = fixture({ clock, hash: '', providerReady: false });
    let completeHistory;
    f.service.server.getMostRecentlyUsedWorkspace = () => new Promise(resolve => { completeHistory = resolve; });
    const initialization = f.service.doInit();
    await clock.advance(10);
    completeHistory(offlineUri);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.registrationListeners.size, 1);
    await clock.advance(5);
    await initialization;
    assert.equal(f.registrationListeners.size, 0);
    assert.equal(clock.pendingTimers, 0);
    assert.equal(f.storage.size, 0);
    assert.deepEqual(f.writes, []);
    f.registerFileProvider();
    assert.equal(f.service._workspace, undefined);
});

test('manual opening owns provider-wait cleanup when delayed timers expire in a different order', async () => {
    const clock = rendererClock();
    const f = fixture({ clock, providerReady: false, resolve: async () => assert.fail('expired manual opening must not start IO') });
    const waitForProvider = f.service.waitForLocalFileSystemProvider.bind(f.service);
    f.service.waitForLocalFileSystemProvider = signal => {
        const pending = waitForProvider(signal);
        clock.elapseWithoutCallbacks(10);
        return pending;
    };
    const opening = f.service.toFileStat(new URI(offlineUri));
    await clock.advance(21, true);
    assert.equal(await opening, undefined);
    assert.equal(f.registrationListeners.size, 0);
    assert.equal(clock.pendingTimers, 0);
    f.registerFileProvider();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.storage.size, 0);
});

test('a manual selection made while registration is pending prevents stale filesystem calls', async () => {
    const f = fixture({ providerReady: false, resolve: async () => assert.fail('superseded startup must not probe the old folder') });
    const initialization = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    const selected = stat('file:///workspace/selected');
    await f.service.setWorkspace(selected);
    f.registerFileProvider();
    await initialization;
    assert.equal(f.service._workspace, selected);
    assert.equal(f.storage.size, 0);
    assert.deepEqual(f.writes, []);
});

test('workspace-file reads and nested root resolution share the startup deadline', async () => {
    for (const stage of ['read', 'root']) {
        const f = fixture({
            hash: '#/workspace/project.code-workspace',
            resolve: async uri => uri.path.base.endsWith('.code-workspace') ? stat(uri.toString(), false) : new Promise(() => {}),
            read: stage === 'root' ? async () => ({ value: '{"folders":[{"path":"file:///Volumes/offline/project"}]}' }) : undefined
        });
        await f.service.doInit();
        assert.equal(f.service._workspace, undefined, stage);
        assert.equal(f.notices.length, 1, stage);
        assert.deepEqual(f.watches, []);
    }
});

test('malformed workspace documents recover while valid JSONC documents restore', async () => {
    for (const value of ['{"folders": [', '{"folders":"broken"}']) {
        const f = fixture({ hash: '#/workspace/project.code-workspace', resolve: async uri => stat(uri.toString(), false), read: async () => ({ value }) });
        await f.service.doInit();
        assert.equal(f.service._workspace, undefined);
        assert.equal(f.notices.length, 1);
    }
    const f = fixture({
        hash: '#/workspace/project.code-workspace',
        resolve: async uri => stat(uri.toString(), !uri.path.base.endsWith('.code-workspace')),
        read: async () => ({ value: '{ // JSONC\n "folders":[{"path":"file:///workspace/healthy"},],}' })
    });
    await f.service.doInit();
    assert.equal(f.service._workspace.resource.toString(), 'file:///workspace/project.code-workspace');
    assert.equal((await f.service.roots)[0].resource.toString(), 'file:///workspace/healthy');
    assert.deepEqual(f.notices, []);
});

test('late preparation cannot override a workspace selected during startup', async () => {
    let complete;
    const f = fixture({ resolve: () => new Promise(resolve => { complete = resolve; }) });
    const initializing = f.service.doInit();
    await new Promise(resolve => setImmediate(resolve));
    const selected = stat('file:///workspace/selected');
    await f.service.setWorkspace(selected);
    complete(stat(offlineUri));
    await initializing;
    await f.service.ready;
    assert.equal(f.service._workspace, selected);
    assert.equal((await f.service.roots)[0], selected);
    assert.deepEqual(f.writes, []);
});

test('launcher scripts and explicit empty windows stay quiet', async () => {
    const script = fixture({ hash: '#/tmp/theia-electron-main.js', resolve: async uri => stat(uri.toString(), false) });
    await script.service.doInit();
    assert.equal(script.location.hash, '');
    assert.deepEqual(script.notices, []);
    const empty = fixture({ hash: '#!empty', resolve: async () => assert.fail('no probe for empty window') });
    empty.service.server.getMostRecentlyUsedWorkspace = async () => assert.fail('do not restore MRU');
    await empty.service.doInit();
    assert.deepEqual(empty.notices, []);
});

test('non-file remote handler initialization keeps Theia semantics', async () => {
    const f = fixture({ hash: '' });
    f.service.server.getMostRecentlyUsedWorkspace = async () => 'devcontainer://workspace';
    await f.service.doInit();
    assert.equal(f.service.remoteInitialization, true);
    assert.deepEqual(f.writes, []);
    assert.equal(f.storage.size, 0);
});
