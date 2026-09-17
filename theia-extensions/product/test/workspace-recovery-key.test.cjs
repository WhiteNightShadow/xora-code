// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { workspaceRecoveryKey, readWorkspaceRecoveryState, writeWorkspaceRecoveryState } = require('../lib/common/workspace-recovery-key');

const prefix = 'xora.workspace-recovery:';
const mru = 'file:///C:/Users/Example/%E9%A1%B9%E7%9B%AE%20V3/restore.code-workspace';
const launcher = 'file:///c%3A%5CUsers%5CExample%5C%E9%A1%B9%E7%9B%AE%20V3%5Crestore.code-workspace';

function storage(entries = []) {
    const values = new Map(entries);
    return {
        values,
        get length() { return values.size; },
        key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
}

test('Windows launcher and MRU spellings share one recovery key without drive IO', () => {
    assert.equal(workspaceRecoveryKey(mru, true), workspaceRecoveryKey(launcher, true));
    const state = storage();
    writeWorkspaceRecoveryState(state, mru, true, 'failed');
    assert.equal(readWorkspaceRecoveryState(state, launcher, true), 'failed');
    assert.equal(state.values.size, 1);
});

test('Windows restart honors legacy raw URI markers and explicit retry clears equivalent aliases', () => {
    for (const marker of ['pending', 'failed']) {
        const unrelated = prefix + 'file:///C:/another/project';
        const state = storage([[prefix + mru, marker], [prefix + launcher, marker], [unrelated, 'failed'], ['unrelated-setting', 'preserved']]);
        assert.equal(readWorkspaceRecoveryState(state, launcher, true), marker);
        writeWorkspaceRecoveryState(state, launcher, true, 'failed');
        assert.equal(state.values.size, 3, 'legacy aliases migrate to one canonical marker');
        writeWorkspaceRecoveryState(state, mru, true, undefined);
        assert.equal(readWorkspaceRecoveryState(state, launcher, true), null);
        assert.deepEqual([...state.values], [[unrelated, 'failed'], ['unrelated-setting', 'preserved']]);
    }
});

test('Windows recovery keeps case-sensitive directories separate', () => {
    const upper = 'file:///C:/Workspace/Project';
    const lower = 'file:///c:/Workspace/project';
    assert.notEqual(workspaceRecoveryKey(upper, true), workspaceRecoveryKey(lower, true));
    const state = storage([[workspaceRecoveryKey(upper, true), 'failed']]);
    assert.equal(readWorkspaceRecoveryState(state, lower, true), null);
});

test('failed marker migration retains the legacy quarantine', () => {
    const state = storage([[prefix + mru, 'failed']]);
    state.setItem = () => { throw new Error('storage quota'); };
    assert.throws(() => writeWorkspaceRecoveryState(state, launcher, true, 'failed'), /storage quota/);
    assert.equal(readWorkspaceRecoveryState(state, launcher, true), 'failed');
});

test('UNC file paths normalize separators and host case while preserving share path case', () => {
    assert.equal(workspaceRecoveryKey('file://SERVER/Share/Project', true), workspaceRecoveryKey('file://server/Share%5CProject', true));
    assert.notEqual(workspaceRecoveryKey('file://server/Share/Project', true), workspaceRecoveryKey('file://server/Share/project', true));
});

test('POSIX, remote and malformed recovery identities retain existing semantics', () => {
    for (const uri of ['file:///Volumes/Project', 'file:///tmp/back%5Cslash', mru, 'devcontainer://SERVER/Project', 'not a uri']) {
        assert.equal(workspaceRecoveryKey(uri, false), prefix + uri);
    }
    assert.equal(workspaceRecoveryKey('file:///Volumes/Project', true), prefix + 'file:///Volumes/Project');
    assert.equal(workspaceRecoveryKey('devcontainer://SERVER/Project', true), prefix + 'devcontainer://SERVER/Project');
});
