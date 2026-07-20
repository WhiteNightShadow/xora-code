// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const path = require('node:path');
const { app } = require('electron');
const { migrateLegacyData } = require('./xora-data-migration');

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
