// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCAN_CHUNK_BYTES = 1024 * 1024;
const SCAN_OVERLAP_BYTES = 4096;
const PE_DEBUG_DIRECTORY_ENTRY_BYTES = 28;
const PE_CODEVIEW_TYPE = 2;
const SAFE_PE_DIAGNOSTIC_EXTENSIONS = Object.freeze(['.c', '.cc', '.cpp', '.h', '.hpp', '.pdb']);
const EXECUTABLE_SUFFIXES = Object.freeze([
    '.appimage', '.asar', '.dll', '.dylib', '.exe', '.node', '.so', '.wasm'
]);

// These patterns intentionally target build/workspace locations rather than
// every absolute path. System paths such as /usr/lib are valid runtime data.
// The matched value is never included in an error message.
const BUILD_PATH_PATTERNS = Object.freeze([
    {
        kind: 'macOS user-home build path',
        expression: /(?<![A-Za-z0-9._~\/-])\/Users\/[A-Za-z0-9._-]+\/(?:Desktop|Documents|Downloads|Projects?|dev|src|source|build|work|workspace|\.cargo|\.cache|Library\/Developer\/Xcode\/DerivedData)\/[^\0\r\n\t "'<>]{1,1024}/gu
    },
    {
        kind: 'Linux user-home build path',
        expression: /(?<![A-Za-z0-9._~\/-])\/(?:home\/[A-Za-z0-9._-]+|root)\/(?:Desktop|Documents|Downloads|Projects?|dev|src|source|build|work|workspace|\.cargo|\.cache)\/[^\0\r\n\t "'<>]{1,1024}/gu
    },
    {
        kind: 'temporary macOS build path',
        expression: /(?<![A-Za-z0-9._~\/-])\/(?:private\/)?var\/folders\/[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{20,64}\/T\/[^\0\r\n\t "'<>]{1,1024}/gu
    },
    {
        kind: 'CI workspace build path',
        expression: /(?<![A-Za-z0-9._~\/-])\/(?:builds|workspace)\/[^\0\r\n\t "'<>]{1,1024}/gu
    },
    {
        kind: 'Windows user or CI build path',
        expression: /(?<![A-Za-z0-9._~\/-])[A-Za-z]:[\\/](?:Users[\\/][^\\/\0\r\n\t "'<>]+[\\/](?:(?:Desktop|Documents|Downloads|Projects?|dev|src|source|build|work|workspace|\.cargo|\.cache)[\\/]|AppData[\\/]Local[\\/](?:Temp|node-gyp|npm-cache)[\\/])|a[\\/]|agent[\\/]_work[\\/]|actions-runner[\\/]_work[\\/]|dev[\\/]|projects?[\\/]|source[\\/]|src[\\/]|build[\\/]|work[\\/]|workspace[\\/])[^\0\r\n\t "'<>]{1,1024}/giu
    }
]);

function fail(message) {
    throw new Error(`Packaged path sanitization refused: ${message}`);
}

function relativeName(root, file) {
    if (root === file) return path.basename(file);
    return path.relative(root, file) || path.basename(file);
}

function isHttpUrlContext(text, index) {
    const prefix = text.slice(Math.max(0, index - 2048), index);
    return /https?:\/\/[^\0\s"'<>]*$/iu.test(prefix);
}

function buildPathMatches(text) {
    const matches = [];
    for (const candidate of BUILD_PATH_PATTERNS) {
        candidate.expression.lastIndex = 0;
        let match;
        while ((match = candidate.expression.exec(text)) !== null) {
            if (!isHttpUrlContext(text, match.index)) {
                matches.push({ kind: candidate.kind, index: match.index, value: match[0] });
            }
        }
    }
    return matches.sort((left, right) => left.index - right.index);
}

function findBuildPathLeak(text) {
    const match = buildPathMatches(text)[0];
    return match ? { kind: match.kind, index: match.index } : undefined;
}

function findBuildPathLeakInBuffer(buffer, baseOffset = 0) {
    const singleByte = findBuildPathLeak(buffer.toString('latin1'));
    if (singleByte) return { ...singleByte, encoding: 'single-byte', offset: baseOffset + singleByte.index };

    // Windows toolchains can persist source paths as UTF-16LE debug strings.
    const utf16 = findBuildPathLeak(buffer.toString('utf16le'));
    if (utf16) return { ...utf16, encoding: 'UTF-16LE', offset: baseOffset + (utf16.index * 2) };
    const oddUtf16 = findBuildPathLeak(buffer.subarray(1).toString('utf16le'));
    if (oddUtf16) return { ...oddUtf16, encoding: 'UTF-16LE', offset: baseOffset + 1 + (oddUtf16.index * 2) };
    return undefined;
}

function scanFileForBuildPath(file) {
    const descriptor = fs.openSync(file, 'r');
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let position = 0;
    try {
        for (;;) {
            const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, position);
            if (bytesRead === 0) return undefined;
            const combined = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
            const leak = findBuildPathLeakInBuffer(combined, Math.max(0, position - carry.length));
            if (leak) return leak;
            carry = Buffer.from(combined.subarray(Math.max(0, combined.length - SCAN_OVERLAP_BYTES)));
            position += bytesRead;
        }
    } finally {
        fs.closeSync(descriptor);
    }
}

function regularFiles(root) {
    const result = [];
    const visit = file => {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) return;
        if (stat.isFile()) {
            result.push({ file, stat });
            return;
        }
        if (!stat.isDirectory()) return;
        const children = fs.readdirSync(file).sort((left, right) => left.localeCompare(right));
        for (const child of children) visit(path.join(file, child));
    };
    visit(root);
    return result;
}

function filesEndingWith(root, segments) {
    return regularFiles(root)
        .map(({ file }) => file)
        .filter(file => {
            const relative = path.relative(root, file).split(path.sep);
            return relative.length >= segments.length
                && segments.every((segment, index) => relative[relative.length - segments.length + index] === segment);
        });
}

function uniquePackagedFile(root, segments, label) {
    const matches = filesEndingWith(root, segments);
    if (matches.length !== 1) fail(`expected one ${label}, found ${matches.length}`);
    return matches[0];
}

function fileSha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function installSourceBuiltRipgrep(root, platform = process.platform, runner = spawnSync) {
    const executable = platform === 'win32' ? 'rg.exe' : 'rg';
    const helper = uniquePackagedFile(
        root,
        ['sidecars', 'grok', 'packaging-tools', executable],
        'source-built ripgrep packaging helper'
    );
    const checksum = uniquePackagedFile(
        root,
        ['sidecars', 'grok', 'packaging-tools', `${executable}.sha256`],
        'source-built ripgrep checksum'
    );
    const releasePath = uniquePackagedFile(root, ['sidecars', 'grok', 'release.json'], 'Grok release metadata');
    const target = uniquePackagedFile(
        root,
        ['app.asar.unpacked', 'lib', 'backend', 'native', executable],
        'Theia ripgrep executable'
    );

    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const ripgrep = release?.bundledTools?.ripgrep;
    if (ripgrep?.package !== 'ripgrep' || ripgrep?.source !== 'crates.io'
        || !/^\d+\.\d+\.\d+$/u.test(ripgrep?.version ?? '')
        || JSON.stringify(ripgrep?.features) !== JSON.stringify(['pcre2'])
        || ripgrep?.lockedSourceBuild !== true) {
        fail('Grok release metadata does not describe the audited ripgrep source build');
    }

    const expectedHash = fileSha256(helper);
    const checksumText = fs.readFileSync(checksum, 'utf8');
    if (checksumText !== `${expectedHash}  ${executable}\n`) {
        fail('the source-built ripgrep packaging helper checksum does not match');
    }
    const helperLeak = scanFileForBuildPath(helper);
    if (helperLeak) fail(`the source-built ripgrep helper contains a ${helperLeak.kind}; the path value was redacted`);

    const version = runner(helper, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        windowsHide: true,
        shell: false
    });
    const versionOutput = `${version?.stdout ?? ''}\n${version?.stderr ?? ''}`;
    const escapedVersion = ripgrep.version.replaceAll('.', '\\.');
    if (!version || version.status !== 0
        || !new RegExp(`^ripgrep ${escapedVersion}(?:\\r?\\n|$)`, 'mu').test(versionOutput)
        || !/^features:\+pcre2\r?$/mu.test(versionOutput)
        || !/^PCRE2 .*available.*\r?$/mu.test(versionOutput)) {
        fail(`the ripgrep packaging helper does not report the locked ${ripgrep.version} pcre2 build`);
    }

    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) fail('the packaged Theia ripgrep target is unsafe');
    fs.copyFileSync(helper, target);
    if (platform !== 'win32') fs.chmodSync(target, targetStat.mode | 0o111);
    if (fileSha256(target) !== expectedHash) fail('the packaged Theia ripgrep replacement changed while copying');
    const targetLeak = scanFileForBuildPath(target);
    if (targetLeak) fail(`the packaged Theia ripgrep replacement contains a ${targetLeak.kind}; the path value was redacted`);

    fs.rmSync(path.dirname(helper), { recursive: true, force: true });
    return { target, sha256: expectedHash, version: ripgrep.version };
}

function isExecutablePayload(file, stat) {
    const name = path.basename(file).toLowerCase();
    if ((stat.mode & 0o111) !== 0) return true;
    if (name.includes('.so.')) return true;
    return EXECUTABLE_SUFFIXES.some(suffix => name.endsWith(suffix));
}

function executablePayloads(root) {
    try {
        return regularFiles(root).filter(({ file, stat }) => isExecutablePayload(file, stat));
    } catch {
        fail('the packaged output could not be enumerated');
    }
}

function assertNoBuildPathLeaks(root) {
    const payloads = executablePayloads(root);
    for (const { file } of payloads) {
        const displayName = relativeName(root, file);
        let leak;
        try {
            leak = scanFileForBuildPath(file);
        } catch {
            fail(`could not scan packaged payload ${displayName}`);
        }
        if (leak) {
            fail(`${displayName} contains a ${leak.kind} (${leak.encoding}, byte ${leak.offset}); the path value was redacted`);
        }
    }
    return payloads.map(({ file }) => file);
}

function stripConfiguration(platform) {
    if (platform === 'darwin') return { command: '/usr/bin/strip', arguments: ['-S'] };
    if (platform === 'linux') return { command: 'strip', arguments: ['--strip-debug'] };
    return undefined;
}

function assertBufferRange(buffer, offset, bytes) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0 || offset + bytes > buffer.length) {
        fail('a Windows native addon has a malformed PE debug directory');
    }
}

function parsePeCodeViewRecords(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
        fail('a Windows native addon is not a valid PE image');
    }
    const peOffset = buffer.readUInt32LE(0x3c);
    assertBufferRange(buffer, peOffset, 24);
    if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
        fail('a Windows native addon has an invalid PE signature');
    }

    const coffOffset = peOffset + 4;
    const sectionCount = buffer.readUInt16LE(coffOffset + 2);
    const optionalBytes = buffer.readUInt16LE(coffOffset + 16);
    const optionalOffset = coffOffset + 20;
    assertBufferRange(buffer, optionalOffset, optionalBytes);
    const magic = buffer.readUInt16LE(optionalOffset);
    const dataDirectoryRelativeOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
    const dataDirectoryCountRelativeOffset = magic === 0x20b ? 108 : magic === 0x10b ? 92 : -1;
    const dataDirectoryOffset = optionalOffset + dataDirectoryRelativeOffset;
    const dataDirectoryCountOffset = optionalOffset + dataDirectoryCountRelativeOffset;
    if (dataDirectoryOffset < optionalOffset) fail('a Windows native addon uses an unsupported PE optional header');
    if (optionalBytes < dataDirectoryRelativeOffset) fail('a Windows native addon has a truncated PE optional header');
    const assertOptionalRange = (offset, bytes) => {
        assertBufferRange(buffer, offset, bytes);
        if (offset < optionalOffset || offset + bytes > optionalOffset + optionalBytes) {
            fail('a Windows native addon has a malformed PE data directory');
        }
    };
    assertOptionalRange(optionalOffset + 60, 8);
    const sizeOfHeaders = buffer.readUInt32LE(optionalOffset + 60);
    const checksum = buffer.readUInt32LE(optionalOffset + 64);
    const dataDirectoryCount = buffer.readUInt32LE(dataDirectoryCountOffset);
    const sectionTableOffset = optionalOffset + optionalBytes;
    assertBufferRange(buffer, sectionTableOffset, sectionCount * 40);

    const sections = [];
    for (let index = 0; index < sectionCount; index += 1) {
        const section = sectionTableOffset + (index * 40);
        sections.push({
            virtualSize: buffer.readUInt32LE(section + 8),
            virtualAddress: buffer.readUInt32LE(section + 12),
            rawSize: buffer.readUInt32LE(section + 16),
            rawOffset: buffer.readUInt32LE(section + 20)
        });
    }

    const rvaToOffset = (rva, bytes) => {
        if (rva < sizeOfHeaders) {
            assertBufferRange(buffer, rva, bytes);
            return rva;
        }
        for (const section of sections) {
            const relative = rva - section.virtualAddress;
            if (relative >= 0 && relative + bytes <= section.rawSize) {
                const offset = section.rawOffset + relative;
                assertBufferRange(buffer, offset, bytes);
                return offset;
            }
        }
        fail('a Windows native addon contains an unmapped PE debug address');
    };

    let certificateTableBytes = 0;
    if (dataDirectoryCount > 4) {
        assertOptionalRange(dataDirectoryOffset + (4 * 8), 8);
        const certificateOffset = buffer.readUInt32LE(dataDirectoryOffset + (4 * 8));
        certificateTableBytes = buffer.readUInt32LE(dataDirectoryOffset + (4 * 8) + 4);
        if ((certificateOffset === 0) !== (certificateTableBytes === 0)) {
            fail('a Windows native addon has a malformed certificate table');
        }
        if (certificateTableBytes > 0) assertBufferRange(buffer, certificateOffset, certificateTableBytes);
    }

    if (dataDirectoryCount <= 6) return { certificateTableBytes, checksum, records: [] };
    assertOptionalRange(dataDirectoryOffset + (6 * 8), 8);
    const debugRva = buffer.readUInt32LE(dataDirectoryOffset + (6 * 8));
    const debugBytes = buffer.readUInt32LE(dataDirectoryOffset + (6 * 8) + 4);
    if (debugRva === 0 && debugBytes === 0) return { certificateTableBytes, checksum, records: [] };
    if (debugRva === 0 || debugBytes === 0 || debugBytes % PE_DEBUG_DIRECTORY_ENTRY_BYTES !== 0) {
        fail('a Windows native addon has a malformed PE debug directory');
    }
    const debugOffset = rvaToOffset(debugRva, debugBytes);
    const records = [];
    for (let entryOffset = debugOffset; entryOffset < debugOffset + debugBytes; entryOffset += PE_DEBUG_DIRECTORY_ENTRY_BYTES) {
        if (buffer.readUInt32LE(entryOffset + 12) !== PE_CODEVIEW_TYPE) continue;
        const dataBytes = buffer.readUInt32LE(entryOffset + 16);
        const dataRva = buffer.readUInt32LE(entryOffset + 20);
        const rawDataOffset = buffer.readUInt32LE(entryOffset + 24);
        if (dataBytes === 0) fail('a Windows native addon has an empty CodeView record');
        const mappedDataOffset = dataRva === 0 ? undefined : rvaToOffset(dataRva, dataBytes);
        if (rawDataOffset !== 0 && mappedDataOffset !== undefined && rawDataOffset !== mappedDataOffset) {
            fail('a Windows native addon has inconsistent CodeView file and virtual addresses');
        }
        const dataOffset = rawDataOffset === 0 ? mappedDataOffset : rawDataOffset;
        if (dataOffset === undefined) fail('a Windows native addon has an unmapped CodeView record');
        assertBufferRange(buffer, dataOffset, dataBytes);
        const signature = buffer.toString('ascii', dataOffset, dataOffset + 4);
        const pathOffset = dataOffset + (signature === 'RSDS' ? 24 : signature === 'NB10' ? 16 : 0);
        if (pathOffset === dataOffset || pathOffset >= dataOffset + dataBytes) continue;
        const terminator = buffer.indexOf(0, pathOffset);
        if (terminator < pathOffset || terminator >= dataOffset + dataBytes) {
            fail('a Windows native addon has an unterminated CodeView path');
        }
        const pathBytes = terminator - pathOffset;
        const pdbPath = buffer.toString('utf8', pathOffset, terminator);
        if (pdbPath.includes('\ufffd')) fail('a Windows native addon has a malformed CodeView path');
        records.push({ path: pdbPath, pathBytes, pathOffset, signature });
    }
    return { certificateTableBytes, checksum, records };
}

