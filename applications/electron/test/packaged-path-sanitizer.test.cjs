// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    assertNoBuildPathLeaks,
    assertNoBuildPathLeaksInAllFiles,
    executablePayloads,
    findBuildPathLeak,
    findBuildPathLeakInBuffer,
    installSourceBuiltRipgrep,
    parsePeCodeViewRecords,
    peDiagnosticPathRanges,
    scrubPeDiagnosticPaths,
    stripConfiguration,
    stripNativeAddons
} = require('../scripts/packaged-path-sanitizer');

function sourceBuiltRipgrepFixture(t) {
    const root = temporaryDirectory(t);
    const helperDirectory = path.join(root, 'Xora Code.app', 'Contents', 'Resources', 'sidecars', 'grok', 'packaging-tools');
    const releaseDirectory = path.dirname(helperDirectory);
    const target = path.join(root, 'Xora Code.app', 'Contents', 'Resources', 'app.asar.unpacked', 'lib', 'backend', 'native', 'rg');
    fs.mkdirSync(helperDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const helper = path.join(helperDirectory, 'rg');
    const contents = Buffer.from('source-built-ripgrep');
    fs.writeFileSync(helper, contents, { mode: 0o755 });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex');
    fs.writeFileSync(path.join(helperDirectory, 'rg.sha256'), `${sha256}  rg\n`);
    fs.writeFileSync(path.join(releaseDirectory, 'release.json'), `${JSON.stringify({
        bundledTools: {
            ripgrep: {
                package: 'ripgrep', version: '15.0.0', source: 'crates.io',
                features: ['pcre2'], lockedSourceBuild: true
            }
        }
    })}\n`);
    fs.writeFileSync(target, 'prebuilt-ripgrep-with-upstream-path', { mode: 0o755 });
    return { contents, helper, helperDirectory, root, sha256, target };
}

function temporaryDirectory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xora-path-sanitizer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function syntheticPe({
    checksum = 0,
    extraDiagnostic,
    pdbPath = String.raw`D:\a\_work\1\s\build\Release\conpty.pdb`,
    signed = false,
    sourcePath = String.raw`D:\a\_work\1\s\src\win\conpty.cc`
} = {}) {
    const buffer = Buffer.alloc(0x1000);
    const peOffset = 0x80;
    const coffOffset = peOffset + 4;
    const optionalOffset = coffOffset + 20;
    const optionalBytes = 0xf0;
    const dataDirectories = optionalOffset + 112;
    const sectionOffset = optionalOffset + optionalBytes;
    const debugOffset = 0x500;
    const codeViewOffset = 0x600;

    buffer.write('MZ', 0, 'ascii');
    buffer.writeUInt32LE(peOffset, 0x3c);
    buffer.write('PE\0\0', peOffset, 'ascii');
    buffer.writeUInt16LE(0x8664, coffOffset);
    buffer.writeUInt16LE(1, coffOffset + 2);
    buffer.writeUInt16LE(optionalBytes, coffOffset + 16);
    buffer.writeUInt16LE(0x20b, optionalOffset);
    buffer.writeUInt32LE(0x400, optionalOffset + 60);
    buffer.writeUInt32LE(checksum, optionalOffset + 64);
    buffer.writeUInt32LE(16, optionalOffset + 108);

    buffer.write('.rdata', sectionOffset, 'ascii');
    buffer.writeUInt32LE(0xa00, sectionOffset + 8);
    buffer.writeUInt32LE(0x1000, sectionOffset + 12);
    buffer.writeUInt32LE(0xa00, sectionOffset + 16);
    buffer.writeUInt32LE(0x400, sectionOffset + 20);

    buffer.writeUInt32LE(0x1100, dataDirectories + (6 * 8));
    buffer.writeUInt32LE(28, dataDirectories + (6 * 8) + 4);
    const pdb = Buffer.from(`${pdbPath}\0`, 'ascii');
    buffer.writeUInt32LE(2, debugOffset + 12);
    buffer.writeUInt32LE(24 + pdb.length, debugOffset + 16);
    buffer.writeUInt32LE(0x1200, debugOffset + 20);
    buffer.writeUInt32LE(codeViewOffset, debugOffset + 24);
    buffer.write('RSDS', codeViewOffset, 'ascii');
    pdb.copy(buffer, codeViewOffset + 24);

    Buffer.from(`${sourcePath}\0`, 'utf16le').copy(buffer, 0x800);
    if (extraDiagnostic) Buffer.from(`${extraDiagnostic}\0`, 'ascii').copy(buffer, 0xa00);
    if (signed) {
        buffer.writeUInt32LE(0xf00, dataDirectories + (4 * 8));
        buffer.writeUInt32LE(0x40, dataDirectories + (4 * 8) + 4);
        buffer.fill(0xa5, 0xf00, 0xf40);
    }
    return buffer;
}

test('scanner detects Unix and Windows build-user paths without returning the path value', () => {
    const mac = findBuildPathLeak('symbol\0/Users/buildbot/work/xora/native.cc\0');
    assert.deepEqual(mac, { kind: 'macOS user-home build path', index: 7 });

    const linux = findBuildPathLeak('debug=/home/runner/work/xora/native.cc');
    assert.equal(linux?.kind, 'Linux user-home build path');

    const windows = findBuildPathLeak(String.raw`debug=D:\a\xora-code\xora-code\native.cc`);
    assert.equal(windows?.kind, 'Windows user or CI build path');
    assert.deepEqual(Object.keys(windows).sort(), ['index', 'kind']);
});

test('scanner detects UTF-16LE paths and ignores ordinary HTTP documentation URLs', () => {
    const utf16 = findBuildPathLeakInBuffer(Buffer.from(String.raw`D:\Users\builder\work\xora\addon.cc`, 'utf16le'));
    assert.equal(utf16?.kind, 'Windows user or CI build path');
    assert.equal(utf16?.encoding, 'UTF-16LE');

    for (const documentation of [
        'Read https://docs.example.test/Users/example/project/setup for details.',
        'Read http://localhost/home/example/workspace/help for details.',
        'See https://docs.example.test/D:/Users/example/project/setup.',
        'Chromium resources: core/root/root.js and chrome://home/*.',
        'Runtime defaults: /home/chronos/user and C:\\Users\\Default\\AppData\\Roaming.'
    ]) {
        assert.equal(findBuildPathLeak(documentation), undefined);
    }
});

test('macOS temporary paths require a real non-empty var/folders build layout', () => {
    assert.equal(
        findBuildPathLeak('/private/var/folders/98/3xx60qm136qbvj2l179vxmsm0000gn/T/xora-build/native.cc')?.kind,
        'temporary macOS build path'
    );
    assert.equal(
        findBuildPathLeak('/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/xora-build/native.cc')?.kind,
        'temporary macOS build path'
    );
    for (const runtimeTemplate of ['/var/folders//T/', '/private/var/folders///origin', '/var/folders/98/short/T/file']) {
        assert.equal(findBuildPathLeak(runtimeTemplate), undefined);
    }
});

test('native packaging replaces Theia ripgrep with the verified locked source build', t => {
    const fixture = sourceBuiltRipgrepFixture(t);
    const calls = [];
    const result = installSourceBuiltRipgrep(fixture.root, 'darwin', (file, args, options) => {
        calls.push({ args, file, options });
        return {
            status: 0,
            stdout: 'ripgrep 15.0.0\n\nfeatures:+pcre2\nPCRE2 10.45 is available (JIT is available)\n',
            stderr: ''
        };
    });
    assert.equal(result.sha256, fixture.sha256);
    assert.deepEqual(fs.readFileSync(fixture.target), fixture.contents);
    assert.equal(fs.existsSync(fixture.helperDirectory), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, fixture.helper);
    assert.deepEqual(calls[0].args, ['--version']);
    assert.equal(calls[0].options.shell, false);
});

test('native packaging rejects a tampered ripgrep helper before replacing Theia', t => {
    const fixture = sourceBuiltRipgrepFixture(t);
    fs.appendFileSync(fixture.helper, '-tampered');
    assert.throws(
        () => installSourceBuiltRipgrep(fixture.root, 'darwin', () => ({ status: 0 })),
        /checksum does not match/u
    );
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), 'prebuilt-ripgrep-with-upstream-path');
});

