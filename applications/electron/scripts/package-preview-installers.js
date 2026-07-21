// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertNoBuildPathLeaks } = require('./packaged-path-sanitizer');
const { spawnYarnSync } = require('./spawn-yarn');

const applicationRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(applicationRoot, '..', '..');
const distRoot = path.join(applicationRoot, 'dist');
const previewAssetsRoot = path.join(distRoot, 'preview-assets');

const TARGETS = Object.freeze({
    'darwin-arm64': {
        platform: 'mac', runtimePlatform: 'darwin', arch: 'arm64',
        builder: ['--mac', 'dmg', 'zip', '--arm64'], required: ['.dmg', '.zip'], allowed: ['.dmg', '.zip', '.blockmap'],
        signature: 'ad-hoc; not notarized'
    },
    'darwin-x64': {
        platform: 'mac', runtimePlatform: 'darwin', arch: 'x64',
        builder: ['--mac', 'dmg', 'zip', '--x64'], required: ['.dmg', '.zip'], allowed: ['.dmg', '.zip', '.blockmap'],
        signature: 'ad-hoc; not notarized'
    },
    'win32-x64': {
        platform: 'windows', runtimePlatform: 'win32', arch: 'x64',
        builder: ['--win', 'nsis', '--x64'], required: ['.exe'], allowed: ['.exe', '.blockmap'],
        signature: 'unsigned'
    },
    'linux-x64': {
        platform: 'linux', runtimePlatform: 'linux', arch: 'x64',
        builder: ['--linux', 'AppImage', 'deb', '--x64'], required: ['.AppImage', '.deb'], allowed: ['.AppImage', '.deb', '.blockmap'],
        signature: 'SHA-256 checksums only'
    }
});

const FORBIDDEN_RELEASE_ASSET = /(?:^|\/)(?:app-update\.json|grok-sidecar-update\.json|SHA256SUMS\.asc)$|\.(?:asc|sig)$/iu;
const SIGNING_ENVIRONMENT = [
    'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_TEAM_ID',
    'CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
    'WINDOWS_CERTIFICATE_PFX_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD',
    'APP_UPDATE_ED25519_PRIVATE_KEY_BASE64', 'SIDECAR_UPDATE_ED25519_PRIVATE_KEY_BASE64',
    'LINUX_GPG_PRIVATE_KEY_BASE64', 'LINUX_GPG_PASSPHRASE'
];

function fail(message) {
    throw new Error(`Unsigned preview packaging refused: ${message}`);
}

function options(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        if (!name.startsWith('--') || index + 1 >= argv.length) fail(`invalid argument ${name}`);
        parsed[name.slice(2)] = argv[++index];
    }
    if (!parsed.platform || !parsed.arch) fail('--platform and --arch are required');
    const targetName = Object.keys(TARGETS).find(name => TARGETS[name].platform === parsed.platform && TARGETS[name].arch === parsed.arch);
    if (!targetName) fail(`unsupported preview target ${parsed.platform}/${parsed.arch}`);
    return { targetName, target: TARGETS[targetName] };
}

