// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const path = require('node:path');

/**
 * Playwright launches the development Electron binary like a bundled app, so
 * Electron's `process.defaultApp` marker can be absent even though argv[1] is
 * still the JavaScript entrypoint. Theia then treats that entrypoint as the
 * positional workspace and shows a misleading "Not a valid workspace file"
 * notification. Remove only that exact, resolved entrypoint; normal `electron
 * script.js`, packaged launches and every user supplied path remain untouched.
 */
function normalizeDevelopmentLaunchArgv(options) {
    const { argv, defaultApp, isPackaged, entryPath } = options;
    if (isPackaged || argv.length < 2 || !entryPath) return false;
    let entry;
    try {
        entry = path.resolve(entryPath);
    } catch {
        return false;
    }
    const entryIndex = argv.findIndex((candidate, index) => {
        if (index === 0 || typeof candidate !== 'string' || candidate.startsWith('--')) return false;
        try { return path.resolve(candidate) === entry; } catch { return false; }
    });
    if (entryIndex < 0) return false;

    if (defaultApp === true) {
        // Playwright prepends its two debugger flags before the application
        // script. Theia assumes argv[1] is that script for an unbundled app,
        // so remove only the known automation flags and restore the standard
        // Electron argv shape after the inspector has already been activated.
        if (entryIndex === 1) return false;
        const instrumentation = argv.slice(1, entryIndex);
        if (!instrumentation.length || instrumentation.some(argument =>
            !/^--(?:inspect(?:-brk)?|remote-debugging-port)(?:=|$)/u.test(argument))) return false;
        argv.splice(1, instrumentation.length);
        return true;
    }

    // Defensive fallback for launchers that omit process.defaultApp entirely:
    // Theia will use argv[0] as the bundled executable and must not see the
    // JavaScript wrapper as its positional workspace.
    argv.splice(entryIndex, 1);
    return true;
}

module.exports = { normalizeDevelopmentLaunchArgv };