test('scanner finds an odd-byte-aligned UTF-16LE Windows build path', () => {
    const buffer = Buffer.concat([
        Buffer.from([0xff]),
        Buffer.from(String.raw`D:\a\_work\1\s\src\win\conpty.cc`, 'utf16le')
    ]);
    const leak = findBuildPathLeakInBuffer(buffer);
    assert.equal(leak?.encoding, 'UTF-16LE');
    assert.equal(leak?.offset, 1);
});

test('PE sanitizer rewrites only NUL-terminated PDB and source diagnostic paths at constant length', () => {
    const input = syntheticPe();
    const ranges = peDiagnosticPathRanges(input);
    assert.deepEqual(ranges.map(range => range.encoding), ['ascii', 'utf16le']);

    const result = scrubPeDiagnosticPaths(input);
    assert.equal(result.scrubbed, 2);
    assert.equal(result.buffer.length, input.length);
    assert.equal(findBuildPathLeakInBuffer(result.buffer), undefined);
    assert.deepEqual(parsePeCodeViewRecords(result.buffer).records.map(record => record.path), ['xora-code.pdb']);
    for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== result.buffer[index]) {
            assert.ok(ranges.some(range => index >= range.start && index < range.end), `unexpected mutation at ${index}`);
        }
    }
});