function previewEnvironment(environment = process.env) {
    const result = { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
    const signingNames = new Set(SIGNING_ENVIRONMENT.map(name => name.toUpperCase()));
    for (const name of Object.keys(result)) {
        if (signingNames.has(name.toUpperCase())) delete result[name];
    }
    return result;
}

function runYarn(args, environment) {
    const result = spawnYarnSync(args, {
        cwd: applicationRoot,
        env: environment,
        encoding: 'utf8',
        stdio: 'inherit',
        windowsHide: true
    });
    if (result.status !== 0) fail(`yarn ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`);
}

function runNative(file, args, timeout = 10 * 60_000) {
    const result = spawnSync(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        windowsHide: true,
        shell: false
    });
    if (!result || result.status !== 0) {
        fail(`${path.basename(file)} failed with status ${result?.status ?? 'unknown'}`);
    }
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function applicationBundle(directory) {
    const bundles = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
        .map(entry => path.join(directory, entry.name));
    if (bundles.length !== 1) fail(`expected one packaged macOS application, found ${bundles.length}`);
    return bundles[0];
}

function macApplicationOutputDirectory(directory, arch) {
    // electron-builder omits the architecture suffix for its default x64
    // output and uses `mac-arm64` for arm64. Do not guess `mac-x64`: that
    // directory is never produced by the pinned builder and would make the
    // Intel preview fail only after the expensive native build completed.
    return path.join(directory, arch === 'x64' ? 'mac' : `mac-${arch}`);
}

function createMacPreviewDmg(directory, target, runner = runNative) {
    if (process.platform !== 'darwin') fail('the preview DMG must be created on macOS');
    const applicationPackage = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'));
    const app = applicationBundle(macApplicationOutputDirectory(directory, target.arch));
    const artifact = path.join(directory, `Xora Code-${applicationPackage.version}-mac-${target.arch}.dmg`);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-preview-dmg-'));
    const writableImage = path.join(temporary, 'staging.dmg');
    const mountpoint = path.join(temporary, 'volume');
    let attached = false;
    try {
        fs.mkdirSync(mountpoint);
        runner('/usr/bin/hdiutil', [
            'create', '-srcfolder', app, '-volname', `Xora Code ${applicationPackage.version} ${target.arch}`,
            '-anyowners', '-nospotlight', '-format', 'UDRW', '-fs', 'APFS', writableImage
        ]);
        runner('/usr/bin/hdiutil', [
            'attach', '-readwrite', '-noverify', '-noautoopen', '-nobrowse',
            '-mountpoint', mountpoint, writableImage
        ]);
        attached = true;
        fs.symlinkSync('/Applications', path.join(mountpoint, 'Applications'));
        runner('/bin/sync', []);
        runner('/usr/bin/hdiutil', ['detach', mountpoint]);
        attached = false;
        fs.rmSync(artifact, { force: true });
        runner('/usr/bin/hdiutil', [
            'convert', writableImage, '-ov', '-format', 'UDZO',
            '-imagekey', 'zlib-level=9', '-o', artifact
        ]);
        runner('/usr/bin/hdiutil', ['verify', artifact]);
        if (!fs.statSync(artifact).isFile() || fs.statSync(artifact).size === 0) fail('hdiutil produced an empty DMG');
        return artifact;
    } finally {
        if (attached) {
            spawnSync('/usr/bin/hdiutil', ['detach', '-force', mountpoint], {
                encoding: 'utf8', stdio: 'ignore', timeout: 120_000, windowsHide: true, shell: false
            });
        }
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

function hasExtension(name, extension) {
    return name.toLowerCase().endsWith(extension.toLowerCase());
}

function selectArtifacts(directory, target) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort((left, right) => left.localeCompare(right));
    if (files.some(name => FORBIDDEN_RELEASE_ASSET.test(name))) {
        fail('formal update manifests or detached signatures appeared in the preview output');
    }
    const selected = files.filter(name => target.allowed.some(extension => hasExtension(name, extension)));
    for (const extension of target.required) {
        if (!selected.some(name => hasExtension(name, extension))) fail(`required ${extension} installer was not produced`);
    }
    return selected;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stagePreviewAssets(directory, outputDirectory, targetName, target, metadata = {}) {
    const selected = selectArtifacts(directory, target);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const name of selected) {
        fs.copyFileSync(path.join(directory, name), path.join(outputDirectory, name), fs.constants.COPYFILE_EXCL);
    }

    const applicationPackage = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'));
    const provenanceName = `Xora-Code-${applicationPackage.version}-${targetName}-PREVIEW.json`;
    fs.writeFileSync(path.join(outputDirectory, provenanceName), `${JSON.stringify({
        schemaVersion: 1,
        product: 'xora-code',
        version: applicationPackage.version,
        target: targetName,
        commit: metadata.commit || process.env.GITHUB_SHA || 'local',
        preview: true,
        productionSigned: false,
        signature: target.signature
    }, null, 2)}\n`, { flag: 'wx' });

    const checksummed = [...selected, provenanceName].sort((left, right) => left.localeCompare(right));
    const checksums = checksummed.map(name => `${sha256(path.join(outputDirectory, name))}  ${name}`).join('\n');
    fs.writeFileSync(path.join(outputDirectory, `SHA256SUMS-${targetName}.txt`), `${checksums}\n`, { flag: 'wx' });
    return selected;
}

function assertNative(targetName, target) {
    if (process.platform !== target.runtimePlatform || process.arch !== target.arch) {
        fail(`${targetName} must be packaged on native ${target.runtimePlatform}/${target.arch}, received ${process.platform}/${process.arch}`);
    }
    const binaryName = process.platform === 'win32' ? 'grok.exe' : 'grok';
    const sidecar = path.join(repositoryRoot, 'resources', 'sidecars', 'grok', binaryName);
    const release = path.join(repositoryRoot, 'resources', 'sidecars', 'grok', 'release.json');
    if (!fs.existsSync(sidecar) || !fs.existsSync(release)) fail('the pinned Grok binary and release.json must be staged before packaging');
}

function assertWindowsInstallersUnsigned(directory) {
    const installers = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
        .map(entry => path.join(directory, entry.name));
    if (installers.length === 0) fail('the Windows NSIS preview installer is missing');
    for (const installer of installers) {
        const escaped = installer.replaceAll("'", "''");
        const result = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`
        ], {
            encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false
        });
        if (result.status !== 0 || result.stdout.trim() !== 'NotSigned') {
            fail(`Windows preview unexpectedly has an Authenticode signature: ${path.basename(installer)}`);
        }
    }
}

function assertFinalExecutableArtifacts(directory, target) {
    const selected = selectArtifacts(directory, target);
    const scanned = [];
    for (const name of selected) {
        scanned.push(...assertNoBuildPathLeaks(path.join(directory, name)));
    }
    return scanned;
}

function packagePreview(targetName, target) {
    assertNative(targetName, target);
    const environment = previewEnvironment();
    runYarn(['clean:dist'], environment);
    runYarn(['build:prod'], environment);

    // The native hdiutil call can take longer than dmg-builder's retry window
    // for this large application. Build the signed ZIP/app with electron-builder,
    // then create and verify the preview DMG synchronously with a ten-minute
    // native timeout. This also prevents ZIP compression and APFS creation from
    // competing for I/O.
    const builderPlans = target.platform === 'mac'
        ? [['--mac', 'zip', `--${target.arch}`]]
        : [target.builder];
    for (const plan of builderPlans) {
        const builder = ['electron-builder', ...plan, '--publish', 'never'];
        if (target.platform === 'mac') {
            builder.push(
                '--config.mac.identity=null',
                '--config.mac.notarize=false',
                '--config.afterPack=./scripts/preview-after-pack.js'
            );
        }
        runYarn(builder, environment);
    }
    if (target.platform === 'mac') createMacPreviewDmg(distRoot, target);
    assertFinalExecutableArtifacts(distRoot, target);
    if (target.platform === 'windows') assertWindowsInstallersUnsigned(distRoot);
    return stagePreviewAssets(distRoot, previewAssetsRoot, targetName, target);
}

module.exports = {
    FORBIDDEN_RELEASE_ASSET,
    SIGNING_ENVIRONMENT,
    TARGETS,
    createMacPreviewDmg,
    macApplicationOutputDirectory,
    assertFinalExecutableArtifacts,
    assertWindowsInstallersUnsigned,
    options,
    previewEnvironment,
    selectArtifacts,
    stagePreviewAssets
};

if (require.main === module) {
    try {
        const parsed = options(process.argv.slice(2));
        const files = packagePreview(parsed.targetName, parsed.target);
        process.stdout.write(`Prepared unsigned preview ${parsed.targetName}: ${files.join(', ')}\n`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
