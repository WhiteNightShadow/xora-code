// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    CURRENT_APP_DIRECTORY,
    CURRENT_CONFIG_DIRECTORY,
    LEGACY_APP_DIRECTORY,
    LEGACY_CONFIG_DIRECTORY,
    MIGRATION_MARKER,
    copyTreeMissing,
    hasElectronUserDataOverride,
    migrateLegacyData
} = require('../scripts/xora-data-migration');

test('copyTreeMissing preserves current files and never follows legacy symlinks', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-migration-copy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'copied.txt'), 'legacy');
    fs.writeFileSync(path.join(source, 'kept.txt'), 'legacy');
    fs.writeFileSync(path.join(destination, 'kept.txt'), 'current');
    fs.symlinkSync(path.join(source, 'nested'), path.join(source, 'linked'));

    const result = copyTreeMissing(source, destination);

    assert.equal(fs.readFileSync(path.join(destination, 'nested', 'copied.txt'), 'utf8'), 'legacy');
    assert.equal(fs.readFileSync(path.join(destination, 'kept.txt'), 'utf8'), 'current');
    assert.equal(fs.existsSync(path.join(destination, 'linked')), false);
    assert.equal(result.copied, 1);
    assert.equal(result.symlinks, 1);
});

test('migrateLegacyData copies both data roots, writes markers and binds Xora userData', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-migration-roots-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const appDataPath = path.join(root, 'app-data');
    const homeDirectory = path.join(root, 'home');
    fs.mkdirSync(path.join(appDataPath, LEGACY_APP_DIRECTORY, 'agent-sessions'), { recursive: true });
    fs.mkdirSync(path.join(homeDirectory, LEGACY_CONFIG_DIRECTORY), { recursive: true });
    fs.writeFileSync(path.join(appDataPath, LEGACY_APP_DIRECTORY, 'agent-sessions', 'index.json'), '{}\n');
    fs.writeFileSync(path.join(homeDirectory, LEGACY_CONFIG_DIRECTORY, 'settings.json'), '{}\n');
    let selectedUserData;

    const result = migrateLegacyData({
        appDataPath,
        homeDirectory,
        argv: ['electron'],
        setUserDataPath: value => { selectedUserData = value; }
    });

    assert.equal(selectedUserData, path.join(appDataPath, CURRENT_APP_DIRECTORY));
    assert.equal(result.currentConfig, path.join(homeDirectory, CURRENT_CONFIG_DIRECTORY));
    assert.equal(fs.existsSync(path.join(result.currentUserData, 'agent-sessions', 'index.json')), true);
    assert.equal(fs.existsSync(path.join(result.currentConfig, 'settings.json')), true);
    assert.equal(fs.existsSync(path.join(result.currentUserData, MIGRATION_MARKER)), true);
    assert.equal(fs.existsSync(path.join(result.currentConfig, MIGRATION_MARKER)), true);
});

test('explicit electronUserData overrides remain authoritative', () => {
    assert.equal(hasElectronUserDataOverride(['electron', '--electronUserData', '/tmp/custom']), true);
    assert.equal(hasElectronUserDataOverride(['electron', '--electronUserData=/tmp/custom']), true);
    assert.equal(hasElectronUserDataOverride(['electron']), false);
});

test('migrateLegacyData does not touch or bind the default userData when it is overridden', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-migration-override-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const appDataPath = path.join(root, 'app-data');
    const homeDirectory = path.join(root, 'home');
    fs.mkdirSync(path.join(appDataPath, LEGACY_APP_DIRECTORY), { recursive: true });
    fs.writeFileSync(path.join(appDataPath, LEGACY_APP_DIRECTORY, 'legacy.txt'), 'legacy');
    let selectedUserData;

    migrateLegacyData({
        appDataPath,
        homeDirectory,
        argv: ['electron', '--electronUserData', path.join(root, 'custom')],
        setUserDataPath: value => { selectedUserData = value; }
    });

    assert.equal(selectedUserData, undefined);
    assert.equal(fs.existsSync(path.join(appDataPath, CURRENT_APP_DIRECTORY)), false);
});
