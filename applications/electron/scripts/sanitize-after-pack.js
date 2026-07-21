// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { sanitizePackagedOutput } = require('./packaged-path-sanitizer');

/**
 * Native electron-builder hook shared by directory previews and installers.
 * It strips removable native-addon debug data and rejects any remaining
 * build-user path before electron-builder creates an installer.
 */
async function sanitizeAfterPack(context) {
    sanitizePackagedOutput(context);
}

module.exports = sanitizeAfterPack;
