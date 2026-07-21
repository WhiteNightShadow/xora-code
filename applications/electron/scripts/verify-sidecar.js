// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SIDECAR_ROOT = path.join(ROOT, 'resources', 'sidecars', 'grok');
const LOCK_PATH = path.join(ROOT, 'build', 'grok', 'sidecar.lock.json');
const LEGAL_ROOT = path.join(ROOT, 'resources', 'legal', 'grok-build');
const allowMissing = process.argv.includes('--allow-missing');
const allowUnsignedPreview = process.argv.includes('--allow-unsigned-preview');
const executableName = process.platform === 'win32' ? 'grok.exe' : 'grok';
const executablePath = path.join(SIDECAR_ROOT, executableName);

const REQUIRED_LEGAL = [
    'LICENSE',
    'THIRD-PARTY-NOTICES',
    'crates/xai-grok-tools/THIRD_PARTY_NOTICES.md',
    'crates/xai-ratatui-textarea/NOTICE',
    'crates/xai-ratatui-inline/NOTICE',
    'third_party/NOTICE'
];

async function main() {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    const targetName = targetForRuntime(process.platform, process.arch);
    assert(lock.upstream.version === '0.2.102', 'Unexpected Grok Build version in sidecar lock.');
    assert(lock.upstream.commit === '98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce', 'Unexpected public Grok Build commit.');
    assert(lock.upstream.sourceRevision === '124d85bc5dc6e7805560215fcc6d5413944920e1', 'Unexpected Grok Build SOURCE_REV.');
    assert(lock.toolchain.rust === '1.92.0', 'Unexpected Rust toolchain.');
    assert(JSON.stringify(lock.runtime.args) === JSON.stringify(['--no-auto-update', '--cwd', '<root>', 'agent', '--no-leader', 'stdio']), 'Unsafe Grok runtime arguments.');

    for (const relative of REQUIRED_LEGAL) {
        assertRegularFile(path.join(LEGAL_ROOT, relative), `Required Grok notice is missing: ${relative}`);
    }

    if (!fs.existsSync(executablePath)) {
        const message = `Grok Build sidecar is not staged at ${executablePath}`;
        if (allowMissing) {
            console.warn(`${message}; continuing with a development preview.`);
            return;
        }
        throw new Error(message);
    }
    assertRegularFile(executablePath, 'Grok Build sidecar must be a non-symlink regular file.');
    const stat = fs.statSync(executablePath);
    if (process.platform !== 'win32') assert((stat.mode & 0o111) !== 0, 'Grok Build sidecar is not executable.');

    const releasePath = path.join(SIDECAR_ROOT, 'release.json');
    assertRegularFile(releasePath, 'Formal packaging requires resources/sidecars/grok/release.json.');
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    assertReleaseIdentity(release, lock, targetName);
    assert(release.version === lock.upstream.version, 'Sidecar release metadata version mismatch.');
    assert(release.upstreamCommit === lock.upstream.commit, 'Sidecar release metadata commit mismatch.');
    assert(release.sourceRevision === lock.upstream.sourceRevision, 'Sidecar release metadata SOURCE_REV mismatch.');
    assert(Number.isSafeInteger(release.size) && release.size === stat.size, 'Sidecar release metadata size mismatch.');
    assert(/^[0-9a-f]{64}$/.test(release.sha256), 'Sidecar release metadata needs an exact SHA-256.');
    const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex');
    assert(actualSha256 === release.sha256, `Grok Build checksum mismatch: expected ${release.sha256}, received ${actualSha256}`);

    verifyPlatformSignature(executablePath, allowUnsignedPreview);
    const version = spawnSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false });
    assert(version.status === 0, `grok --version failed: ${(version.stderr || version.error?.message || '').trim()}`);
    assert(`${version.stdout}\n${version.stderr}`.includes(lock.upstream.version), `grok --version did not report ${lock.upstream.version}.`);
    await smokeAcpInitialize(executablePath, lock.runtime.args);
    console.log(`Verified pinned Grok Build ${lock.upstream.version}: ${executablePath}`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertRegularFile(candidate, message) {
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { throw new Error(message); }
    assert(stat.isFile() && !stat.isSymbolicLink(), message);
}

function targetForRuntime(platform, arch) {
    const targets = {
        'darwin:arm64': 'darwin-arm64',
        'darwin:x64': 'darwin-x64',
        'linux:x64': 'linux-x64',
        'win32:x64': 'win32-x64'
    };
    const target = targets[`${platform}:${arch}`];
    assert(target, `Formal packaging is not configured for ${platform}/${arch}.`);
    return target;
}

function assertReleaseIdentity(release, lock, targetName) {
    const target = lock.targets?.[targetName];
    assert(target, `Sidecar lock has no target for ${targetName}.`);
    assert(release.schemaVersion === 1, 'Sidecar release metadata schemaVersion mismatch.');
    assert(release.target === targetName, `Sidecar release metadata target mismatch: expected ${targetName}.`);
    assert(release.rustTarget === target.rustTarget, `Sidecar release metadata Rust target mismatch: expected ${target.rustTarget}.`);
    assert(release.cargoPackage === lock.toolchain.cargoPackage, 'Sidecar release metadata Cargo package mismatch.');
    assert(release.cargoProfile === lock.toolchain.cargoProfile, 'Sidecar release metadata Cargo profile mismatch.');
    assert(
        release.bundledTools?.ripgrep?.package === lock.bundledTools?.ripgrep?.package &&
        release.bundledTools?.ripgrep?.version === lock.bundledTools?.ripgrep?.version &&
        release.bundledTools?.ripgrep?.source === lock.bundledTools?.ripgrep?.source &&
        JSON.stringify(release.bundledTools?.ripgrep?.features) === JSON.stringify(lock.bundledTools?.ripgrep?.features) &&
        release.bundledTools?.ripgrep?.lockedSourceBuild === true,
        'Sidecar release metadata bundled ripgrep identity mismatch.'
    );
}

function verifyPlatformSignature(binary, allowUnsigned = false) {
    // Native CI previews are deliberately unsigned. This explicit flag is
    // never used by the formal package/release path, which remains fail-closed.
    if (allowUnsigned) return;
    if (process.platform === 'darwin') {
        const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary], { encoding: 'utf8', timeout: 15_000 });
        assert(result.status === 0, `The Grok sidecar has no valid macOS code signature: ${result.stderr.trim()}`);
    } else if (process.platform === 'win32') {
        const escaped = binary.replace(/'/g, "''");
        const command = `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
        assert(result.status === 0 && result.stdout.trim() === 'Valid', 'The Grok sidecar has no valid Windows Authenticode signature.');
    }
}

function smokeAcpInitialize(binary, lockedArgs) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whitenight-acp-smoke-'));
    const args = lockedArgs.map(value => value === '<root>' ? workspace : value);
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { cwd: workspace, env: { ...process.env, NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            fs.rmSync(workspace, { recursive: true, force: true });
            error ? reject(error) : resolve();
        };
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
            if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) return finish(new Error('ACP initialize smoke output exceeded 2 MiB.'));
            let newline;
            while ((newline = stdout.indexOf('\n')) >= 0) {
                const line = stdout.slice(0, newline).trim();
                stdout = stdout.slice(newline + 1);
                if (!line) continue;
                try {
                    const message = JSON.parse(line);
                    if (message.id === 'verify-initialize') {
                        if (!message.result || message.error) return finish(new Error('ACP initialize returned an error.'));
                        return finish();
                    }
                } catch { return finish(new Error('ACP initialize emitted malformed JSON on stdout.')); }
            }
        });
        child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-32_000); });
        child.once('error', finish);
        child.once('exit', code => finish(new Error(`ACP initialize exited early (${code}): ${stderr}`)));
        const timer = setTimeout(() => finish(new Error(`ACP initialize timed out: ${stderr}`)), 15_000);
        child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0', id: 'verify-initialize', method: 'initialize', params: {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: 'Xora Code release verifier', version: '0.1.0' }
            }
        })}\n`);
    });
}

module.exports = { assertReleaseIdentity, targetForRuntime };

if (require.main === module) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
