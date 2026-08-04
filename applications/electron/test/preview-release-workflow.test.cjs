// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    SIGNING_ENVIRONMENT,
    TARGETS,
    assertFinalExecutableArtifacts,
    previewEnvironment,
    selectArtifacts,
    stagePreviewAssets
} = require('../scripts/package-preview-installers');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/preview-release.yml'), 'utf8');
const notes = fs.readFileSync(path.join(repositoryRoot, '.github/PREVIEW-RELEASE-NOTES.md'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'applications/electron/package.json'), 'utf8'));
const applicationVersion = packageJson.version;
const builderConfiguration = fs.readFileSync(path.join(repositoryRoot, 'applications/electron/electron-builder.yml'), 'utf8');
const packager = fs.readFileSync(path.join(repositoryRoot, 'applications/electron/scripts/package-preview-installers.js'), 'utf8');
const macHook = fs.readFileSync(path.join(repositoryRoot, 'applications/electron/scripts/preview-after-pack.js'), 'utf8');
const sanitizerHook = fs.readFileSync(path.join(repositoryRoot, 'applications/electron/scripts/sanitize-after-pack.js'), 'utf8');

test('preview workflow is manual, concurrent-safe, four-target, and least-privilege', () => {
    assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/mu);
    assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request|schedule):/mu);
    assert.match(workflow, /group: preview-release-\$\{\{ github\.repository \}\}-\$\{\{ github\.ref \}\}/u);
    assert.equal((workflow.match(/^\s+contents: write\s*$/gmu) ?? []).length, 1);
    assert.match(workflow, /^permissions:\n\s{2}contents: read$/mu);

    const targets = [...workflow.matchAll(/^\s+grokTarget:\s+(\S+)$/gmu)].map(match => match[1]).sort();
    assert.deepEqual(targets, ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
    for (const runner of ['macos-15', 'macos-15-intel', 'windows-2025', 'ubuntu-24.04']) {
        assert.match(workflow, new RegExp(`runner: ${runner.replaceAll('.', '\\.')}`, 'u'));
    }
    assert.match(workflow, /xora-preview-\$\{\{ matrix\.grokTarget \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
});

test('preview build keeps native Grok and Windows ACP/auth cleanup as release blockers', () => {
    assert.match(workflow, /build\/grok\/build-sidecar\.mjs/u);
    assert.match(workflow, /Release-blocking Grok ACP, authentication, and process-cleanup smoke test/u);
    assert.match(workflow, /smoke-sidecar\.mjs --binary resources\/sidecars\/grok\/grok\.exe/u);
    assert.match(workflow, /yarn build/u);
    assert.match(workflow, /yarn test/u);
    assert.match(workflow, /node --test build\/grok\/test\/\*\.test\.mjs build\/grok\/test\/\*\.test\.ts/u);
    assert.match(workflow, /verify:sidecar:preview/u);
    assert.doesNotMatch(workflow, /electron-app verify:sidecar(?:\s|$)/u);
});

test('preview packaging creates installers without formal signing or update manifests', () => {
    assert.equal(
        packageJson.scripts['package:preview:installers'],
        'node scripts/ensure-plugins.js && node scripts/package-preview-installers.js',
        'preview installers must stage the bundled language plugins before packaging'
    );
    for (const fragment of ['--mac', 'dmg', 'zip', '--win', 'nsis', '--linux', 'AppImage', 'deb']) {
        assert.ok(packager.includes(`'${fragment}'`), `missing preview target ${fragment}`);
    }
    assert.match(packager, /--config\.mac\.identity=null/u);
    assert.match(packager, /--config\.mac\.notarize=false/u);
    assert.match(packager, /--config\.afterPack=\.\/scripts\/preview-after-pack\.js/u);
    assert.match(packager, /native hdiutil call can take longer/u);
    assert.match(packager, /\['--mac', 'zip'/u);
    assert.match(packager, /createMacPreviewDmg\(distRoot, target\)/u);
    assert.match(packager, /arch === 'x64' \? 'mac' : `mac-\$\{arch\}`/u);
    assert.match(packager, /'convert', writableImage/u);
    assert.match(packager, /'verify', artifact/u);
    assert.match(packager, /Get-AuthenticodeSignature/u);
    assert.match(packager, /stdout\.trim\(\) !== 'NotSigned'/u);
    assert.match(packager, /assertFinalExecutableArtifacts\(distRoot, target\)/u);
    assert.match(macHook, /--deep', '--sign', '-'/u);
    assert.match(macHook, /Signature=adhoc/u);
    assert.match(macHook, /TeamIdentifier=not set/u);
    assert.match(macHook, /stripNativeAddons/u);
    assert.match(macHook, /assertNoBuildPathLeaksInAllFiles\(bundle\)/u);
    assert.doesNotMatch(macHook, /assertNoBuildPathLeaks\(bundle\)/u);
    assert.match(builderConfiguration, /^afterPack: \.\/scripts\/sanitize-after-pack\.js$/mu);
    assert.match(builderConfiguration, /from: \.\.\/\.\.\/plugins[\s\S]*!\*\*\/\*\.map/u);
    assert.match(sanitizerHook, /sanitizePackagedOutput\(context\)/u);

    for (const forbidden of [
        'sign-release-manifests.mjs', 'verify-release-key-configuration.mjs',
        'APP_UPDATE_ED25519_PRIVATE_KEY_BASE64', 'SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64',
        'LINUX_GPG_PRIVATE_KEY_BASE64', 'SHA256SUMS.asc'
    ]) {
        assert.equal(workflow.includes(forbidden), false, `${forbidden} must remain outside preview workflow`);
    }
});

test('preview publish is immutable, prerelease-only, non-latest, and explicitly documented', () => {
    assert.match(workflow, /tag="preview-v\$\{version\}-\$\{short_sha\}"/u);
    assert.match(workflow, /gh release create "\$PREVIEW_TAG"/u);
    assert.match(workflow, /--prerelease/u);
    assert.match(workflow, /--latest=false/u);
    assert.match(workflow, /--target "\$GITHUB_SHA"/u);
    assert.match(notes, /未签名预览版/u);
    assert.match(notes, /ad-hoc/u);
    assert.match(notes, /没有 Authenticode/u);
    assert.match(notes, /SHA-256/u);
    assert.match(notes, /CycloneDX JSON SBOM/u);
    assert.match(notes, /不会替代 Latest/u);
    assert.doesNotMatch(workflow, /anchore\/sbom-action@/u);
    assert.match(workflow, /yarn sbom:preview --/u);
    assert.match(workflow, /build\/sbom\/syft\.lock\.json|xora-code\/syft/u);
    assert.match(workflow, /--target "\$\{\{ matrix\.grokTarget \}\}"/u);
    assert.match(workflow, /merge-multiple: false/u);
    assert.match(workflow, /build\/sbom\/verify-preview-assets\.mjs/u);
    assert.match(workflow, /for target in darwin-arm64 darwin-x64 win32-x64 linux-x64/u);
    assert.doesNotMatch(workflow, /Missing CycloneDX SBOM for \$\{target\}/u);
    assert.match(workflow, /if \(\/\\\{\\\{\[A-Z_\]\+\\\}\\\}\/u\.test\(notes\)\)/u);
    assert.doesNotMatch(workflow, /if \(\/\{\{\[A-Z_\]\+\}\}\/u\.test\(notes\)\)/u);
});

test('packager strips signing credentials and stages only target installers plus checksums', t => {
    const seeded = Object.fromEntries(SIGNING_ENVIRONMENT.map(name => [name, 'must-not-survive']));
    const environment = previewEnvironment({ ...seeded, csc_link: 'case-insensitive-leak', PATH: '/bin' });
    assert.equal(environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    for (const name of SIGNING_ENVIRONMENT) assert.equal(environment[name], undefined, `${name} leaked into preview packaging`);
    assert.equal(environment.csc_link, undefined, 'case-insensitive signing variable leaked into preview packaging');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-preview-assets-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dist = path.join(root, 'dist');
    const output = path.join(root, 'output');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, `Xora Code-${applicationVersion}-mac-arm64.dmg`), 'dmg');
    fs.writeFileSync(path.join(dist, `Xora Code-${applicationVersion}-mac-arm64.zip`), 'zip');
    fs.writeFileSync(path.join(dist, 'latest-mac.yml'), 'ignored');

    assert.deepEqual(selectArtifacts(dist, TARGETS['darwin-arm64']), [
        `Xora Code-${applicationVersion}-mac-arm64.dmg`,
        `Xora Code-${applicationVersion}-mac-arm64.zip`
    ]);
    stagePreviewAssets(dist, output, 'darwin-arm64', TARGETS['darwin-arm64'], { commit: 'abc123' });
    const staged = fs.readdirSync(output).sort();
    assert.ok(staged.includes('SHA256SUMS-darwin-arm64.txt'));
    const metadataName = `Xora-Code-${applicationVersion}-darwin-arm64-PREVIEW.json`;
    assert.ok(staged.includes(metadataName));
    assert.ok(fs.readFileSync(path.join(output, 'SHA256SUMS-darwin-arm64.txt'), 'utf8').includes(metadataName));
    assert.equal(staged.includes('latest-mac.yml'), false);

    fs.writeFileSync(path.join(dist, 'grok-sidecar-update.json'), '{}');
    assert.throws(() => selectArtifacts(dist, TARGETS['darwin-arm64']), /formal update manifests/u);
});

test('packager verifies final compressed installers structurally after unpacked payload scanning', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-preview-final-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installer = path.join(root, `Xora Code-${applicationVersion}-win-x64.exe`);
    fs.writeFileSync(installer, String.raw`debug=D:\Users\private-builder\work\xora\installer.cc`);

    assert.deepEqual(assertFinalExecutableArtifacts(root, TARGETS['win32-x64']), [installer]);
    fs.rmSync(installer);
    assert.throws(() => assertFinalExecutableArtifacts(root, TARGETS['win32-x64']), /required \.exe installer was not produced/u);
});