test('PE sanitizer is fail-closed for signed, checksummed, or non-source diagnostic paths', () => {
    assert.throws(() => scrubPeDiagnosticPaths(syntheticPe({ signed: true })), /signed Windows native addon/u);
    assert.throws(() => scrubPeDiagnosticPaths(syntheticPe({ checksum: 1 })), /checksummed Windows native addon/u);
    assert.throws(
        () => scrubPeDiagnosticPaths(syntheticPe({ extraDiagnostic: String.raw`D:\a\_work\1\s\src\lib.rs` })),
        /outside a replaceable diagnostic path/u
    );
});

test('Windows addon staging atomically scrubs the synthetic PE before the final scan', t => {
    const root = temporaryDirectory(t);
    const addon = path.join(root, 'conpty.node');
    const input = syntheticPe();
    fs.writeFileSync(addon, input);

    const result = stripNativeAddons(root, 'win32');
    const output = fs.readFileSync(addon);
    assert.deepEqual(result.stripped, [addon]);
    assert.equal(output.length, input.length);
    assert.equal(findBuildPathLeakInBuffer(output), undefined);
    assert.equal(assertNoBuildPathLeaks(root).length, 1);
});

test('real node-pty Windows prebuilds are sanitized without changing their length', t => {
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
    const files = ['conpty.node', 'conpty_console_list.node'].map(name =>
        path.join(repositoryRoot, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', name)
    );
    if (files.some(file => !fs.existsSync(file))) {
        t.skip('node-pty Windows prebuilds are not installed');
        return;
    }

    const scrubbed = files.map(file => {
        const input = fs.readFileSync(file);
        const result = scrubPeDiagnosticPaths(input);
        assert.equal(result.buffer.length, input.length);
        assert.equal(findBuildPathLeakInBuffer(result.buffer), undefined);
        assert.deepEqual(parsePeCodeViewRecords(result.buffer).records.map(record => record.path), ['xora-code.pdb']);
        return result.scrubbed;
    });
    assert.deepEqual(scrubbed, [2, 1]);
});

test('fail-closed scan redacts the discovered path and scans app code plus executables', t => {
    const root = temporaryDirectory(t);
    const native = path.join(root, 'addon.node');
    const executable = path.join(root, 'xora-code');
    const applicationCode = path.join(root, 'app.asar');
    const documentation = path.join(root, 'README.txt');
    fs.writeFileSync(native, 'native payload');
    fs.writeFileSync(executable, 'launcher');
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(applicationCode, 'https://docs.example.test/Users/example/project/setup');
    fs.writeFileSync(documentation, '/Users/documentation/example.txt');

    assert.deepEqual(
        executablePayloads(root).map(({ file }) => path.basename(file)).sort(),
        ['addon.node', 'app.asar', 'xora-code']
    );
    assert.equal(assertNoBuildPathLeaks(root).length, 3);

    fs.writeFileSync(native, '/Users/private-builder/work/xora/native.cc');
    let error;
    try {
        assertNoBuildPathLeaks(root);
    } catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /addon\.node contains a macOS user-home build path/u);
    assert.match(error.message, /path value was redacted/u);
    assert.doesNotMatch(error.message, /private-builder|native\.cc/u);
});