function peDiagnosticPathRanges(buffer) {
    const ranges = [];
    const append = (text, encoding, byteOffset, bytesPerCharacter) => {
        for (const match of buildPathMatches(text)) {
            const extension = SAFE_PE_DIAGNOSTIC_EXTENSIONS.find(candidate => match.value.toLowerCase().endsWith(candidate));
            if (!extension || ![...match.value].every(character => character.codePointAt(0) >= 0x20 && character.codePointAt(0) <= 0x7e)) continue;
            const start = byteOffset + (match.index * bytesPerCharacter);
            const end = start + (match.value.length * bytesPerCharacter);
            assertBufferRange(buffer, start, (end - start) + bytesPerCharacter);
            if (bytesPerCharacter === 1) {
                if (buffer[end] !== 0) continue;
            } else {
                let exactUtf16 = buffer[end] === 0 && buffer[end + 1] === 0;
                for (let index = 0; exactUtf16 && index < match.value.length; index += 1) {
                    exactUtf16 = buffer[start + (index * 2)] === match.value.charCodeAt(index)
                        && buffer[start + (index * 2) + 1] === 0;
                }
                if (!exactUtf16) continue;
            }
            ranges.push({ encoding, end, extension, kind: match.kind, start });
        }
    };

    append(buffer.toString('latin1'), 'ascii', 0, 1);
    append(buffer.toString('utf16le'), 'utf16le', 0, 2);
    append(buffer.subarray(1).toString('utf16le'), 'utf16le', 1, 2);
    const unique = new Map();
    for (const range of ranges) unique.set(`${range.start}:${range.end}`, range);
    const result = [...unique.values()].sort((left, right) => left.start - right.start);
    for (let index = 1; index < result.length; index += 1) {
        if (result[index - 1].end > result[index].start) fail('a Windows native addon has overlapping diagnostic paths');
    }
    return result;
}

