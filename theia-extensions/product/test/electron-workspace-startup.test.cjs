// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function fixture(realpath) {
    const opened = [];
    const delegated = [];
    class ElectronMainApplication {
        async openWindowWithWorkspace(workspace) { opened.push(workspace); }
        async handleMainCommand(options) { delegated.push(options); }
    }
    const filename = path.resolve(__dirname, '../lib/electron-main/xora-electron-main-application.js');
    const actualRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, process,
        require(id) {
            if (id === '@theia/core/lib/electron-main/electron-main-application') return { ElectronMainApplication };
            if (id === 'fs') return { promises: { realpath } };
            return actualRequire(id);
        }
    }, { filename });
    const application = new module.exports.XoraElectronMainApplication();
    application.workspacePathTimeout = 10;
    return { application, opened, delegated };
}

test('CLI launch opens the requested window when realpath hangs on a mounted drive', async () => {
    let complete;
    const f = fixture(() => new Promise(resolve => { complete = resolve; }));
    await f.application.handleMainCommand({ cwd: '/Volumes/offline', file: 'project', secondInstance: false });
    assert.deepEqual(f.opened, [path.resolve('/Volumes/offline', 'project')]);
    complete('/Volumes/reconnected/project');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.opened, [path.resolve('/Volumes/offline', 'project')], 'late realpath must not open a second window');
});

test('explicit second-instance paths recover in a window when resolution fails', async () => {
    const f = fixture(async () => { throw new Error('ENOTCONN'); });
    await f.application.handleMainCommand({ cwd: '/Volumes/offline', file: 'project', secondInstance: true });
    assert.deepEqual(f.opened, [path.resolve('/Volumes/offline', 'project')]);
});

test('healthy CLI symlinks still use their canonical workspace location', async () => {
    const f = fixture(async () => '/workspace/canonical');
    await f.application.handleMainCommand({ cwd: '/tmp', file: 'link', secondInstance: false });
    assert.deepEqual(f.opened, ['/workspace/canonical']);
});

test('launches without workspace arguments retain default window behavior', async () => {
    const f = fixture(async () => assert.fail('no realpath without an argument'));
    for (const secondInstance of [false, true]) {
        const options = { cwd: '/tmp', secondInstance };
        await f.application.handleMainCommand(options);
        assert.equal(f.delegated.at(-1), options);
    }
    assert.deepEqual(f.opened, []);
});
