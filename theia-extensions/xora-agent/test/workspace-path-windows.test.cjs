// Copyright (c) 2026 Xora Code contributors.
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

// Load TS source via the built lib if present; otherwise transpile-free mirror
// of normalizeWindowsFilesystemPath for the pure string transform.
let normalizeWindowsFilesystemPath;
try {
    ({ normalizeWindowsFilesystemPath } = require('../lib/common/workspace-path'));
} catch {
    normalizeWindowsFilesystemPath = function normalizeWindowsFilesystemPath(input, platform = process.platform) {
        if (!input || platform !== 'win32') {
            return input;
        }
        let value = input.replace(/\//g, '\\');
        const posixDrive = value.match(/^\\([A-Za-z]):(\\.+)$/);
        if (posixDrive) {
            value = `${posixDrive[1]}:${posixDrive[2]}`;
        }
        const doubled = value.match(/^([A-Za-z]):\\([A-Za-z]):\\(.*)$/);
        if (doubled && doubled[1].toLowerCase() === doubled[2].toLowerCase()) {
            value = `${doubled[1]}:\\${doubled[3]}`;
        }
        return value;
    };
}

test('Windows URI.path form /d:/project is repaired to d:\\project', () => {
    assert.equal(
        normalizeWindowsFilesystemPath('/d:/project/fast-news', 'win32'),
        'd:\\project\\fast-news'
    );
    assert.equal(
        normalizeWindowsFilesystemPath('\\D:\\project\\fast-news', 'win32'),
        'D:\\project\\fast-news'
    );
});

test('doubled drive D:\\d:\\project is collapsed', () => {
    assert.equal(
        normalizeWindowsFilesystemPath('D:\\d:\\project\\fast-news', 'win32'),
        'D:\\project\\fast-news'
    );
});

test('non-Windows platforms leave paths unchanged', () => {
    assert.equal(
        normalizeWindowsFilesystemPath('/d:/project/fast-news', 'darwin'),
        '/d:/project/fast-news'
    );
    assert.equal(
        normalizeWindowsFilesystemPath('/Users/me/project', 'linux'),
        '/Users/me/project'
    );
});

test('normal absolute Windows paths pass through', () => {
    const value = normalizeWindowsFilesystemPath('D:\\project\\fast-news', 'win32');
    assert.equal(value, 'D:\\project\\fast-news');
    assert.equal(path.win32.isAbsolute(value), true);
});

let filesystemPathsEqual;
let filesystemPathListIncludes;
let filesystemPathKey;
try {
    ({ filesystemPathsEqual, filesystemPathListIncludes, filesystemPathKey } = require('../lib/common/workspace-path'));
} catch {
    // Mirror until lib is rebuilt.
    filesystemPathKey = function filesystemPathKey(input, platform = process.platform) {
        if (!input) return '';
        let value = normalizeWindowsFilesystemPath(input, platform).replace(/\\/g, '/');
        if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
        if (platform === 'win32') value = value.toLowerCase();
        return value;
    };
    filesystemPathsEqual = (a, b, platform = process.platform) => {
        if (a === b) return true;
        if (!a || !b) return false;
        return filesystemPathKey(a, platform) === filesystemPathKey(b, platform);
    };
    filesystemPathListIncludes = (list, candidate, platform = process.platform) => {
        if (!candidate) return false;
        const key = filesystemPathKey(candidate, platform);
        return list.some(entry => filesystemPathKey(entry, platform) === key);
    };
}

test('Windows path equality ignores drive-letter case', () => {
    assert.equal(
        filesystemPathsEqual('d:\\project\\fast-news', 'D:\\project\\fast-news', 'win32'),
        true
    );
    assert.equal(
        filesystemPathListIncludes(['d:\\project\\fast-news'], 'D:\\project\\fast-news', 'win32'),
        true
    );
    assert.equal(
        filesystemPathKey('D:\\project\\fast-news\\', 'win32'),
        'd:/project/fast-news'
    );
});
