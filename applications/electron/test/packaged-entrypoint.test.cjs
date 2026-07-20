// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const applicationRoot = path.resolve(__dirname, '..');

test('the packaged Electron wrapper starts the bundled Theia main process', () => {
    const applicationPackage = JSON.parse(
        fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8')
    );
    const wrapperPath = path.join(applicationRoot, applicationPackage.main);
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    assert.equal(applicationPackage.main, 'scripts/theia-electron-main.js');
    assert.match(wrapper, /require\(['"]\.\.\/lib\/backend\/electron-main['"]\);/u);
    assert.doesNotMatch(wrapper, /require\(['"]\.\.\/src-gen\/backend\//u);
});

test('packaging relies on Theia bundles instead of shipping the workspace node_modules tree', () => {
    const builderConfiguration = fs.readFileSync(
        path.join(applicationRoot, 'electron-builder.yml'),
        'utf8'
    );

    assert.match(builderConfiguration, /^\s*-\s+"!\*\*\/node_modules\/\*\*"\s*$/mu);
    assert.match(builderConfiguration, /^\s*-\s+"!\*\*\/\*\.map"\s*$/mu);
    assert.match(builderConfiguration, /^\s*-\s+lib\s*$/mu);
});

test('startup policy shows immediate feedback and avoids watching generated dependency trees', () => {
    const applicationPackage = JSON.parse(
        fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8')
    );
    const frontend = applicationPackage.theia.frontend.config;
    const excludes = frontend.preferences['files.watcherExclude'];

    assert.equal(frontend.electron.showWindowEarly, true);
    assert.equal(frontend.preferences['toolbar.showToolbar'], false);
    for (const pattern of [
        '**/.git/objects/**',
        '**/.git/subtree-cache/**',
        '**/node_modules/**',
        '**/.browser_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/out/**',
        '**/target/**',
        '**/.cache/**'
    ]) {
        assert.equal(excludes[pattern], true, `${pattern} should be excluded from file watching`);
    }
});

test('packaging uses the reviewed Xora Code icon on every desktop target', () => {
    const builderConfiguration = fs.readFileSync(
        path.join(applicationRoot, 'electron-builder.yml'),
        'utf8'
    );
    const applicationPackage = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'));

    const packagedIcon = fs.readFileSync(path.join(applicationRoot, 'resources/icon.png'));
    const masterIcon = fs.readFileSync(path.join(applicationRoot, 'resources/icons/1024x1024.png'));

    assert.equal(packagedIcon.equals(masterIcon), true);
    // PNG IHDR: width, height, bit depth and colour type start at byte 16.
    // Colour type 6 is RGBA; transparent corners keep the icon rounded on
    // macOS, Windows and Linux instead of baking in a square black backdrop.
    assert.equal(packagedIcon.readUInt32BE(16), 1024);
    assert.equal(packagedIcon.readUInt32BE(20), 1024);
    assert.equal(packagedIcon[25], 6);
    assert.equal(applicationPackage.theia.frontend.config.preferences['window.title'], '${appName}');
    assert.equal((builderConfiguration.match(/^\s*icon:\s+resources\/icon\.png\s*$/gmu) ?? []).length, 3);
});

test('Linux 安装包包含维护者信息，未签名豁免只用于预览构建', () => {
    const builderConfiguration = fs.readFileSync(path.join(applicationRoot, 'electron-builder.yml'), 'utf8');
    const applicationPackage = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'));
    const verifier = fs.readFileSync(path.join(applicationRoot, 'scripts/verify-sidecar.js'), 'utf8');

    assert.match(applicationPackage.homepage, /^https:\/\/github\.com\/WhiteNightShadow\/xora-code$/u);
    assert.match(applicationPackage.author.email, /@users\.noreply\.github\.com$/u);
    assert.match(builderConfiguration, /^\s*maintainer:\s+.+<.+@users\.noreply\.github\.com>\s*$/mu);
    assert.equal(applicationPackage.scripts['verify:sidecar'], 'node scripts/verify-sidecar.js');
    assert.match(applicationPackage.scripts['verify:sidecar:preview'], /--allow-missing --allow-unsigned-preview/u);
    assert.match(applicationPackage.scripts['package:preview'], /^yarn verify:sidecar:preview/u);
    assert.match(verifier, /verifyPlatformSignature\(executablePath, allowUnsignedPreview\)/u);
    assert.match(verifier, /if \(allowUnsigned\) return;/u);
});