function scrubPeDiagnosticPaths(buffer) {
    const parsed = parsePeCodeViewRecords(buffer);
    const targets = peDiagnosticPathRanges(buffer);
    const originalLeak = findBuildPathLeakInBuffer(buffer);
    if (targets.length === 0) {
        if (originalLeak) fail(`a Windows native addon contains a ${originalLeak.kind} outside a safely replaceable diagnostic path`);
        return { buffer: Buffer.from(buffer), scrubbed: 0 };
    }
    if (parsed.certificateTableBytes > 0) fail('a signed Windows native addon cannot have its CodeView path rewritten safely');
    if (parsed.checksum !== 0) fail('a checksummed Windows native addon cannot have its CodeView path rewritten safely');

    const output = Buffer.from(buffer);
    for (const target of targets) {
        const replacement = Buffer.from(`xora-code${target.extension}`, target.encoding);
        if (replacement.length > target.end - target.start) fail('a Windows diagnostic build path is too short to replace safely');
        output.fill(0, target.start, target.end);
        replacement.copy(output, target.start);
    }

    if (output.length !== buffer.length) fail('Windows diagnostic path sanitization changed the native addon length');
    let rangeIndex = 0;
    for (let index = 0; index < buffer.length; index += 1) {
        while (rangeIndex < targets.length && index >= targets[rangeIndex].end) rangeIndex += 1;
        const insideTarget = rangeIndex < targets.length && index >= targets[rangeIndex].start;
        if (!insideTarget && output[index] !== buffer[index]) {
            fail('Windows diagnostic path sanitization changed bytes outside an approved path');
        }
    }

    const verified = parsePeCodeViewRecords(output);
    if (verified.records.some(record => findBuildPathLeak(record.path))) {
        fail('Windows CodeView sanitization left a build path in the debug directory');
    }
    const residual = findBuildPathLeakInBuffer(output);
    if (residual) fail(`a Windows native addon still contains a ${residual.kind} outside a replaceable diagnostic path`);
    return { buffer: output, scrubbed: targets.length };
}

