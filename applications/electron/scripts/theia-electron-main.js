// Copyright (c) 2026 WhiteNight Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const path = require('node:path');
const { app } = require('electron');

const developmentPlugins = path.resolve(__dirname, '..', '..', '..', 'plugins');
const packagedPlugins = path.resolve(process.resourcesPath, 'app', 'plugins');
const pluginDirectory = app.isPackaged ? packagedPlugins : developmentPlugins;

if (!process.env.THEIA_DEFAULT_PLUGINS) {
    process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${pluginDirectory}`;
}

require('../src-gen/backend/main');
