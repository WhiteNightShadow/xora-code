// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnYarnSync } = require('./spawn-yarn');

const applicationRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(applicationRoot, '..', '..');
const outputRoot = path.join(applicationRoot, 'generated-legal');

function fail(message) {
    throw new Error(`Third-party license generation failed: ${message}`);
}

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeDisclaimer(raw) {
    const newline = raw.indexOf('\n');
    if (newline < 0 || !raw.startsWith('THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES')) {
        fail('Yarn returned an unrecognized disclaimer format');
    }
    const normalized = [
        'THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES FOR THIRD PARTY SOFTWARE THAT MAY BE CONTAINED IN XORA CODE.',
        raw.slice(newline + 1).trimStart()
    ].join('\n');
    if (normalized.length < 100_000 || !normalized.includes('MIT License')) {
        fail('the generated dependency license bundle is unexpectedly incomplete');
    }
    return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function generateYarnDisclaimer() {
    const result = spawnYarnSync(['licenses', 'generate-disclaimer'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true
    });
    if (result.status !== 0) {
        fail(`yarn licenses exited with status ${result.status ?? 'unknown'}: ${(result.stderr || '').trim()}`);
    }
    return normalizeDisclaimer(result.stdout || '');
}

function copyRequiredLicense(source, destination) {
    if (!fs.existsSync(source)) fail(`required license file is missing: ${path.basename(source)}`);
    fs.copyFileSync(source, destination);
}

function generate(outputDirectory = outputRoot) {
    const electronRoot = path.join(repositoryRoot, 'node_modules', 'electron');
    const electronDist = path.join(electronRoot, 'dist');
    const electronPackage = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8'));
    const applicationPackage = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'));
    const disclaimer = generateYarnDisclaimer();

    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.mkdirSync(outputDirectory, { recursive: true });

    const dependencyNotices = path.join(outputDirectory, 'NODE-DEPENDENCY-LICENSES.txt');
    const electronLicense = path.join(outputDirectory, 'ELECTRON-LICENSE');
    const chromiumLicenses = path.join(outputDirectory, 'CHROMIUM-THIRD-PARTY-LICENSES.html');
    fs.writeFileSync(dependencyNotices, disclaimer, { flag: 'wx' });
    copyRequiredLicense(path.join(electronDist, 'LICENSE'), electronLicense);
    copyRequiredLicense(path.join(electronDist, 'LICENSES.chromium.html'), chromiumLicenses);

    const files = [dependencyNotices, electronLicense, chromiumLicenses].map(file => {
        const content = fs.readFileSync(file);
        return {
            name: path.basename(file),
            bytes: content.length,
            sha256: sha256(content)
        };
    });
    fs.writeFileSync(path.join(outputDirectory, 'LEGAL-INVENTORY.json'), `${JSON.stringify({
        schemaVersion: 1,
        product: 'Xora Code',
        applicationVersion: applicationPackage.version,
        electronVersion: electronPackage.version,
        generatedBy: 'yarn licenses generate-disclaimer',
        files
    }, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`Prepared ${files.length} dependency license assets.\n`);
}

module.exports = { generate, normalizeDisclaimer, sha256 };

if (require.main === module) {
    try {
        generate();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
