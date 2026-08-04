// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    assertNativeAfterPackContext,
    assertNoBuildPathLeaksInAllFiles,
    installSourceBuiltRipgrep,
    stripNativeAddons
} = require('./packaged-path-sanitizer');

function fail(message) {
    throw new Error(`Unsigned preview ad-hoc signing refused: ${message}`);
}

function run(file, args) {
    const result = spawnSync(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        windowsHide: true,
        shell: false
    });
    if (result.status !== 0) {
        fail(`${file} ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
    }
    return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function applicationBundle(appOutDir) {
    const entries = fs.readdirSync(appOutDir, { withFileTypes: true });
    const bundles = entries
        .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
        .map(entry => path.join(appOutDir, entry.name));
    if (bundles.length !== 1) fail(`expected one .app in ${appOutDir}, found ${bundles.length}`);
    return bundles[0];
}

/**
 * Preview-only electron-builder hook.
 *
 * It ad-hoc signs the application without using a Developer ID. The pinned
 * Grok binary is restored byte-for-byte after the deep signing pass so its
 * audited release.json hash remains valid, then the outer bundle seal is
 * refreshed. Formal release.yml never references this hook.
 */
async function previewAfterPack(context) {
    const { platform, root } = assertNativeAfterPackContext(context);
    if (platform !== 'darwin') {
        fail('this hook may only run for a native macOS preview build');
    }

    const ripgrep = installSourceBuiltRipgrep(root, platform);
    const stripResult = stripNativeAddons(root, platform);

    const bundle = applicationBundle(context.appOutDir);
    const sidecarRoot = path.join(bundle, 'Contents', 'Resources', 'sidecars', 'grok');
    const sidecar = path.join(sidecarRoot, 'grok');
    const releasePath = path.join(sidecarRoot, 'release.json');
    if (!fs.statSync(sidecar).isFile() || !fs.statSync(releasePath).isFile()) {
        fail('the packaged Grok binary or release.json is missing');
    }

    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const originalHash = sha256(sidecar);
    if (release.sha256 !== originalHash) fail('the packaged Grok hash does not match release.json before signing');

    const backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-preview-sidecar-'));
    const backup = path.join(backupDirectory, 'grok');
    try {
        fs.copyFileSync(sidecar, backup, fs.constants.COPYFILE_EXCL);
        run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);

        fs.copyFileSync(backup, sidecar);
        fs.chmodSync(sidecar, 0o755);
        if (sha256(sidecar) !== originalHash) fail('the Grok binary changed while restoring the audited preview payload');

        run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
        run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
        const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
        if (!details.includes('Signature=adhoc') || !details.includes('TeamIdentifier=not set') || details.includes('Authority=Developer ID')) {
            fail('the macOS preview must be ad-hoc signed without a Developer ID team');
        }
        if (sha256(sidecar) !== release.sha256) fail('ad-hoc signing invalidated the audited Grok release hash');
        const scanned = assertNoBuildPathLeaksInAllFiles(bundle);
        process.stdout.write(`Installed source-built ripgrep ${ripgrep.version}, sanitized ${stripResult.stripped.length} native addon(s), and scanned ${scanned.length} packaged file(s).\n`);
    } finally {
        fs.rmSync(backupDirectory, { recursive: true, force: true });
    }
}

module.exports = previewAfterPack;
module.exports.applicationBundle = applicationBundle;
module.exports.sha256 = sha256;
