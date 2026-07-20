// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CURRENT_APP_DIRECTORY = 'Xora Code';
const CURRENT_CONFIG_DIRECTORY = '.xora-code';
// These names are deliberately retained only as migration inputs. The source
// is never modified or removed, so users can still open the previous build.
const LEGACY_APP_DIRECTORY = 'WhiteNight Code';
const LEGACY_CONFIG_DIRECTORY = '.whitenight-code';
const MIGRATION_MARKER = '.xora-code-migration-v1.json';

/**
 * Copy a legacy tree without following symlinks or overwriting any current
 * file. Concurrent Xora Code startups are safe: COPYFILE_EXCL makes each file
 * claim atomic, and an already-created destination simply wins.
 */
function copyTreeMissing(source, destination, result = { copied: 0, skipped: 0, symlinks: 0 }) {
    let sourceStat;
    try {
        sourceStat = fs.lstatSync(source);
    } catch (error) {
        if (error && error.code === 'ENOENT') return result;
        throw error;
    }
    if (sourceStat.isSymbolicLink()) {
        result.symlinks += 1;
        return result;
    }

    let destinationStat;
    try {
        destinationStat = fs.lstatSync(destination);
    } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }
    if (destinationStat?.isSymbolicLink()) {
        result.symlinks += 1;
        return result;
    }

    if (sourceStat.isDirectory()) {
        if (destinationStat && !destinationStat.isDirectory()) {
            result.skipped += 1;
            return result;
        }
        if (!destinationStat) {
            try {
                fs.mkdirSync(destination, { mode: sourceStat.mode & 0o777 });
            } catch (error) {
                if (!error || error.code !== 'EEXIST') throw error;
            }
        }
        for (const name of fs.readdirSync(source)) {
            copyTreeMissing(path.join(source, name), path.join(destination, name), result);
        }
        return result;
    }

    if (!sourceStat.isFile() || destinationStat) {
        result.skipped += 1;
        return result;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, sourceStat.mode & 0o777);
        fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
        const descriptor = fs.openSync(destination, 'r');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        result.copied += 1;
    } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        result.skipped += 1;
    }
    return result;
}

function hasElectronUserDataOverride(argv) {
    return argv.some(argument => argument === '--electronUserData' || argument.startsWith('--electronUserData='));
}

function writeMarker(directory, payload) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const marker = path.join(directory, MIGRATION_MARKER);
    if (fs.existsSync(marker)) return;
    const temporary = `${marker}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    try {
        fs.renameSync(temporary, marker);
    } catch (error) {
        try { fs.unlinkSync(temporary); } catch { /* another process may have won */ }
        if (!fs.existsSync(marker)) throw error;
    }
}

function migrateLegacyData(options) {
    const appDataPath = options.appDataPath;
    const homeDirectory = options.homeDirectory ?? os.homedir();
    const argv = options.argv ?? process.argv;
    const currentUserData = path.join(appDataPath, CURRENT_APP_DIRECTORY);
    const legacyUserData = path.join(appDataPath, LEGACY_APP_DIRECTORY);
    const currentConfig = path.join(homeDirectory, CURRENT_CONFIG_DIRECTORY);
    const legacyConfig = path.join(homeDirectory, LEGACY_CONFIG_DIRECTORY);
    const userDataOverridden = hasElectronUserDataOverride(argv);

    const emptyResult = () => ({ copied: 0, skipped: 0, symlinks: 0 });
    const userDataResult = userDataOverridden || fs.existsSync(path.join(currentUserData, MIGRATION_MARKER))
        ? emptyResult()
        : copyTreeMissing(legacyUserData, currentUserData);
    const configResult = fs.existsSync(path.join(currentConfig, MIGRATION_MARKER))
        ? emptyResult()
        : copyTreeMissing(legacyConfig, currentConfig);
    if (!userDataOverridden) {
        writeMarker(currentUserData, {
            schemaVersion: 1,
            migratedAt: new Date().toISOString(),
            source: LEGACY_APP_DIRECTORY,
            copiedFiles: userDataResult.copied,
            skippedEntries: userDataResult.skipped,
            skippedSymlinks: userDataResult.symlinks,
            encryptedCredentialsMayRequireReentry: true
        });
    }
    writeMarker(currentConfig, {
        schemaVersion: 1,
        migratedAt: new Date().toISOString(),
        source: LEGACY_CONFIG_DIRECTORY,
        copiedFiles: configResult.copied,
        skippedEntries: configResult.skipped,
        skippedSymlinks: configResult.symlinks
    });

    if (!userDataOverridden) {
        options.setUserDataPath(currentUserData);
    }
    return { currentUserData, currentConfig, userDataResult, configResult };
}

module.exports = {
    CURRENT_APP_DIRECTORY,
    CURRENT_CONFIG_DIRECTORY,
    LEGACY_APP_DIRECTORY,
    LEGACY_CONFIG_DIRECTORY,
    MIGRATION_MARKER,
    copyTreeMissing,
    hasElectronUserDataOverride,
    migrateLegacyData
};