const scrubPeCodeViewPaths = scrubPeDiagnosticPaths;

function defaultStripRunner(command, args) {
    return spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        windowsHide: true,
        shell: false
    });
}

function stripNativeAddons(root, platform = process.platform, runner = defaultStripRunner) {
    const addons = regularFiles(root)
        .filter(({ file }) => file.toLowerCase().endsWith('.node') || path.basename(file) === 'spawn-helper')
        .map(({ file }) => file);
    if (addons.length === 0) return { stripped: [], unstripped: [] };

    if (platform === 'win32') {
        const stripped = [];
        for (const addon of addons) {
            const original = fs.statSync(addon);
            const temporary = path.join(
                path.dirname(addon),
                `.${path.basename(addon)}.xora-strip-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
            );
            try {
                fs.copyFileSync(addon, temporary, fs.constants.COPYFILE_EXCL);
                const sanitized = scrubPeDiagnosticPaths(fs.readFileSync(temporary));
                if (sanitized.scrubbed === 0) continue;
                fs.writeFileSync(temporary, sanitized.buffer);
                fs.chmodSync(temporary, original.mode & 0o777);
                fs.renameSync(temporary, addon);
                stripped.push(addon);
            } finally {
                fs.rmSync(temporary, { force: true });
            }
        }
        return { stripped, unstripped: addons.filter(addon => !stripped.includes(addon)) };
    }

    const configuration = stripConfiguration(platform);
    if (!configuration) return { stripped: [], unstripped: addons };

    const stripped = [];
    for (let index = 0; index < addons.length; index += 1) {
        const addon = addons[index];
        const original = fs.statSync(addon);
        const temporary = path.join(
            path.dirname(addon),
            `.${path.basename(addon)}.xora-strip-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
        );
        try {
            fs.copyFileSync(addon, temporary, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(temporary, original.mode & 0o777);
            const result = runner(configuration.command, [...configuration.arguments, temporary]);
            if (result?.error?.code === 'ENOENT') {
                return { stripped, unstripped: addons.slice(index) };
            }
            if (!result || result.status !== 0) {
                fail(`native addon ${relativeName(root, addon)} could not be stripped safely`);
            }
            const sanitized = fs.statSync(temporary);
            if (!sanitized.isFile() || sanitized.size === 0) {
                fail(`native addon ${relativeName(root, addon)} became invalid while stripping`);
            }
            fs.chmodSync(temporary, original.mode & 0o777);
            fs.renameSync(temporary, addon);
            stripped.push(addon);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }
    return { stripped, unstripped: [] };
}

function assertNativeAfterPackContext(context) {
    const platform = context?.electronPlatformName;
    if (!['darwin', 'linux', 'win32'].includes(platform)) fail('electron-builder supplied an unsupported platform');
    if (platform !== process.platform) fail(`the ${platform} packaged output must be sanitized on its native runner`);
    if (!context.appOutDir || !fs.existsSync(context.appOutDir)) fail('electron-builder did not supply a packaged output directory');
    return { platform, root: context.appOutDir };
}

function sanitizePackagedOutput(context) {
    const { platform, root } = assertNativeAfterPackContext(context);
    const ripgrep = installSourceBuiltRipgrep(root, platform);
    const stripResult = stripNativeAddons(root, platform);
    const scanned = assertNoBuildPathLeaks(root);
    process.stdout.write(`Installed source-built ripgrep ${ripgrep.version}, sanitized ${stripResult.stripped.length} native addon(s), and scanned ${scanned.length} packaged executable payload(s).\n`);
    return { ...stripResult, ripgrep, scanned };
}

module.exports = {
    BUILD_PATH_PATTERNS,
    assertNativeAfterPackContext,
    assertNoBuildPathLeaks,
    executablePayloads,
    findBuildPathLeak,
    findBuildPathLeakInBuffer,
    isExecutablePayload,
    isHttpUrlContext,
    installSourceBuiltRipgrep,
    parsePeCodeViewRecords,
    peDiagnosticPathRanges,
    regularFiles,
    sanitizePackagedOutput,
    scanFileForBuildPath,
    scrubPeCodeViewPaths,
    scrubPeDiagnosticPaths,
    stripConfiguration,
    stripNativeAddons
};
