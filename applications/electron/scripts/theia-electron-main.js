// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const path = require('node:path');
const { app } = require('electron');
const { normalizeDevelopmentLaunchArgv } = require('./dev-launch-normalizer');
const { migrateLegacyData } = require('./xora-data-migration');

// Capture the actual development entry before argv normalization removes it.
// Packaged helpers enter through the same signed executable and main file.
process.env.XORA_CREDENTIAL_HELPER_ENTRY = __filename;
if (process.argv.includes('--xora-credential-helper')) {
    if (typeof process.send !== 'function' || !process.env.XORA_CREDENTIAL_USER_DATA) {
        app.exit(1);
    } else {
        app.setName(process.env.XORA_CREDENTIAL_APP_NAME || 'Xora Code');
        app.setPath('userData', process.env.XORA_CREDENTIAL_USER_DATA);
        require('./credential-helper');
    }
} else {

// Keep automated/local development launches product-shaped. Playwright's
// Electron launcher omits process.defaultApp, which otherwise makes Theia
// parse this wrapper as a workspace path. Naming the app before safeStorage is
// first consulted also avoids creating a generic "Electron" Keychain identity.
normalizeDevelopmentLaunchArgv({
    argv: process.argv,
    defaultApp: process.defaultApp,
    isPackaged: app.isPackaged,
    entryPath: __filename
});
if (!app.isPackaged) app.setName('Xora Code');

// Bind every backend singleton to Xora Code's data root before Theia starts.
// Existing data is copied once, never deleted, and explicit CLI overrides keep
// taking precedence when Theia parses them later in its startup sequence.
if (process.env.XORA_SKIP_LEGACY_MIGRATION !== '1') {
    migrateLegacyData({
        appDataPath: app.getPath('appData'),
        argv: process.argv,
        setUserDataPath: value => app.setPath('userData', value)
    });
}

const developmentPlugins = path.resolve(__dirname, '..', '..', '..', 'plugins');
const packagedPlugins = path.resolve(process.resourcesPath, 'app', 'plugins');
const pluginDirectory = app.isPackaged ? packagedPlugins : developmentPlugins;

if (!process.env.THEIA_DEFAULT_PLUGINS) {
    process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${pluginDirectory}`;
}

require('../lib/backend/electron-main');
}
