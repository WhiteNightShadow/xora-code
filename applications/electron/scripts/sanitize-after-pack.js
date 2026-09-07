// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizePackagedOutput } = require('./packaged-path-sanitizer');

function assertWindowsJobGuardian(context) {
    if (context.electronPlatformName !== 'win32') return;
    const target = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'scripts', 'windows-process-job.ps1');
    try {
        if (!fs.lstatSync(target).isFile()
            || !fs.readFileSync(target).equals(fs.readFileSync(path.join(__dirname, 'windows-process-job.ps1')))) {
            throw new Error('Invalid launcher');
        }
    } catch {
        throw new Error('Windows Agent launcher is missing or changed in the unpacked application.');
    }
}

/**
 * Native electron-builder hook shared by directory previews and installers.
 * It strips removable native-addon debug data and rejects any remaining
 * build-user path before electron-builder creates an installer.
 */
async function sanitizeAfterPack(context) {
    assertWindowsJobGuardian(context);
    sanitizePackagedOutput(context);
}

module.exports = sanitizeAfterPack;
module.exports.assertWindowsJobGuardian = assertWindowsJobGuardian;