test('afterPack scans every regular file, including extension source maps', t => {
    const root = temporaryDirectory(t);
    const extension = path.join(root, 'resources', 'app', 'plugins', 'language', 'extension.js.map');
    const readme = path.join(root, 'resources', 'README.txt');
    fs.mkdirSync(path.dirname(extension), { recursive: true });
    fs.writeFileSync(extension, JSON.stringify({ sources: ['/Users/private-builder/work/extension.ts'] }));
    fs.writeFileSync(readme, 'ordinary packaged documentation');

    assert.equal(assertNoBuildPathLeaks(root).length, 0, 'executable-only scan should not see source maps');
    assert.throws(() => assertNoBuildPathLeaksInAllFiles(root), /extension\.js\.map contains a macOS user-home build path/u);

    fs.writeFileSync(extension, JSON.stringify({ sources: ['xora://source/extension.ts'] }));
    assert.deepEqual(
        assertNoBuildPathLeaksInAllFiles(root).map(file => path.relative(root, file)).sort(),
        ['resources/README.txt', 'resources/app/plugins/language/extension.js.map']
    );
});

test('native addon stripping uses an atomic temporary copy and preserves its mode', t => {
    const root = temporaryDirectory(t);
    const addon = path.join(root, 'native', 'addon.node');
    fs.mkdirSync(path.dirname(addon), { recursive: true });
    fs.writeFileSync(addon, '/Users/buildbot/work/xora/native.cc');
    fs.chmodSync(addon, 0o755);
    const calls = [];

    const result = stripNativeAddons(root, 'darwin', (command, args) => {
        calls.push({ command, args: [...args] });
        fs.writeFileSync(args.at(-1), 'sanitized native addon');
        return { status: 0 };
    });

    assert.equal(result.stripped.length, 1);
    assert.deepEqual(result.unstripped, []);
    assert.equal(calls[0].command, '/usr/bin/strip');
    assert.equal(calls[0].args[0], '-S');
    assert.notEqual(calls[0].args.at(-1), addon);
    assert.equal(fs.readFileSync(addon, 'utf8'), 'sanitized native addon');
    assert.equal(fs.statSync(addon).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(path.dirname(addon)), ['addon.node']);
});

test('native stripping also covers the node-pty spawn helper executable', t => {
    const root = temporaryDirectory(t);
    const helper = path.join(root, 'lib', 'prebuilds', 'darwin-arm64', 'spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, 'native helper fixture', { mode: 0o755 });
    const calls = [];
    const result = stripNativeAddons(root, 'darwin', (command, args) => {
        calls.push({ args, command });
        return { status: 0 };
    });
    assert.deepEqual(result.stripped, [helper]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/strip');
    assert.deepEqual(calls[0].args.slice(0, 1), ['-S']);
});

test('missing strip tool leaves addons unchanged for the fail-closed scanner', t => {
    const root = temporaryDirectory(t);
    const addon = path.join(root, 'addon.node');
    fs.writeFileSync(addon, '/home/builder/work/xora/native.cc');
    const result = stripNativeAddons(root, 'linux', () => ({ status: null, error: { code: 'ENOENT' } }));

    assert.deepEqual(result.stripped, []);
    assert.deepEqual(result.unstripped, [addon]);
    assert.throws(() => assertNoBuildPathLeaks(root), /Linux user-home build path/u);
    assert.equal(stripConfiguration('win32'), undefined);
});
